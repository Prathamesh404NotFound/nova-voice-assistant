// Nova — notes/actions.js
//
// Registers every notes/reminders/tasks action through the existing
// permission framework. Levels per the spec:
//   L1 (SAFE)   — create/read: add-note, add-reminder, add-task, list-*, search-notes
//   L2 (REVERSIBLE) — edit/delete of existing items + summarize (L2 because it
//                     fires a one-off network call the user may cancel)
// Every L2 action has a reverse() fn so Nova's Undo button restores it.

const { registerAction } = require("../permissions/action-registry");
const { RISK_LEVEL } = require("../permissions/risk-levels");
const store = require("./store");

// ---------------------------------------------------------------------------
// L1 — safe, run immediately (still logged)
// ---------------------------------------------------------------------------

registerAction({
  id: "notes:add-note",
  level: RISK_LEVEL.SAFE,
  description: "Create a timestamped local note",
  simulate: async (p) => ({ summary: `would save the note "${(p.text || "").slice(0, 60)}" locally` }),
  execute: async (p) => {
    const note = store.addNote(p.text);
    return { note, kind: "note" };
  },
});

registerAction({
  id: "notes:add-reminder",
  level: RISK_LEVEL.SAFE,
  description: "Create a local timed reminder",
  simulate: async (p) => ({ summary: `would set a reminder "${(p.text || "").slice(0, 60)}" for ${p.dueAt ? new Date(p.dueAt).toLocaleString() : "now"}` }),
  execute: async (p) => {
    const reminder = store.addReminder(p.text, p.dueAt);
    return { reminder, kind: "reminder" };
  },
});

registerAction({
  id: "notes:add-task",
  level: RISK_LEVEL.SAFE,
  description: "Add an item to the local task list",
  simulate: async (p) => ({ summary: `would add "${(p.text || "").slice(0, 60)}" to your task list` }),
  execute: async (p) => {
    const task = store.addTask(p.text, { dueDate: p.dueDate || null });
    return { task, kind: "task" };
  },
});

registerAction({
  id: "notes:list-notes",
  level: RISK_LEVEL.SAFE,
  description: "List stored notes",
  execute: async () => ({ notes: store.all().notes, kind: "list" }),
});

registerAction({
  id: "notes:search-notes",
  level: RISK_LEVEL.SAFE,
  description: "Keyword search over stored notes",
  execute: async (p) => ({ matches: store.searchNotes(p.query), query: p.query, kind: "search" }),
});

registerAction({
  id: "notes:list-tasks",
  level: RISK_LEVEL.SAFE,
  description: "List stored tasks",
  execute: async () => ({ tasks: store.all().tasks, kind: "list" }),
});

registerAction({
  id: "notes:list-reminders",
  level: RISK_LEVEL.SAFE,
  description: "List stored reminders",
  execute: async () => ({ reminders: store.all().reminders, kind: "list" }),
});

// ---------------------------------------------------------------------------
// L2 — reversible, cancellable 5 s toast, reverse() for Undo
// ---------------------------------------------------------------------------

// Round 18: change or clear a task's due date. Edit of an existing item →
// L2 (REVERSIBLE): plain-language toast, 5 s cancel, reverse() restores the
// old due date (or re-adds a removed one) so the Undo button handles it.
registerAction({
  id: "notes:set-task-due",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Change or remove the due date of an existing task",
  simulate: async (p) => {
    const label = (p.dueDate ? `move the due date of "${(p.text || p.id || "").slice(0, 80)}" from ${(p.oldDueDate ? new Date(p.oldDueDate).toDateString() : "no date")} to ${new Date(p.dueDate).toDateString()}` : `remove the due date from "${(p.text || p.id || "").slice(0, 80)}"`);
    return {
      title: `Nova wants to ${label}`,
      body: "Nothing gets deleted — the old due date can be restored within 5 minutes from the Action Log or the Undo button.",
    };
  },
  execute: async (p) => {
    // payload.dueDate null = clear the date; a valid ISO string = pin it;
    // the planner never sends undefined, but guard anyway.
    const task = store.setTaskDue(p.id, p.dueDate === undefined ? null : p.dueDate);
    if (!task) throw new Error("task not found");
    return { task, kind: "task-due-set", oldDueDate: p.oldDueDate || null };
  },
  reverse: async (p) => {
    // Restore the old due date (or clear what was just added).
    store.setTaskDue(p.id, p.oldDueDate || null);
    return { undone: true, text: p.task ? p.task.text : String(p.id) };
  },
});

registerAction({
  id: "notes:complete-task",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Mark a task done (or undone)",
  simulate: async (p) => ({
    title: `Nova wants to mark "${(p.text || p.id || "").slice(0, 80)}" as done`,
    body: "This can be undone within 5 minutes from the Action Log or the Undo button.",
  }),
  execute: async (p) => {
    const task = store.setTaskDone(p.id, p.done === false ? false : !p.wasDone);
    if (!task) throw new Error("task not found");
    return { task, kind: "task-done" };
  },
  reverse: async (p) => {
    const task = p.task || { id: p.id };
    const undone = store.setTaskDone(task.id, false);
    return undone ? { undone: true, text: undone.text } : { undone: false, error: "task no longer exists" };
  },
});

registerAction({
  id: "notes:delete-note",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Delete a stored note",
  simulate: async (p) => ({
    title: `Nova wants to delete the note "${(p.text || p.id || "").slice(0, 80)}"`,
    body: "Nova keeps a copy for 5 minutes so you can undo this from the Action Log or the Undo button.",
  }),
  execute: async (p) => {
    const note = store.deleteNote(p.id);
    if (!note) throw new Error("note not found");
    return { note, kind: "note-deleted" };
  },
  reverse: async (p) => {
    const note = p.note || { id: p.id, text: p.text };
    // Re-insert: addNote gives a new id, but the undo tracker keys by the
    // original action id — that's fine, Undo works per action, not per item.
    store.addNote(note.text);
    return { undone: true, text: note.text };
  },
});

registerAction({
  id: "notes:delete-task",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Delete a stored task",
  simulate: async (p) => ({
    title: `Nova wants to delete the task "${(p.text || p.id || "").slice(0, 80)}"`,
    body: "This can be undone within 5 minutes from the Action Log or the Undo button.",
  }),
  execute: async (p) => {
    const task = store.deleteTask(p.id);
    if (!task) throw new Error("task not found");
    return { task, kind: "task-deleted" };
  },
  reverse: async (p) => {
    const task = p.task || { id: p.id, text: p.text };
    store.addTask(task.text);
    return { undone: true, text: task.text };
  },
});

registerAction({
  id: "notes:cancel-reminder",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Cancel a pending reminder",
  simulate: async (p) => ({ summary: `would cancel the reminder "${(p.text || p.id || "").slice(0, 80)}"` }),
  execute: async (p) => {
    const reminder = store.cancelReminder(p.id);
    if (!reminder) throw new Error("reminder not found");
    return { reminder, kind: "reminder-cancelled" };
  },
  reverse: async (p) => {
    const reminder = p.reminder || { id: p.id, dueAt: p.dueAt };
    const rearmed = store.rearmReminder(reminder.id, reminder.dueAt);
    return rearmed ? { undone: true, dueAt: rearmed.dueAt } : { undone: false, error: "reminder no longer exists" };
  },
});

// Round 14: task stats — read-only aggregate over the local store. L1 (safe):
// completion rate, weekly completions, current streak. Zero network.
registerAction({
  id: "notes:task-stats",
  level: RISK_LEVEL.SAFE,
  description: "Read-only task statistics: completion rate, weekly completions, current streak",
  simulate: async () => ({ summary: "would read your task list and compute completion stats locally" }),
  execute: async () => {
    const s = store.taskStats();
    return { stats: s, kind: "task-stats" };
  },
});

// Round 21: daily briefing — "what's on my plate today". One local-only,
// read-only snapshot: tasks due today, overdue tasks, and today's reminders.
registerAction({
  id: "notes:daily-briefing",
  level: RISK_LEVEL.SAFE,
  description: "Read-only snapshot of today: tasks due, overdue, and reminders",
  simulate: async () => ({ summary: "would read your task list and reminders and summarise today locally" }),
  execute: async () => ({ result: store.dailyBriefing(), kind: "daily-briefing" }),
});

// Round 23: weekly digest — "my week in review". One local-only, read-only
// snapshot of the week: completed, pending, overdue, next week's dues, and
// upcoming reminders. L1 SAFE, fully local, works in Private Mode.
registerAction({
  id: "notes:weekly-digest",
  level: RISK_LEVEL.SAFE,
  description: "Read-only snapshot of the week: completed, pending, overdue, next week's dues, upcoming reminders",
  simulate: async () => ({ summary: "would read your task list and reminders and summarise the week locally" }),
  execute: async () => ({ result: store.weeklyDigest(), kind: "weekly-digest" }),
});

// Round 13: snooze — re-arms the most recently FIRED reminder (there is no
// newer fired one to speak of — snooze is only meaningful against a reminder
// that already nudged the user). Re-arming is L1 (safe, local only); the
// due time comes from the planner so nothing destructive ever runs.
registerAction({
  id: "notes:snooze-reminder",
  level: RISK_LEVEL.SAFE,
  description: "Snooze the last fired reminder for a duration (default 10 minutes)",
  simulate: async (p) => ({ summary: `would snooze the last fired reminder by ${Math.round(((p.seconds || 0) * 1000) / 60000)} minute(s) — fires again at ${new Date(p.dueAt).toLocaleTimeString()}` }),
  execute: async (p) => {
    // Round 19: the UI snooze chips name the reminder by id (p.fromUi +
    // p.id). The voice path still targets the most recently fired one.
    // When the caller gives `seconds`, the new due time is now + seconds.
    const fired = (store.all().reminders || []).filter((r) => r.fired).sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
    if (!fired.length) return { ok: false, error: "no-fired" };
    const targetId = p.fromUi ? String(p.id || "") : null;
    const last = targetId ? (fired.find((r) => r.id === targetId) || null) : fired[0];
    if (!last) return { ok: false, error: "no-fired" };
    const dueAt = p.dueAt || (Number(p.seconds) > 0 ? new Date(Date.now() + Number(p.seconds) * 1000).toISOString() : null);
    const rearmed = store.rearmReminder(last.id, dueAt);
    if (!rearmed) return { ok: false, error: "reminder vanished while snoozing" };
    return { ok: true, reminder: rearmed, dueAt: rearmed.dueAt, seconds: p.seconds || 600, kind: "reminder-snoozed" };
  },
});

registerAction({
  id: "notes:summarize-notes",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Summarize stored notes via a one-off model call (only note text leaves the machine)",
  simulate: async () => ({
    title: "Nova wants to summarize your notes",
    body: "Only the text of your notes will be sent to the model for this one request. Nothing else — no other files, no search history — ever leaves this machine.",
  }),
  execute: async () => ({ kind: "summarized" }),
  reverse: async () => ({ undone: true, note: "summarize is idempotent — nothing to reverse" }),
});

module.exports = {};
