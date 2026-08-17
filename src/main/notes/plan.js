// Nova — notes/plan.js
//
// Rule-based natural-language → notes action payload parser (Stage 7).
// Same style as files/plan.js and control/planner.js: NO LLM round-trip,
// works fully offline and in Private Mode. Returns a payload object for
// the dispatcher (actionId + payload), or null when the message isn't
// notes-related, or { error } when it IS notes-related but incomplete.

// Regexes ---------------------------------------------------------------

// "Nova, note that I have a dentist appointment Friday" / "note: buy milk"
// Optional wake word "nova" plus comma tolerated at the start.
// 'note that X' → body is the content AFTER the optional 'that' keyword;
// a bare 'note that' (or 'note that:') has an empty body → planning error.
const RE_NOTE = /^(?:nova\s*,?\s*)?(?:note(?:\s*:\s*|\s+that\s+)(.+)|note\s+(.+)|(?:note down|write down|remember)\s+(?:that\s+)?(.+))/i;

// "remind me to call mom at 3pm" / "remind me to stand up in 30 minutes"
// Task text is everything after "remind me (to)?" up to the LAST " at/in "
// time preposition; greedy match handles "X at Y in Z" (at = clock, in = dur).
const RE_REMIND = /^remind me\s+(?:(?:to\s+)?(.+?))?\s+(?:at|in)\s+(.+)$/i;
const RE_REMIND_ONLY = /^remind me\s+(?:to\s+)?(.+)$/i;

// "add buy milk to my tasks" / "task: call dentist"
const RE_TASK_ADD = /^add\s+(.+?)\s+to my tasks$|^task[:\s]+(.+)/i;

// "what's on my task list" / "list my tasks"
const RE_TASKS_LIST = /(?:what('s| is)\s+(?:on|in)\s+my|list\s+my|show\s+my)\s+task list$|^(?:list|show)\s+(?:my\s+)?tasks$|^tasks$|what tasks do i have/i;

// "mark buy milk done" / "done: call dentist" / "mark task <id> done"
const RE_TASK_DONE = /^(?:mark|set)\s+(.+?)\s+(?:as\s+)?done$|^done[:\s]+(.+)/i;

// "cancel reminder <id>" (side-panel mouse path)
const RE_REMIND_CANCEL = /^cancel reminder\s+(["“]?[\w-]+["”]?)\s*$/i;

// "delete note <id>" / "delete task <id>" (side-panel mouse path)
const RE_DELETE_ID = /^delete\s+(note|task|reminder)\s+(["“]?[\w-]+["”]?)\s*$/i;

// "what did I note about dentist" / "search my notes for milk" — the bare
// "what did I note/write/say about X" phrasing belongs to the NOTES stage
// (keyword search over stored notes); the knowledge-base stage claims the
// same phrasing only with an explicit kb-context suffix ("in my kb").
const RE_SEARCH_NOTES =
  /what did i (?:note|write|say) about\s+(.+)|search my notes for\s+(.+)|notes about\s+(.+)|what('s| is) in my notes about\s+(.+)|find in my notes:\s*(.+)|find my notes on\s+(.+)/i;

// "show my notes" / "list my notes"
const RE_NOTES_LIST = /^(?:show|list|what('s| is))\s+(?:my\s+)?notes$/i;

// "delete my note about milk" / "delete the task buy milk"
const RE_DELETE = /^delete\s+(?:my |the )?(note|task)\s+["“]?(.+?)["”]?\s*$/i;

// "summarize my notes"
const RE_SUMMARIZE = /^summarize my notes$/i;

// Time expression parser -------------------------------------------------

/**
 * Parse a time expression into a Date:
 *  - "3pm", "15:30", "3:15 pm"            → today/next matching clock time
 *  - "in 10 minutes", "in 1 hour"          → relative duration
 *  - "in 2 hours 15 minutes"               → compound duration
 *  - "tomorrow at 9am"                     → tomorrow + clock time
 */
function parseTime(expr) {
  const e = String(expr || "").trim();
  if (!e) return null;
  const now = new Date();

  // "tomorrow at 9am" / "tomorrow 9:30"
  const tmr = /^(?:tomorrow)(?:\s+at\s+)?(.*)$/i.exec(e);
  if (tmr) {
    const base = new Date(now);
    base.setDate(base.getDate() + 1);
    base.setHours(0, 0, 0, 0);
    if (tmr[1].trim()) {
      const h = clockHm(tmr[1].trim(), base);
      if (h) return h;
    }
    return base;
  }

  // "3pm", "3:15 pm", "15:30" — pure clock times first, so a bare number
  // like "3pm" is never misread as a relative duration.
  const clock = clockHm(e, now);
  if (clock) return clock;

  // "in 2 hours 15 minutes" / "in 10 min" / "in 1 hour" / "in 30 seconds"
  // Also bare durations without the "in" prefix: "30 minutes", "2 hours".
  // Requires at least one numeric quantity WITH a unit word — plain "3pm"
  // has no unit, so it already returned above as a clock time.
  const rel = /^(?:in\s+)?(.+)$/i.exec(e);
  if (rel) {
    let totalMs = 0;
    const parts = rel[1].trim().toLowerCase();
    const specs = [
      [/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i, 3600_000],
      [/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i, 60_000],
      [/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i, 1_000],
      [/(\d+(?:\.\d+)?)\s*days?\b/i, 86_400_000],
    ];
    let matched = 0;
    for (const [re, ms] of specs) {
      // matchAll requires a global regex — clone the spec with the /g flag
      const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      for (const m of parts.matchAll(globalRe)) {
        totalMs += parseFloat(m[1]) * ms;
        matched++;
      }
    }
    if (matched) return new Date(now.getTime() + totalMs);
  }

  return null;
}

function clockHm(expr, base) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(expr.trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (min >= 60 || h > 12 || (m[3] && h > 12)) return null;
  const ampm = (m[3] || "").toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  const d = new Date(base);
  d.setHours(h, min, 0, 0);
  if (d <= base) d.setDate(d.getDate() + 1); // next occurrence if already past
  return d;
}

// Planning --------------------------------------------------------------

/** Pick the first task whose text matches (case-insensitive substring). */
function matchTask(tasks, text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  const exact = tasks.find((x) => x.text.toLowerCase() === t);
  if (exact) return exact;
  const inc = tasks.filter((x) => x.text.toLowerCase().includes(t));
  return inc.length ? inc[0] : null;
}

/** Look up an item by its id (side-panel mouse path passes ids directly). */
function findById(pool, id) {
  const sid = String(id || "").trim().replace(/["“”]/g, "");
  if (!sid) return null;
  const found = (pool || []).find((x) => String(x.id) === sid);
  return found || null;
}

/**
 * Parse a user message into a notes action payload.
 * @param {string} text  user message
 * @param {{tasks?: Array, notes?: Array}} ctx  stored items (optional)
 * @returns {object|null}  { actionId, payload } | { error } | null
 */
function planNoteAction(text, ctx = {}) {
  const t = text.trim();
  let m;

  m = RE_NOTE.exec(t);
  if (m) {
    // m[1]='note: X'/'note that X' body, m[2]='note X' body, m[3]='write
    // down that X' body — pick whichever group the alternation matched.
    const body = (m[1] || m[2] || m[3] || "").trim();
    // "note that" with no body (or "note that that?") → ask for content.
    if (!body || body.toLowerCase() === "that") {
      return { error: "Note what, exactly? Try \"note that I have a dentist appointment Friday\"." };
    }
    return { actionId: "notes:add-note", payload: { text: body } };
  }

  m = RE_REMIND.exec(t);
  if (m) {
    // "remind me to X at Y" → task=group1, time=group2
    let taskText = (m[1] || "").trim();
    const timeExpr = (m[2] || "").trim();
    // "remind me at 3pm" without task text → ask
    if (!taskText && timeExpr) {
      return { error: "Remind you to do what? Say \"remind me to stand up at 3pm\"." };
    }
    // "remind me call mom at 3pm" has no preposition — timeExpr wrongly took
    // '3pm' while taskText took nothing; re-split at the last 'at/in'.
    if (!taskText) {
      const m2 = RE_REMIND_ONLY.exec(t);
      if (!m2 || !m2[1]) {
        return { error: "Remind you to do what, and when? Say \"remind me to call mom at 3pm\"." };
      }
      // split 'call mom at 3pm' on the last ' at/' in' preposition
      const inner = m2[1].trim();
      const split = inner.match(/^(.*?)\s+(?:at|in)\s+(.+)$/i);
      if (split) {
        taskText = split[1].trim();
        const dueAt2 = parseTime(split[2]);
        if (!dueAt2) return { error: `I could not parse "${split[2]}" as a time. Try "at 3pm", "in 10 minutes", or "tomorrow at 9am".` };
        return { actionId: "notes:add-reminder", payload: { text: taskText, dueAt: dueAt2.toISOString(), timeExpr: split[2] } };
      }
      // "remind me call mom" — task, immediate reminder
      return { actionId: "notes:add-reminder", payload: { text: inner, dueAt: null, timeExpr: null } };
    }
    const dueAt = timeExpr ? parseTime(timeExpr) : null;
    if (timeExpr && !dueAt) {
      return { error: `I could not parse "${timeExpr}" as a time. Try "at 3pm", "in 10 minutes", or "tomorrow at 9am".` };
    }
    return {
      actionId: "notes:add-reminder",
      payload: { text: taskText, dueAt: dueAt ? dueAt.toISOString() : null, timeExpr },
    };
  }
  // "remind me stand up" — no time preposition at all: bare request, immediate
  m = RE_REMIND_ONLY.exec(t);
  if (m && m[1]) {
    const bare = m[1].trim();
    // A leftover function word means the request is incomplete ("remind me to").
    if (/^(to|at|in)$|^$/.test(bare)) {
      return { error: "Remind you to do what? Say \"remind me to stand up at 3pm\"." };
    }
    return { actionId: "notes:add-reminder", payload: { text: bare, dueAt: null, timeExpr: null } };
  }

  m = RE_TASK_ADD.exec(t);
  if (m) {
    const taskText = (m[1] || m[2] || "").trim();
    if (!taskText) return { error: "Add what to your tasks? Try \"add buy milk to my tasks\"." };
    return { actionId: "notes:add-task", payload: { text: taskText } };
  }

  if (RE_TASKS_LIST.test(t)) {
    return { actionId: "notes:list-tasks", payload: {} };
  }

  m = RE_TASK_DONE.exec(t);
  if (m) {
    // "mark task <id> done" (mouse path) — strip the literal 'task ' prefix
    // before lookup; findById needs the raw id, matchTask the bare words.
    const taskText = (m[1] || m[2] || "").trim().replace(/^task\s+/i, "");
    if (!ctx.tasks || !ctx.tasks.length) {
      return { error: "Your task list is empty — nothing to mark done." };
    }
    const task = findById(ctx.tasks, taskText) || matchTask(ctx.tasks, taskText);
    if (!task) return { error: `I could not find a task matching "${taskText}" on your list.` };
    return { actionId: "notes:complete-task", payload: { id: task.id, text: task.text } };
  }

  m = RE_REMIND_CANCEL.exec(t);
  if (m) {
    const reminder = findById(ctx.reminders, m[1]);
    if (!reminder) return { error: "I could not find a reminder with that id — the list may have changed." };
    return { actionId: "notes:cancel-reminder", payload: { id: reminder.id, dueAt: reminder.dueAt } };
  }

  m = RE_DELETE_ID.exec(t);
  if (m) {
    const kind = (m[1] || "").toLowerCase();
    const id = String(m[2] || "").trim().replace(/["“”]/g, "");
    if (kind === "reminder") {
      const reminder = findById(ctx.reminders, id);
      if (!reminder) return { error: "I could not find a reminder with that id." };
      return { actionId: "notes:cancel-reminder", payload: { id: reminder.id, dueAt: reminder.dueAt } };
    }
    const pool = kind === "task" ? ctx.tasks : ctx.notes;
    const item = findById(pool, id);
    if (!item) return { error: `I could not find a ${kind} with that id.` };
    return {
      actionId: kind === "task" ? "notes:delete-task" : "notes:delete-note",
      payload: { id: item.id, text: item.text },
    };
  }

  m = RE_SEARCH_NOTES.exec(t);
  if (m) {
    // The new "what did I (note|write|say) about X" alternative uses a
    // non-capturing verb group, so its topic lands in m[1]; "find my notes
    // on X" lands in m[6]. First non-empty group wins either way.
    const query = (m[1] || m[2] || m[3] || m[4] || m[5] || m[6] || "").trim();
    if (!query) return { error: "Search your notes for what? Try \"search my notes for dentist\"." };
    return { actionId: "notes:search-notes", payload: { query } };
  }

  if (RE_NOTES_LIST.test(t)) {
    return { actionId: "notes:list-notes", payload: {} };
  }

  m = RE_DELETE.exec(t);
  if (m) {
    const kind = (m[1] || "").toLowerCase();
    // "delete my note about pizza" — strip leading topic keyword so the
    // remaining words match the note text directly.
    const subject = (m[2] || "").trim().replace(/^(?:about|for|with|on)\s+/i, "");
    if (!subject) return { error: `Delete which ${kind}? Name it, e.g. "delete my note about milk".` };
    const pool = kind === "task" ? ctx.tasks : ctx.notes;
    if (!pool || !pool.length) return { error: `I could not find a ${kind} matching "${subject}".` };
    const match = findById(pool, subject) || matchTask(pool, subject);
    if (!match) return { error: `I could not find a ${kind} matching "${subject}".` };
    return {
      actionId: kind === "task" ? "notes:delete-task" : "notes:delete-note",
      payload: { id: match.id, text: match.text },
    };
  }

  if (RE_SUMMARIZE.test(t)) {
    return { actionId: "notes:summarize-notes", payload: {} };
  }

  return null;
}

module.exports = {
  planNoteAction, parseTime, matchTask, findById,
  RE_NOTE, RE_REMIND, RE_TASK_ADD, RE_TASKS_LIST, RE_TASK_DONE,
  RE_SEARCH_NOTES, RE_NOTES_LIST, RE_DELETE, RE_DELETE_ID, RE_REMIND_CANCEL, RE_SUMMARIZE,
};
