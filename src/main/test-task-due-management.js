// Nova — test-task-due-management.js
// Round 18: task due-date lifecycle.
//   - plan.js: set-due verb / clear / implicit forms (needs ctx.tasks)
//   - store.js: setTaskDue persistence, clear, NaN-guard
//   - actions.js: notes:set-task-due is L2 with simulate + reverse
//   - dispatch.js: spoken text for set/clear and completion celebration
//   - boot-nudge.js: overdue payload, fires once per boot
//
// Runs WITHOUT a real Electron runtime via the shared shim-electron.js file.
// Usage: node src/main/test-task-due-management.js [dataDir]

const Module = require("module");
const path = require("path");
const fs = require("fs");
const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-task-due-management-test-data");
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
require("./notes/actions"); // register notes:* actions
const dispatch = require("./notes/dispatch");
const bootNudge = require("./notes/boot-nudge");

// Pin the clock to a known Wednesday noon (UTC).
plan.setNowForTesting(new Date("2026-08-18T12:00:00Z"));
store.setStorePathForTesting(path.join(DATA_DIR, "notes.json"));

const registry = require("./permissions/action-registry");
const { RISK_LEVEL } = require("./permissions/risk-levels");

// Seed a couple of pending tasks.
const a = store.addTask("finish report", { dueDate: new Date("2026-08-17T23:59:59.999Z").toISOString() }); // overdue
const b = store.addTask("buy milk", {});
const ctx = () => ({ tasks: store.all().tasks, notes: [], reminders: [] });

// ---------------- planner routing ----------------
const r1 = plan.planNoteAction("change the due date for finish report to next monday", ctx());
assert(r1.actionId === "notes:set-task-due" && r1.payload.id === a.id && r1.payload.dueDate.startsWith("2026-08-24T23:59"), "change-verb → Monday EOD");

const r2 = plan.planNoteAction("remove the due date for buy milk", ctx());
assert(r2.actionId === "notes:set-task-due" && r2.payload.id === b.id && r2.payload.dueDate === null, "clear-verb → null due");

const r3 = plan.planNoteAction("finish report is now due by friday", ctx());
assert(r3.actionId === "notes:set-task-due" && r3.payload.id === a.id && r3.payload.dueDate.startsWith("2026-08-21T23:59"), "implicit-set → Friday EOD");

const r4 = plan.planNoteAction("buy milk dropped its due date", ctx());
assert(r4.actionId === "notes:set-task-due" && r4.payload.dueDate === null, "implicit-clear → null");

const r5 = plan.planNoteAction("mark buy milk done", ctx());
assert(r5.actionId === "notes:complete-task", "mark-done untouched by the new rules");

const r6 = plan.planNoteAction("task stats", ctx());
assert(r6.actionId === "notes:task-stats", "task stats untouched");

const r7 = plan.planNoteAction("add take out trash to my tasks by sunday", ctx());
assert(r7.actionId === "notes:add-task" && r7.payload.dueDate && r7.payload.dueDate.startsWith("2026-08-23T23:59"), "R17 add with due clause still works");

const r8 = plan.planNoteAction("change the due date for unicorn to tomorrow", ctx());
assert(r8.error && /could not find/.test(r8.error), "unknown task → honest error");

const r9 = plan.planNoteAction("change the due date for finish report to banana", ctx());
assert(r9.error && /could not parse/.test(r9.error), "garbage due expr → parse error");

const r10 = plan.planNoteAction("change the due date for finish report to tomorrow", { tasks: [] });
assert(r10.error && /empty/.test(r10.error), "empty store → honest error");

// Done tasks cannot be rescheduled by voice:
store.setTaskDone(b.id, true);
const r11 = plan.planNoteAction("change the due date for buy milk to tomorrow", ctx());
assert(r11.error && /could not find/.test(r11.error), "done task excluded from rescheduling");
store.setTaskDone(b.id, false);

// ---------------- store setTaskDue ----------------
const updated = store.setTaskDue(a.id, new Date("2026-08-25T23:59:59.999Z").toISOString());
assert(updated && updated.dueDate.startsWith("2026-08-25T23:59"), "setTaskDue persists new due date");
const cleared = store.setTaskDue(a.id, null);
assert(cleared && !cleared.dueDate, "setTaskDue(null) removes the due date");
const garbage = store.setTaskDue(a.id, "not-a-date");
assert(garbage && !garbage.dueDate, "setTaskDue with garbage leaves no dueDate");
const reSet = store.setTaskDue(a.id, new Date("2026-08-17T23:59:59.999Z").toISOString());
assert(reSet && reSet.dueDate, "due date set back to the overdue date for later tests");
assert(!store.setTaskDue("nonexistent-id", "2026-08-25T23:59:59.999Z"), "unknown id → null");

// ---------------- action registration ----------------
const act = registry.getAction("notes:set-task-due");
assert(act && act.level === RISK_LEVEL.REVERSIBLE, "registered at L2 (REVERSIBLE)");
assert(typeof act.simulate === "function" && typeof act.reverse === "function", "has simulate() and reverse()");

// ---------------- async checks: registration, dispatcher, boot nudge ----
(async () => {
  const sim = await act.simulate({ id: a.id, text: "finish report", dueDate: new Date("2026-08-25T23:59:59.999Z").toISOString(), oldDueDate: reSet.dueDate });
  assert(/move the due date.*from .* to /.test(sim.title), "simulate() describes the move in plain language");
  const simClear = await act.simulate({ id: a.id, text: "finish report", dueDate: null, oldDueDate: reSet.dueDate });
  assert(/remove the due date/.test(simClear.title), "simulate() for clearing mentions removal");
  // reverse restores the old due date:
  await act.execute({ id: a.id, text: "finish report", dueDate: new Date("2026-08-25T23:59:59.999Z").toISOString(), oldDueDate: reSet.dueDate });
  const restored = await act.reverse({ id: a.id, text: "finish report", oldDueDate: reSet.dueDate });
  assert(restored.undone && store.all().tasks.find((t) => t.id === a.id).dueDate === reSet.dueDate, "reverse() restores the old due date");

  const set = await dispatch.runNoteAction("change the due date for finish report to friday");
  assert(set.text && /now due/.test(set.text) && /Fri/.test(set.text), "dispatcher confirms the new due date");

  const clear = await dispatch.runNoteAction("remove the due date for finish report");
  assert(clear.text && /Removed the due date/.test(clear.text), "dispatcher confirms due-date removal");

  // The nudge needs an overdue pending task — restore it after the clear test.
  const fr = store.all().tasks.find((t) => t.text === "finish report");
  store.setTaskDue(fr.id, new Date("2026-08-17T23:59:59.999Z").toISOString());
  assert(store.all().tasks.find((t) => t.id === fr.id).dueDate, "due date restored for the nudge test");

  // ---------------- boot nudge (inside the async wrapper — top-level
  // await in Node 22 would flip this file into ESM mode) ----------------
  // "finish report" is still pending + overdue (due Aug 17, not yet marked
  // done) when the nudge timer fires — mark it done AFTER confirming the
  // nudge so the celebration test doesn't clear the overdue list.
  const fakeWindow = { isDestroyed: () => false, webContents: { send: (ch, data) => { fakeWindow._events.push([ch, data]); } }, _events: [] };
  bootNudge.resetForTesting();
  bootNudge.start(fakeWindow);
  await new Promise((r) => setTimeout(r, 3500));
  assert(fakeWindow._events.length === 1 && fakeWindow._events[0][0] === "nova:task-due-nudge", "nudge event sent exactly once");
  const payload = fakeWindow._events[0][1];
  assert(payload.count >= 1 && payload.text.includes("overdue"), "nudge payload names the overdue count");
  assert(payload.text.includes("finish report"), "nudge payload names the overdue task");
  // Second start in the same boot must NOT fire again:
  bootNudge.start(fakeWindow);
  await new Promise((r) => setTimeout(r, 3500));
  assert(fakeWindow._events.length === 1, "nudge fires only once per boot");

  // Restoration for the celebration test: put it back due today.
  store.setTaskDue(
    store.all().tasks.find((t) => t.text === "finish report").id,
    new Date("2026-08-18T23:59:59.999Z").toISOString(),
  );
  const done = await dispatch.runNoteAction("mark finish report done");
  assert(done.text && /done\./.test(done.text) && /right on time/.test(done.text), "completion of a due-today task celebrates");
})();

console.log("\nAll Round 18 task due-management tests passed.");
