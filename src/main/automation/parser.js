// Nova — automation/parser.js (Stage 9)
//
// Parses a natural-language automation request into:
//   { name, cron, steps: [{kind, text}] }
// Rule-based (no model call) so creation works fully offline / Private Mode.
//
// Recognized patterns:
//   "every weekday at 8 AM, tell me my tasks and check Downloads"
//   "every day at 9 AM, tell me what's in my Downloads folder"
//   "at 7:30 every morning, summarize my notes and read the news"
//   "every Monday at 9 AM, clean up my Downloads folder"
//
// The time part converts to a cron `minute hour` pair; the step part is
// split on "and"/", then" and each clause is classified into a step kind
// by small verb recognizers that mirror each stage's own planner verbs.

const { STEP_KINDS, MAX_STEPS } = require("./types");

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------
const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sundays: 0, mondays: 1, tuesdays: 2, wednesdays: 3, thursdays: 4, fridays: 5, saturdays: 6 };

const TIME_RE =
  /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:in the\s+)?(?:morning|afternoon|evening)?/i;

function parseTime(text) {
  // Explicit clock time first: "8 AM", "19:00", "7:30pm"
  const m = text.match(/(?:^|at\s+|,?\s+at\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const mer = (m[3] || "").toLowerCase();
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
    if (hour < 0 || hour > 23 || min < 0 || min > 59) return null;
    return { hour, min };
  }
  // Bare 24h-style or unqualified times: "7:30" → 7:30, "9" → 9:00 (12-hour
  // style defaults to morning — a 24h-only user says "19" or "19:00").
  const b = text.match(/(?:^|at\s+|,?\s+at\s+)(\d{1,2})(?::(\d{2}))?$/i);
  if (b) {
    let hour = parseInt(b[1], 10);
    const min = b[2] ? parseInt(b[2], 10) : 0;
    if (hour > 23 || hour < 1 || min < 0 || min > 59) return null;
    return { hour, min };
  }
  // Fuzzy times: "every morning" → 8:00, "every evening" → 18:00, "every night" → 21:00
  const t = text.toLowerCase();
  if (/(?:every\s+|each\s+|\bat\s+)?morning/.test(t)) return { hour: 8, min: 0 };
  if (/(?:every\s+|each\s+|\bat\s+)?evening/.test(t)) return { hour: 18, min: 0 };
  if (/(?:every\s+|each\s+|\bat\s+)?night/.test(t)) return { hour: 21, min: 0 };
  if (/(?:every\s+|each\s+|\bat\s+)?noon/.test(t)) return { hour: 12, min: 0 };
  return null;
}

// ---------------------------------------------------------------------------
// Schedule parsing
// ---------------------------------------------------------------------------
function parseSchedule(text) {
  const lower = text.toLowerCase();
  // "every weekday" / "weekdays"
  if (/every\s+weekday|weekdays/.test(lower)) {
    const t = parseTime(text);
    if (!t) return null;
    return { cron: `${t.min} ${t.hour} * * 1-5` };
  }
  // "every weekend"
  if (/every\s+weekend|weekends/.test(lower)) {
    const t = parseTime(text);
    if (!t) return null;
    return { cron: `${t.min} ${t.hour} * * 0,6` };
  }
  // "every Monday at 9 AM" / "every Monday" (default 9:00)
  for (const [name, dow] of Object.entries(DAYS)) {
    const re = new RegExp(`every\\s+${name}(?:\\s+at\\s+\\d{1,2}[^,]*)?`, "i");
    if (re.test(lower)) {
      const t = parseTime(text) || { hour: 9, min: 0 };
      return { cron: `${t.min} ${t.hour} * * ${dow}` };
    }
  }
  // "every day" / "daily" / "each day"
  if (/every\s+day|daily|each\s+day/.test(lower)) {
    const t = parseTime(text) || { hour: 9, min: 0 };
    return { cron: `${t.min} ${t.hour} * * *` };
  }
  // "every morning/evening/night"
  if (/every\s+(morning|evening|night|noon)/.test(lower)) {
    const t = parseTime(text);
    if (!t) return null;
    return { cron: `${t.min} ${t.hour} * * *` };
  }
  // "at 9 AM" (no frequency — daily implied)
  const t = parseTime(text);
  if (t) return { cron: `${t.min} ${t.hour} * * *` };
  return null;
}

// ---------------------------------------------------------------------------
// Step classification (mirrors each stage's own verb set)
// ---------------------------------------------------------------------------
const RE_VISION =
  /what('s| is)? (on my screen|my screen|this screen|this (error|message))|what am i looking at|describe (my |the )?screen|read (my |the )?screen|tell me what's on my screen|screenshot/i;
const RE_FILES_SEARCH =
  /(?:find|search (for)?|locate|look for|list|what('s| is)? (in|inside)|show (me )?(the )?(files|pdfs?|documents?|new files))/i;
const RE_FILES_STATS =
  /(?:how much (?:space|size|room)|how big|size of|disk usage)/i;
const RE_FILES_ORGANIZE =
  /(?:clean up|cleanup|clean|tidy|organize|sort)\s+/i;
const RE_FILES_DELETE =
  /(?:delete|remove|trash|get rid of)\s+/i;
const RE_FILES_MOVE =
  /move\s+(?:my |the )?(this|these|that|those)\s+(file|files)\s+to/i;
const RE_NOTES_TASKS =
  /(?:my tasks|task list|what('s| is)? on my task list|what do i have to do|to-dos?|todos?|remind(?:ers)?|my notes|note that|what did i note)/i;
const RE_NOTES_SUMMARIZE =
  /summarize my notes|summary of my notes|what('s| is)? been going on in my notes/i;
const RE_NOTES_REMIND =
  /remind me (to|about)|set a reminder/i;
const RE_KB =
  /(?:my kb|knowledge base|my documents|my (docs|files)|indexed|in my kb)/i;
const RE_KB_ADD =
  /add (?:this|the|my) folder/i;
const RE_CONTROL =
  /(?:open (?:the )?(calculator|notepad|notes app)|type|click|double[- ]?click|press|compute|calculate|submit)/i;
// Round 22: daily-plate briefing step — "every morning at 7, tell me what's on
// my plate" routes this clause to the notes stage, which executes it through
// the existing notes:daily-briefing action (L1 SAFE, local-only, works in
// Private Mode). The optional conversational prefix keeps "and give me my
// briefing"-style clause forms routable.
const RE_BRIEFING_STEP =
  /(?:tell me|give me|read me)?\s*(?:what('s| is)\s+on my plate today|brief me on today|(?:today|morning|daily)\s+briefing|my (daily|morning) briefing|what do i have due today|give me my briefing)/i;
// Round 23: weekly digest clause forms — "my week in review", "weekly digest",
// "how did my week go" — route to NOTES (reads from the same digest action).
const RE_DIGEST_STEP =
  /(?:tell me|give me|show me)?\s*(?:my week in review|weekly digest|how did my week go|what happened this week)/i;

function classifyClause(clause) {
  const c = clause.trim();
  if (!c) return null;
  if (RE_VISION.test(c)) return { kind: STEP_KINDS.VISION, text: c };
  if (RE_CONTROL.test(c)) return { kind: STEP_KINDS.CONTROL, text: c };
  // Destructive/reversible verbs ALWAYS mean FILES (never KB): a deletion
  // or reorganization is a file operation even if the wording mentions
  // "my files" — KB steps are only queries and index management.
  if (RE_FILES_ORGANIZE.test(c) || RE_FILES_DELETE.test(c) || RE_FILES_MOVE.test(c)) {
    return { kind: STEP_KINDS.FILES, text: c };
  }
  if (RE_KB_ADD.test(c) || RE_KB.test(c)) return { kind: STEP_KINDS.KB, text: c };
  if (RE_FILES_STATS.test(c) || RE_FILES_SEARCH.test(c)) {
    return { kind: STEP_KINDS.FILES, text: c };
  }
  if (RE_NOTES_REMIND.test(c) || RE_NOTES_TASKS.test(c) || RE_NOTES_SUMMARIZE.test(c) || RE_BRIEFING_STEP.test(c) || RE_DIGEST_STEP.test(c)) {
    return { kind: STEP_KINDS.NOTES, text: c };
  }
  // Default: files search ("check for new files in Downloads") — the most
  // common fallback for "check / look at" wording. Conservative default.
  return { kind: STEP_KINDS.FILES, text: c };
}

/** Split the step portion on natural conjunctions, preserving clause text. */
function splitClauses(text) {
  // Remove the leading schedule phrase AND the time expression, then split
  // on natural conjunctions ("and", ",", "then").
  let stepsText = text
    // strip day-frequency prefix (e.g. "every weekday", "weekdays")
    .replace(/^(?:every\s+(?:day|weekday|weekend|morning|evening|night|noon)\b|weekdays|weekends)\s*/i, "")
    // strip frequency words appearing AFTER the time expression too (e.g.
    // "at 8 AM every morning") — only when followed by a fuzzy time word,
    // so "every day" inside a step text is not stripped
    .replace(/\bevery\s+(morning|evening|night|noon)\b/gi, "")
    // strip explicit clock times anywhere (e.g. "at 8 AM", "7:30pm", "at 19:00")
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, "")
    // strip weekday names and fuzzy times (e.g. "every Monday", "in the morning")
    .replace(/\bevery\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi, "")
    .replace(/\b(?:in the\s+)?(?:morning|evening|night|noon)\b/gi, "")
    .replace(/\s*,\s*then\s+/gi, " AND ")
    .replace(/\s*\bthen\b\s+/gi, " AND ")
    .replace(/\s+and\s+/gi, " AND ")
    .replace(/\s*,\s*/g, " AND ")
    .trim()
    .replace(/^and\s+/i, "");
  return stepsText.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
}

function makeName(cron) {
  const dow = cron.split(/\s+/)[4];
  const hour = parseInt(cron.split(/\s+/)[1], 10);
  const part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 21 ? "evening" : "daily";
  const freq = dow === "*" ? "" :
    dow === "1-5" ? "weekday " :
    dow === "0,6" ? "weekend " :
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parseInt(dow, 10)] + " ";
  return `${freq}${part} automation`;
}

/**
 * Parse a full automation request.
 * @param {string} text e.g. "every weekday at 8 AM, tell me my tasks and check for new files in Downloads"
 * @param {{ name?: string } = {}}
 * @returns {{ ok, automation?: {name, cron, steps}, error?: string }}
 */
// Round 22: dedicated "set up a morning briefing" preset — a schedule-first
// command with no step clauses, so the user never has to phrase the step:
// "create a daily briefing at 7:30", "set up a morning briefing" (default 8 AM),
// "start a briefing for 6 AM". Produces a single notes-kind briefing step named
// "Morning briefing".
const RE_BRIEFING_PRESET =
  /^(?:set up|create|start|schedule|make me|add)\s+(?:a\s+)?(?:(?:daily|morning)\s+)?briefing(?:\s+(?:at|for)\s+(.+))?\s*$/i;
const RE_DIGEST_PRESET =
  /^(?:set up|create|start|schedule|make me|add)\s+(?:a\s+)?(?:my\s+)?(?:weekly\s+)?digest(?:\s+(?:at|on|for)\s+(.+))?\s*$/i;

function parseAutomation(text, opts = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, error: "Say something like \u201cevery day at 9 AM, check my Downloads folder\u201d." };

  const preset = RE_BRIEFING_PRESET.exec(trimmed);
  if (preset) {
    const timeExpr = (preset[1] || "").trim();
    const t = timeExpr ? (parseTime(`at ${timeExpr}`) || parseTime(timeExpr)) : { hour: 8, min: 0 };
    if (!t) return { ok: false, error: `I could not parse \u201c${timeExpr}\u201d as a time — try \u201c8 AM\u201d or \u201c7:30\u201d.` };
    return {
      ok: true,
      automation: {
        name: opts.name || "Morning briefing",
        cron: `${t.min} ${t.hour} * * *`,
        steps: [{ kind: STEP_KINDS.NOTES, text: "what's on my plate today" }],
      },
    };
  }

  // Round 23: weekly digest preset — "set up a weekly digest at 7 PM" /
  // "create a weekly digest for Sunday at 8 PM" / bare "create a digest".
  // Weekly cron (day 0 = Sunday) at the requested time (7 PM default).
  const digest = RE_DIGEST_PRESET.exec(trimmed);
  if (digest) {
    const timeExpr = (digest[1] || "").trim();
    const t = timeExpr ? (parseTime(`at ${timeExpr}`) || parseTime(timeExpr)) : { hour: 19, min: 0 };
    if (!t) return { ok: false, error: `I could not parse \u201c${timeExpr}\u201d as a time — try \u201c7 PM\u201d or \u201c8:30 PM\u201d.` };
    return {
      ok: true,
      automation: {
        name: opts.name || "Weekly digest",
        cron: `${t.min} ${t.hour} * * 0`,
        steps: [{ kind: STEP_KINDS.NOTES, text: "my week in review" }],
      },
    };
  }

  const sched = parseSchedule(trimmed);
  if (!sched) {
    return { ok: false, error: "I could not find a schedule. Try \u201cevery day at 9 AM\u201d, \u201cevery weekday at 8 AM\u201d, or \u201cevery Monday at 7:30pm\u201d." };
  }

  const clauses = splitClauses(trimmed);
  if (!clauses.length) {
    return { ok: false, error: "What should I do when it fires? Add at least one step, e.g. \u201c\u2026and check for new files in Downloads\u201d." };
  }
  if (clauses.length > MAX_STEPS) {
    return { ok: false, error: `That\u2019s ${clauses.length} steps — automations are capped at ${MAX_STEPS} steps to keep them safe and simple.` };
  }
  const steps = clauses.map(classifyClause);

  return {
    ok: true,
    automation: { name: opts.name || makeName(sched.cron), cron: sched.cron, steps },
  };
}

module.exports = { parseAutomation, parseSchedule, parseTime, classifyClause, splitClauses, DAYS };
