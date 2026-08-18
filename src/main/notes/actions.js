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
const actionLog = require("../permissions/action-log");
const store = require("./store");
const userModels = require("../identity/user-model");
const identity = require("../identity/identity");
const settings = require("../settings");

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

// Round 33: ranked TOPICAL note search — "find notes about the dog" / "any
// notes on rent". L1 SAFE read-only: scores stored note text with the same
// whole-word (10) / substring (5) token ladder as the R30 task search,
// strips stop tokens, ties on recency (most recently updated first), and
// caps the readout at 10. Deliberately NOT a model call — fully offline,
// works in Private Mode, and note content never leaves the machine.
registerAction({
  id: "notes:topic-search-notes",
  level: RISK_LEVEL.SAFE,
  description: "Ranked topical search over stored notes (local, offline)",
  simulate: async (p) => ({ summary: `would search your notes for "${(p.subject || "").slice(0, 60)}" locally` }),
  execute: async (p) => ({ matches: store.topicSearchNotes(p.subject), subject: p.subject, kind: "topic" }),
});

registerAction({
  id: "notes:list-tasks",
  level: RISK_LEVEL.SAFE,
  description: "List stored tasks",
  execute: async () => ({ tasks: store.all().tasks, kind: "list" }),
});

// Round 30: fuzzy task search — "find tasks about the report" / "tasks with
// billing". L1 SAFE read-only: matches query tokens against task text with
// whole-word (10) and substring (5) scoring, excludes done tasks, caps at 10.
registerAction({
  id: "notes:task-search",
  level: RISK_LEVEL.SAFE,
  description: "Fuzzy search over stored task text",
  simulate: async (p) => ({ summary: `would search your tasks for "${(p.query || "").slice(0, 60)}" locally` }),
  execute: async (p) => ({ matches: store.searchTasks(p.query, { includeDone: !!(p && p.includeDone) }), query: p.query, kind: "search" }),
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

// Round 34: recurring reminders/tasks — create is L2 (REVERSIBLE) because a
// recurring reminder can ring every day forever if created by mistake; the
// reverse() tears down the spec (and its armed reminder row) cleanly.
// Removal is also L2 with an exact re-creation reverse: re-add the spec and
// re-arm its reminder row at the stored nextDue, so "undo" is lossless.
registerAction({
  id: "notes:add-recurring",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Create a recurring reminder or task",
  simulate: async (p) => ({
    title: `Nova wants to add a recurring ${p.mode || "reminder"}: "${(p.text || "").slice(0, 80)}"`,
    body: `This will repeat ${p.cadence || "daily"}${p.time ? ` at ${new Date(p.time).toLocaleTimeString()}` : ""}. You can cancel it anytime.`,
  }),
  execute: async (p) => {
    const item = store.addRecurring(p);
    return { item, kind: "recurring" };
  },
  reverse: async (p, result) => {
    const id = (result && result.item && result.item.id) || null;
    if (!id) return { undone: false, error: "nothing recorded to remove" };
    const removed = store.removeRecurring(id);
    return removed ? { undone: true } : { undone: false, error: "item already removed" };
  },
});
registerAction({
  id: "notes:remove-recurring",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Remove a recurring reminder or task",
  simulate: async (p) => ({
    title: `Nova wants to remove the recurring item "${(p.text || p.id || "").slice(0, 80)}"`,
    body: "It stops repeating and its pending reminder is cancelled. You can undo this.",
  }),
  execute: async (p) => {
    const removed = store.removeRecurring(p.id);
    if (!removed) throw new Error("recurring item not found");
    return { removed, kind: "recurring-removed" };
  },
  reverse: async (p, result) => {
    const item = (result && result.removed) || null;
    if (!item) return { undone: false, error: "nothing recorded to restore" };
    const restored = store.addRecurring({
      text: item.text, mode: item.mode, cadence: item.cadence,
      day: item.day, weekdays: !!item.weekdays, time: item.time,
    });
    return restored ? { undone: true, item: restored } : { undone: false, error: "could not restore the recurring item" };
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

// Round 24: identity layer — remember a fact about the user ("remember I
// work from home on Fridays") into the local user model. L1 SAFE: purely
// local JSON, fully works in Private Mode, never leaves the machine.
registerAction({
  id: "notes:remember-fact",
  level: RISK_LEVEL.SAFE,
  description: "Remember a fact about the user (stored locally in the user model)",
  simulate: async () => ({ summary: "would save a fact about you to the local user model" }),
  execute: async (p) => {
    const res = userModels.addFact(p.fact);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, fact: res.fact.fact, kind: "remember-fact" };
  },
});

// Round 24: forget a fact from the user model. L2 REVERSIBLE: the fact comes
// back via the 5 s toast-cancel pattern and can be re-remembered by voice
// (reverse() re-inserts it, and undo works for the forget action too).
registerAction({
  id: "notes:forget-fact",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Forget a fact about the user (removes it from the local user model)",
  simulate: async (p) => ({ title: "Nova wants to forget a fact about you", body: `Would remove "${String(p.fact || "").slice(0, 200)}" from what Nova knows about you.` }),
  execute: async (p) => {
    const res = userModels.removeFact(p.fact);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, removed: res.removed.fact, kind: "forget-fact" };
  },
  reverse: async (p) => {
    const res = userModels.addFact(p.fact);
    return { ok: res.ok, undone: res.ok, note: res.ok ? "fact re-remembered" : "could not restore the forgotten fact" };
  },
});

// Round 24: "what do you know about me" — read-only readout of the user model.
registerAction({
  id: "notes:user-model-ask",
  level: RISK_LEVEL.SAFE,
  description: "Read-only readout of everything Nova knows about the user",
  simulate: async () => ({ summary: "would read what Nova knows about you from the local user model" }),
  execute: async () => ({ facts: userModels.list(), kind: "user-model-ask" }),
});

// Round 24: greeting — "good morning", "hi nova". Purely local; uses the
// identity module (name/personality/user name) for tone.
registerAction({
  id: "notes:greet",
  level: RISK_LEVEL.SAFE,
  description: "Personalized greeting (uses your name and the time of day)",
  simulate: async () => ({ summary: "would greet you by name based on the time of day" }),
  execute: async () => ({ kind: "greet" }),
});

// Round 27: mood/energy check-in — "how am I feeling today", "check in with
// me", or "I feel energized". The mood lands as a regular fact in the user
// model (so it persists), but the check-in itself is a dedicated read action
// that names the most recent mood and its age. L1 SAFE — fully local JSON,
// zero network, works in Private Mode.
registerAction({
  id: "notes:mood-check",
  level: RISK_LEVEL.SAFE,
  description: "Read the most recent mood/energy check-in from the user model",
  simulate: async () => ({ summary: "would read your latest mood check-in from the local user model" }),
  execute: async () => ({ kind: "mood-check" }),
});

// Round 27: explicit mood statement — "I feel tired", "I'm feeling great
// today". Stored as a user-model fact like any other preference; check-in
// reads it back as a mood specifically. L1 SAFE, local only.
registerAction({
  id: "notes:mood-statement",
  level: RISK_LEVEL.SAFE,
  description: "Store a mood/energy statement about the user (local user model)",
  simulate: async () => ({ summary: "would remember how you're feeling right now in the local user model" }),
  execute: async (p) => {
    const res = userModels.addFact(p.fact);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, fact: res.fact.fact, kind: "mood-statement" };
  },
});

// Round 28: mood-aware task prioritization — "what should I work on first?".
// Purely read-only: orders pending tasks (overdue first, then due today,
// then the rest) and lets the latest mood check-in lift the smallest tasks
// to the top when energy is low. L1 SAFE — nothing is written, zero network.
registerAction({
  id: "notes:priority-check",
  level: RISK_LEVEL.SAFE,
  description: "Order pending tasks by urgency and the latest mood check-in (read-only)",
  simulate: async () => ({ summary: "would order your pending tasks by urgency and how you're feeling" }),
  execute: async (p) => ({ result: { pending: store.all().tasks, now: p && p.now ? new Date(p.now).getTime() : Date.now() }, kind: "priority-check" }),
});

// Round 31: "plan my day" — builds one time-blocked spoken schedule from
// the pending task list (overdue first, due-today next, rest by size),
// reordered by the user's time-of-day preference and opened with a
// mood-framed line when the latest check-in is recent. Purely read-only:
// L1 SAFE, zero network.
registerAction({
  id: "notes:plan-day",
  level: RISK_LEVEL.SAFE,
  description: "Build a time-blocked spoken plan for today from pending tasks (read-only)",
  simulate: async () => ({ summary: "would build a time-blocked plan for today from your pending tasks" }),
  execute: async (p) => ({
    result: {
      pending: store.all().tasks,
      reminders: store.all().reminders,
      now: p && p.now ? new Date(p.now).getTime() : Date.now(),
    },
    kind: "plan-day",
  }),
});

// Round 32: focus-time accounting — read-only summary of completed focus
// sessions for today and the trailing 7 days. Level 1 (SAFE): nothing is
// created, moved, or sent anywhere; the payload optionally carries the
// pinned test clock forwarded from the planner.
registerAction({
  id: "notes:focus-stats",
  level: RISK_LEVEL.SAFE,
  description: "Report focus-time totals for today and the trailing week (read-only)",
  simulate: async () => ({ summary: "would summarize your focus time for today and the trailing week" }),
  execute: async (p) => ({
    result: {
      now: p && p.now ? new Date(p.now).getTime() : Date.now(),
    },
    kind: "focus-stats",
  }),
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

// Round 29: focus mode / Pomodoro — "start focus mode (for N minutes)" opens
// a local focus session and "stop/end/quit focus" closes the running one.
// Purely local records: the countdown UI ticks in the renderer; the store
// only keeps an honest append-only time log (running → completed/cancelled).
// L1 SAFE — creates a record, zero network.
registerAction({
  id: "notes:focus-start",
  level: RISK_LEVEL.SAFE,
  description: "Start a local focus (Pomodoro) session",
  simulate: async (p) => ({ summary: `would start a ${(p && p.durationMin) || 25}-minute focus session` }),
  execute: async (p) => {
    const durationMin = (p && Number.isFinite(Number(p.durationMin)) && Number(p.durationMin) > 0) ? Number(p.durationMin) : 25;
    // Candid swap: a running session is candidly closed when a new one starts.
    // The outer run log only records this start as 'success' — the replaced
    // session needs its own honest entry so history never looks edited.
    const running = store.latestFocus && store.latestFocus();
    const session = store.startFocus(durationMin, p && p.now ? new Date(p.now).toISOString() : undefined);
    if (running && running.status !== "running") {
      actionLog.append({
        actionId: "notes:focus-start",
        level: RISK_LEVEL.SAFE,
        outcome: "cancelled",
        detail: { id: running.id, reason: "replaced by a new focus session" },
      });
    }
    return { session, kind: "focus-start" };
  },
});

registerAction({
  id: "notes:focus-stop",
  level: RISK_LEVEL.SAFE,
  description: "End the running focus session (read-only close of the local record)",
  simulate: async () => ({ summary: "would close your running focus session" }),
  execute: async (p) => {
    const ended = store.stopFocus("completed", p && p.now ? new Date(p.now).toISOString() : undefined);
    const pending = store.all().tasks.filter((t) => !t.done);
    return { ended, pendingCount: pending.length, kind: "focus-stop" };
  },
});

// Round 35: voice-controlled settings. Personality is a wording change only,
// so it gets the faster L2 REVERSIBLE toast treatment; Private Mode and
// Developer Mode change what future actions may do (all network calls, and
// debug exposure), so they are L3 SENSITIVE — modal Confirm, each reversible
// via reverse() which restores the previous value losslessly.
registerAction({
  id: "settings:set-personality",
  level: RISK_LEVEL.REVERSIBLE,
  description: "Change Nova's personality (affects acknowledgement tone only)",
  simulate: async (p) => ({ summary: `would switch Nova's personality to "${p.personality}"` }),
  execute: async (p) => {
    const prev = identity.get().personality;
    const next = identity.set({ personality: p.personality }).personality;
    return { previous: prev, next, personality: next, kind: "personality" };
  },
  reverse: async (p, result) => {
    const prev = (result && result.previous) || null;
    if (!prev) return { undone: false, error: "no previous personality recorded" };
    identity.set({ personality: prev });
    return { undone: true, personality: prev };
  },
});

registerAction({
  id: "settings:set-private-mode",
  level: RISK_LEVEL.SENSITIVE,
  description: "Turn Private Mode on or off (on = all outbound work refused)",
  simulate: async (p) => ({ summary: p.on ? "would turn Private Mode ON — no outbound network calls from now on" : "would turn Private Mode OFF" }),
  execute: async (p) => {
    const prev = settings.isPrivateMode();
    settings.setPrivateMode(!!p.on);
    return { previous: prev, next: !!p.on, kind: "private-mode" };
  },
  reverse: async (p, result) => {
    const prev = (result && typeof result.previous === "boolean") ? result.previous : null;
    if (prev === null) return { undone: false, error: "no previous value recorded" };
    settings.setPrivateMode(prev);
    return { undone: true, privateMode: prev };
  },
});

registerAction({
  id: "settings:set-developer-mode",
  level: RISK_LEVEL.SENSITIVE,
  description: "Turn Developer Mode on or off (exposes run details in the Dev panel)",
  simulate: async (p) => ({ summary: p.on ? "would turn Developer Mode ON — run details appear in the Developer panel" : "would turn Developer Mode OFF" }),
  execute: async (p) => {
    const prev = settings.isDeveloperMode();
    settings.setDeveloperMode(!!p.on);
    return { previous: prev, next: !!p.on, kind: "developer-mode" };
  },
  reverse: async (p, result) => {
    const prev = (result && typeof result.previous === "boolean") ? result.previous : null;
    if (prev === null) return { undone: false, error: "no previous value recorded" };
    settings.setDeveloperMode(prev);
    return { undone: true, developerMode: prev };
  },
});

module.exports = {};
