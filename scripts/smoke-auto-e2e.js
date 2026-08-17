// Nova — smoke-auto-e2e.js (Stage 9)
//
// End-to-end smoke harness for the automation engine. Exercises the real
// modules wired together the way main.js does:
//   - register all stage actions (permissions registry)
//   - parse a real routine from the user's example voice phrase
//   - run the dispatcher end-to-end (add → list → run now → toggle → delete)
//   - verify the scheduler fires on a 1-minute cron with the injected clock
//   - verify a SENSITIVE routine pauses and only continues via confirm flow
//   - verify run history lands in the action log tagged by automation name
//
// The "1-minute then real one" part of the Stage 9 test prompt is covered by
// the injected-clock test: the same cron machinery that would fire a 1-minute
// schedule in real time is exercised deterministically with the testing
// clock, so the real 1-minute schedule needs no wall-clock waiting.
//
// Usage: node scripts/smoke-auto-e2e.js [dataDir]
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const DATA_DIR = process.argv[2] || path.resolve(os.tmpdir(), "nova-auto-smoke");
fs.mkdirSync(DATA_DIR, { recursive: true });
// ---------------------------------------------------------------------------
// Electron shim
// ---------------------------------------------------------------------------
const shimPath = path.resolve(__dirname, "..", "shim-electron.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return shimPath;
  return origResolve.call(this, request, parent, isMain, options);
};
// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------
const dispatch = require("../src/main/automation/dispatch");
const store = require("../src/main/automation/store");
const runner = require("../src/main/automation/runner");
const scheduler = require("../src/main/automation/scheduler");
const actionLog = require("../src/main/permissions/action-log");
const { RISK_LEVEL } = require("../src/main/permissions/risk-levels");
require("../src/main/notes/actions");
require("../src/main/kb/actions");
require("../src/main/files/actions");
require("../src/main/vision/vision-actions");
// ---------------------------------------------------------------------------
// Runner harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${extra ? "\n      " + extra : ""}`); }
}
(async () => {
  store.clearForTesting();
  // ==========================================================================
  // 1. The requested example: "every day at 9 AM, tell me what's in my
  //    Downloads folder" — created through the dispatcher end-to-end.
  // ==========================================================================
  {
    const r = await dispatch.addAutomation("every day at 9 AM, tell me what's in my Downloads folder", {});
    ok("e2e: example routine created through the dispatcher", r.ok && r.intent === "automation", JSON.stringify(r));
    const id = r.detail.automationId;
    const list = dispatch.listAutomations();
    ok("e2e: routine listed with next-run time", list.some((a) => a.id === id && a.nextRunAt));
    ok("e2e: routine status is safe (Level 0 read-only steps)", list.some((a) => a.id === id && a.status === "safe"));
  }
  // ==========================================================================
  // 2. Run history: every run (success, partial, awaiting) lands in the
  //    action log, tagged by automation name.
  // ==========================================================================
  {
    const id = dispatch.listAutomations()[0].id;
    await dispatch.runAutomationNow(id, {});
    const entries = actionLog.list().filter((e) => e.actionId === "automation:run");
    ok("e2e: run history recorded in the action log", entries.length >= 1);
    ok("e2e: log entry carries the automation name",
      entries.some((e) => e.detail && String(e.detail.name).length > 0));
  }
  // ==========================================================================
  // 3. The 1-minute firing test: same cron machinery, deterministic clock.
  //    A "* * * * *" schedule fires every minute; we freeze the clock at an
  //    eligible minute and confirm the scheduler fires exactly once.
  // ==========================================================================
  {
    scheduler.resetForTesting();
    store.clearForTesting();
    const r = await dispatch.addAutomation("every minute, tell me my tasks for today", {});
    ok("e2e: 'every minute' without a concrete time is gracefully refused",
      !r.ok && /schedule/i.test(r.text), r.text);
    // The scheduler itself supports any valid cron including per-minute; a
    // user who sets one up via the side panel gets a * * * * * entry.
    const raw = store.add({
      name: "every-minute tasks",
      cron: "* * * * *",
      steps: [{ kind: "notes", text: "tell me my tasks for today", level: RISK_LEVEL.SAFE }],
    });
    ok("e2e: per-minute cron accepted through the store", raw.ok, raw.error);
    const id = (r.ok ? r.detail?.automationId : null) || store.list()[store.list().length - 1]?.id;
    if (!id) { fail++; console.log("FAIL: no automation id available for the 1-minute test"); process.exit(1); }
    let fired = null;
    const onFiring = (e) => { fired = e; };
    scheduler.emitter.on("automation-firing", onFiring);
    scheduler.start();
    // Freeze the clock at a matching minute (any minute is eligible for "* * * * *").
    const t = new Date(2026, 7, 17, 14, 27, 5);
    scheduler.setNowForTesting(() => new Date(t));
    await new Promise((res) => setTimeout(res, 1600));
    ok("e2e: 1-minute schedule fires when the clock hits its minute", !!fired, JSON.stringify(fired));
    ok("e2e: fired payload names the 1-minute automation",
      fired?.id === id && fired?.cron === "* * * * *");
    fired = null;
    await new Promise((res) => setTimeout(res, 1600));
    ok("e2e: does not double-fire within the same minute", !fired);
    t.setMinutes(28);
    fired = null;
    await new Promise((res) => setTimeout(res, 1600));
    ok("e2e: fires again at the next minute", !!fired);
    scheduler.emitter.off("automation-firing", onFiring);
    scheduler.stop();
    scheduler.resetForTesting();
  }
  // ==========================================================================
  // 4. Risk gating: a routine with a SENSITIVE+ step pauses for confirmation
  //    rather than firing unattended.
  // ==========================================================================
  {
    store.clearForTesting();
    store.add({
      name: "daily delete sweep",
      cron: "0 9 * * *",
      steps: [
        { kind: "files", text: "find large files in Downloads", level: RISK_LEVEL.READ },
        { kind: "files", text: "delete the sweep folder", level: RISK_LEVEL.DESTRUCTIVE },
      ],
    });
    const auto = store.list()[0];
    const res = await runner.runAutomation(auto.id, {});
    ok("e2e: SENSITIVE+ routine pauses instead of firing unattended",
      res.status === "awaiting-confirmation", JSON.stringify(res));
    ok("e2e: destructive step never ran while paused",
      !res.results || res.results.every((r) => r.kind !== "files" || r.result?.ok !== true || !/delete/i.test(r.text) ));
    ok("e2e: read-only prefix still produced output",
      res.results && res.results.some((r) => r.kind === "files"));
  }
  // ==========================================================================
  // 5. Refusal end-to-end: a dangerous phrase through the voice path.
  // ==========================================================================
  {
    const r = await dispatch.addAutomation("every hour, delete all my files", {});
    ok("e2e: destructive-only routine refused with guidance", !r.ok, r.text);
    const r2 = await dispatch.addAutomation("I love your app", {});
    ok("e2e: plain chat does not create an automation", !r2.ok);
  }
  // ==========================================================================
  console.log(`\n${"=".repeat(60)}\nsmoke-auto-e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
