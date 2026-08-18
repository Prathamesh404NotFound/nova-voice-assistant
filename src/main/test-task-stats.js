// Nova — test-task-stats.js
//
// Headless self-test for Round 14: task statistics ("how am I doing on my
// tasks"). Runs WITHOUT a real Electron runtime via the shared
// shim-electron.js file.
//
// Covers:
//   - planner routes stats phrasings → notes:task-stats; plain task chatter
//     is not swallowed
//   - notes:task-stats is registered Level 1 (SAFE) with simulate()
//   - setTaskDone records completedAt on the done flip (and clears it on
//     un-done) — the stats engine's only history source
//   - completion rate, weekly window, and the streak day-by-day against a
//     crafted multi-day history
//   - empty store → honest zero stats, no division errors
//   - pre-round tasks (no completedAt) do not inflate the streak or week
//
// Usage: node src/main/test-task-stats.js [dataDir]
const Module = require("module");
const path = require("path");
const fs = require("fs");

const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-task-stats-test-data");
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

const store = require("./notes/store");
require("./notes/actions");

// Surgery hook: force the store to reload from disk (used by tests that
// rewrite the on-disk JSON directly, e.g. backdating a completedAt).
// resetForTesting wipes memory AND deletes the file, so this writes the
// mutated snapshot back first, resets, then re-writes so a fresh module
// instance can load it.
function reloadedStore() {
  const data = store.all();
  store.setStorePathForTesting(store.filePath()); // reset memory+flag, file untouched
  fs.writeFileSync(store.filePath(), JSON.stringify(data));
  return store;
}

// store.all() returns DISCONNECTED copies — mutating them never touches the
// in-memory data or the file. Use this helper to persist a mutated snapshot:
// mutate the snapshot, then persistAndReload() writes it to disk and forces a
// reload so the next stats call sees the change.
function persistAndReload(snapshot) {
  fs.writeFileSync(store.filePath(), JSON.stringify(snapshot));
  store.setStorePathForTesting(store.filePath());
}
const plan = require("./notes/plan");
const dispatch = require("./notes/dispatch");
const registry = require("./permissions/action-registry");
const { RISK_LEVEL } = require("./permissions/risk-levels");

store.setStorePathForTesting(path.join(DATA_DIR, "nova-notes.json"));
store.resetForTesting();

let passCount = 0, failCount = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ok   ${label}`); passCount += 1; }
  else { console.log(`  FAIL ${label}`); failCount += 1; }
}

const dayKey = (d) => d.toISOString().slice(0, 10);

function resetState() {
  store.resetForTesting();
}

(async function main() {
  console.log("Task-stats tests");

  // --- Planning -----------------------------------------------------------
  const statsPhrasings = [
    "task stats", "task statistics", "how am I doing on my tasks",
    "my task completion rate", "task completion rate",
    "how is my task progress", "how many tasks have i done",
  ];
  for (const phrase of statsPhrasings) {
    const p = plan.planNoteAction(phrase);
    assert(p && p.actionId === "notes:task-stats" && !p.error, `planner routes "${phrase}" → notes:task-stats`);
  }
  // Regression: the task LIST phrasing stays list-tasks, and notes keep theirs.
  const list = plan.planNoteAction("what's on my task list");
  assert(list && list.actionId === "notes:list-tasks", "\"what's on my task list\" stays notes:list-tasks");
  const note = plan.planNoteAction("note that I have a dentist appointment Friday");
  assert(note && note.actionId === "notes:add-note", "plain 'note that …' stays notes:add-note");

  // --- Registration -------------------------------------------------------
  const action = registry.getAction("notes:task-stats");
  assert(!!action, "notes:task-stats is registered");
  assert(action.level === RISK_LEVEL.SAFE, "notes:task-stats is Level 1 (SAFE) — local read only");
  const dry = await action.simulate({});
  assert(dry && /locally/.test(dry.summary), "simulate() describes the local-only read");

  // --- CompletedAt tracking -----------------------------------------------
  resetState();
  const t1 = store.addTask("buy milk");
  const doneTask = store.setTaskDone(t1.id, true);
  assert(doneTask && doneTask.done && doneTask.completedAt, "marking done records completedAt");
  const undone = store.setTaskDone(t1.id, false);
  assert(undone && !undone.completedAt, "un-marking clears completedAt");
  const redone = store.setTaskDone(t1.id, true);
  assert(redone && redone.completedAt, "re-marking records a fresh completedAt");

  // --- Empty store --------------------------------------------------------
  resetState();
  let s = store.taskStats();
  assert(s.completionRate === 0 && s.totalTasks === 0 && s.currentStreakDays === 0,
    "empty store → zero stats, no division errors");
  const r0 = await dispatch.runNoteAction("task stats");
  // NOTE: this must run BEFORE any tasks are added in later blocks.
  assert(r0.ok && /No tasks yet/.test(r0.text), "empty store → honest zero answer in chat");

  // --- Rate + week window --------------------------------------------------
  resetState();
  store.addTask("a"); store.addTask("b"); store.addTask("c"); store.addTask("d");
  store.setTaskDone(store.all().tasks[0].id, true);
  store.setTaskDone(store.all().tasks[1].id, true);
  s = store.taskStats();
  assert(s.totalTasks === 4 && s.done === 2 && s.pending === 2 && s.completionRate === 50,
    "completion rate: 2/4 → 50%");
  assert(s.weekCompletions === 2, "this week sees the 2 fresh completions");

  // A completion backdated beyond the 7-day window must NOT count for the
  // week — fake it directly in the store data.
  const tBack = store.addTask("backdated");
  store.setTaskDone(tBack.id, true);
  // store.all() returns stripped copies; persist the mutation by rewriting
  // the on-disk JSON and forcing a reload.
  const snap = store.all();
  const backItem = snap.tasks.find((t) => t.id === tBack.id);
  backItem.completedAt = new Date(Date.now() - 10 * 86_400_000).toISOString(); // 10 days ago
  persistAndReload(snap);
  s = store.taskStats();
  assert(s.weekCompletions === 2, "backdated (10-day-old) completion does NOT inflate the week");

  // --- Streak: today + yesterday both done → 2-day streak ------------------
  resetState();
  const today = store.addTask("today task");
  store.setTaskDone(today.id, true);
  const yesterdayTask = store.addTask("yesterday task");
  store.setTaskDone(yesterdayTask.id, true);
  const yDay = new Date(Date.now() - 86_400_000).toISOString();
  const snap2 = store.all();
  snap2.tasks.find((t) => t.id === yesterdayTask.id).completedAt = yDay;
  persistAndReload(snap2);
  s = store.taskStats();
  assert(s.currentStreakDays >= 2, `today+yesterday done → streak ≥ 2 (got ${s.currentStreakDays})`);

  // --- Streak break: gap of 2 days ----------------------------------------
  resetState();
  const old = store.addTask("old task");
  store.setTaskDone(old.id, true);
  const snap3 = store.all();
  snap3.tasks.find((t) => t.id === old.id).completedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  persistAndReload(snap3);
  s = store.taskStats();
  assert(s.currentStreakDays === 0, "gap of 3 days with nothing since → streak 0");

  // --- Pre-round tasks (nil completedAt) -----------------------------------
  resetState();
  const pre = store.addTask("legacy");
  // Legacy done: set done=true without completedAt (simulating an old record).
  store.setTaskDone(pre.id, true);
  const snap4 = store.all();
  snap4.tasks.find((t) => t.id === pre.id).completedAt = null;
  persistAndReload(snap4);
  s = store.taskStats();
  assert(s.completionRate === 100 && s.weekCompletions === 0 && s.currentStreakDays === 0,
    "legacy done-task (nil completedAt) counts for rate but NOT for week/streak");

  console.log(`\n${passCount} task-stats test(s) passed, ${failCount} failed`);
  if (failCount > 0) process.exitCode = 1;
})().catch((err) => {
  console.error("UNCAUGHT:", err?.message || err);
  process.exitCode = 1;
});
