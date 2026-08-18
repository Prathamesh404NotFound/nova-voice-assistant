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

module.exports = { personalizeNarration, applyTimePreference, userFacts, greetSnapshot };
