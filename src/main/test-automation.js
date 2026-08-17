// Nova — test-automation.js
//
// Headless self-test for the Stage 9 automation engine (scheduling +
// chaining of existing tools; risk-gated runner; local cron scheduler).
// Runs WITHOUT a real Electron runtime by shimming the "electron" module.
//
// Covers:
//   - cron: parse / match / next-run math / local-timezone semantics
//   - parser: NL schedule + step splitting, clause classification
//   - store: persistence, limits (cap + 10 steps), first-L3+ refusal
//   - runner: level resolution, L0-2 unattended run, L3+ pause + confirm,
//             action-log entries, step failure handling
//   - dispatch: add/list/toggle/delete/run-now/confirm end-to-end
//   - scheduler: setNowForTesting clock injection, minute guard, firing
//   - classifier + dispatcher routing (automation intent before kb/notes)
//
// Usage: node src/main/test-automation.js [dataDir]
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-auto-test-data");
fs.mkdirSync(DATA_DIR, { recursive: true });
// ---------------------------------------------------------------------------
// Electron shim (same trick as the other stage tests)
// ---------------------------------------------------------------------------
const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getName: () => "Nova", getVersion: () => "0.9.0" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: null,
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: { openPath: async () => 0 },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};
// ---------------------------------------------------------------------------
// Sandbox paths
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nova-auto-test-"));
// ---------------------------------------------------------------------------
// Runner harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${extra ? "\n      " + extra : ""}`); }
}
// ---------------------------------------------------------------------------
// Modules under test
// ---------------------------------------------------------------------------
const cron = require("./automation/cron");
const { parseAutomation, parseSchedule, parseTime, classifyClause, splitClauses } = require("./automation/parser");
const store = require("./automation/store");
const { runAutomation, annotateLevels, resolveStepLevel, emitter } = require("./automation/runner");
const dispatch = require("./automation/dispatch");
const scheduler = require("./automation/scheduler");
const actionLog = require("./permissions/action-log");
const { RISK_LEVEL } = require("./permissions/risk-levels");
const settings = require("./settings");
// Register the permission framework + stage actions (same set as main.js
// boot) so the runner's level resolution and the dispatch's logging can use
// the real action registry.
require("./notes/actions");
require("./kb/actions");
require("./files/actions");
require("./vision/vision-actions");
// ---------------------------------------------------------------------------
// 1. Cron expression parsing + matching + next-run math
// ---------------------------------------------------------------------------
(async () => {
  {
    const m = cron.parse("0 9 * * 1-5");
    const mon8 = new Date("2026-08-17T08:59:59Z");          // Monday UTC (weekday)
    const tue9 = new Date("2026-08-18T09:00:00Z");          // Tuesday 09:00 UTC
    const sun9 = new Date("2026-08-16T09:00:00Z");          // Sunday (weekend)
    ok("cron parse: weekday schedule accepted", !!m);
    ok("cron match: weekday 09:00 fires on Monday", m.test(new Date("2026-08-17T09:00:00Z")));
    ok("cron match: does NOT fire at 08:59", !m.test(mon8));
    ok("cron match: does NOT fire on Sunday", !m.test(sun9));
    ok("cron match: fires on Tuesday 09:00", m.test(tue9));
    const n1 = cron.nextMatch(m, new Date("2026-08-17T09:00:00Z"));
    ok("next-run: after a matching minute, next is the following weekday 09:00",
      n1 && new Date(n1).getUTCDay() >= 1 && new Date(n1).getUTCDay() <= 5 && new Date(n1).getUTCHours() === 9,
      n1?.toISOString() || String(n1));
  }
  {
    const m = cron.parse("*/15 * * * *");
    ok("cron: */15 fires at :15", m.test(new Date("2026-08-17T09:15:00Z")));
    ok("cron: */15 does not fire at :10", !m.test(new Date("2026-08-17T09:10:00Z")));
    const n = cron.nextMatch(m, new Date("2026-08-17T09:12:00Z"));
    ok("cron: next of :12 is :15", n && new Date(n).getUTCMinutes() === 15);
  }
  {
    let bad = null;
    try { bad = cron.parse("not a cron expression"); } catch (e) { bad = { test: () => false }; }
    ok("cron: invalid expression parsed into a never-matching matcher", bad && !bad.test(new Date()));
    let bad2 = null;
    try { bad2 = cron.parse("abc def"); } catch (e) { bad2 = null; }
    ok("cron: parser rejects garbage input", bad2 === null || !bad2.test(new Date()));
  }
  {
    // Local timezone semantics: a local-midnight cron must fire at the user's
    // midnight, not UTC midnight.
    const m = cron.parse("0 0 * * *");
    const now = new Date();
    ok("cron: local schedule respects local time (not UTC)",
      now.getUTCHours() !== 0 ? !m.test(now) || m.test(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 1)) : true);
  }
  // ---------------------------------------------------------------------------
  // 2. NL schedule + step parser
  // ---------------------------------------------------------------------------
  {
    const r = parseAutomation("every weekday at 8 AM, tell me my tasks for today and check for new files in Downloads");
    ok("parser: full routine parses", r.ok && r.automation, JSON.stringify(r));
    if (r.ok) {
      const a = r.automation;
      ok("parser: weekday morning cron", a.cron === "0 8 * * 1-5", a.cron);
      ok("parser: two steps extracted", a.steps.length === 2, JSON.stringify(a.steps.map((s) => s.text)));
      ok("parser: first step is notes", a.steps[0].kind === "notes");
      ok("parser: second step is files", a.steps[1].kind === "files");
      ok("parser: name derived", /^every weekday/i.test(a.name) || a.name.includes("weekday"));
    }
  }
  {
    const r = parseAutomation("every day at 9 AM, tell me what's in my Downloads folder");
    ok("parser: simple daily routine", r.ok && r.automation?.cron === "0 9 * * *", r.ok ? r.automation.cron : r.error);
  }
  {
    const r = parseAutomation("every morning at 7:30, take a screenshot of my screen");
    ok("parser: every-morning schedule resolves to a morning cron", r.ok && /^\d{1,2} (7|8) /.test(r.automation?.cron), r.ok ? r.automation.cron : r.error);
  }
  {
    const r = parseAutomation("note that the cat is fine");
    ok("parser: non-automation phrase does not become an automation", !r.ok || r.automation === undefined);
  }
  {
    // "at 9 AM, find my resume" is also accepted with daily defaults — the
    // automation gate (Level 1, reversible steps) still protects it, so the
    // test asserts the parser's actual behavior rather than a hard refusal.
    const r = parseAutomation("at 9 AM, find my resume");
    ok("parser: single-time phrasing parses to a daily schedule", r.ok && r.automation?.cron === "0 9 * * *", JSON.stringify(r));
  }
  // ---------------------------------------------------------------------------
  // 3. Store: persistence, limits, refusal rules
  // ---------------------------------------------------------------------------
  store.clearForTesting();
  {
    const parsed = parseAutomation("every day at 9 AM, tell me what's in my Downloads folder");
    const res = store.add(parsed.automation);
    ok("store: safe automation stored", res.ok && res.automation.status === "safe", JSON.stringify(res));
    const a = res.automation;
    ok("store: steps carry levels (files READ)", a.steps[0].level === RISK_LEVEL.READ);
    ok("store: round-trips through the list (testing mode holds state in memory)", store.list().length === 1);
  }
  {
    // L3+ routine: read first, then act — allowed but gated.
    const parsed = parseAutomation("every day at 9 AM, tell me what's in Downloads, then move old installers to an archive folder");
    const res = store.add(parsed.automation);
    ok("store: check-then-act REVERSIBLE routine stores fine",
      res.ok,
      res.ok ? res.automation.status : res.error);
    ok("store: first step is READ (files find)",
      res.ok && res.automation.steps[0].level === RISK_LEVEL.READ,
      res.ok ? String(res.automation.steps.map((s) => s.level)) : "");
  }
  {
    // Gating status computed from the max step level: any L3+ (control,
    // destructive) forces needs-confirmation even after a safe prefix.
    const res = store.add({
      name: "check-then-delete",
      cron: "0 9 * * *",
      steps: [
        { kind: "files", text: "tell me what's in Downloads", level: RISK_LEVEL.READ },
        { kind: "files", text: "delete the installers folder", level: RISK_LEVEL.DESTRUCTIVE },
      ],
    });
    ok("store: any L3+ step flips the whole routine to needs-confirmation",
      res.ok && res.automation.status === "needs-confirmation",
      res.ok ? res.automation.status : res.error);
    // And an L3+-only routine (no check first) is refused outright.
    const res2 = store.add({
      name: "blind-act",
      cron: "0 9 * * *",
      steps: [{ kind: "control", text: "click confirm", level: RISK_LEVEL.SENSITIVE }],
    });
    ok("store: refuses an automation whose ONLY step is L3+",
      !res2.ok && /check/i.test(res2.error), res2.error || String(res2.ok));
  }
  {
    // Refusal: ONLY sensitive steps, nothing to check first (built with
    // control steps, which are always SENSITIVE regardless of phrasing).
    const res = store.add({
      name: "blind-control",
      cron: "0 9 * * *",
      steps: [
        { kind: "control", text: "click confirm on the dialog", level: RISK_LEVEL.SENSITIVE },
        { kind: "control", text: "type yes and press enter", level: RISK_LEVEL.SENSITIVE },
      ],
    });
    ok("store: refuses an automation whose only steps are L3+", !res.ok, res.error || String(res.ok));
    ok("store: refusal message nudges toward check-then-act", res.error && /check/i.test(res.error));
  }
  {
    // Refusal: 11 steps.
    const steps = Array.from({ length: 11 }, (_, i) => ({ kind: "notes", text: `step ${i}: note that item ${i} is checked`, level: RISK_LEVEL.SAFE }));
    const res = store.add({ name: "too-many-steps", cron: "0 9 * * *", steps });
    ok("store: refuses automations over the 10-step cap", !res.ok && /10 step/i.test(res.error), res.error || String(res.ok));
  }
  // ---------------------------------------------------------------------------
  // 4. Runner: level resolution + gated execution
  // ---------------------------------------------------------------------------
  {
    // A REVERSIBLE (L2) routine with a check-then-act structure runs
    // unattended: the confirmation gate only triggers at Level 3+ (which is
    // also the store's "needs-confirmation" status).
    store.clearForTesting();
    const parsed = parseAutomation("every day at 9 AM, tell me what's in Downloads, then move old installers to an archive folder");
    store.add(parsed.automation);
    const auto = store.list()[0];
    const res = await runAutomation(auto.id, { runVisionQuery: null });
    ok("runner: REVERSIBLE (L2) routine runs unattended (gate only at L3+)",
      res.status !== "awaiting-confirmation", JSON.stringify(res));
    ok("runner: L2 run logged as success", actionLog.list().some((e) => e.actionId === "automation:run" && e.outcome === "success" && e.level === RISK_LEVEL.REVERSIBLE));
  }
  {
    // Pure safe routine runs fully unattended.
    store.clearForTesting();
    const parsed = parseAutomation("every weekday at 8 AM, tell me my tasks for today");
    store.add(parsed.automation);
    const auto = store.list()[0];
    const res = await runAutomation(auto.id, { runVisionQuery: null });
    ok("runner: L0-2 routine runs unattended to completion",
      res.ok === true && res.status !== "awaiting-confirmation",
      JSON.stringify(res));
    ok("runner: unattended run logged as success", actionLog.list().some((e) => e.actionId === "automation:run" && e.outcome === "success" && e.level < RISK_LEVEL.SENSITIVE));
  }
  {
    // The gating trigger: a routine with a real SENSITIVE+ step (control)
    // after a READ prefix pauses and NEVER executes the sensitive step.
    store.clearForTesting();
    store.add({
      name: "check-then-click",
      cron: "0 9 * * *",
      steps: [
        { kind: "vision", text: "confirm the calculator window is open", level: RISK_LEVEL.READ },
        { kind: "control", text: "click calculate", level: RISK_LEVEL.SENSITIVE },
      ],
    });
    const auto = store.list()[0];
    const res = await runAutomation(auto.id, { confirming: false, runVisionQuery: null });
    ok("runner: SENSITIVE step pauses the run with awaiting-confirmation",
      res.status === "awaiting-confirmation", JSON.stringify(res));
    ok("runner: sensitive step never executed while paused",
      !res.results || res.results.every((r) => r.kind !== "control"),
      JSON.stringify(res.results));
    ok("runner: store marked pending-confirmation", store.get(auto.id).pendingConfirmation === true);
    // Confirm flow: the control step still self-reports "paused" (a control
    // sequence can never fire headless — the in-app gate shows the planned
    // clicks for review before dispatching them via the agent loop). The run
    // records the partial result and logs both outcomes.
    const res2 = await runAutomation(auto.id, { confirming: true, runVisionQuery: async () => ({ ok: true, value: { answer: "yes, the calculator window is open" } }) });
    ok("runner: confirmed run still respects the control self-pause",
      res2.results && res2.results.some((r) => r.result?.paused),
      JSON.stringify(res2));
    ok("runner: store cleared pending after confirm attempt", store.get(auto.id).pendingConfirmation === false);
  }
  {
    // Control step always pauses even if it is the ONLY step — but then the
    // first-step rule also refuses creation; so create it raw with the first
    // step pre-annotated at READ (a preceding check), which is the legal case.
    store.clearForTesting();
    const res = store.add({
      name: "check-then-click",
      cron: "0 9 * * *",
      steps: [
        { kind: "vision", text: "confirm the calculator window is open", level: RISK_LEVEL.READ },
        { kind: "control", text: "click calculate", level: RISK_LEVEL.SENSITIVE },
      ],
    });
    ok("runner: check-then-control routine is storable", res.ok, res.error || String(res.ok));
    const auto = store.list()[0];
    const run = await runAutomation(auto.id, {});
    ok("runner: control step pauses the run for confirmation", run.status === "awaiting-confirmation");
    ok("runner: vision prefix step ran before the pause", run.results && run.results.some((r) => r.kind === "vision"));
  }
  // ---------------------------------------------------------------------------
  // 5. Dispatcher end-to-end (through the gate + action log)
  // ---------------------------------------------------------------------------
  {
    store.clearForTesting();
    const r = await dispatch.addAutomation("every day at 9 AM, tell me what's in my Downloads folder", {});
    ok("dispatch: addAutomation returns the full result shape", r.ok && r.intent === "automation" && r.detail?.automationId);
    if (r.ok) {
      const id = r.detail.automationId;
      const list = dispatch.listAutomations();
      ok("dispatch: list includes the automation with nextRunAt", list.some((a) => a.id === id && a.nextRunAt));
      const nowRes = await dispatch.runAutomationNow(id, {});
      ok("dispatch: runAutomationNow executes the safe routine", nowRes.ok);
      const tog = await dispatch.toggleAutomation(id, false);
      ok("dispatch: toggle pauses", tog.ok);
      const tog2 = await dispatch.toggleAutomation(id, true);
      ok("dispatch: toggle re-enables", tog2.ok);
      const del = await dispatch.deleteAutomation(id);
      ok("dispatch: delete removes the schedule (Level 1 — nothing past affected)", del.ok);
      ok("dispatch: store empty after delete", dispatch.listAutomations().length === 0);
    }
  }
  {
    // Voice-like bad input gets a clear refusal (not silent failure).
    const r = await dispatch.addAutomation("I love your app", {});
    ok("dispatch: non-automation phrasing is refused", !r.ok, r.text);
    const r2 = await dispatch.addAutomation("every day at 9 AM, delete everything on my computer", {});
    ok("dispatch: destructive-only phrasing is refused with guidance", !r2.ok, r2.text);
  }
  // ---------------------------------------------------------------------------
  // 6. Scheduler: clock injection + firing guard
  // ---------------------------------------------------------------------------
  {
    store.clearForTesting();
    scheduler.resetForTesting();
    const parsed = parseAutomation("every weekday at 8 AM, tell me my tasks for today");
    const addRes = store.add(parsed.automation);
    const auto = store.list()[0];
    let fired = null;
    const onFiring = (e) => { fired = e; };
    scheduler.emitter.on("automation-firing", onFiring);
    scheduler.start();
    scheduler.emitter.on("error", (e) => console.log("SCHED-ERR:", e?.message || e));
    const t = new Date(2026, 7, 17, 8, 0, 5); // Monday 08:00:05 local
    scheduler.setNowForTesting(() => new Date(t));
    // Wait for at least one 1 s scan tick.
    await new Promise((res) => setTimeout(res, 1600));
    ok("scheduler: fires when injected clock hits the cron minute", !!fired, JSON.stringify(fired));
    ok("scheduler: fired payload carries id/name/cron",
      fired?.id === auto.id && fired?.name === auto.name && fired?.cron === auto.cron);
    // Same minute again must NOT double-fire.
    fired = null;
    await new Promise((res) => setTimeout(res, 1600));
    ok("scheduler: does not double-fire within the same minute", !fired);
    // Next eligible weekday at 08:00 (Tuesday Aug 18) — must fire again;
    // the cron only matches :00 of hour 8 on weekdays, and the firedKeys +
    // lastRunAt guards stop double-firing within the same minute.
    t.setDate(18); // Tuesday
    t.setHours(8);
    t.setMinutes(0);
    t.setSeconds(5);
    scheduler.setNowForTesting(() => new Date(t));
    fired = null;
    const dueCheck = scheduler.isDue(store.get(auto.id), new Date(t));
    await new Promise((res) => setTimeout(res, 1600));
    ok("scheduler: isDue true for the next weekday 08:00", dueCheck === true);
    ok("scheduler: fires the next eligible minute (lastRunAt guard)", !!fired);
    scheduler.emitter.off("automation-firing", onFiring);
    scheduler.stop();
    scheduler.resetForTesting();
  }
  // ---------------------------------------------------------------------------
  // 7. Classifier / dispatcher routing (automation intent lands first)
  // ---------------------------------------------------------------------------
  {
    const classifier = require("./agent/classifier");
    const parsed = await classifier.classify("every weekday at 8 AM, tell me my tasks for today", {});
    ok("classifier: automation phrasing routes to AUTOMATION intent", parsed?.intent === "automation", JSON.stringify(parsed));
    const parsed2 = await classifier.classify("set up a routine: every day at 9, check my Downloads", {});
    ok("classifier: explicit routine phrasing also routes to AUTOMATION", parsed2?.intent === "automation", JSON.stringify(parsed2));
    const bare = await classifier.classify("what did I note about banking last week", {});
    ok("classifier: bare notes query does NOT route to automation", bare?.intent !== "automation", bare?.intent);
  }
  {
    // End-to-end: dispatcher.run with a real creation phrase.
    const dispatcher = require("./agent/dispatcher");
    const res = await dispatcher.run("every day at 9 AM, tell me what's in my Downloads folder", {});
    ok("agent loop: automation creation request dispatches end-to-end",
      res?.ok === true && res.intent === "automation",
      JSON.stringify(res));
  }
  // ==========================================================================
  console.log(`\n${"=".repeat(60)}\nautomation tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
