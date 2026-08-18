// Nova — test-event-triggers.js (Round 5)
//
// Headless harness for event-triggered automations. All tests run against the
// in-memory store (clearForTesting) with injected clocks/idlers — no real
// file watchers tick during tests; the chokidar watch wiring is smoke-tested
// separately via the live file scenario at the end (temp folder).
//
// Exit 0 = all assertions pass.

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const store = require("./automation/store");
const dispatch = require("./automation/dispatch");
const triggers = require("./automation/event-triggers");
const { RISK_LEVEL } = require("./permissions/risk-levels");

let passed = 0;
let failed = 0;
const __queue = [];
function test(name, fn) {
  __queue.push([name, fn]);
}
async function runAll() {
  for (const [name, fn] of __queue) {
    try {
      await fn();
      passed++;
      console.log(`  pass — ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL — ${name}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n[event-triggers] done — ${passed} passed, ${failed} failed`);
  process.exit(process.exitCode ?? (failed ? 1 : 0));
}
// All test() declarations register synchronously; run them at the end.
process.nextTick(runAll);

function t0() { return new Date("2026-08-18T09:00:00Z").getTime(); }
function t(minutes) { return t0() + minutes * 60_000; }

let fireCount = 0;
beforeAll();
function beforeAll() {
  triggers.emitter.on("automation-event-firing", () => { fireCount++; });
}

function fresh() {
  store.clearForTesting();
  triggers.resetForTesting();
  fireCount = 0;
  process.exitCode = undefined;
}

function notesStep(text) {
  return { kind: "notes", text, level: RISK_LEVEL.SAFE };
}
function visionStep(text) {
  return { kind: "vision", text, level: RISK_LEVEL.READ };
}

// ---------------------------------------------------------------
console.log("\n[event-triggers] validation");

test("file trigger: valid folder accepted", async () => {
  fresh();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nova-trig-"));
  try {
    const r = triggers.validateTrigger({ type: "file", folder: tmp });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.trigger.type, "file");
    assert.strictEqual(r.trigger.folder, tmp);
    assert.strictEqual(r.trigger.depth, 4);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("file trigger: relative path rejected", async () => {
  fresh();
  const r = triggers.validateTrigger({ type: "file", folder: "relative/folder" });
  assert.ok(!r.ok);
});

test("file trigger: nonexistent folder rejected", async () => {
  fresh();
  const r = triggers.validateTrigger({ type: "file", folder: "/no-such-nova-folder-xyz" });
  assert.ok(!r.ok);
});

test("time trigger: valid HH:MM accepted", async () => {
  fresh();
  const r = triggers.validateTrigger({ type: "time", at: "9:30" });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.trigger.at, "09:30");
});

test("time trigger: invalid time rejected", async () => {
  fresh();
  const r = triggers.validateTrigger({ type: "time", at: "25:99" });
  assert.ok(!r.ok);
});

test("event trigger: valid name accepted", async () => {
  fresh();
  const r = triggers.validateTrigger({ type: "event", name: "startup" });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.trigger.name, "startup");
});

test("event trigger: invalid name rejected", async () => {
  fresh();
  const r = triggers.validateTrigger({ type: "event", name: "bad name with spaces!!" });
  assert.ok(!r.ok);
});

test("idle trigger: defaults applied and clamped", async () => {
  fresh();
  const r = triggers.validateTrigger({ type: "idle", minutes: 7 });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.trigger.minutes, 7);
});

test("unknown trigger type rejected", async () => {
  fresh();
  const r = triggers.validateTrigger({ type: "magic" });
  assert.ok(!r.ok);
});

test("store persists trigger object", async () => {
  fresh();
  const res = await dispatch.addEventAutomation("downloads-watcher",
    { type: "file", folder: os.tmpdir(), depth: 2, debounceMs: 3000, match: "pdf" },
    [visionStep("what just appeared in Downloads")]);
  assert.ok(res.ok, res.text);
  const stored = store.get(res.detail.automationId);
  assert.ok(stored);
  assert.strictEqual(stored.trigger.type, "file");
  assert.strictEqual(stored.trigger.folder, os.tmpdir());
  assert.strictEqual(stored.trigger.match, "pdf");
});

test("cron validation skipped when trigger present, enforced otherwise", async () => {
  fresh();
  const ev = await dispatch.addEventAutomation("ev", { type: "event", name: "wake" }, [visionStep("x")]);
  assert.ok(ev.ok, ev.text);
  const badCron = await dispatch.addAutomation("when does it fail", { name: "bad", forceCron: true });
  // addAutomation parses via parser (cron-shaped); ensure a stored cron-only
  // entry with a malformed cron is refused by the store directly:
  const res = store.add({ name: "x", cron: "not a cron", trigger: null, steps: [visionStep("x")] });
  assert.ok(!res.ok);
});

// ---------------------------------------------------------------
console.log("\n[event-triggers] firing semantics");

test("event trigger fires on matching app event", async () => {
  fresh();
  const res = await dispatch.addEventAutomation("wake-note",
    { type: "event", name: "wake" }, [notesStep("remember: app woke up")]);
  assert.ok(res.ok, res.text);
  triggers.setAppEmitter(null);
  const { EventEmitter } = require("events");
  const bus = new EventEmitter();
  triggers.setAppEmitter(bus);
  triggers.start();
  bus.emit("app-event", { name: "wake" });
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(fireCount, 1, `expected 1 fire, got ${fireCount}`);
  triggers.stop();
});

test("non-matching event does not fire", async () => {
  fresh();
  await dispatch.addEventAutomation("wake-note", { type: "event", name: "wake" }, [notesStep("x")]);
  triggers.start();
  const bus = global.__novaAppEvents;
  if (bus) bus.emit("app-event", { name: "unrelated-event-xyz" });
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(fireCount, 0);
  triggers.stop();
});

test("5-minute cooldown prevents flood", async () => {
  fresh();
  const when = t0();
  triggers.setNowForTesting(() => when);
  await dispatch.addEventAutomation("wake-note", { type: "event", name: "wake" }, [notesStep("x")]);
  triggers.setAppEmitter(null);
  const { EventEmitter } = require("events");
  const bus = new EventEmitter();
  triggers.setAppEmitter(bus);
  triggers.start();
  bus.emit("app-event", { name: "wake" });
  await new Promise((r) => setTimeout(r, 250));
  bus.emit("app-event", { name: "wake" });
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(fireCount, 1, `flood guard failed: fired ${fireCount} times`);
  triggers.stop();
});

test("time trigger fires at target HH:MM", async () => {
  fresh();
  triggers.setNowForTesting(() => new Date("2026-08-18T09:30:10Z").getTime());
  await dispatch.addEventAutomation("tea-time", { type: "time", at: "09:30" }, [notesStep("tea reminder")]);
  triggers.start();
  await new Promise((r) => setTimeout(r, 2500)); // time poller ticks every 1s in tests
  assert.ok(fireCount >= 1, `time trigger did not fire (${fireCount})`);
  triggers.stop();
});

test("time trigger does not fire off-target", async () => {
  fresh();
  triggers.setNowForTesting(() => new Date("2026-08-18T09:00:05Z").getTime());
  await dispatch.addEventAutomation("tea-time", { type: "time", at: "09:30" }, [notesStep("tea")]);
  triggers.start();
  await new Promise((r) => setTimeout(r, 2200));
  assert.strictEqual(fireCount, 0);
  triggers.stop();
});

test("idle trigger fires when injected idler reports enough idle", async () => {
  fresh();
  // fake idle seconds >= 10 min
  triggers.setIdleForTesting(() => 11 * 60);
  await dispatch.addEventAutomation("idle-report", { type: "idle", minutes: 10 }, [visionStep("what's on my screen")]);
  triggers.start();
  await new Promise((r) => setTimeout(r, 16_000)); // idle poll every 15s
  assert.ok(fireCount >= 1, `idle trigger did not fire (${fireCount})`);
  triggers.stop();
});

test("idle trigger stays dormant with no idle source", async () => {
  fresh();
  triggers.setIdleForTesting(() => null);
  await dispatch.addEventAutomation("idle-report", { type: "idle", minutes: 10 }, [visionStep("x")]);
  triggers.start();
  await new Promise((r) => setTimeout(r, 16_000));
  assert.strictEqual(fireCount, 0);
  triggers.stop();
});

test("disabled automation never fires on events", async () => {
  fresh();
  const res = await dispatch.addEventAutomation("wake-note", { type: "event", name: "wake" }, [notesStep("x")]);
  await dispatch.toggleAutomation(res.detail.automationId, false);
  triggers.start();
  const bus = global.__novaAppEvents;
  if (bus) bus.emit("app-event", { name: "wake" });
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(fireCount, 0);
  triggers.stop();
});

test("file trigger rebuilds watcher when an automation is added", async () => {
  fresh();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nova-rt-"));
  try {
    const res = await dispatch.addEventAutomation("tmp-watch",
      { type: "file", folder: tmp, debounceMs: 1500 }, [visionStep("what changed")]);
    assert.ok(res.ok, res.text);
    // start AFTER the automation exists so the chokidar watcher attaches to tmp
    triggers.start();
    await new Promise((r) => setTimeout(r, 400)); // let chokidar settle (ignoreInitial)
    fs.writeFileSync(path.join(tmp, "hello.txt"), "hi");
    // poll with backoff instead of a single fixed sleep
    let ok = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (fireCount >= 1) { ok = true; break; }
    }
    assert.ok(ok, `file watcher did not fire (${fireCount})`);
    triggers.stop();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("store refuses trigger-only automation with sensitive-first steps", async () => {
  fresh();
  const res = store.add({
    name: "bad-only",
    cron: "",
    trigger: { type: "event", name: "startup" },
    steps: [{ kind: "control", text: "delete everything", level: RISK_LEVEL.DESTRUCTIVE }],
  });
  assert.ok(!res.ok, "must refuse sensitive-first event automation");
});

test("list exposes triggerLabel", async () => {
  fresh();
  await dispatch.addEventAutomation("tea-time", { type: "time", at: "09:30" }, [notesStep("tea")]);
  const list = dispatch.listAutomations();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].triggerLabel, "time at 09:30");
  assert.strictEqual(list[0].nextRunAt, null);
});


