// Nova — notes/dispatch.js
//
// Notes/reminders/tasks dispatcher (Stage 7). planNoteAction() → gate
// runAction (notes actions are L1 safe for create/read, L2 for
// edit/delete/summarize) → narrated result. Summarize is the only branch
// that ever sends note content off-machine, and only after the user
// explicitly asks, and only that one request.

const { planNoteAction, setNowForTesting } = require("./plan");
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
  return { tasks: a.tasks, notes: a.notes, reminders: a.reminders, recurring: a.recurring };
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
  // Round 28/29: pin the clock for time-math actions (priority-check,
  // focus-start/stop) so tests stay deterministic — the store's today/
  // overdue / end-time math is day-granular or minute-granular and must
  // never drift with the live clock mid-run.
  const effPayload = (actionId === "notes:priority-check" || actionId === "notes:focus-start" || actionId === "notes:focus-stop") && opts.now !== undefined
    ? { ...payload, now: new Date(opts.now).getTime() }
    : payload;
  const res = await gate.runAction(actionId, effPayload, { taskId: opts.taskId });
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
    // Round 34: recurring reminders/tasks — confirmation text is composed by
    // dispatch-personal (pure module) so the wording stays testable and the
    // spoken line always repeats the user's own words verbatim (additive).
    case "notes:add-recurring": {
      const pc = detail.item || {};
      const { text: confText, narration } = recurringConfirmText({
        item: pc, cadence: (pc.cadence || payload.cadence || "day"), mode: (pc.mode || payload.mode || "reminder"),
        day: pc.day !== undefined ? pc.day : (payload.day !== undefined ? payload.day : null),
        time: payload.time, weekdays: payload.weekdays,
      });
      return { ok: true, intent: "notes", text: confText, narration, actionId, detail: { kind: "recurring", item: pc } };
    }
    case "notes:remove-recurring": {
      const rc = detail.removed || {};
      const { text: remText, narration: remNarr } = recurringRemoveText({ removed: rc });
      return { ok: true, intent: "notes", text: remText, narration: remNarr, actionId, detail: { kind: "recurring-removed", removed: rc } };
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
    // Round 33: ranked TOPICAL note search — scored results (whole-word >
    // substring) with a recency tag per match. Empty plate gets the plain
    // "no match" line; the spoken readout caps at 5 with an honest tail.
    case "notes:topic-search-notes": {
      const matches = detail.matches || [];
      const subj = String(payload.subject || "").trim();
      return {
        ok: true, intent: "notes",
        text: topicSearchText({ matches, subject: subj, now: Date.now() }),
        actionId, detail: { kind: "topic", matches, subject: subj },
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
    // Round 30: task search — numbered results with due badges (overdue /
    // due today), ordered by the store's match score (whole-word > substring)
    // then recency. Empty plate gets a plain "nothing matches X" answer.
    case "notes:task-search": {
      const matches = detail.matches || [];
      const q = String(payload.query || "").trim();
      if (!matches.length) return { ok: true, intent: "notes", text: `No tasks match "${q}".`, actionId, detail: { kind: "search", matches, query: q } };
      // Due badges: overdue / due today only (same bucket math as priority-
      // check) — the rest of the dates keep the list quiet.
      const todayMs = new Date().setHours(0, 0, 0, 0);
      const tag = (t) => {
        if (!t.dueDate) return "";
        try {
          const d = new Date(t.dueDate);
          d.setHours(0, 0, 0, 0);
          return d.getTime() < todayMs ? " (overdue)" : d.getTime() === todayMs ? " (due today)" : "";
        } catch { return ""; }
      };
      const line = (m, i) => `${i + 1}. ${m.task.text}${tag(m.task)}`;
      return {
        ok: true, intent: "notes",
        text: `Found ${matches.length} task${matches.length === 1 ? "" : "s"} about "${q}":\n` + matches.map(line).join("\n"),
        actionId, detail: { kind: "search", matches, query: q },
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
      // Round 18: light celebration when the task was due today or overdue
      // (done on/before its due day) or overdue when completed.
      let extra = "";
      try {
        if (t.dueDate) {
          const due = new Date(t.dueDate);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          due.setHours(0, 0, 0, 0);
          extra = due.getTime() >= today.getTime() ? " And right on time — thanks for crushing it." : " Better late than never — that one was overdue!";
        }
      } catch { /* never let a bad date break the reply */ }
      return {
        ok: true, intent: "notes",
        text: `Marked "${t.text}" as done.${extra}`,
        narration: "Task done.",
        actionId, detail: { kind: "task-done", task: t },
      };
    }
    // Round 18: change or clear a task's due date (L2 — already confirmed by the gate).
    case "notes:set-task-due": {
      const t = detail.task || {};
      if (payload.dueDate) {
        const nice = new Date(payload.dueDate).toDateString();
        return {
          ok: true, intent: "notes",
          text: `Done — "${t.text}" is now due ${nice}.`,
          narration: `Due date moved to ${nice}.`,
          actionId, detail: { kind: "task-due-set", task: t },
        };
      }
      return {
        ok: true, intent: "notes",
        text: `Removed the due date from "${t.text}" — it stays on your list with no deadline.`,
        narration: "Due date removed.",
        actionId, detail: { kind: "task-due-set", task: t },
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
    // Round 14: read-only task statistics.
    case "notes:task-stats": {
      const s = detail.stats || {};
      const verdict = s.completionRate >= 80
        ? "Great pace!"
        : s.completionRate >= 50
          ? "You're past half way."
          : s.totalTasks
            ? "Lots still to do — keep going."
            : "No tasks yet — say \"add X to my tasks\" anytime.";
      return {
        ok: true, intent: "notes",
        text: `You have ${s.totalTasks} task${s.totalTasks === 1 ? "" : "s"}: ${s.done} done, ${s.pending} pending — a ${s.completionRate}% completion rate. ${s.weekCompletions} completed in the last 7 days${s.currentStreakDays ? `, and your current streak is ${s.currentStreakDays} day${s.currentStreakDays === 1 ? "" : "s"}` : ""}. ${s.overdue ? s.overdue + " task" + (s.overdue === 1 ? " is" : "s are") + " overdue" : "Nothing is overdue"}${s.dueThisWeek ? `, and ${s.dueThisWeek} due this week` : ""}. ${verdict}`,
        narration: "Here's your task progress…",
        actionId, detail: { kind: "task-stats", stats: s },
      };
    }
    // Round 21: read-only daily briefing — today's due tasks, overdue,
    // and today's reminders in one spoken sentence.
    case "notes:daily-briefing": {
      const b = detail.result || {};
      const named = (list) => list.map((x) => `"${x.text.slice(0, 40)}"`).join(", ");
      const duet = b.dueToday || [];
      const ov = b.overdue || [];
      let rem = (b.remindersToday || []).map((r) => ({ ...r }));
      // Round 25: respect the user's time-of-day preference ("I like
      // mornings") by reordering reminders; a morning preference keeps
      // the default earliest-first order.
      rem = applyTimePreference(rem);
      let text;
      if (!duet.length && !ov.length && !rem.length) {
        text = "Nothing on the plate today — clear skies.";
      } else {
        const parts = [];
        if (duet.length) parts.push(`${duet.length} task${duet.length === 1 ? "" : "s"} due today: ${named(duet)}`);
        if (ov.length) parts.push(`${ov.length} overdue: ${named(ov)}`);
        if (rem.length) parts.push(`${rem.length} reminder${rem.length === 1 ? "" : "s"} today: ${named(rem)}`);
        text = `Here's today's plate: ${parts.join(". ")}.`;
      }
      // Round 25: identity-aware narration — userName lead-in, fact recap.
      // The base line follows the branch so the spoken narration matches
      // what the text said (empty day vs. full plate).
      const baseNarr = duet.length || ov.length || rem.length
        ? "Here's what's on your plate today\u2026"
        : "Nothing on the plate today \u2014 clear skies.";
      // Round 27: mood check-ins weave into the narration when the latest
      // mood fact exists — additive (no mood → byte-identical narration).
      return {
        ok: true, intent: "notes",
        text,
        narration: personalizeNarration("daily-briefing", baseNarr).replace(/^(\s*)/, (m0) => m0 + moodNarration()),
        actionId, detail: { kind: "daily-briefing", briefing: b },
      };
    }
    // Round 23: read-only weekly digest — the week's completions, what's
    // still pending, overdue, next week's dues, and upcoming reminders.
    case "notes:weekly-digest": {
      const d = detail.result || {};
      const named = (list) => list.map((x) => `"${x.text.slice(0, 40)}"`).join(", ");
      const done = d.completedThisWeek || [];
      const pend = d.pending || [];
      const ov = d.overdue || [];
      const nxt = d.dueNextWeek || [];
      let rem = (d.remindersUpcoming || []).map((r) => ({ ...r }));
      // Round 25: apply the user's time-of-day preference to upcoming
      // reminders in the digest as well.
      rem = applyTimePreference(rem);
      let text;
      if (!done.length && !pend.length && !ov.length && !nxt.length && !rem.length) {
        text = "Quiet week — nothing to report.";
      } else {
        const parts = [];
        if (done.length) parts.push(`${done.length} task${done.length === 1 ? "" : "s"} completed this week: ${named(done)}`);
        if (pend.length) parts.push(`${pend.length} task${pend.length === 1 ? "" : "s"} still pending: ${named(pend)}`);
        if (ov.length) parts.push(`${ov.length} overdue: ${named(ov)}`);
        if (nxt.length) parts.push(`${nxt.length} due next week: ${named(nxt)}`);
        if (rem.length) parts.push(`${rem.length} reminder${rem.length === 1 ? "" : "s"} coming up: ${named(rem)}`);
        text = `Here's your week in review: ${parts.join(". ")}.`;
      }
      // Round 25: identity-aware narration — userName lead-in, fact recap.
      // The base line follows the branch so the spoken narration matches
      // what the text said (quiet week vs. busy week).
      const baseNarrD = done.length || pend.length || ov.length || nxt.length || rem.length
        ? "Here's your week in review\u2026"
        : "Quiet week \u2014 nothing to report.";
      // Round 27: mood check-ins weave into the digest narration too —
      // the week review also carries today's mood when one exists.
      return {
        ok: true, intent: "notes",
        text,
        narration: personalizeNarration("weekly-digest", baseNarrD).replace(/^(\s*)/, (m0) => m0 + moodNarration()),
        actionId, detail: { kind: "weekly-digest", digest: d },
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
    // Round 24: greeting — personalized by user name and Nova's personality.
    // Round 26: when a user name is set and today has anything on it, the
    // greeting carries a one-line day preview (counts only — no item text —
    // so the first "good morning" already hints at the plate).
    case "notes:greet": {
      const id = identityGet();
      const greeting = greetLine(id.personality, id.userName);
      // Round 26: day preview — additive (empty name/day → untouched line).
      const preview = greetSnapshot(store.dailyBriefing());
      // Round 27: mood prefix — additive (no mood → byte-identical greeting).
      const mood = moodGreet();
      return {
        ok: true, intent: "notes",
        text: greeting + preview,
        narration: greeting + mood + preview,
        actionId, detail: { kind: "greet", identity: id, snapshot: !!preview, mood: !!mood },
      };
    }
    // Round 27: mood/energy check-in — "how am I feeling today". Reads the
    // most recent mood fact from the user model with a human age. Purely
    // local; L1 SAFE. Additive wording: no stored mood → an invitation to
    // check in rather than an error.
    case "notes:mood-check": {
      const mc = latestMood();
      if (!mc) {
        return {
          ok: true, intent: "notes",
          text: "You haven't told me how you're feeling yet — try \"I feel energized today\" and I'll keep it in mind for your briefings.",
          narration: "You haven't told me how you're feeling yet — try \"I feel energized today\" and I'll keep it in mind for your briefings.",
          actionId, detail: { kind: "mood-check" },
        };
      }
      const age = moodAge(mc.updatedAt);
      const id3 = identityGet();
      const p = id3.personality || "warm";
      const ack = p === "concise" ? "Latest check-in:"
        : p === "professional" ? "Here's your latest check-in:"
        : p === "playful" ? "The cosmos remembers:"
        : "You told me, " + age + ":";
      return {
        ok: true, intent: "notes",
        text: `${ack} "${mc.fact}"${p === "concise" || p === "professional" || p === "playful" ? ` (recorded ${age})` : ""}`,
        narration: `${ack} "${mc.fact}"`,
        actionId, detail: { kind: "mood-check", fact: mc.fact, updatedAt: mc.updatedAt },
      };
    }
    // Round 27: explicit mood statement — "I feel tired". Stored as a user-
    // model fact with a dedicated acknowledgement so check-ins feel like a
    // conversation, not a settings change. L1 SAFE, local only.
    case "notes:mood-statement": {
      if (detail.ok === false) {
        return { ok: false, intent: "notes", text: detail.error === "too-long" ? "That's a bit long for one fact — try splitting it up." : "I could not remember that.", actionId, detail: { kind: "mood-statement", error: detail.error } };
      }
      const id4 = identityGet();
      const p2 = id4.personality || "warm";
      const ack2 = p2 === "concise" ? "Noted."
        : p2 === "professional" ? "Logged — I'll keep it in mind for your briefings."
        : p2 === "playful" ? "The cosmos heard you! ✨"
        : "Got it — I'll keep that in mind today.";
      return {
        ok: true, intent: "notes",
        text: `${ack2} "${detail.fact || ""}"`,
        narration: ack2,
        actionId, detail: { kind: "mood-statement", fact: detail.fact },
      };
    }
    // Round 28: mood-aware prioritization — "what should I work on first?".
    // Purely read-only: orders pending tasks (overdue first, oldest first;
    // then due today; then the rest) and lets a recent low-energy mood
    // check-in lift the smallest tasks to the top of the rest bucket —
    // quick wins beat deadlines when energy is low. L1 SAFE, local only.
    case "notes:priority-check": {
      const pc = detail.result || {};
      const pend = (pc.pending || []).slice();
      if (!pend.length) {
        return {
          ok: true, intent: "notes",
          text: "Nothing to prioritize — your plate is clean. Say \"add X to my tasks\" when you have something on it.",
          narration: "Nothing to prioritize — your plate is clean.",
          actionId, detail: { kind: "priority-check", order: [], lowEnergy: false },
        };
      }
      const pc2 = prioritize(pend, pc.now);
      // Labels for the spoken list: overdue / due today / the rest.
      const safeDay = (iso) => {
        if (!iso) return null;
        try {
          const d = new Date(iso);
          d.setHours(0, 0, 0, 0);
          return d;
        } catch { return null; }
      };
      const todayMs = new Date(pc.now).setHours(0, 0, 0, 0);
      const tagged = pc2.order.map((t) => {
        const d = safeDay(t.dueDate);
        const tag = !d ? "" : d.getTime() < todayMs ? "overdue" : d.getTime() === todayMs ? "due today" : "";
        return { text: t.text, tag };
      });
      // Cap the spoken list at 5 — a laundry list defeats the point of a
      // prioritized answer; the rest still wait their turn.
      const shown = tagged.slice(0, 5);
      const left = tagged.length - shown.length;
      const listed = shown.map((x, i) => `${i + 1}. ${x.text}${x.tag ? ` (${x.tag})` : ""}`).join(". ") + ".";
      // Mood framing: a recent check-in (<12h of the real wall clock) explains
      // the strategy when energy is low, or simply colors the opener when
      // energy is fine. Mood aging is wall-clock real (a check-in from last
      // night is stale whether today's math is pinned or not) — pc.now pins
      // only the due-date/overdue bucket math.
      const mood = latestMood();
      const moodRecent = mood && (Date.now() - new Date(mood.updatedAt).getTime()) < 12 * 3_600_000;
      let text;
      if (pc2.lowEnergy && moodRecent) {
        const opener = moodAge(mood.updatedAt, pc.now);
        text = `You said ${opener} "${mood.fact}" — so small wins first: ${listed}`;
      } else if (moodRecent) {
        const opener = moodAge(mood.updatedAt, pc.now);
        text = `You said ${opener} "${mood.fact}" — here's what I'd work on first: ${listed}`;
      } else {
        text = `Here's what I'd work on first: ${listed}`;
      }
      if (left > 0) {
        text += ` …and ${left} more after those.`;
      }
      return {
        ok: true, intent: "notes",
        text,
        narration: `Here's how I'd order your day${pc2.lowEnergy ? " — small wins first" : ""}\u2026`,
        actionId, detail: { kind: "priority-check", order: pc2.order, lowEnergy: pc2.lowEnergy, moodRecent: !!moodRecent },
      };
    }
    // Round 31: "plan my day" — one time-blocked spoken schedule from the
    // pending task list, anchored by the user's time-of-day preference,
    // fixed reminder hours respected, mood-framed opener when the latest
    // check-in is recent. Purely read-only; L1 SAFE, zero network.
    case "notes:plan-day": {
      const pc3 = detail.result || {};
      const plan = planDay({ pending: (pc3.pending || []).filter((t) => !t.done), reminders: pc3.reminders, now: pc3.now });
      if (!plan.blocks.length && !plan.remindersFixed.length) {
        return {
          ok: true, intent: "notes",
          text: "Your day is wide open — nothing on the task list yet. Say " + String.raw`"add X to my tasks"` + " and I'll fill it in.",
          narration: "Your day is wide open — nothing on the task list yet.",
          actionId, detail: { kind: "plan-day", blocks: [], remindersFixed: [], pref: plan.pref, moodFramed: false, overCap: 0 },
        };
      }
      const hr = (h) => (h < 12 ? `${h}:00 AM` : h === 12 ? "12:00 PM" : `${h - 12}:00 PM`);
      // One chronologically-ordered numbered list from the union of task
      // blocks and fixed reminder slots, keeping task order stable.
      const events = [
        ...plan.blocks.map((b) => ({ hour: b.hour, label: b.task.text, type: "task" })),
        ...plan.remindersFixed.map((r) => ({ hour: r.hour, label: r.text, type: "reminder" })),
      ].sort((a, b) => a.hour - b.hour);
      let text = events.map((e, i) => `${i + 1}. ${hr(e.hour)} — ${e.type === "reminder" ? "reminder: " : ""}${e.label}`).join("\n");
      // Opener: mood-framed only when the check-in is recent (< 12h of the
      // pinned clock). A low-energy mood keeps the plan short anyway (cap),
      // and says so — one honest schedule, no double messaging.
      let opener;
      const moodPc = latestMood();
      if (plan.moodFramed && moodPc) {
        const age = moodAge(moodPc.updatedAt, pc3.now);
        opener = `You said ${age} "${moodPc.fact}" — ${plan.lowEnergy ? "so this is a light day: " : "here's a plan that fits: "}`;
      } else {
        opener = "Here's a plan for your day: ";
      }
      if (plan.overCap > 0) {
        text += `\n…and ${plan.overCap} more after those — one schedule shouldn't bite off more than six hours.`;
      }
      return {
        ok: true, intent: "notes",
        text: opener + text,
        narration: "Here's a plan for your day\u2026",
        actionId, detail: { kind: "plan-day", blocks: plan.blocks, remindersFixed: plan.remindersFixed, pref: plan.pref, moodFramed: plan.moodFramed, overCap: plan.overCap },
      };
    }
    // Round 29: focus mode / Pomodoro — start. Opens a local session, tells
    // the user when it ends (local time) and how long it lasts. Zero network;
    // the renderer's countdown HUD ticks down on the nova:focus-started event.
    case "notes:focus-start": {
      const sess = (detail && detail.session) || {};
      if (!sess || !sess.startedAt) {
        return { ok: false, intent: "notes", text: "I could not start the focus session — check the Action Log.", actionId, detail: { kind: "focus-start" } };
      }
      const started = new Date(sess.startedAt);
      const endsAt = new Date(started.getTime() + sess.durationMin * 60_000);
      const local = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const dur = sess.durationMin === 60 ? "1 hour" : sess.durationMin >= 60 && sess.durationMin % 60 === 0 ? `${Math.round(sess.durationMin / 60)} hours` : `${sess.durationMin} minutes`;
      return {
        ok: true, intent: "notes",
        text: `Focus mode on — ${dur}, ${local(started)} to ${local(endsAt)}. When it ends I'll ping you — and if you ever want a plan for it, "what should I work on first" is ready.`,
        narration: `Focus mode on — ${dur} until ${local(endsAt)}. I'll ping you when it's done.`,
        actionId,
        detail: { kind: "focus-start", session: { id: sess.id, durationMin: sess.durationMin, startedAt: sess.startedAt, endsAt: endsAt.toISOString() } },
      };
    }
    // Round 29: focus mode / Pomodoro — stop. Closes the running session
    // candidly (record says completed) and, when the task plate has pending
    // items, suggests marking one done while momentum is high. No suggestion
    // on an empty plate — no point celebrating an already-clear list.
    case "notes:focus-stop": {
      const ended = detail && detail.ended ? { id: detail.ended.id, durationMin: detail.ended.durationMin, startedAt: detail.ended.startedAt, stoppedAt: detail.ended.stoppedAt } : null;
      if (!ended) {
        return {
          ok: true, intent: "notes",
          text: "No focus session was running — say " + String.raw`"start focus mode"` + " whenever you want one.",
          narration: "No focus session was running.",
          actionId, detail: { kind: "focus-stop", ended: null },
        };
      }
      const started = new Date(ended.startedAt);
      const stopped = new Date(ended.stoppedAt);
      const realMin = Math.max(1, Math.round((stopped.getTime() - started.getTime()) / 60_000));
      const was = realMin === 1 ? "a minute" : `${realMin} minutes`;
      const suggest = (detail && detail.pendingCount > 0)
        ? " Want me to mark a task done while the momentum's there?"
        : "";
      return {
        ok: true, intent: "notes",
        text: `Focus ended after ${was}${suggest}`,
        narration: `Nice — ${was} of deep work.${suggest}`,
        actionId, detail: { kind: "focus-stop", ended },
      };
    }
    // Round 32: focus-time accounting — how much focus time did the user
    // bank today / in the trailing 7 days? Read-only from the R29 session
    // log. The `now` travels from the planner's pinned clock (same seam as
    // plan-day), so the trailing-7-day cutoff and today bucket are
    // deterministic in tests and honest on the live clock.
    case "notes:focus-stats": {
      const pc = detail && detail.result ? detail.result : {};
      const now = pc.now || Date.now();
      const weekMin = store.focusMinutesThisWeek(now);
      const todayMin = store.focusMinutesToday(now);
      const id = identityGet();
      const text = focusStatsSummary({ weekMin, todayMin, personality: id.personality || "warm" });
      return {
        ok: true, intent: "notes",
        text,
        narration: weekMin || todayMin ? `Adding up your focus time — ${text}` : "Checking the focus log…",
        actionId,
        detail: { kind: "focus-stats", weekMin, todayMin },
      };
    }
    // Round 24: remember a fact about the user. L1 SAFE — acknowledgement
    // line follows the personality for warmth but the fact itself is echoed
    // verbatim so nothing gets paraphrased away.
    case "notes:remember-fact": {
      if (detail.ok === false) {
        return { ok: false, intent: "notes", text: detail.error === "too-long" ? "That's a bit long for one fact — try splitting it up." : "I could not remember that.", actionId, detail: { kind: "remember-fact", error: detail.error } };
      }
      const id = identityGet();
      const ack = id.personality === "concise" ? "Remembered."
        : id.personality === "professional" ? "Noted — stored in my local model of you."
        : id.personality === "playful" ? `Got it, memorized it forever! \u{1F9E0}`
        : "Got it — I'll remember that.";
      const line = id.personality === "playful"
        ? `Memorized: "${detail.fact || ""}" \u{1F9E0}`
        : `I'll remember that you said "${detail.fact || ""}".`;
      return {
        ok: true, intent: "notes",
        text: `${ack} ${line}`,
        narration: ack,
        actionId, detail: { kind: "remember-fact", fact: detail.fact },
      };
    }
    // Round 24: forget a fact — the planner already made the user read the
    // exact fact, so keep the confirmation plain (forget is a deliberate act).
    case "notes:forget-fact": {
      if (detail.ok === false) {
        return { ok: false, intent: "notes", text: detail.error === "not-found" ? "I couldn't find that fact in what I know about you." : "I could not forget that.", actionId, detail: { kind: "forget-fact", error: detail.error } };
      }
      const id2 = identityGet();
      const line2 = id2.personality === "concise" ? "Forgotten."
        : id2.personality === "professional" ? `Removed "${detail.removed || ""}" from my model of you.`
        : `Noted — "${detail.removed || ""}" is forgotten.`;
      return { ok: true, intent: "notes", text: line2, narration: "Forgotten.", actionId, detail: { kind: "forget-fact", removed: detail.removed } };
    }
    // Round 24: user-model readout — "what do you know about me".
    case "notes:user-model-ask": {
      const facts = detail.facts || [];
      if (!facts.length) {
        return {
          ok: true, intent: "notes",
          text: "I don't know you yet — tell me things to remember. Say \"remember that I work from home on Fridays\", and I'll build my model of you locally. Nothing leaves this machine.",
          narration: "I don't know you yet — tell me things to remember.",
          actionId, detail: { kind: "user-model-ask", facts: [] },
        };
      }
      const named = (list) => list.map((f) => `"${String(f.fact || "").slice(0, 50)}"`).join("; ");
      const visible = facts.slice(-3);
      const tail = facts.length - visible.length;
      const head = tail > 0 ? `…and ${tail} more. ` : "";
      return {
        ok: true, intent: "notes",
        text: `You've told me: ${head}${named(visible)}.`,
        narration: `I know ${facts.length} thing${facts.length === 1 ? "" : "s"} about you.`,
        actionId, detail: { kind: "user-model-ask", facts },
      };
    }
    default:
      return { ok: false, intent: "notes", text: "I don't know how to handle that notes action.", actionId, detail };
  }
}

// Round 24: greeting helper — time-of-day greeting personalized by the user's
// name and Nova's identity personality (tone only, never fact wording).
const { get: identityGet } = require("../identity/identity");
const { personalizeNarration, applyTimePreference, greetSnapshot, userFacts, latestMood, moodAge, moodNarration, moodGreet, prioritize, planDay, focusStatsSummary, topicSearchText, recurringConfirmText, recurringRemoveText } = require("./dispatch-personal");

function greetLine(personality, userName) {
  const hour = new Date().getHours();
  const tod = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const who = userName ? `, ${userName}` : "";
  if (personality === "concise") return `${tod}${who}.`;
  if (personality === "professional") return `${tod}${who} — I'm ready when you are.`;
  if (personality === "playful") return `${tod}${who}! The cosmos says it's your lucky hour 🌟`;
  // warm (default)
  return `${tod}${who} — glad you're here. What shall we do today?`;
}
module.exports = { runNoteAction, planNoteAction, storeContext, formatLocalResult, greetLine, greetSnapshot, latestMood, moodAge, moodNarration, moodGreet, prioritize, setNowForTesting };
