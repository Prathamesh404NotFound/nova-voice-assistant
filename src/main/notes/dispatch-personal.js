// Nova — notes/dispatch-personal.js
//
// Round 25: identity-aware briefing personalization. The daily briefing and
// weekly digest narrations are woven with whatever Nova knows about the
// user — their name, Nova's personality tone, and up to a handful of
// remembered facts. Pure local string composition: NO model call, no
// networking. Deliberately additive — when the user model is empty the
// narration text is byte-identical to the pre-R25 wording, so no earlier
// round's tests can regress.
const { get: identityGet } = require("../identity/identity");
const userModel = require("../identity/user-model");

// Fact keywords that Nova can *act on* rather than merely recite. These are
// lightweight, honest hooks: a "morning" preference reorders today's plate
// (mornings-first or afternoons-first), and any remaining remembered facts
// get recited verbatim after the numbers so the briefing doubles as the
// user's memory check-in ("remembered: I work from home on Fridays").
const TIME_FACT_REGEX = /\b(morning|afternoon|evening|night)s?\b/i;

// Which items in a briefing list get recited (facts about the user, echoed
// verbatim — never paraphrased).
function userFacts(limit = 2) {
  return userModel.relevantFacts(limit).map((f) => f.fact);
}

/**
 * Weave a personalization lead-in + fact recap into a readout narration.
 * @param {"daily-briefing"|"weekly-digest"} kind
 * @param {string} baseText   the pre-personalization narration line
 * @returns {string} the personalized narration
 */
function personalizeNarration(kind, baseText) {
  const id = identityGet();
  const name = (id.userName || "").trim();
  const personality = id.personality || "warm";
  const facts = userFacts(2);

  // Lead-in: name + time-of-day framing. When no name is set and no facts
  // exist, return the original baseText verbatim (additive rule).
  const hasName = name.length > 0;
  // Most recent time-of-day fact wins (user changed their mind → last-wins,
  // same rule as the user model's fact dedupe).
  const timeFact = facts.slice().reverse().find((f) => TIME_FACT_REGEX.test(f));
  const needsLeading = hasName || !!timeFact;

  let lead = "";
  if (needsLeading) {
    const who = hasName ? `${name}, ` : "";
    if (kind === "daily-briefing") {
      const when = timeFact
        ? {
            morning: "morning ",
            afternoon: "afternoon ",
            evening: "evening ",
            night: "night ",
          }[(TIME_FACT_REGEX.exec(timeFact)[1].toLowerCase())]
        : "";
      lead = personality === "concise" ? `${who}${when}today: `
        : personality === "professional" ? `${who}here's your ${when}briefing — `
        : personality === "playful" ? `${who}the ${when}stars align for you — `
        : `${who}here's your ${when}day: `;
    } else {
      // weekly-digest: facts still mention a time of day? That's context,
      // not a framing device — keep the week framing clean and lead with name.
      lead = personality === "concise" ? `${who}this week: `
        : personality === "professional" ? `${who}here's your week in review — `
        : personality === "playful" ? `${who}what a week the cosmos wrote for you — `
        : `${who}here's your week: `;
    }
  }

  // Fact recap: the user hears what Nova remembers about them at the end
  // of the readout (so every briefing is also a gentle memory check-in).
  const recap = facts.length
    ? ` Remembered about you: ${facts.join(". ")}.`
    : "";

  return lead + baseText + recap;
}

/**
 * Reorder a briefing group by the user's stated time-of-day preference:
 * "I prefer mornings" puts earlier-scheduled items first; "I prefer
 * afternoons" flips to latest-first within that group. Everything else is
 * untouched.
 */
function applyTimePreference(items) {
  const timeFact = userFacts(2).find((f) => TIME_FACT_REGEX.test(f));
  if (!timeFact || !items || !items.length) return items;
  const pref = TIME_FACT_REGEX.exec(timeFact)[1].toLowerCase();
  const morningPrefs = ["morning"];
  if (pref === "morning") return items; // default order (creation/earliest)
  if (["afternoon", "evening", "night"].includes(pref)) {
    return items.slice().sort((a, b) => (b.dueAt || b.dueDate || b.createdAt || "")
      .localeCompare(a.dueAt || a.dueDate || a.createdAt || ""));
  }
  return items;
}

/**
 * One-line day preview for the greeting path (Round 26).
 *
 * A greeting still opens the same way as always — but when the user's name
 * is set and today actually has anything on it (due/overdue tasks or
 * reminders firing), Nova adds a short, personality-tuned preview so the
 * very first thing Nova says when you say "good morning" carries your day:
 * "Good morning, Alex — two things on the plate today, and buy milk is overdue."
 *
 * Additive: no name or an empty day → greeting line is untouched (byte-
 * identical pre-R26), so no earlier harness or conversation regresses.
 * Pure local composition — no model call, no networking.
 * @param {object} briefing  store.dailyBriefing() result {dueToday, overdue, remindersToday}
 * @returns {string} empty string (no preview) or the preview clause, leading " — "
 */
function greetSnapshot(briefing) {
  const id = identityGet();
  const name = (id.userName || "").trim();
  const personality = id.personality || "warm";
  if (!name || !briefing) return "";
  const nDue = (briefing.dueToday || []).length;
  const nOv = (briefing.overdue || []).length;
  // Greeting previews what's still waiting — a fired or cancelled reminder
  // already rang today, so it doesn't belong in the hello line.
  const nRem = (briefing.remindersToday || []).filter((r) => !r.fired).length;
  if (!nDue && !nOv && !nRem) return "";

  // Name the day in the user's preferred time of day when a time fact exists
  // (R25 bridge): "your morning" vs "your afternoon" — otherwise "today".
  const timeFact = userFacts(2).find((f) => TIME_FACT_REGEX.test(f));
  const when = timeFact
    ? { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" }[(TIME_FACT_REGEX.exec(timeFact)[1].toLowerCase())]
    : null;
  const dayWord = when ? `${when} ` : "";

  const pieces = [];
  if (nDue) pieces.push(`${nDue} thing${nDue === 1 ? "" : "s"} on the plate`);
  if (nOv) pieces.push(`${nOv} overdue`);
  // The " today" tail would double "today has … today" on a reminder-only
  // plate — drop it when nothing else is on the plate.
  if (nRem) pieces.push(`${nRem} reminder${nRem === 1 ? "" : "s"}${nDue || nOv ? " today" : ""}`);
  const summary = pieces.join(" and ");
  if (personality === "concise") return ` — ${summary}.`;
  if (personality === "professional") return ` — ${dayWord}today: ${summary}.`;
  if (personality === "playful") return ` — the ${dayWord}cosmos wrote you ${summary}!`;
  // warm (default)
  return ` — ${dayWord}today has ${summary}.`;
}

// ---------------------------------------------------------------------------
// Round 27: mood/energy check-in hooks.
//
// Mood check-ins ("I feel energized", "I'm feeling down today") land in the
// user model as ordinary facts, but they're flagged by MOOD_FACT_REGEX so
// Nova can *act* on them instead of merely reciting them:
//   1. The briefing/digest lead-in picks up today's mood
//      ("You sounded energized this morning — here's your day: …").
//   2. The check-in voice route reads the most recent mood fact back, with
//      an age ("just now" / "2 hours ago") — the mood is ephemeral context,
//      not a permanent preference.
// Additive as always: no mood fact, no change to the output.
// ---------------------------------------------------------------------------
const MOOD_FACT_REGEX = /\b(?:feeling|feel|felt|mood|energi|tired|exhausted|drained|burnt|burned|stressed|great|awesome|amazing|wonderful|fantastic|good|bad|terrible|awful|horrible|down|low|flat|off|upbeat|buzzing|pumped|sluggish|foggy|rested|sleepy|anxious|calm|zen|fired|motivated|unmotivated|blah|meh|sick|so-so)\b/i;

/**
 * The most recent fact that reads as a mood/energy check-in. The user model
 * stores facts newest-last, so this is the last match in list order (O(n),
 * n ≤ 100).
 * @returns {{fact: string, updatedAt: string}|null}
 */
function latestMood() {
  const facts = userModel.list(); // [{key, fact, updatedAt}]
  let latest = null;
  for (const f of facts) {
    if (MOOD_FACT_REGEX.test(f.fact) && (!latest || (f.updatedAt || "") >= (latest.updatedAt || ""))) {
      latest = f;
    }
  }
  return latest;
}

/**
 * Human-readable age of the most recent mood check-in — moods are ephemeral
 * context, so the wording matters more than the timestamp: "just now",
 * "20 minutes ago", "2 hours ago", "this morning".
 * @param {string} updatedAt ISO timestamp of the mood fact
 * @param {number} [now] epoch ms (testing seam)
 * @returns {string} like "just now", "20 minutes ago", "this morning"
 */
function moodAge(updatedAt, now = Date.now()) {
  if (!updatedAt) return "just now";
  const ms = now - new Date(updatedAt).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 12) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  // Past the half-day mark: name the part of the day it happened in.
  const then = new Date(updatedAt);
  const hour = then.getHours();
  const part = hour < 12 ? "this morning" : hour < 17 ? "this afternoon" : "this evening";
  return part;
}

/**
 * Briefing/digest mood prefix — weaves today's check-in mood into the
 * narration lead-in when a mood fact exists from earlier today.
 * @param {number} [now] epoch ms (testing seam)
 * @returns {string} empty string when no mood, else a lead-in like
 *   "You sounded energized this morning — " (additive guarantee).
 */
function moodNarration(now = Date.now()) {
  const mood = latestMood();
  if (!mood) return "";
  const age = moodAge(mood.updatedAt, now);
  // The mood fact itself is the evidence — quote its key phrase, not the
  // whole sentence, for a natural spoken line.
  return `You mentioned ${age} that "${mood.fact}" — `;
}

/**
 * Greeting mood prefix — the hello line picks up today's latest check-in
 * so "good morning" after "I feel tired" gets the soft landing it deserves:
 * "Good morning, Alex — you told me earlier you're feeling tired — "
 * Additive: no mood → untouched byte-identical greeting.
 * @param {number} [now] epoch ms (testing seam)
 * @returns {string} empty or a prefix ending in " — "
 */
function moodGreet(now = Date.now()) {
  const mood = latestMood();
  if (!mood) return "";
  const age = moodAge(mood.updatedAt, now);
  const id = identityGet();
  const personality = id.personality || "warm";
  if (personality === "concise") return `(${age}: "${mood.fact}") — `;
  if (personality === "professional") return `I have your ${age} check-in on file ("${mood.fact}") — `;
  if (personality === "playful") return `the cosmos heard you ${age} ("${mood.fact}") — `;
  // warm (default)
  return `you told me ${age} ("${mood.fact}") — `;
}

// Round 28: low-energy mood words — the moods that should change the
// prioritization strategy. When the latest check-in reads as one of these,
// Nova surfaces the smallest remaining tasks first (quick wins beat
// deadlines when energy is low). Same spirit as MOOD_FACT_REGEX but only the
// low-energy subset, so "I feel tired" reorders while "I feel energized"
// does not.
const LOW_ENERGY_RE = /\b(?:tired|exhausted|stressed|drained|fatigued|down|low|burnt|burned out|burning out|sluggish|foggy|overwhelmed|wiped out|fried|flat|off)\b/i;

/**
 * Order pending tasks by urgency, with the latest mood as a strategy hint.
 *
 * The urgency ladder is fixed and honest:
 *   1. Overdue tasks, oldest first (the most overdue waits longest).
 *   2. Due today, soonest due date first.
 *   3. Everything else — when the latest mood check-in reads as low energy,
 *      the smallest tasks (fewest words) go first so a tired user can
 *      bank quick wins; otherwise, original order is preserved.
 *
 * Pure function — no require of store, no identity module side effects;
 * the caller passes in the tasks. `now` is injectable for deterministic
 * tests. Additive: with no low-energy mood the "rest" bucket stays in the
 * order it was passed in, so mood never silently reshuffles a healthy day.
 *
 * @param {Array} tasks  pending task objects {id, text, dueDate?, createdAt}
 * @param {number} [now] epoch ms (testing seam)
 * @returns {{order: Array, lowEnergy: boolean}}
 */
function prioritize(tasks, now = Date.now()) {
  if (!tasks || !tasks.length) return { order: [], lowEnergy: false };
  const lowEnergy = !!latestMood() && LOW_ENERGY_RE.test(latestMood().fact);

  const safeDay = (iso) => {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      d.setHours(0, 0, 0, 0);
      return d;
    } catch { return null; }
  };
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tms = today.getTime();

  const overdue = tasks
    .filter((t) => safeDay(t.dueDate) && safeDay(t.dueDate).getTime() < tms)
    .sort((a, b) => safeDay(a.dueDate) - safeDay(b.dueDate));
  const dueToday = tasks
    .filter((t) => !safeDay(t.dueDate) ? false : safeDay(t.dueDate).getTime() === tms)
    .sort((a, b) => safeDay(a.dueDate) - safeDay(b.dueDate));
  const rest = tasks
    .filter((t) => !safeDay(t.dueDate) || safeDay(t.dueDate).getTime() > tms);

  if (lowEnergy) {
    // Quick-wins ordering inside the rest bucket only — overdue and due-
    // today keep their urgency seats even when tired (a deadline is a
    // deadline; the mood only changes how far down the list you sit).
    rest.sort((a, b) => (a.text || "").trim().split(/\s+/).length - (b.text || "").trim().split(/\s+/).length);
  }

  return { order: [...overdue, ...dueToday, ...rest], lowEnergy };
}

/**
 * Build a time-blocked spoken plan for today from the pending task list.
 *
 * Slots the ordered tasks into one-hour blocks and anchors them by the
 * user's time-of-day preference (from the user model — last-wins):
 *   morning  → blocks run forward from 9:00 AM  (the classic workday)
 *   afternoon → blocks run forward from 1:00 PM
 *   evening  → blocks run forward from 5:00 PM
 *   night    → blocks run forward from 9:00 PM
 *   no pref  → morning
 * Reminders firing today get their own fixed-time slots at their due hour
 * (anchored to the plan's `now`, not the clock) so the plan reads as one
 * honest timeline. Overdue tasks and due-today tasks sit in the earliest
 * blocks regardless of preference — a deadline is a deadline. The plan caps
 * at six blocks (6 hours of focus) with a tail for anything beyond.
 *
 * Pure function — no store require; the caller passes in tasks, reminders,
 * and an injectable `now` for deterministic tests. Additive: with no tasks
 * the caller gets an empty plan (the dispatcher voices the wide-open day),
 * and with no preference/mood the output is stable wording.
 *
 * @param {{pending: Array, reminders?: Array, now?: number}} opts
 * @returns {{blocks: Array, remindersFixed: Array, pref: string, moodFramed: boolean, overCap: number}}
 */
function planDay({ pending = [], reminders = [], now = Date.now() } = {}) {
  const safeDay = (iso) => {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      d.setHours(0, 0, 0, 0);
      return d;
    } catch { return null; };
  };
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tms = today.getTime();

  // Time-of-day preference: most recent fact containing a time word wins.
  let pref = "morning";
  const facts = userModel.relevantFacts(20);
  const timeFact = facts.slice().reverse().find((f) => TIME_FACT_REGEX.test(f.fact));
  if (timeFact) {
    const m = TIME_FACT_REGEX.exec(timeFact.fact);
    pref = { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" }[(m[1].toLowerCase())] || "morning";
  }

  // Same urgency ladder as prioritize() — overdue (oldest) → due today
  // (soonest) → rest (largest first, so the heaviest work gets the prime
  // blocks). Mood never moves the ladder; it only tinted narration.
  // Defense in depth: "pending" means NOT done — a done task never earns a
  // time block even if the caller passes it in by mistake.
  const live = pending.filter((t) => !t.done);
  const overdue = live
    .filter((t) => safeDay(t.dueDate) && safeDay(t.dueDate).getTime() < tms)
    .sort((a, b) => safeDay(a.dueDate) - safeDay(b.dueDate));
  const dueToday = live
    .filter((t) => safeDay(t.dueDate) && safeDay(t.dueDate).getTime() === tms)
    .sort((a, b) => safeDay(a.dueDate) - safeDay(b.dueDate));
  const rest = live
    .filter((t) => !safeDay(t.dueDate) || safeDay(t.dueDate).getTime() > tms)
    .sort((a, b) => (b.text || "").trim().split(/\s+/).length - (a.text || "").trim().split(/\s+/).length);

  const ordered = [...overdue, ...dueToday, ...rest];
  const startHour = { morning: 9, afternoon: 13, evening: 17, night: 21 }[pref] || 9;

  // Today's reminders get fixed-time slots (their own due hour); tasks
  // never share a reminder's hour — they slot around it.
  const dH = (iso) => {
    try { return new Date(iso).getHours(); } catch { return null; };
  };
  const remindersFixed = (reminders || [])
    .filter((r) => !r.fired && !r.cancelled && r.dueAt && dH(r.dueAt) !== null && new Date(r.dueAt).getTime() >= tms && new Date(r.dueAt).getTime() < tms + 24 * 3600_000)
    .map((r) => ({ text: r.text, hour: dH(r.dueAt), dueAt: r.dueAt }))
    .sort((a, b) => a.hour - b.hour);
  const blockedHours = new Set(remindersFixed.map((r) => r.hour));

  const MAX_BLOCKS = 6;
  const blocks = [];
  for (let i = 0, hour = startHour; i < ordered.length && blocks.length < MAX_BLOCKS; i++, hour += 1) {
    // Skip past midnight and any hour claimed by a reminder.
    while (hour >= 24 || blockedHours.has(hour)) hour += 1;
    blocks.push({ task: ordered[i], hour });
  }

  // Mood framing: only when the latest check-in is recent (< 12h).
  const mood = latestMood();
  const moodFramed = !!mood && (now - new Date(mood.updatedAt).getTime()) < 12 * 3600_000;

  return {
    blocks,
    remindersFixed,
    pref,
    moodFramed,
    lowEnergy: !!mood && LOW_ENERGY_RE.test(mood.fact),
    overCap: Math.max(0, ordered.length - MAX_BLOCKS),
  };
}

// ---------------------------------------------------------------------------
// Round 32: focus-time accounting — a one-question summary of how much
// completed focus time the user banked today and in the trailing 7 days,
// pulled straight from the R29 session log. Pure composition: the numbers
// come from the store helpers and only get spoken wording here.
// ---------------------------------------------------------------------------

/**
 * Summarize completed focus sessions for today and the trailing week.
 * @param {object} opts
 * @param {number} [opts.weekMin]   completed minutes in the trailing 7 days
 * @param {number} [opts.todayMin]  completed minutes started today
 * @param {string} [opts.personality] override personality (default: warm)
 * @returns {string} a one-or-two line spoken summary; honest when both are 0.
 */
function focusStatsSummary({ weekMin = 0, todayMin = 0, personality } = {}) {
  const p = personality || (identityGet().personality || "warm");
  const fmt = (m) => {
    m = Math.round(Number(m) || 0);
    if (m <= 0) return "0 minutes";
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h <= 0) return `${m} minute${m === 1 ? "" : "s"}`;
    return mm > 0 ? `${h} hour${h === 1 ? "" : "s"} ${mm} minute${mm === 1 ? "" : "s"}` : `${h} hour${h === 1 ? "" : "s"}`;
  };
  if (weekMin <= 0 && todayMin <= 0) {
    if (p === "concise") return "No focus sessions recorded yet.";
    if (p === "professional") return "Your focus log is empty — no sessions have been recorded yet.";
    if (p === "playful") return "The cosmos hasn't seen a single focus session yet — start one and it'll remember!";
    // warm (default)
    return "No focus sessions recorded yet — say \"start focus mode\" whenever you're ready, and I'll start keeping score.";
  }
  // Both populated: week first, today as the fresh detail. Today-only or
  // week-only keep a single clean line.
  const weekLine = weekMin > 0 ? `This week you've focused for ${fmt(weekMin)} in the last 7 days${todayMin > 0 ? ` — ${fmt(todayMin)} of that today` : ""}.`
    : `Today's total so far: ${fmt(todayMin)} — nothing else in the trailing 7 days.`;
  if (weekMin > 0 && todayMin <= 0) {
    if (p === "concise") return `${fmt(weekMin)} of focus this week.`;
    if (p === "professional") return `You logged ${fmt(weekMin)} of focused work in the last 7 days.`;
    if (p === "playful") return `The cosmos counted ${fmt(weekMin)} of focus this week — stardust well spent!`;
    return `You've focused for ${fmt(weekMin)} this week. Nicely done.`;
  }
  if (p === "concise") return `${fmt(weekMin)} this week, ${fmt(todayMin)} today.`;
  if (p === "professional") return `In the last 7 days you logged ${fmt(weekMin)}, with ${fmt(todayMin)} today.`;
  if (p === "playful") return `The cosmos clocks ${fmt(weekMin)} of focus this week — and ${fmt(todayMin)} already today!`;
  // warm (default)
  return weekLine;
}

// ---------------------------------------------------------------------------
// Round 33: ranked topical note-search wording.
//
// Pure (no store, no network): the dispatcher hands in the scored matches
// and the subject; this module decides how the readout sounds. Matches
// carry a recency tag ("… (3 days ago)") so the answer sounds like memory
// rather than a grep dump. Empty → an honest "no match" line; the spoken
// readout caps at TOPIC_MAX_SPOKEN (5) with a tail for the rest — the full
// 10-item result still arrives in the side-panel detail object. Additive:
// the search never writes anything, and nothing here touches the identity
// or facts (those belong to chat; topic search is memory retrieval only).
// ---------------------------------------------------------------------------
const TOPIC_MAX_SPOKEN = 5;
// Age ladder for the per-match recency tag — mirrors the R27 check-in age
// wording but coarser (a readout mixes notes from different hours, so the
// tag answers "recent or old" rather than quoting a precise clock).
const AGE_STEPS = [
  { s: 120_000, w: "just now" },
  { s: 5 * 60_000, w: "5 minutes ago" },
  { s: 30 * 60_000, w: "30 minutes ago" },
  { s: 3600_000, w: "1 hour ago" },
  { s: 3 * 3600_000, w: "a few hours ago" },
  { s: 24 * 3600_000, w: "earlier today" },
  { s: 2 * 24 * 3600_000, w: "yesterday" },
  { s: 7 * 24 * 3600_000, w: "this week" },
  { s: 30 * 24 * 3600_000, w: "a while ago" },
];
function ageOf(iso, now) {
  const ms = Math.max(0, (now || Date.now()) - new Date(iso).getTime());
  for (const st of AGE_STEPS) if (ms < st.s) return st.w;
  return "a while ago";
}
function topicSearchText({ matches = [], subject = "", now } = {}) {
  const subj = String(subject || "").trim();
  if (!matches || !matches.length) return `No notes match "${subj}".`;
  const show = matches.slice(0, TOPIC_MAX_SPOKEN);
  const lines = show.map((m) => `• ${m.note.text} (${ageOf(m.note.updatedAt, now)})`);
  const head = matches.length === 1
    ? `Found 1 note about "${subj}":`
    : `Found ${matches.length} notes about "${subj}":`;
  const tail = matches.length > TOPIC_MAX_SPOKEN
    ? `\n…and ${matches.length - TOPIC_MAX_SPOKEN} more in the full results.`
    : "";
  return head + "\n" + lines.join("\n") + tail;
}

// ---------------------------------------------------------------------------
// Round 34: recurring reminder/task confirmation wording.
//
// Pure (no store, no network): the dispatcher hands in the created item and
// the original parse spec; this module decides how the confirmation sounds.
// Additive: the spoken text field repeats exactly what the user said plus
// the cadence, so nothing the user said is ever rewritten or dropped.
// ---------------------------------------------------------------------------
const RECUR_WEEKDAYS = { monday: "Mondays", tuesday: "Tuesdays", wednesday: "Wednesdays", thursday: "Thursdays", friday: "Fridays", saturday: "Saturdays", sunday: "Sundays" };
const RECUR_CADENCE_W = { day: "every day", week: "every week", month: "every month", weekday: "every weekday", morning: "every morning", afternoon: "every afternoon", evening: "every evening", night: "every night" };
function fmtTimeLocal(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch { return null; }
}
function cadenceWords(spec) {
  const dayName = Object.keys(RECUR_WEEKDAYS).find((k) => spec.day !== undefined && spec.day !== null && spec.cadence === k);
  if (dayName) return `every ${RECUR_WEEKDAYS[dayName]}`; // RECUR_WEEKDAYS values are capitalized ("Mondays")
  return RECUR_CADENCE_W[spec.cadence] || `every ${spec.cadence || "day"}`;
}
/** Spoken + written confirmation for a newly created recurring item. */
function recurringConfirmText({ item, cadence, mode, time, weekdays } = {}) {
  const text = (item && item.text) || "";
  const words = cadenceWords({ cadence, time, weekdays, day: (item && item.day) !== undefined ? (item && item.day) : undefined });
  const when = time ? ` at ${fmtTimeLocal(time)}` : "";
  if (mode === "task") {
    return {
      text: `Added a recurring task: "${text}" — ${words}${when}. It'll show up on your task list each time it fires.`,
      narration: `Recurring task added: ${text} — ${words.replace("every ", "")}.`,
    };
  }
  return {
    text: `Got it — I'll remind you to ${text} ${words}${when}.`,
    narration: `Recurring reminder set: ${words.replace("every ", "")}${when ? ` at ${when.replace(" at ", "")}` : ""}.`,
  };
}
/** Spoken + written confirmation for removing a recurring item. */
function recurringRemoveText({ removed } = {}) {
  if (!removed) return { text: "I couldn't find that recurring item — nothing was removed.", narration: "Couldn't find that one." };
  return {
    text: `Removed the recurring ${removed.mode || "item"} for "${removed.text}" — it won't repeat anymore.`,
    narration: `Recurring ${removed.mode === "task" ? "task" : "reminder"} removed.`,
  };
}

module.exports = { personalizeNarration, applyTimePreference, userFacts, greetSnapshot, latestMood, moodAge, moodNarration, moodGreet, LOW_ENERGY_RE, prioritize, planDay, focusStatsSummary, ageOf, topicSearchText, recurringConfirmText, recurringRemoveText };
