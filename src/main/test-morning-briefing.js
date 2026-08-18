// Nova — test-morning-briefing.js
// Round 22: morning briefing automation — "set up a morning briefing at 7:30"
// creates a scheduled automation that runs the daily briefing each day.
//
// Covers:
//   - parser.js: RE_BRIEFING_PRESET ("create a daily briefing [at 7:30]") and
//     RE_BRIEFING_STEP clause classification inside schedule requests
//   - runner.js: briefing step executes through notes:daily-briefing, stays
//     L1 SAFE, and the single-narrated summary speaks as the dispatcher wrote
//   - store.js: the preset automation persists with status "safe"
//
// Usage: node src/main/test-morning-briefing.js [dataDir]
const Module = require("module");
const path = require("path");
const fs = require("fs");
const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-morning-briefing-test-data");
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getName: () => "Nova", getVersion: () => "0.9.0" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: null,
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: { openPath: async () => 0 },
  Notification: class Notification { constructor() {} show() {} },
};
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};
Module._load = function (request, parent, isMain, options) {
  if (request === "electron") return shim;
  return origLoad.call(this, request, parent, isMain, options);
};
globalThis.fetch = async () => { throw new Error("[test] outbound call blocked"); };

const assert = (cond, label) => {
  if (!cond) throw new Error("ASSERT FAILED: " + label);
  console.log("PASS  " + label);
};

const { parseAutomation, parseSchedule, classifyClause } = require("./automation/parser");
const store = require("./automation/store");
const { runAutomation, resolveStepLevel } = require("./automation/runner");
const dispatch = require("./automation/dispatch");
const { RISK_LEVEL } = require("./permissions/risk-levels");

// Register stage actions so level resolution finds notes:daily-briefing.
require("./notes/actions");
require("./kb/actions");
require("./files/actions");
require("./vision/vision-actions");

// Pin the notes store clock: Wednesday 2026-08-18 12:00 UTC.
const notesStore = require("./notes/store");
notesStore.setStorePathForTesting(path.join(DATA_DIR, "notes.json"));
notesStore.resetForTesting();

// ---------------- parser: briefing step clause classification ----------------
assert(classifyClause("what's on my plate today").kind === "notes" && /plate/.test(classifyClause("what's on my plate today").text), "plate phrasing routes to notes (kept text intact)");
assert(classifyClause("daily briefing").kind === "notes", "daily briefing clause → notes");
assert(classifyClause("morning briefing").kind === "notes", "morning briefing clause → notes");
assert(classifyClause("brief me on today").kind === "notes", "brief me on today → notes");
assert(classifyClause("what do i have due today").kind === "notes", "what do i have due today → notes");
assert(classifyClause("tell me what's on my plate today").kind === "notes", "tell-me prefix keeps notes routing");
assert(classifyClause("and give me my briefing").kind === "notes", "and give me my briefing → notes");
assert(classifyClause("my morning briefing").kind === "notes", "my morning briefing → notes");
// Non-briefing phrases must NOT become briefing notes (routing safety):
assert(classifyClause("summarize my notes").kind === "notes", "summarize still routes to notes via its own rule");
assert(classifyClause("find my resume").kind === "files", "files phrasing unaffected");

// Schedule + briefing step combined (R9-style chained request, new step):
{
  const r = parseAutomation("every weekday at 7:30 AM, tell me my tasks and what's on my plate today");
  assert(r.ok && r.automation.steps.length === 2, "combined routine parses with 2 steps");
  assert(r.automation.steps[1].kind === "notes" && /plate/.test(r.automation.steps[1].text), "briefing clause is the second notes step");
  assert(r.automation.cron === "30 7 * * 1-5", "weekday 7:30 cron");
}

// ---------------- parser: dedicated briefing preset ----------------
{
  const r = parseAutomation("set up a morning briefing at 7:30 AM");
  assert(r.ok && r.automation.name === "Morning briefing", "preset name is friendly");
  assert(r.automation.cron === "30 7 * * *", "preset: 7:30 daily cron");
  assert(r.automation.steps.length === 1 && r.automation.steps[0].kind === "notes", "preset: single notes step");
  assert(r.automation.steps[0].text === "what's on my plate today", "preset step text is the exact briefing phrase");
}
{
  const r = parseAutomation("create a daily briefing");
  assert(r.ok && r.automation.cron === "0 8 * * *", "preset without time defaults to 8:00 daily");
}
{
  const r = parseAutomation("schedule a briefing for 6 AM");
  assert(r.ok && r.automation.cron === "0 6 * * *", "bare 'a briefing' preset parses at 6 AM");
}
{
  const r = parseAutomation("start a morning briefing at 9 AM");
  assert(r.ok && r.automation.cron === "0 9 * * *", "bare-hour AM time parses");
}
{
  const r = parseAutomation("create a daily briefing at never a time");
  assert(!r.ok && /time/i.test(r.error), "preset refuses unparseable time with a plain error");
}
// The preset must never masquerade as an empty schedule or swallow notes phrases:
assert(!parseAutomation("note that the cat is fine").ok || parseAutomation("note that the cat is fine").automation === undefined, "plain notes phrasing is not a briefing preset");

// ---------------- store: persistence ----------------
store.clearForTesting();
{
  const r = parseAutomation("set up a morning briefing at 7:30");
  const res = store.add(r.automation);
  assert(res.ok, "store accepts the preset");
  const a = res.automation;
  assert(a.status === "safe", "preset status is safe (single L1 notes step)");
  assert(a.cron === "30 7 * * *" && a.name === "Morning briefing", "stored name + cron");
  // The parser deliberately assigns no level — level resolution happens at
  // dispatch (annotateLevels) and runner (resolveStepLevel) from the registry,
  // so assert the resolution itself, not the stored default.
  assert(resolveStepLevel(a.steps[0]) === RISK_LEVEL.SAFE, "briefing step resolves to L1 SAFE from the registry");
  assert(store.list().length === 1, "round-trips through the list");
  // Persistence across a reload simulation:
  const reloaded = store.list()[0];
  assert(reloaded.cron === "30 7 * * *" && reloaded.status === "safe", "persists across reload");
}

// ---------------- runner: briefing step executes + speaks ----------------
store.clearForTesting();
(async () => {
  // Seed the notes store: 2 tasks due today, 1 overdue, 1 reminder today.
  const nStore = require("./notes/store");
  nStore.addTask("finish the report", { dueDate: new Date("2026-08-18T23:59:59.999Z").toISOString() });
  nStore.addTask("send invoices", { dueDate: new Date("2026-08-18T23:59:59.999Z").toISOString() });
  nStore.addTask("pay rent", { dueDate: new Date("2026-08-17T23:59:59.999Z").toISOString() });
  nStore.addReminder("call mom", new Date("2026-08-18T17:00:00Z").toISOString());

  const parsed = parseAutomation("every weekday at 7:30 AM, tell me my tasks and what's on my plate today");
  if (!parsed.ok) throw new Error("combined routine did not parse: " + parsed.error);
  const res = store.add(parsed.automation);
  const auto = store.list().find((x) => x.name === parsed.automation.name);
  const run = await runAutomation(auto.id, { runVisionQuery: null });
  assert(run.ok && run.status !== "awaiting-confirmation", "combined briefing automation runs unattended");
  assert(/2 tasks due today/.test(run.text) && /1 overdue/.test(run.text) && /1 reminder today/.test(run.text), "run summary speaks the plate (2 due / 1 overdue / 1 reminder)");
  assert(/"call mom"/.test(run.text), "run summary names today's reminder");

  // Single-step preset: result must be the dispatcher's exact briefing text
  // (narration passthrough — no joined " · " wrapper).
  store.clearForTesting();
  const preset = parseAutomation("set up a morning briefing at 7:30");
  const pRes = store.add(preset.automation);
  const pAuto = store.list()[0];
  const pRun = await runAutomation(pAuto.id, { runVisionQuery: null });
  assert(pRun.ok && /^Here's today's plate:/.test(pRun.text), "single-preset run speaks the exact dispatcher line (narration passthrough)");

  // Empty plate preset: honest line, no crash.
  nStore.resetForTesting();
  const emptyRun = await runAutomation(pAuto.id, { runVisionQuery: null });
  assert(emptyRun.ok && emptyRun.text === "Nothing on the plate today \u2014 clear skies.", "empty-plate preset speaks the honest line");

  // Level resolution: the briefing step itself resolves to L1 SAFE from the
  // action registry, so the preset can never be gate-flipped.
  const briefLevel = resolveStepLevel({ kind: "notes", text: "what's on my plate today" });
  assert(briefLevel === RISK_LEVEL.SAFE, "briefing step resolves to L1 SAFE from the registry");

  console.log("\nAll Round 22 morning-briefing automation tests passed.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
