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
// Round 12: "note what is on my screen" / "capture my screen as a note" —
// screenshot-to-note. Must come BEFORE the generic RE_NOTE so the phrase is
// not swallowed as a plain text note (the OCR path is the whole point).
// Matches (grouped):  a) "(note|save|capture|remember|write down) [what('s| is) ][(on my|my|the)] screen"
//                      b) "(capture|snap) the screen (and note|save it)"
const RE_SCREEN_NOTE = /^(?:nova\s*,?\s*)?(?:(?:note|save|capture|remember|write down)\s+(?:(?:what(?:'s| is)\s+)?(?:(?:on\s+)?(?:my|the)\s+)?screen))|(?:capture|snap)\s+(?:my\s+|the\s+)?screen(?:\s+and\s+(?:note|save)\s+it)?$/i;

// "remind me to call mom at 3pm" / "remind me to stand up in 30 minutes"
// Task text is everything after "remind me (to)?" up to the LAST " at/in "
// time preposition; greedy match handles "X at Y in Z" (at = clock, in = dur).
const RE_REMIND = /^remind me\s+(?:(?:to\s+)?(.+?))?\s+(?:at|in)\s+(.+)$/i;
const RE_REMIND_ONLY = /^remind me\s+(?:to\s+)?(.+)$/i;

// "add buy milk to my tasks" / "task: call dentist"
const RE_TASK_ADD = /^add\s+(.+?)\s+to my tasks$|^task[:\s]+(.+)/i;

// "what's on my task list" / "list my tasks"
const RE_TASKS_LIST = /(?:what('s| is)\s+(?:on|in)\s+my|list\s+my|show\s+my)\s+task list$|^(?:list|show)\s+(?:my\s+)?tasks$|^tasks$|what tasks do i have/i;

// Round 18: change/clear a task's due date.
//  a) "change the due date for finish report to next monday"
//     "move the deadline for finish report to friday"
//     "reschedule finish report for next week"
//  b) "finish report is now due by friday" / "finish report due next monday"
//  c) "remove the due date for finish report" / "finish report no longer has a due date"
//
// Task identification always happens against ctx.tasks (must be provided by
// the dispatcher — voice path snapshots the live store first), and a
// matched task must be PENDING (done tasks don't get rescheduled by voice).
// The verb branch (a) always runs when it matches; branches (b)/(c) only
// apply when the subject matches exactly one pending task.
// Verb forms cover both the full noun phrase ("change the due date for X to Y")
// and the shorthand "reschedule X for Y" / "reschedule X to Y".
const RE_SET_DUE_VERB = /^(?:(?:change|move|push|shift|adjust|update)\s+(?:the\s+)?(?:due\s+date|deadline|due\s+day)\s+(?:of|for|on)\s+(.+?)\s+(?:to|for|to be)\s+(.+)|reschedule\s+(.+?)\s+(?:to|for|to be)\s+(.+))$/i;
const RE_CLEAR_DUE_VERB = /^(?:remove|delete|clear|drop|cancel)\s+(?:the\s+)?(?:due\s+date|deadline)\s+(?:of|for|on)\s+(.+)$/i;
const RE_IMPLICIT_SET_DUE = /^(.+?)\s+(?:is\s+(?:now\s+|no longer\s+|)?due|due(?:\s+date)?(?:\s+is)?)\s+(?:to be\s+)?(today|tomorrow|by\s+today|by\s+tomorrow|end\s+of\s+day|by\s+tonight|tonight|this\s+weekend|next\s+week|(?:in\s+)?\d+(?:\.\d+)?\s+(?:day|week)s?|(?:next\s+)?(?:this\s+)?(?:by\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b)$/i;
// "X is no longer due" / "X has/lost/dropped its due date" / "X lost the deadline".
// Two separate alternations joined with $ anchors so the two-phrase form
// cannot be matched by a wrong first alt of a single regex.
const RE_IMPLICIT_CLEAR_DUE = /^(.+?)\s+(?:is\s+)?no\s+longer\s+due$|^(.+?)\s+(?:has|had|lost|dropped)\s+(?:a|the|its|their)\s+(due date|deadline)$/i;

/** Subject → due-date expression for the verb branches. */
function setDueClause(text) {
  let m = RE_SET_DUE_VERB.exec(text);
  if (m) {
    // Groups 1/2 = noun-phrase form ("change the due date for X to Y"),
    // groups 3/4 = shorthand ("reschedule X for Y") — whichever matched.
    const subject = (m[1] || m[3] || "").trim();
    const dueExpr = (m[2] || m[4] || "").trim();
    if (subject && dueExpr) return { subject, dueExpr };
  }
  m = RE_CLEAR_DUE_VERB.exec(text);
  if (m) return { subject: m[1], dueExpr: null, clear: true };
  return null;
}

// "mark buy milk done" / "done: call dentist" / "mark task <id> done"
const RE_TASK_DONE = /^(?:mark|set)\s+(.+?)\s+(?:as\s+)?done$|^done[:\s]+(.+)/i;

// "cancel reminder <id>" (side-panel mouse path)
const RE_REMIND_CANCEL = /^cancel reminder\s+(["“]?[\w-]+["”]?)\s*$/i;

// Round 13: "snooze 10 minutes" / "snooze it for an hour" / "snooze reminder
// for 5 minutes" — re-arms the most recently fired reminder. Bare "snooze"
// alone is accepted (defaults to 10 minutes).
const RE_SNOOZE = /^(?:snooze|pause|delay)(?:\s+(?:it|the reminder|that reminder|reminder))?(?:\s+(?:for|by))?\s*(in\s+.+|.+)?$/i;
const SNOOZE_DEFAULT_MS = 10 * 60_000; // 10 minutes

// "delete note <id>" / "delete task <id>" (side-panel mouse path)
const RE_DELETE_ID = /^delete\s+(note|task|reminder)\s+(["“]?[\w-]+["”]?)\s*$/i;

// "what did I note about dentist" / "search my notes for milk" — the bare
// "what did I note/write/say about X" phrasing belongs to the NOTES stage
// (keyword search over stored notes); the knowledge-base stage claims the
// same phrasing only with an explicit kb-context suffix ("in my kb").
const RE_SEARCH_NOTES =
  /what did i (?:note|write|say) about\s+(.+)|search my notes for\s+(.+)|notes about\s+(.+)|what('s| is) in my notes about\s+(.+)|find in my notes:\s*(.+)|find my notes on\s+(.+)/i;

// "show my notes" / "list my notes"
// Round 33: ranked TOPICAL note search — "find notes about the dog" / "any notes
// on rent increases" — scores stored note text with whole-word-over-substring
// token scoring (see notes:topic-search-notes in actions.js). Runs BEFORE the
// keyword search (RE_SEARCH_NOTES). Additive guard: the bare "notes about X"
// / "my notes on X" forms stay in the Stage 7 keyword action (byte-identical
// contract for existing users), so the topic route only triggers on explicit
// lead-ins: find/any/what-did-I-write/what-have-I-noted/tell-me-about.
const RE_TOPIC_NOTES = /^(?:nova\s*,?\s*)?(?:(?:find|any|show me)\s+(?:my\s+)?notes?\s+(?:about|on|related to)\s+(.+)|what did i write about\s+(.+)|what have i noted on\s+(.+)|tell me about my notes on\s+(.+))\s*$/i;

const RE_NOTES_LIST = /^(?:show|list|what('s| is))\s+(?:my\s+)?notes$/i;

// Round 21: "what's on my plate today" / "brief me on today" / "daily briefing"
// / "morning briefing" / "what do I have due today" — one spoken snapshot of
// today: due tasks, overdue, and reminders. Checked before the notes list so
// "brief" phrasings are never read as a search/list request.
// Round 26: question phrasings ("how's my day looking", "what's the plan for
// today") join the same test so the natural ask-and-greet shape of a voice
// assistant routes to the daily-briefing gate from the first conversation.
const RE_BRIEFING = /^(?:nova\s*,?\s*)?(?:what('s| is) on my plate today|brief me on today|(?:today|morning|daily)\s+briefing|what do i have due today|give me my briefing|how('s| is) (?:my day looking|today looking|today for me)|how does today look|what('s| is) the plan for today)\s*$/i;

// Round 23: "my week in review" / "weekly digest" / "how did my week go" —
// one spoken snapshot of the week: completed, pending, overdue, next week's
// dues, and upcoming reminders. Checked right after RE_BRIEFING so "weekly"
// phrasings never leak into list/search.
const RE_WEEKLY = /^(?:nova\s*,?\s*)?(?:my week in review|weekly digest|how did my week go|what happened this week)\s*$/i;

// Round 24: identity layer — facts the user asks Nova to remember. "remember
// I work from home on Fridays" / "remember that I like quiet mornings".
// "remember" alone is NOT a match (no fact clause follows — that reads as
// plain conversation), and the rule runs before the notes list so "remember
// my notes about X" never reads as a search. The trailing .+\S clause
// guarantees at least one non-space character after the personal-pronoun
// phrase, so "remember me" does not match.
const RE_REMEMBER_FACT = /^(?:nova\s*,?\s*)?remember(?:\s+that)?\s+(?:i|we)(?:'m|\s+am|\s+will|\s+would|\s+like|\s+love|\s+hate|\s+prefer|\s+work|\s+live)?\s+.+\S\s*$/i;
// "forget that I work from home on Fridays" / "forget I like quiet mornings"
const RE_FORGET_FACT = /^(?:nova\s*,?\s*)?forget(?:\s+that)?\s+(?:i|we)(?:'m|\s+am|\s+will|\s+would|\s+like|\s+love|\s+hate|\s+prefer|\s+work|\s+live)?\s+.+\S\s*$/i;
// "what do you know about me" / "what have i told you" / "do you know me"
const RE_USER_MODEL_ASK = /^(?:nova\s*,?\s*)?(?:what do you know about me|what have i told you|do you know me|what do you remember about me)\s*$/i;
// Round 24: greeting — "good morning nova" / "hi" / "hello" (wake-word
// phrasings). Runs after the user-model ask so "do you know me" never
// becomes a greeting; bare greetings without a wake word still match.
// NOTE: "good (morning|afternoon|evening)" takes the wake word as an optional
// TAIL ("good morning nova") — putting the tail inside the same optional
// group would make bare "good morning" require "nova" or vice versa; the
// alternation below covers both shapes explicitly.
const RE_GREETING = /^(?:nova\s*,?\s*)?(?:good\s+(?:morning|afternoon|evening)(?:\s+nova)?|hey(?:\s+nova)?|hi(?:\s+nova)?|hello(?:\s+nova)?)\s*$/i;

// Round 28: mood-aware task prioritization. "what should I work on first" /
// "prioritize my tasks" → notes:priority-check. Purely read-only (L1 SAFE):
// it answers from the pending task list + the latest mood check-in (low-
// energy moods surface the smallest tasks first). Exact-match phrases that
// run BEFORE RE_NOTE — otherwise "what should I work on first" would be
// swallowed as a plain note.
const RE_PRIORITY_CHECK = /^(?:nova\s*,?\s*)?(?:what should i work on first|prioritize my tasks|what(?:'s| is) (?:most )?urgent|what(?:'s| is) the most important(?: task)?|help me prioritize|what comes first|order my tasks|what should i do first)\s*$/i;

// Round 27: mood/energy check-in. "how am i feeling today" / "check in with
// me" → notes:mood-check (reads the latest mood fact). The question must run
// BEFORE the user-model ask branch: without it, "how am i feeling today" would
// fall through to the generic notes classifier. Explicit mood statements
// ("i feel X", "i'm feeling X") → notes:mood-statement — also before
// RE_NOTE, whose "remember that (.+)" alternations must not swallow them.
const RE_MOOD_CHECK = /^(?:nova\s*,?\s*)?(?:how am i feeling(?:\s+today)?|how am i doing(?:\s+today)?|how do i feel(?:\s+today)?|check in with me|what'?s my mood(?:\s+today)?|what is my mood(?:\s+today)?)\s*$/i;
// The statement regex demands at least one mood/energy word anywhere in the
// sentence — otherwise a plain note like "I am a developer" would get stored
// as a fact about the user instead of a note. The lexicon covers the usual
// check-in answers (energized/tired/great/down/flat/stressed/buzzing/…); a
// "today/i feel like" anchor already exists in the leading alternation, so
// the lexicon gate only adds precision without shrinking coverage.
const MOOD_LEXICON = /\b(?:feeling|feel|felt|mood|energi|tired|exhausted|drained|burnt|burned|stressed|great|awesome|amazing|wonderful|fantastic|good|bad|terrible|awful|horrible|down|low|flat|off|great|upbeat|buzzing|pumped|sluggish|foggy|rested|sleepy|anxious|calm|zen|fired|motivated|unmotivated|blah|meh|sick|under the weather|so-so|not bad)\b/i;
const RE_MOOD_STATEMENT = /^(?:nova\s*,?\s*)?(?:i feel|i'?m feeling|i am feeling|i'?ve been feeling|i'?ve been|i am|i'm|i feel like i'?m)\s+.+\S\s*$/i;

// Round 14: "how am I doing on my tasks" / "task stats" / "my completion rate"
// NOTE: the optional-group + \b combo ((?:istics)?\b) breaks under JS regex
// backtracking — use explicit alternation instead. The 'task stats(s)' branch
// excludes task-creation/mark-done phrasings ('add task …', 'mark task …
// done') via lookbehind/negative-lookahead — those belong to their own rules
// that run before/after this check.
const RE_TASK_STATS = /(?:how(?: am i|('s| is)) (?:doing (?:with|on) my|is my task))\s*tasks?\b|(?<!\badd\b\s)(?<!\bmark\b\s)\b(?:create|new)\s+task stats(?:istics)?\b|(?<!\badd\b\s)(?<!\bmark\b\s)\b(?:task stats|task statistics)\b(?!\s+(?:sheet|review|list|for|about))|\bcompletion rate\b|how many tasks have i done|my task (?:completion rate|progress|stats|statistics)/i;

// Round 30: "find tasks about the report" / "search my tasks for client" /
// "tasks with billing" — fuzzy task search (L1 SAFE read). Runs before the
// notes search ("find in my notes:") and the task list so task phrasings
// never leak into either. The subject tail is stripped of voice padding
// ("find tasks", "about", "with", "show", …) before matching against text.
// Negatives deliberately kept out: "show my task list" / "what tasks do i
// have" → task-list; "find a note about X" → notes search; "my tasks" alone
// → task-list.
const RE_TASK_SEARCH = /^(?:nova\s*,?\s*)?(?:(?:find|search|look for|show)\s+(?:my\s+)?tasks?(?:\s+(?:about|for|with|matching)\s+(.+))|(?:my\s+)?tasks?(?:\s+(?:about|for|with|matching)\s+(.+)))\s*$/i;

// Round 31: "plan my day" / "schedule my tasks" — one time-blocked spoken
// schedule built from the pending task list (overdue first, due-today next,
// time-of-day preference from the user model, mood-framed opener).
// L1 SAFE read-only: builds a plan, never acts on anything. Runs after the
// task search so "plan my day about X" still searches; the fixed phrases
// never collide with the daily briefing ("what's on my plate today") because
// the briefing phrases are questions about NOW while these are imperatives
// asking Nova to BUILD a schedule.
const RE_PLAN_DAY = /^(?:nova\s*,?\s*)?(?:plan (?:my|the|this|today's|todays) day|plan today|make a plan for today|schedule my (?:tasks|day)|build me a schedule(?: for today)?|what should my day look like|give me a plan for today|organize my day|lay out my day)\s*$/i;

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
    // Round 13: word-only quantities — "an hour", "a minute", "half an hour".
    const wordSpecs = [
      [/(?:^|\s)an?\s+hours?\b/i, 3600_000],
      [/(?:^|\s)an?\s+minutes?\b/i, 60_000],
      [/(?:^|\s)an?\s+seconds?\b/i, 1_000],
    ];
    for (const [re, ms] of wordSpecs) {
      const globalRe = new RegExp(re.source, "gi");
      for (const m of parts.matchAll(globalRe)) { totalMs += ms; matched++; }
    }
    if (/half\s+an?\s+hour\b|half\s+hour/i.test(parts)) { totalMs += 30 * 60_000; matched++; }
    if (matched) return new Date(now.getTime() + totalMs);
  }

  return null;
}

/**
 * Round 17: parse a task due-date expression. Returns a Date or null.
 * Supports: "in 3 days", "by Friday", "next Monday", "tomorrow",
 * "today", "end of day" / "by tonight", "this weekend", "next week",
 * "in 2 weeks". Times are kept day-granular (due at end of the day) so a
 * task isn't silently marked overdue because of the current hour.
 */
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEK_MS = 7 * 86_400_000;

function parseDueDate(expr, now = __nowForTesting || new Date()) {
  const e = String(expr || "").trim().toLowerCase();
  if (!e) return null;

  // "in N days", "in 2 weeks"
  const relDays = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(days?|weeks?)\b/i.exec(e);
  if (relDays) {
    const n = parseFloat(relDays[1]);
    const mult = /^week/i.test(relDays[2]) ? 7 : 1;
    const d = new Date(now);
    d.setDate(d.getDate() + Math.round(n * mult));
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // "by Friday", "Friday", "next Monday" — nearest matching weekday at EOD
  const weekday = /^((?:next\s+)?(?:this\s+)?(?:by\s+)?)(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(e);
  if (weekday) {
    const targetIdx = DAY_NAMES.indexOf(weekday[2].toLowerCase());
    if (targetIdx >= 0) {
      const todayIdx = now.getDay();
      let delta = targetIdx - todayIdx;
      const prefix = weekday[1].toLowerCase().trim();
      if (/^next/.test(prefix)) delta = delta <= 0 ? delta + 7 : delta; // next = strictly future
      else delta = delta <= 0 ? delta + 7 : delta || 7; // 'by Friday' / bare 'Friday' = upcoming
      const d = new Date(now);
      d.setDate(d.getDate() + delta);
      d.setHours(23, 59, 59, 999);
      return d;
    }
  }

  if (/^today$|^by\s+today$|end\s+of\s+day|by\s+tonight$|^tonight$/i.test(e)) {
    const d = new Date(now);
    d.setHours(23, 59, 59, 999);
    return d;
  }
  if (/^tomorrow$|^by\s+tomorrow$/i.test(e)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(23, 59, 59, 999);
    return d;
  }
  if (/^this\s+weekend$/i.test(e)) {
    const d = new Date(now);
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
    d.setHours(23, 59, 59, 999);
    return d;
  }
  if (/^next\s+week$/i.test(e)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 7);
    d.setHours(0, 0, 0, 0);
    return d;
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

// Module-level test clock (Round 17) — harnesses pin 'now' via
// setNowForTesting(date) so due-date math is deterministic. null == live clock.
let __nowForTesting = null;
function setNowForTesting(d) { __nowForTesting = d ? new Date(d) : null; }
const nowForTesting = { now() { return __nowForTesting || new Date(); } };


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

  // Round 12: screenshot-to-note — checked BEFORE the generic RE_NOTE.
  if (RE_SCREEN_NOTE.test(t)) {
    return { actionId: "notes:screen-to-note", payload: {} };
  }

  // Round 14: task stats — checked first, before every add/list/delete rule
  // so phrases like "task stats" or "task completion rate" are never read as
  // "add task 'stats'" / "delete task …".
  if (RE_TASK_STATS.test(t)) {
    return { actionId: "notes:task-stats", payload: {} };
  }

  // Round 24: identity layer — personal facts belong to the USER MODEL
  // (user-model.js), not to plain notes. These MUST run before RE_NOTE:
  // RE_NOTE's third alternation "(note down|write down|remember) that? (.+)"
  // would otherwise swallow "remember I work from home on Fridays" as a
  // plain note. Same for forget/ask/greeting.
  if (RE_FORGET_FACT.test(t)) {
    const fact = t.replace(/^(?:nova\s*,?\s*)?forget(?:\s+that)?\s+/i, "").trim();
    return fact ? { actionId: "notes:forget-fact", payload: { fact } } : { error: "Forget what about yourself? Say \"forget that I work from home on Fridays\"." };
  }
  if (RE_REMEMBER_FACT.test(t)) {
    const fact = t.replace(/^(?:nova\s*,?\s*)?remember(?:\s+that)?\s+/i, "").trim();
    if (!fact) return { error: "Remember what? Say \"remember that I work from home on Fridays\"." };
    return { actionId: "notes:remember-fact", payload: { fact } };
  }
  if (RE_USER_MODEL_ASK.test(t)) {
    return { actionId: "notes:user-model-ask", payload: {} };
  }
  if (RE_GREETING.test(t)) {
    return { actionId: "notes:greet", payload: {} };
  }
  // Round 29: focus mode / Pomodoro. "start focus mode", "focus mode for 25
// minutes", "start a pomodoro", "pomodoro for 45 min", "focus for 1 hour",
// "start 30-minute focus" → notes:focus-start with durationMin (default 25).
// "stop focus" / "end focus mode" / "quit focus" → notes:focus-stop (closes
// the running session candidly — the record says completed or cancelled).
// Runs before RE_NOTE: "note focus mode" should still be a note, which it
// is, because these are anchored exact-match sentences.
// Grouping is deliberate: every alternation owns its own '(?:nova ...)?'
// prefix AND its own duration group, and the outer '(?:…)' makes the ^/$
// anchors apply to ALL branches (top-level | would let each branch anchor
// independently — which is what caused 'end focus mode' to match via the
// 'focus mode' branch in an earlier revision). Branch 2 must keep 'start
// (a? )?pomodoro' as ONE alternation inside the group so the optional
// duration '(?: for N min)?' belongs to 'pomodoro for …', not to a bare
// 'start a pomodoro' alternation.
const RE_FOCUS_START = /^(?:(?:nova\s*,?\s*)?(?:start\s+focus\s+(?:mode|session)|start\s+(?:a\s+)?focus(?:\s+(?:mode|session))?(?:\s+for\s+(\d+(?:\.\d+)?)\s*(?:minutes?|min))?|focus\s+mode(?:\s+for\s+(\d+(?:\.\d+)?)\s*(?:minutes?|min))?)|(?:nova\s*,?\s*)?(?:start\s+(?:a\s+)?pomodoro(?:\s+for\s+(\d+(?:\.\d+)?)\s*(?:minutes?|min))?)|(?:nova\s*,?\s*)?(?:pomodoro(?:\s+for\s+(\d+(?:\.\d+)?)\s*(?:minutes?|min))?)|(?:nova\s*,?\s*)?(?:focus\s+for\s+(\d+(?:\.\d+)?)\s*(?:minutes?|min|hour|h|hours?))|(?:nova\s*,?\s*)?(?:start\s+(\d+(?:\.\d+)?)\s*(?:-\s?)?(?:minutes?|min|hour|h|hours?)\s+focus)|(?:nova\s*,?\s*)?(?:focus\s+mode(?:\s+for\s+(\d+(?:\.\d+)?)\s*(?:hours?|h|hour))?|(\d+(?:\.\d+)?)\s*(?:minutes?|min|hour|h|hours?)\s+(?:of\s+)?focus))\s*$/i;
const RE_FOCUS_STOP = /^(?:nova\s*,?\s*)?(?:stop\s+focus(?:\s+mode)?|end\s+focus(?:\s+mode)?|quit\s+focus(?:\s+mode)?|end\s+my\s+(?:focus )?session|stop\s+(?:my\s+)?(?:focus )?session|pomodoro\s+(?:done|over))\s*$/i;
// Round 32: focus-time accounting — questions about time already spent
// (read-only stats). Must sit before note/task rules; after START/STOP so
// 'start focus mode' keeps creating sessions instead of being summarized.
// Word anchors keep it out of the stats path: 'my focus stats' has no verb
// of creation, while a stats phrase never contains start/stop/quit.
const RE_FOCUS_STATS = /^(?:(?:nova\s*,?\s*)?(?:how\s+much\s+(?:time|focus(?:\s+time)?)\s+(?:did|do|have)\s+i\s+(?:focus|spend(?:ing)?(?:\s+time)?(?:\s+focusing)?|spent focusing|have))(?:\s+(?:this\s+)?(?:week|today))?|(?:nova\s*,?\s*)?(?:my\s+focus\s+(?:stats|time|minutes|total))(?:\s+(?:this\s+)?(?:week|today))?|(?:nova\s*,?\s*)?(?:how\s+many\s+pomodoros?\s+(?:did\s+i\s+do|have|in total))(?:\s+(?:this\s+)?(?:week|today))?|(?:nova\s*,?\s*)?(?:total\s+focus\s+(?:time|minutes))|(?:nova\s*,?\s*)?(?:focus\s+stats|(?:focus|pomodoro)\s+(?:time|minutes)\s+today|focus\s+time\s+this\s+week|focus\s+minutes\s+this\s+week))\s*$/i;

// Round 28: mood-aware prioritization. Exact-match read-only phrases run
  // right after mood check-in — before RE_NOTE and before every task-
  // creation/edit rule, so "prioritize my tasks" is never read as "add task
  // 'my tasks'" or "what should I work on first" as a plain note.
  if (RE_PRIORITY_CHECK.test(t)) {
    return { actionId: "notes:priority-check", payload: {} };
  }
  // Round 29: focus mode / Pomodoro — before RE_NOTE and before every
  // task-creation rule so "start focus mode" is never read as a task.
  // Round 29: focus STOP runs before START — 'end focus mode' / 'pomodoro
  // done' share the word 'focus'/'pomodoro' with start phrases, and RE_
  // FOCUS_START anchors at ^ so it can't swallow 'end/quit/pomodoro done';
  // the explicit check here exists so a stop can't accidentally fall through
  // to the start branch (they're separate anchors, order is defensive).
  if (RE_FOCUS_STOP.test(t)) {
    return { actionId: "notes:focus-stop", payload: {} };
  }
  if (RE_FOCUS_START.test(t)) {
    const mm = RE_FOCUS_START.exec(t);
    // mm[1..7] = the captured duration groups from each alternation branch;
    // exactly one branch matches, so at most one group is populated.
    const raw = (mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6] || mm[7] || "").trim();
    let durationMin = 25; // Pomodoro default
    if (raw) {
      const n = parseFloat(raw);
      // An hour unit anywhere in the matched sentence means the captured
      // number is in hours (mm[4] 'focus for X hour', mm[5] 'start X-hour
      // focus', mm[6] 'focus mode for X hours').
      const hourUnit = /\b(?:h|hour|hours)\b/i.test(t);
      if (Number.isFinite(n) && n > 0) durationMin = Math.round(hourUnit ? n * 60 : n);
    }
    return { actionId: "notes:focus-start", payload: { durationMin } };
  }
  // Round 32: focus stats — read-only accounting; the payload carries the
  // pinned test clock (same discipline as plan-day) so trailing-7-day and
  // today math stay deterministic in tests.
  if (RE_FOCUS_STATS.test(t)) {
    return { actionId: "notes:focus-stats", payload: { now: nowForTesting.now().getTime() } };
  }
  // Round 27: mood/energy check-in. Questions run first (they're exact-match
  // phrases, so they can't accidentally swallow real notes).
  if (RE_MOOD_CHECK.test(t)) {
    return { actionId: "notes:mood-check", payload: {} };
  }
  if (RE_MOOD_STATEMENT.test(t) && MOOD_LEXICON.test(t)) {
    const fact = t.replace(/^(?:nova\s*,?\s*)?/i, "").trim();
    if (!fact) return { error: "Mood what, exactly? Try \"I feel energized today\"." };
    return { actionId: "notes:mood-statement", payload: { fact } };
  }

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

  // Round 17: "add finish report to my tasks by Friday" / "task fix bug due in 3 days"
  // RE_TASK_ADD is anchored (…to my tasks$), so a trailing due clause must be
  // stripped FIRST; the bare task then matches the normal add rule.
  const DUE_CLAUSE = /\s+(?:by|due|due by|due on)\s+((?:in\s+\d+(?:\.\d+)?\s+(?:day|week)s?|\d+(?:\.\d+)?\s+(?:day|week)s?|(?:next\s+)?(?:this\s+)?(?:by\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|today|by\s+today|tomorrow|by\s+tomorrow|end\s+of\s+day|by\s+tonight|tonight|this\s+weekend|next\s+week))$/i;
  let dueExpr = null;
  let taskSubject = t;
  const dm = DUE_CLAUSE.exec(t);
  if (dm) {
    const stripped = t.slice(0, dm.index).trim();
    // Only strip when the remainder still looks like a task request — avoids
    // mangling unrelated sentences that merely end with "by Friday".
    if (stripped && (/^add\s+.+$/i.test(stripped) || /^task[:\s]+.+$/i.test(stripped))) {
      taskSubject = stripped;
      dueExpr = dm[1];
    }
  }
  m = RE_TASK_ADD.exec(taskSubject);
  if (m) {
    let taskText = (m[1] || m[2] || "").trim();
    if (!taskText) return { error: "Add what to your tasks? Try \"add buy milk to my tasks\"." };
    let dueDate = dueExpr ? parseDueDate(dueExpr, nowForTesting.now()) : null;
    const payload = { text: taskText };
    if (dueDate) payload.dueDate = dueDate.toISOString();
    return { actionId: "notes:add-task", payload };
  }
  if (dueExpr && !m) {
    return { error: "That looks like a task with a due date. Say \"add finish the report to my tasks by Friday\" so I can file it properly." };
  }

  // Round 30: task search runs before the task list — "tasks with billing"
  // is a search, "my tasks" alone is the list (the regex tail requires a
  // preposition + content).
  m = RE_TASK_SEARCH.exec(t);
  if (m) {
    // m[1]/m[2] = the tail after about/for/with/matching (exactly one branch)
    let raw = (m[1] || m[2] || "").trim();
    // Strip the last accidental preposition word if it swallowed none (e.g.
    // "find tasks about") — the tail must carry at least one content word.
    raw = raw.replace(/^(?:about|for|with|matching)\s*/i, "").trim();
    if (!raw) return { error: "Find tasks about what? Try \"find tasks about the report\"." };
    return { actionId: "notes:task-search", payload: { query: raw } };
  }

  // Round 31: "plan my day" — one time-blocked schedule built from the
  // pending task list (overdue first, due-today next, rest by size),
  // reordered by the user's time-of-day preference and opened with a
  // mood-framed line when the latest check-in is recent. L1 SAFE read.
  if (RE_PLAN_DAY.test(t)) {
    return { actionId: "notes:plan-day", payload: { now: nowForTesting.now().getTime() } };
  }

  if (RE_TASKS_LIST.test(t)) {
    return { actionId: "notes:list-tasks", payload: {} };
  }

  // Round 18: change/clear a due date. Needs ctx.tasks (dispatcher always
  // snapshots the live store), so voice is the primary path.
  const vc = setDueClause(t);
  if (vc) {
    if (!ctx.tasks || !ctx.tasks.length) {
      return { error: "Your task list is empty — nothing to reschedule." };
    }
    const pend = ctx.tasks.filter((x) => !x.done);
    const subj = vc.subject.trim();
    const task = findById(pend, subj) || matchTask(pend, subj);
    if (!task) return { error: `I could not find a pending task matching "${subj}" to reschedule.` };
    if (vc.clear) {
      return { actionId: "notes:set-task-due", payload: { id: task.id, text: task.text, dueDate: null, oldDueDate: task.dueDate || null } };
    }
    const due = parseDueDate(vc.dueExpr, nowForTesting.now());
    if (!due) return { error: `I could not parse "${vc.dueExpr}" as a due date. Try "next monday", "in 3 days", or "by friday".` };
    return { actionId: "notes:set-task-due", payload: { id: task.id, text: task.text, dueDate: due.toISOString(), oldDueDate: task.dueDate || null } };
  }
  // Implicit forms: "finish report is now due by friday" / "fix bug due next monday"
  // Clear forms MUST be checked before the set forms — "finish report dropped
  // its due date" would otherwise match the set branch's "due date" middle.
  const ic = RE_IMPLICIT_CLEAR_DUE.exec(t);
  if (ic) {
    if (ctx.tasks && ctx.tasks.length) {
      const pend = ctx.tasks.filter((x) => !x.done);
      const subj = (ic[1] || ic[2]).trim();
      const task = findById(pend, subj) || matchTask(pend, subj);
      if (task) return { actionId: "notes:set-task-due", payload: { id: task.id, text: task.text, dueDate: null, oldDueDate: task.dueDate || null } };
    }
    return { error: "I could not find that task on your list — name it exactly, e.g. \"remove the due date for finish report\"." };
  }
  // Round 21: daily briefing — MUST run before the implicit set-due branch:
  // "what do i have due today" matches RE_IMPLICIT_SET_DUE (it ends in
  // "…due today"), and the fallback below would read an undefined `subj`.
  if (RE_BRIEFING.test(t)) {
    return { actionId: "notes:daily-briefing", payload: {} };
  }
  // Round 23: weekly digest — same placement logic as RE_BRIEFING.
  if (RE_WEEKLY.test(t)) {
    return { actionId: "notes:weekly-digest", payload: {} };
  }
  const im = RE_IMPLICIT_SET_DUE.exec(t);
  if (im) {
    // subj hoisted outside the if-block: the fallback below (no store ctx /
    // no matching task) also needs it — the old const declaration was block-
    // scoped and made the fallback ReferenceError (pre-existing latent bug,
    // only triggered when ctx.tasks is empty or no task matches).
    const subj = im[1].replace(/\s+is\s+(?:now\s+|no longer\s+|)?due$|\s+due\s+date\s+is$|\s+due$|^due\s+date\s+is\s+/i, "").trim();
    if (ctx.tasks && ctx.tasks.length) {
      const pend = ctx.tasks.filter((x) => !x.done);
      const task = findById(pend, subj) || matchTask(pend, subj);
      if (task) {
        const due = parseDueDate(im[2], nowForTesting.now());
        return { actionId: "notes:set-task-due", payload: { id: task.id, text: task.text, dueDate: due.toISOString(), oldDueDate: task.dueDate || null } };
      }
    }
    // No store ctx (no pending task matched) → route it to creation instead
    // of misfiling it as a task-less edit.
    const payload = { text: subj || t };
    if (parseDueDate(im[2], nowForTesting.now())) payload.dueDate = parseDueDate(im[2], nowForTesting.now()).toISOString();
    return { actionId: "notes:add-task", payload };
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

  // Round 13: snooze — checked BEFORE cancel/lookup rules.
  m = RE_SNOOZE.exec(t);
  if (m) {
    const expr = (m[1] || "").trim() || null;
    let dueAt = null;
    if (expr) {
      // "snooze 10 minutes" → expr "10 minutes"; "snooze in 10 minutes" → "in 10 minutes".
      dueAt = parseTime(expr);
    }
    if (!dueAt) dueAt = new Date(Date.now() + SNOOZE_DEFAULT_MS);
    return { actionId: "notes:snooze-reminder", payload: { dueAt: dueAt.toISOString(), seconds: Math.round((dueAt.getTime() - Date.now()) / 1000) } };
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

  // Round 33: topical ranked search. Runs before the keyword search so
  // "find notes about X" never falls back to the unranked contains-match.
  m = RE_TOPIC_NOTES.exec(t);
  if (m) {
    // Any non-empty topic group wins; groups in alternation order (find/any —
    // write-about — noted-on — tell-me-about).
    const subject = (m[1] || m[2] || m[3] || m[4] || "").trim();
    if (!subject) return { error: "Search your notes for what? Try \"find notes about the report\"." };
    return { actionId: "notes:topic-search-notes", payload: { subject } };
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
  planNoteAction, parseTime, parseDueDate, setNowForTesting, matchTask, findById,
  RE_NOTE, RE_REMIND, RE_TASK_ADD, RE_TASKS_LIST, RE_TASK_DONE,
  RE_SEARCH_NOTES, RE_NOTES_LIST, RE_DELETE, RE_DELETE_ID, RE_REMIND_CANCEL, RE_SUMMARIZE,
  RE_SNOOZE, RE_TASK_STATS,
  RE_SET_DUE_VERB, RE_CLEAR_DUE_VERB, RE_IMPLICIT_SET_DUE, RE_IMPLICIT_CLEAR_DUE,
  setDueClause,
};
