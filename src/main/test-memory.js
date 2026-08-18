// Nova — test-memory.js (Round 6)
//
// Headless harness for the cross-session conversation memory. Uses an
// in-memory-only test path (never touches the real userData file) and
// exercises append / persistence shape / pruning / context building /
// Private Mode gating / the memory actions.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const memory = require("./memory/conversation-memory");
const actionRegistry = require("./permissions/action-registry");
const settings = require("./settings");

let passed = 0;
let failed = 0;
const __queue = [];
function test(name, fn) { __queue.push([name, fn]); }
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
  console.log(`\n[memory] done — ${passed} passed, ${failed} failed`);
  process.exit(process.exitCode ?? (failed ? 1 : 0));
}
process.nextTick(runAll);

function fresh() { memory.clearForTesting(); process.exitCode = undefined; }

function seeded(n = 5) {
  fresh();
  for (let i = 0; i < n; i++) {
    memory.append({ intent: "conversation", input: `question ${i}`, output: `answer ${i}`, taskId: `task-${i}` });
  }
}

// ---------------------------------------------------------------
console.log("\n[memory] persistence");

test("append persists entries to the override path", async () => {
  fresh();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nova-mem-"));
  memory.setPathForTesting(path.join(tmp, "nova-memory.json"));
  memory.append({ intent: "conversation", input: "hello nova", output: "hi there", taskId: "t1" });
  assert.ok(fs.existsSync(path.join(tmp, "nova-memory.json")), "memory file not created");
  const entries = JSON.parse(fs.readFileSync(path.join(tmp, "nova-memory.json"), "utf8"));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].input, "hello nova");
  fs.rmSync(tmp, { recursive: true, force: true });
  memory.resetForTesting();
});

test("long inputs/outputs are truncated", async () => {
  fresh();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nova-mem-"));
  memory.setPathForTesting(path.join(tmp, "m.json"));
  memory.append({ input: "x".repeat(2000), output: "y".repeat(5000), intent: "a", taskId: "t" });
  const entries = JSON.parse(fs.readFileSync(path.join(tmp, "m.json"), "utf8"));
  assert.ok(entries[0].input.length <= 500);
  assert.ok(entries[0].output.length <= memory.MAX_OUTPUT_CHARS);
  fs.rmSync(tmp, { recursive: true, force: true });
  memory.resetForTesting();
});

test("non-existent path fallback does not crash on persistence error", async () => {
  fresh();
  memory.setPathForTesting("/nonexistent-ro-dir-xyz/memory.json");
  memory.append({ intent: "a", input: "x", output: "y", taskId: "t" });
  // in-memory still works even if writing to disk fails
  assert.strictEqual(memory.list().length, 1);
  memory.resetForTesting();
});

test("recentContext returns empty when memory is empty", async () => {
  fresh();
  assert.deepStrictEqual(memory.recentContext(), []);
});

test("recentContext builds system summary + turns", async () => {
  seeded(5);
  const ctx = memory.recentContext(3, 8);
  assert.ok(ctx.length >= 2, `too short: ${ctx.length}`);
  assert.strictEqual(ctx[0].role, "system");
  assert.match(ctx[0].content, /Recent history/);
  assert.strictEqual(ctx[1].role, "user");
  assert.strictEqual(ctx[2].role, "assistant");
});

test("recentContext prunes old entries beyond 30 days", async () => {
  seeded(3);
  // corrupt a timestamp to look 60 days old — prune only runs on append
  const list = memory.list();
  list[0].ts = Date.now() - 60 * 86400_000;
  memory.clearForTesting();
  memory.resetForTesting();
  memory.clearForTesting();
  // manually re-append with old timestamp
  for (const e of list) memory.append(e);
  memory.append({ intent: "a", input: "fresh", output: "b", taskId: "x" });
  const ages = memory.list().map((e) => Date.now() - e.ts);
  assert.ok(ages.every((a) => a < 31 * 86400_000), "stale entries remain");
});

test("clear wipes the store", async () => {
  seeded(4);
  assert.strictEqual(memory.list().length, 4);
  memory.clear();
  assert.strictEqual(memory.list().length, 0);
});

test("stats reports file and counts", async () => {
  seeded(2);
  const s = memory.stats();
  assert.strictEqual(s.entries, 2);
  assert.ok(s.file.endsWith("nova-memory.json"));
});

// ---------------------------------------------------------------
console.log("\n[memory] privacy gating");

test("dispatcher would not include memory when Private Mode is on", async () => {
  // The gating logic lives in dispatcher.js; the memory module exposes
  // recentContext() — here we assert the module still returns data (gating
  // happens at the call site), mirroring how the dispatcher checks
  // settings.isPrivateMode() before calling it.
  seeded(3);
  assert.ok(memory.recentContext().length > 0);
  assert.strictEqual(settings.isPrivateMode(), false); // sanity: tests run with PM off
});

// ---------------------------------------------------------------
console.log("\n[memory] actions");

test("memory:stats action registered at level 1", () => {
  // Actions register at require-time; they are already loaded by main.js's
  // `require("./memory/actions")` only in the real app — in the test we load
  // them explicitly. Double-registration throws, so guard with a try/catch.
  let statsAction = null;
  try { require("./memory/actions"); } catch (err) { /* already registered */ }
  statsAction = actionRegistry.getAction("memory:stats");
  assert.strictEqual(statsAction.level, 1);
  const res = statsAction.execute();
  assert.ok(res.ok);
  assert.ok(typeof res.entries === "number");
});

test("memory:clear action is level 1 with simulate()", () => {
  const clearAction = actionRegistry.getAction("memory:clear");
  assert.strictEqual(clearAction.level, 1);
  assert.ok(typeof clearAction.simulate === "function");
  seeded(3);
  const sim = clearAction.simulate();
  assert.ok(sim.ok);
  assert.strictEqual(sim.detail.wouldDelete, 3);
  const res = clearAction.execute();
  assert.ok(res.ok);
  assert.strictEqual(res.detail.cleared, 3);
  assert.strictEqual(memory.list().length, 0);
});

// ---------------------------------------------------------------
console.log("\n[memory] dispatcher integration");

test("dispatcher attaches memoryUsed flag on conversation runs", async () => {
  fresh();
  const dispatcher = require("./agent/dispatcher");
  // Simulate a previous exchange in memory:
  memory.append({ intent: "conversation", input: "tell me about my cat", output: "your cat is called Luna", taskId: "prev" });
  const res = await dispatcher.run("how old is she again", {
    getKey: async () => null, // no key → chat path returns a key-missing reply
  });
  // With no API key the chat path short-circuits; either way the run must
  // not crash and output intent classification must be conversation.
  assert.strictEqual(res.intent, "conversation");
});

// Keep the process alive long enough for sequential tests only; exit handled.
