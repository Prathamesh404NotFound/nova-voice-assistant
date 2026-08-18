// Nova — notes/dispatch.js
//
// Notes/reminders/tasks dispatcher (Stage 7). planNoteAction() → gate
// runAction (notes actions are L1 safe for create/read, L2 for
// edit/delete/summarize) → narrated result. Summarize is the only branch
// that ever sends note content off-machine, and only after the user
// explicitly asks, and only that one request.

const { planNoteAction } = require("./plan");
const store = require("./store");
const gate = require("../permissions/gate");
const actionLog = require("../permissions/action-log");
const { buildSummaryUserMessage, sendSummary } = require("./summarize");
const log = require("electron-log");
const router = require("../router");

// ---------------------------------------------------------------------------
// Context helper: snapshot stored items for "mark X done" name resolution.
// ---------------------------------------------------------------------------

function storeContext() {
  const a = store.all();
  // reminders must be included — the planner needs them for id-based
  // "cancel reminder <id>" (and id-based delete) from the side panel.
  return { tasks: a.tasks, notes: a.notes, reminders: a.reminders };
}

/**
 * Run a notes-related user message end-to-end.
 * @param {string} text
 * @param {{ taskId?: string, getKey?: () => Promise<string|null>, mainWindow?: object } = {}}
 * @returns {object} { ok, intent, text, actionId?, detail?, error? }
 */
async function runNoteAction(text, opts = {}) {
  const planned = planNoteAction(text, storeContext());
  if (!planned) {
    return { ok: false, intent: "notes", text: null };
  }
  if (planned.error) {
    actionLog.append({ actionId: null, level: null, outcome: "planning-error", reason: planned.error });
    return { ok: false, intent: "notes", text: planned.error, detail: { planningError: planned.error } };
  }

  const { actionId, payload } = planned;

  // --- Summarize: the ONLY network-touching path for note content. ---
  if (actionId === "notes:summarize-notes") {
    const key = opts.getKey ? await opts.getKey() : null;
    if (!key) {
      return {
        ok: false, intent: "notes",
        text: "I need your OpenRouter API key to summarize notes. Set it in the side panel settings first.",
        actionId, detail: { kind: "summarize" },
      };
    }
    // Private Mode check is done by the gate below (L2, private-mode blocks
    // nothing automatically — but notes summarize is a network call; the
    // dispatcher layer refuses it explicitly in Private Mode).
    const res = await gate.runAction(actionId, payload, { taskId: opts.taskId });
    if (res.outcome !== "success") {
      return {
        ok: false, intent: "notes",
        text: res.outcome === "cancelled"
          ? "No problem — I won't summarize your notes."
          : "I could not summarize your notes right now.",
        actionId, detail: { kind: "summarize" },
      };
    }
    const noteTexts = store.summarizeOf().map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt }));
    if (!noteTexts.length) {
      return {
        ok: true, intent: "notes",
        text: "You don't have any notes yet. Say \"note that …\" anytime and I'll remember it — locally, nothing leaves this machine.",
        actionId, detail: { kind: "summarize", empty: true },
      };
    }
    const model = router.pickModel("chat");
    const userMessage = buildSummaryUserMessage(noteTexts);
    log.info(`[notes] summarize: sending ${noteTexts.length} note(s) via ${model} (only these texts leave the machine)`);
    const result = await sendSummary(key, model, userMessage);
    // sendSummary runs through retryOnce, which wraps the summary in
    // {ok, value} — unwrap it so the chat text is a plain string.
    const summary = (typeof result === "string") ? result : (result && typeof result.value === "string" ? result.value : "");
    if (!summary) {
      return { ok: false, intent: "notes", text: "The model returned no summary — try again.", actionId, detail: { kind: "summarize" } };
    }
    return {
      ok: true, intent: "notes",
      text: summary,
      narration: "Here's a quick summary of your notes…",
      actionId, detail: { kind: "summarize" },
    };
  }

  // --- All other notes actions: local, through the gate. ---
  const res = await gate.runAction(actionId, payload, { taskId: opts.taskId });
  if (res.outcome === "cancelled") {
    return {
      ok: false, intent: "notes",
      text: "Cancelled — nothing was changed.",
      actionId, detail: payload,
    };
  }
  if (res.outcome !== "success") {
    return {
      ok: false, intent: "notes",
      text: "Something went wrong while handling that. Check the Action Log for details.",
      actionId, detail: payload,
    };
  }

  return formatLocalResult(actionId, payload, res.detail || res);
}

// ---------------------------------------------------------------------------
// Human-readable result formatting + narration
// ---------------------------------------------------------------------------

function formatLocalResult(actionId, payload, detail) {
  switch (actionId) {
    case "notes:add-note": {
      const note = detail.note || {};
      return {
        ok: true, intent: "notes",
        text: `Noted — "${note.text}". Saved locally at ${new Date(note.createdAt).toLocaleTimeString()}.`,
        narration: "Noted!",
        actionId, detail: { kind: "note", note },
      };
    }
    case "notes:add-reminder": {
      const r = detail.reminder || {};
      const when = r.dueAt ? new Date(r.dueAt).toLocaleString() : "now";
      return {
        ok: true, intent: "notes",
        text: `Reminder set — "${r.text}" at ${when}. I'll nudge you then.`,
        narration: `Reminder set for ${when.replace(",", " at")}.`,
        actionId, detail: { kind: "reminder", reminder: r },
      };
    }
    case "notes:add-task": {
      const t = detail.task || {};
      return {
        ok: true, intent: "notes",
        text: `Added "${t.text}" to your task list.`,
        narration: "Added to your tasks.",
        actionId, detail: { kind: "task", task: t },
      };
    }
    case "notes:list-notes": {
      const notes = detail.notes || [];
      if (!notes.length) return { ok: true, intent: "notes", text: "You have no notes yet.", actionId, detail: { kind: "list", notes } };
      return {
        ok: true, intent: "notes",
        text: "Your notes:\n" + notes.map((n) => `• ${new Date(n.createdAt).toLocaleString()} — ${n.text}`).join("\n"),
        actionId, detail: { kind: "list", notes },
      };
    }
    case "notes:search-notes": {
      const matches = detail.matches || [];
      if (!matches.length) return { ok: true, intent: "notes", text: `No notes mention "${payload.query}".`, actionId, detail: { kind: "search", matches } };
      return {
        ok: true, intent: "notes",
        text: `Found ${matches.length} note${matches.length === 1 ? "" : "s"} about "${payload.query}":\n` +
          matches.map((n) => `• ${new Date(n.createdAt).toLocaleString()} — ${n.text}`).join("\n"),
        actionId, detail: { kind: "search", matches },
      };
    }
    case "notes:list-tasks": {
      const tasks = detail.tasks || [];
      if (!tasks.length) return { ok: true, intent: "notes", text: "Your task list is empty.", actionId, detail: { kind: "list", tasks } };
      return {
        ok: true, intent: "notes",
        text: "Your tasks:\n" + tasks.map((t) => `${t.done ? "✓" : "○"} ${t.text}`).join("\n"),
        actionId, detail: { kind: "list", tasks },
      };
    }
    case "notes:list-reminders": {
      const rems = detail.reminders || [];
      const pending = rems.filter((r) => !r.fired);
      if (!pending.length) return { ok: true, intent: "notes", text: "No pending reminders.", actionId, detail: { kind: "list", reminders: rems } };
      return {
        ok: true, intent: "notes",
        text: "Pending reminders:\n" + pending.map((r) => `• ${r.text} — ${new Date(r.dueAt).toLocaleString()}`).join("\n"),
        actionId, detail: { kind: "list", reminders: rems },
      };
    }
    case "notes:complete-task": {
      const t = detail.task || {};
      return {
        ok: true, intent: "notes",
        text: `Marked "${t.text}" as done.`,
        narration: "Task done.",
        actionId, detail: { kind: "task-done", task: t },
      };
    }
    case "notes:delete-note": {
      const n = detail.note || {};
      return {
        ok: true, intent: "notes",
        text: `Deleted the note "${n.text}". You can undo it for 5 minutes.`,
        actionId, detail: { kind: "note-deleted", note: n },
      };
    }
    case "notes:delete-task": {
      const t = detail.task || {};
      return {
        ok: true, intent: "notes",
        text: `Deleted the task "${t.text}". You can undo it for 5 minutes.`,
        actionId, detail: { kind: "task-deleted", task: t },
      };
    }
    case "notes:cancel-reminder": {
      const r = detail.reminder || {};
      return {
        ok: true, intent: "notes",
        text: `Cancelled the reminder "${r.text}".`,
        actionId, detail: { kind: "reminder-cancelled", reminder: r },
      };
    }
    // Round 13: snooze — re-arms the last fired reminder.
    case "notes:snooze-reminder": {
      const r = detail.reminder || {};
      if (detail.ok === false) {
        const msg = detail.error === "no-fired"
          ? "There's no fired reminder to snooze — did one already ring? If it was already snoozed, it's set for later."
          : "I could not snooze that reminder — it may no longer exist.";
        return { ok: false, intent: "notes", text: msg, actionId, detail: { kind: "reminder-snoozed", error: detail.error } };
      }
      const mins = Math.max(1, Math.round((detail.seconds || 0) / 60));
      const at = new Date(detail.dueAt || r.dueAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return {
        ok: true, intent: "notes",
        text: `Reminder "${r.text}" snoozed — I'll nudge you again in ${mins} minute${mins === 1 ? "" : "s"} (${at}).`,
        narration: `Snoozed ${mins} minutes.`,
        actionId, detail: { kind: "reminder-snoozed", reminder: r },
      };
    }
    // Round 12: screenshot-to-note — screen text saved as a local note.
    case "notes:screen-to-note": {
      const note = (detail.note) || {};
      if (detail.ok === false) {
        return { ok: false, intent: "notes", text: detail.error || "I could not save the screen as a note.", actionId, detail: { kind: "screen-note", error: detail.error } };
      }
      const preview = (note.text || "").split("\n")[0];
      return {
        ok: true, intent: "notes",
        text: `Saved your screen as a local note — "${preview}" (${detail.charCount || 0} characters read). Nothing was sent anywhere.`,
        narration: "Noted — I saved what's on your screen.",
        actionId, detail: { kind: "screen-note", note },
      };
    }
    default:
      return { ok: false, intent: "notes", text: "I don't know how to handle that notes action.", actionId, detail };
  }
}

module.exports = { runNoteAction, planNoteAction, storeContext, formatLocalResult };
