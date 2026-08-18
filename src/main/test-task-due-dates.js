// Nova — test-task-due-dates.js
// Round 17: task due dates.
//   - plan.js: parseDueDate + DUE_CLAUSE strip-before-RE_TASK_ADD logic
//   - store.js: addTask({ dueDate }) persistence, taskStats dueThisWeek/overdue
//   - actions.js: payload.dueDate flows into the store
//   - dispatch.js: spoken text mentions overdue / due-this-week counts
//
// Runs WITHOUT a real Electron runtime via the shared shim-electron.js file.
// Usage: node src/main/test-task-due-dates.js [dataDir]

const Module = require("module");
const path = require("path");
const fs = require("fs");
const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-task-due-dates-test-data");
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

// Pin the clock to a known Wednesday noon (UTC).
plan.setNowForTesting(new Date("2026-08-18T12:00:00Z"));
store.setStorePathForTesting(path.join(DATA_DIR, "notes.json"));

// ---------------- parseDueDate math ----------------
const iso = (d) => d.toISOString();
assert(iso(plan.parseDueDate("in 3 days")).startsWith("2026-08-21T00"), "in 3 days → Aug 21 start-of-day");
assert(iso(plan.parseDueDate("in 2 weeks")).startsWith("2026-09-01T00"), "in 2 weeks → Sep 1");
assert(iso(plan.parseDueDate("tomorrow")).startsWith("2026-08-19T23:59"), "tomorrow → Aug 19 EOD");
assert(iso(plan.parseDueDate("today")).startsWith("2026-08-18T23:59"), "today → today EOD");
assert(iso(plan.parseDueDate("end of day")).startsWith("2026-08-18T23:59"), "end of day → EOD");
assert(iso(plan.parseDueDate("by friday")).startsWith("2026-08-21T23:59"), "by friday → Aug 21 EOD");
assert(iso(plan.parseDueDate("next monday")).startsWith("2026-08-24T23:59"), "next monday → Aug 24 EOD (strictly future)");
assert(plan.parseDueDate("in 3 hours") === null, "hour durations are reminder times, not due dates");
assert(plan.parseDueDate("garbage") === null, "nonsense returns null");
assert(plan.parseDueDate(null) === null, "null returns null");
assert(plan.parseDueDate("") === null, "empty returns null");

// ---------------- planner routing ----------------
const r1 = plan.planNoteAction("add finish the report to my tasks by friday");
assert(r1.actionId === "notes:add-task" && r1.payload.text === "finish the report", "add-task with due clause strips text");
assert(r1.payload.dueDate && r1.payload.dueDate.startsWith("2026-08-21T23:59"), "planner due date Friday EOD");

const r2 = plan.planNoteAction("task fix bug due in 3 days");
assert(r2.actionId === "notes:add-task" && r2.payload.text === "fix bug", "task: with due clause");
assert(r2.payload.dueDate && r2.payload.dueDate.startsWith("2026-08-21T00"), "task: due in 3 days");

const r3 = plan.planNoteAction("add buy milk to my tasks");
assert(r3.actionId === "notes:add-task" && !r3.payload.dueDate, "add-task without due stays dateless");

const r4 = plan.planNoteAction("add book flight for the trip by friday");
assert(r4.error, "add X by Y without 'to my tasks' → honest guidance error");

const r5 = plan.planNoteAction("add finish the report to my tasks by tuesday and then eat lunch");
assert(r5 === null, "due clause mid-sentence is not split (no false due date)");

const r6 = plan.planNoteAction("by friday");
assert(r6 === null, "bare due clause is not a task");

// ---------------- store persistence ----------------
const a = store.addTask("finish report", { dueDate: new Date("2026-08-21T23:59:59.999Z").toISOString() });
assert(a.dueDate && a.dueDate.startsWith("2026-08-21"), "store persists dueDate");
const b = store.addTask("buy milk", {});
assert(!b.dueDate, "task without dueDate has no dueDate field");
const c = store.addTask("submit invoice", { dueDate: "not-a-date" });
assert(!c.dueDate, "invalid dueDate is ignored (no garbage stored)");
const found = store.all().tasks.find((t) => t.text === "finish report");
assert(found && found.dueDate === a.dueDate, "dueDate round-trips through all()");

// ---------------- taskStats due view ----------------
const d = store.addTask("overdue thing", { dueDate: new Date("2026-08-10T23:59:59.999Z").toISOString() });
const e = store.addTask("due tomorrow", { dueDate: new Date("2026-08-19T23:59:59.999Z").toISOString() });
const s = store.taskStats();
assert(s.overdue === 1, "overdue count = 1 (Aug 10 due, pinned to Aug 18)");
assert(s.dueThisWeek >= 2, "dueThisWeek ≥ 2 (friday + tomorrow inside 7d window)");
// Marking done removes the task from the due view.
store.setTaskDone(d.id, true);
assert(store.taskStats().overdue === 0, "done tasks drop out of the overdue count");
store.setTaskDone(d.id, false);

// ---------------- dispatcher text ----------------
(async () => {
  const res = await dispatch.runNoteAction("task stats");
  const txt = (res.detail?.text || res.text || "").toLowerCase();
  assert(txt.includes("overdue"), "dispatcher mentions overdue");
  assert(txt.includes("due this week") || txt.includes("nothing is overdue"), "dispatcher mentions due-this-week state");
  console.log("\nAll Round 17 task due-date tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
