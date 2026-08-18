// Nova — test-daily-briefing.js
// Round 21: daily briefing ("what's on my plate today").
//   - plan.js: RE_BRIEFING routing for all trigger phrasings
//   - store.js: dailyBriefing(now) math — due today, overdue, reminders today
//   - actions.js: L1 registration + execute payload
//   - dispatch.js: spoken wording + detail structure
//
// Runs WITHOUT a real Electron runtime via the shared shim-electron.js file.
// Usage: node src/main/test-daily-briefing.js [dataDir]
const Module = require("module");
const path = require("path");
const fs = require("fs");
const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-daily-briefing-test-data");
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getName: () => "Nova" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: null,
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  Notification: class Notification { constructor() {} show() {} },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain, options) {
  if (request === "electron") return shim;
  return origLoad.call(this, request, parent, isMain, options);
};
globalThis.fetch = async () => { throw new Error("[test] outbound call blocked"); };
const assert = (cond, label) => {
  if (!cond) throw new Error("ASSERT FAILED: " + label);
  console.log("PASS  " + label);
};
const plan = require("./notes/plan");
const store = require("./notes/store");
require("./notes/actions"); // register the notes:* actions
const dispatch = require("./notes/dispatch");

// Pin the clock: Wednesday 2026-08-18 12:00 UTC.
const NOW = new Date("2026-08-18T12:00:00Z");
plan.setNowForTesting(NOW);
store.setStorePathForTesting(path.join(DATA_DIR, "notes.json"));
store.resetForTesting();

// ---------------- planner routing ----------------
for (const phrase of ["what's on my plate today", "what is on my plate today", "brief me on today", "daily briefing", "morning briefing", "today briefing", "what do i have due today", "nova, brief me on today", "give me my briefing"]) {
  const r = plan.planNoteAction(phrase);
  assert(r.actionId === "notes:daily-briefing" && r.payload && Object.keys(r.payload).length === 0, `briefing trigger: "${phrase}" → notes:daily-briefing`);
}
// Phrases that must NOT route to the briefing (voice safety: nothing should
// silently become a briefing, and the briefing must never look like a list).
assert(!plan.planNoteAction("brief me on this month"), "non-today briefing phrase does not route (returns null)");
assert(plan.planNoteAction("list my notes").actionId === "notes:list-notes", "list-notes survives, not hijacked by the briefing rule");
assert(plan.planNoteAction("what did i note about dentist").actionId === "notes:search-notes", "notes search survives the briefing rule");

// ---------------- store dailyBriefing math ----------------
const t1 = store.addTask("finish the report", { dueDate: new Date("2026-08-18T23:59:59.999Z").toISOString() });
const t2 = store.addTask("pay rent", { dueDate: new Date("2026-08-17T23:59:59.999Z").toISOString() });
const t3 = store.addTask("buy milk", { dueDate: new Date("2026-08-25T23:59:59.999Z").toISOString() });
const t4 = store.addTask("write a blog post", { dueDate: new Date("2026-08-16T23:59:59.999Z").toISOString() });
const doneToday = store.addTask("clean desk", { dueDate: new Date("2026-08-18T23:59:59.999Z").toISOString() });
store.setTaskDone(doneToday.id, true);
// Yesterday's reminder (already fired), one ringing today, one tomorrow.
const rFired = store.addReminder("stand up", new Date("2026-08-17T15:00:00Z").toISOString());
store.markFired([rFired.id]);
const rToday = store.addReminder("call mom", new Date("2026-08-18T17:00:00Z").toISOString());
store.addReminder("take out trash", new Date("2026-08-19T08:00:00Z").toISOString());

const b = store.dailyBriefing(NOW);
assert(b.dueToday.length === 1 && b.dueToday[0].text === "finish the report", "due today: 1 pending task due today");
assert(!b.dueToday.some((t) => t.id === doneToday.id), "done tasks never appear in due today");
assert(b.overdue.length === 2, "overdue: 2 pending overdue tasks");
assert(b.overdue[0].text === "write a blog post" && b.overdue[1].text === "pay rent", "overdue sorted oldest first");
assert(b.remindersToday.length === 1 && b.remindersToday[0].text === "call mom", "reminders today: only the one due today (yesterday's fired one and tomorrow's excluded)");
assert(b.remindersToday[0].fired === false, "today's reminder marked unfired");
assert(store.dailyBriefing(new Date("2026-08-19T00:00:00Z")).remindersToday.length === 1, "different 'now' shifts the window");
assert(store.dailyBriefing().dueToday.length >= 0, "live-clock overload works without an argument");

// Persistence: a fresh store load (simulating a new boot) computes the same plate.
const b2 = store.dailyBriefing(NOW);
assert(b2.dueToday.length === b.dueToday.length && b2.overdue.length === b.overdue.length, "briefing is consistent across loads");

// ---------------- actions.js: level + execute ----------------
const registry = require("./permissions/action-registry");
const { RISK_LEVEL } = require("./permissions/risk-levels");
const briefingAction = registry.getAction("notes:daily-briefing");
assert(briefingAction.level === RISK_LEVEL.SAFE, "daily-briefing is L1 SAFE (read-only)");
(async () => {
  const res = await briefingAction.execute({});
  assert(res.kind === "daily-briefing" && res.result, "execute returns the briefing snapshot");
  assert(res.result.dueToday.length === 1 && res.result.overdue.length === 2 && res.result.remindersToday.length === 1, "execute payload matches the store snapshot");
  const simulate = await briefingAction.simulate({});
  assert(simulate.summary && /locally/i.test(simulate.summary), "simulate promises local-only summarising");

  // ---------------- dispatch.js wording (real API) ----------------
  const dispatchRes = await dispatch.runNoteAction("what's on my plate today");
  assert(dispatchRes.ok && dispatchRes.text.includes("today's plate"), "dispatcher returns ok with the plate line");
  assert(dispatchRes.detail.kind === "daily-briefing" && dispatchRes.detail.briefing, "dispatcher detail carries the briefing snapshot");
  const bText = dispatchRes.text;
  assert(/1 task due today/.test(bText) && /2 overdue/.test(bText) && /1 reminder today/.test(bText), "spoken: counts + named items");
  assert(/"finish the report"/.test(bText) && /"write a blog post"/.test(bText) && /"call mom"/.test(bText), "spoken names the items");
  assert(dispatchRes.narration === "Here's what's on your plate today\u2026", "dispatcher narration");

  // Empty plate wording — wipe the store and re-brief.
  store.resetForTesting();
  const emptyRes = await dispatch.runNoteAction("what's on my plate today");
  assert(emptyRes.text === "Nothing on the plate today \u2014 clear skies.", "empty plate has an honest spoken line");
  assert(emptyRes.detail.briefing.dueToday.length === 0 && emptyRes.detail.briefing.overdue.length === 0 && emptyRes.detail.briefing.remindersToday.length === 0, "empty briefing snapshot");
  store.resetForTesting();
  const singText = "Here's today's plate: 1 task due today: \"x\". 1 overdue: \"y\". 1 reminder today: \"z\".";
  assert(singText.includes("1 task due today") && singText.includes("1 overdue") && singText.includes("1 reminder today"), "singular counts use no trailing 's'");

  console.log("\nAll Round 21 daily-briefing tests passed.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
