// Quick sanity sweep of Round 18 planner branches (NOT the full harness).
const path = require("path");
const fs = require("fs");
// Fake electron so store/plan deps load headlessly.
const shim = require("../shim-electron.js");
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain, options) {
  if (request === "electron") return shim;
  return origLoad.call(this, request, parent, isMain, options);
};
const DATA_DIR = path.resolve(__dirname, "..", ".nova-r18-plan-check");
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
const plan = require("../src/main/notes/plan");
plan.setNowForTesting(new Date("2026-08-18T12:00:00Z"));

const pass = (ok, label) => console.log((ok ? "PASS  " : "FAIL  ") + label);
const ctx = (tasks) => ({ tasks });
const tasks = [
  { id: "a", text: "finish report", done: false, dueDate: "2026-08-20T23:59:59.999Z" },
  { id: "b", text: "buy milk", done: false },
  { id: "c", text: "fix bug", done: false, dueDate: "2026-08-25T00:00:00Z" },
];

const cases = [
  ["change the due date for finish report to next monday", (r) => r.actionId === "notes:set-task-due" && r.payload.dueDate && r.payload.dueDate.startsWith("2026-08-24T23:59"), "change-verb → Monday EOD"],
  ["move the deadline for finish report to friday", (r) => r.actionId === "notes:set-task-due" && r.payload.dueDate.startsWith("2026-08-21T23:59"), "move-verb → Friday EOD"],
  ["reschedule finish report for next week", (r) => r.actionId === "notes:set-task-due" && r.payload.dueDate.startsWith("2026-08-25T00"), "reschedule-verb → Aug 25"],
  ["reschedule buy milk to tomorrow", (r) => r.actionId === "notes:set-task-due" && r.payload.dueDate.startsWith("2026-08-19T23:59"), "reschedule-short → tomorrow EOD"],
  ["push the due date for buy milk to tomorrow", (r) => r.actionId === "notes:set-task-due", "push-verb"],
  ["remove the due date for finish report", (r) => r.actionId === "notes:set-task-due" && r.payload.dueDate === null, "clear-verb → null due"],
  ["clear the deadline for buy milk", (r) => r.actionId === "notes:set-task-due" && r.payload.dueDate === null, "clear-verb2 → null"],
  ["finish report is now due by friday", (r) => r.actionId === "notes:set-task-due" && r.payload.dueDate.startsWith("2026-08-21T23:59"), "implicit-set → Friday EOD"],
  ["fix bug due next monday", (r) => r.actionId === "notes:set-task-due" && r.payload.dueDate.startsWith("2026-08-24T23:59"), "implicit-short → Monday EOD"],
  ["finish report is no longer due", (r) => r.actionId === "notes:set-task-due" && r.payload.dueDate === null, "implicit-clear → null"],
  ["finish report dropped its due date", (r) => r.actionId === "notes:set-task-due" && r.payload.dueDate === null, "implicit-clear2 → null"],
  ["mark finish report done", (r) => r.actionId === "notes:complete-task", "mark-done untouched"],
  ["what's on my task list", (r) => r.actionId === "notes:list-tasks", "list untouched"],
  ["add finish report to my tasks by friday", (r) => r.actionId === "notes:add-task", "R17 add untouched"],
  ["task stats", (r) => r.actionId === "notes:task-stats", "stats untouched"],
];
for (const [text, okFn, label] of cases) {
  const r = plan.planNoteAction(text, ctx(tasks));
  pass(r && okFn(r), label + " → " + (r ? (r.actionId || "error:" + r.error.slice(0, 50)) : "null"));
}
// Done tasks excluded from rescheduling:
const r2 = plan.planNoteAction("change the due date for finish report to tomorrow", ctx([
  { id: "a", text: "finish report", done: true, dueDate: "2026-08-20T23:59:59.999Z" },
]));
pass(r2 && r2.error && /could not find/i.test(r2.error), "done task excluded from rescheduling");
// Unmatched subject → error:
const r3 = plan.planNoteAction("change the due date for unicorn to tomorrow", ctx([
  { id: "a", text: "finish report", done: false },
]));
pass(r3 && r3.error && /could not find/.test(r3.error), "unknown subject → error");
// No ctx at all → error:
const r4 = plan.planNoteAction("change the due date for finish report to tomorrow", {});
pass(r4 && r4.error && /empty/.test(r4.error), "no ctx → honest error");
// Unparseable due expr → guidance error:
const r5 = plan.planNoteAction("change the due date for finish report to banana", ctx(tasks));
pass(r5 && r5.error && /could not parse/.test(r5.error), "garbage due expr → parse error");
// No store ctx → implicit form becomes an add (not an edit):
const r6 = plan.planNoteAction("fix bug due next monday", {});
pass(r6 && r6.actionId === "notes:add-task" && r6.payload.dueDate, "implicit set without store ctx → add-task with due");
console.log("\nRound 18 planner sweep complete.");
