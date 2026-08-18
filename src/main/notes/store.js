// Nova — notes/store.js
//
// Local, on-device JSON store for notes, reminders, and tasks (Stage 7).
// Lives at userData/nova-notes.json. DELIBERATELY imports NO networking
// module — nothing in this file can reach OpenRouter or any cloud service.
// Writes are atomic-ish: serialize to .tmp, then fs.rename over the real file.
//
// Shape: { notes: [...], reminders: [...], tasks: [...] }
// Each item: { id, text, (done|dueAt|fired as applicable), createdAt, updatedAt }

const fs = require("fs");
const path = require("path");
const log = require("electron-log");

const FILE = "nova-notes.json";
let __filePath = null;
let __data = { notes: [], reminders: [], tasks: [], focus: [] };
let __loaded = false;
// Round 29: deterministic clock seam for focus end-time math (tests pin it).
let __nowForTesting = null;
function setNowForTesting(d) { __nowForTesting = d ? new Date(d) : null; }
function liveNow() { return __nowForTesting || new Date(); }

function dataDir() {
  let dir;
  try {
    dir = require("electron").app.getPath("userData");
  } catch {
    dir = process.cwd();
  }
  return dir;
}

function filePath() {
  return __filePath || path.join(dataDir(), FILE);
}

/** Test hook: store into an arbitrary path (used by headless tests). */
function setStorePathForTesting(p) {
  __filePath = p;
  __loaded = false;
  __nowForTesting = null;
  __data = { notes: [], reminders: [], tasks: [], focus: [] };
}

function load() {
  if (__loaded) return;
  __loaded = true;
  try {
    if (fs.existsSync(filePath())) {
      const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
      __data = {
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
        reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        focus: Array.isArray(parsed.focus) ? parsed.focus : [],
      };
    }
  } catch (err) {
    log.warn(`[notes] failed to load store, starting fresh: ${err?.message || err}`);
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const tmp = filePath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(__data, null, 2));
    fs.renameSync(tmp, filePath());
  } catch (err) {
    log.error(`[notes] failed to persist store: ${err?.message || err}`);
    throw err;
  }
}

function genId() {
  return "n-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function nowISO() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function all() {
  load();
  return {
    notes: __data.notes.map(stripInternal),
    reminders: __data.reminders.map(stripInternal),
    tasks: __data.tasks.map(stripInternal),
    focus: (__data.focus || []).map(stripInternal),
  };
}

/** Add a timestamped note. Returns the new note. */
function addNote(text) {
  load();
  const item = { id: genId(), text: String(text).trim(), createdAt: nowISO(), updatedAt: nowISO() };
  __data.notes.unshift(item);
  save();
  return stripInternal(item);
}

/** Add a reminder: { text, dueAt ISO }. Returns the reminder. */
function addReminder(text, dueAt) {
  load();
  if (!dueAt) throw new Error("reminder requires a dueAt ISO timestamp");
  const item = {
    id: genId(),
    text: String(text).trim(),
    dueAt: new Date(dueAt).toISOString(),
    fired: false,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  __data.reminders.push(item);
  save();
  return stripInternal(item);
}

/** Arm an existing (just-cancelled) reminder back on. Test/undo helper. */
function rearmReminder(id, dueAt) {
  load();
  const item = __data.reminders.find((r) => r.id === id);
  if (!item) return null;
  item.fired = false;
  if (dueAt) item.dueAt = new Date(dueAt).toISOString();
  item.updatedAt = nowISO();
  save();
  return stripInternal(item);
}

/**
 * Add a task. `opts` may carry a day-granular `dueDate` ISO string (Round 17).
 * Returns the task.
 */
function addTask(text, opts = {}) {
  load();
  const item = { id: genId(), text: String(text).trim(), done: false, createdAt: nowISO(), updatedAt: nowISO() };
  if (opts.dueDate && !isNaN(Date.parse(opts.dueDate))) item.dueDate = opts.dueDate;
  __data.tasks.push(item);
  save();
  return stripInternal(item);
}

/**
 * Round 18: change or remove a task's due date. `dueDate` may be an ISO
 * string (pinned to end-of-day for day-based dates) or null to remove the
 * due date entirely. Invalid ISO strings are silently dropped (NaN-guard);
 * a null clears whatever was there. Returns updated task or null.
 */
function setTaskDue(id, dueDate) {
  load();
  const item = __data.tasks.find((t) => t.id === id);
  if (!item) return null;
  if (dueDate === null || dueDate === undefined) {
    delete item.dueDate;
  } else if (!isNaN(Date.parse(dueDate))) {
    item.dueDate = new Date(dueDate).toISOString();
  } // else: garbage — leave the field untouched rather than storing trash
  item.updatedAt = nowISO();
  save();
  return stripInternal(item);
}

/** Mark a task done (or not-done). Returns updated task or null. */
function setTaskDone(id, done) {
  load();
  const item = __data.tasks.find((t) => t.id === id);
  if (!item) return null;
  const goingDone = !!done && !item.done;
  item.done = !!done;
  item.updatedAt = nowISO();
  // Round 14: record the completion moment so the task-stats streak can see
  // which days actually had a completion — set to null on un-done, since the
  // history is then rewritten.
  item.completedAt = goingDone ? nowISO() : null;
  save();
  return stripInternal(item);
}

/**
 * Round 14: task statistics — completion rate, weekly completions, and the
 * current streak (consecutive days ending today or yesterday with at least
 * one task completed). Fully local read; the store never invents history it
 * did not record (completedAt is nil for tasks done before this round).
 */
function taskStats() {
  load();
  const tasks = __data.tasks || [];
  const done = tasks.filter((t) => t.done);
  const pending = tasks.length - done.length;
  const rate = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;
  // Weekly window: the last 7 days (rolling), completions in the window.
  const weekAgo = Date.now() - 7 * 86_400_000;
  const weekCompletions = done.filter((t) => t.completedAt && new Date(t.completedAt).getTime() >= weekAgo).length;
  // Streak: walk back day-by-day from today; each day counts only if the day
  // had >=1 completion. A gap breaks the streak — but today not-yet-having a
  // completion is tolerated (yesterday closes the streak instead).
  const daysWith = new Set(
    done
      .filter((t) => t.completedAt)
      .map((t) => new Date(t.completedAt).toISOString().slice(0, 10)),
  );
  let streak = 0;
  const start = new Date();
  let offset = 0; // 0 = today
  while (true) {
    const d = new Date(start.getTime() - offset * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    if (offset === 0) {
      // Today only extends the streak if it already has a completion; the
      // streak window is then anchored to yesterday instead (or stays 0).
      if (daysWith.has(key)) {
        streak += 1;
        offset += 1;
      } else {
        offset += 1; // anchor point: yesterday
      }
      continue;
    }
    if (daysWith.has(key)) {
      streak += 1;
      offset += 1;
    } else {
      break;
    }
    if (streak >= 365) break; // history cap — no older than a year
  }
  // Round 17: due-date view — pending tasks due within 7 days and overdue
  // counts (day-granular; due dates store at end-of-day, so a task due today
  // is not yet overdue until tomorrow).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekEnd = new Date(today.getTime() + 7 * 86_400_000);
  const pendingTasks = tasks.filter((t) => !t.done);
  const dueThisWeek = pendingTasks.filter((t) => {
    if (!t.dueDate) return false;
    let d; try { d = new Date(t.dueDate); } catch { return false; }
    d.setHours(0, 0, 0, 0);
    return d >= today && d <= weekEnd;
  }).length;
  const overdue = pendingTasks.filter((t) => {
    if (!t.dueDate) return false;
    let d; try { d = new Date(t.dueDate); } catch { return false; }
    d.setHours(0, 0, 0, 0);
    return d < today;
  }).length;
  return {
    totalTasks: tasks.length,
    done: done.length,
    pending,
    completionRate: rate,
    weekCompletions,
    currentStreakDays: streak,
    dueThisWeek,
    overdue,
  };
}

/**
 * Round 21: "what's on my plate today" — one local-only snapshot of today:
 * pending tasks due today, pending overdue tasks, and reminders due today
 * (fired or not — if it rings today, it belongs in the briefing). Day
 * granularity everywhere; done tasks are excluded from both task groups.
 * `now` may be injected for deterministic tests (defaults to the live clock).
 */
function dailyBriefing(now) {
  load();
  const today = new Date(now || Date.now());
  today.setHours(0, 0, 0, 0);
  const tonight = new Date(today.getTime() + 86_400_000); // 00:00 next day
  const all = __data.tasks || [];
  const reminders = (__data.reminders || []).slice();
  const safeDay = (iso) => {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      d.setHours(0, 0, 0, 0);
      return d;
    } catch { return null; }
  };
  const dueToday = all
    .filter((t) => !t.done && safeDay(t.dueDate)?.getTime() === today.getTime())
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
    .map((t) => ({ id: t.id, text: t.text }));
  const overdue = all
    .filter((t) => !t.done && safeDay(t.dueDate) && safeDay(t.dueDate) < today)
    .sort((a, b) => safeDay(a.dueDate) - safeDay(b.dueDate)) // oldest (most overdue) first
    .map((t) => ({ id: t.id, text: t.text, dueDate: t.dueDate }));
  const remindersToday = reminders
    .filter((r) => {
      const at = new Date(r.dueAt).getTime();
      return at >= today.getTime() && at < tonight.getTime();
    })
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
    .map((r) => ({ id: r.id, text: r.text, dueAt: r.dueAt, fired: !!r.fired }));
  return { dueToday, overdue, remindersToday };
}
/**
 * Round 23: "my week in review" — one local-only snapshot of the week:
 * tasks completed this week (by completedAt), all pending tasks, overdue
 * pending tasks, tasks due next week (Mon–Sun), and reminders landing in the
 * next 7 days. Day granularity everywhere; done tasks drop out of pending,
 * overdue, and next-week — matching the daily briefing's rules.
 * Week start is Monday 00:00 local; `now` and `weekStart` may be injected
 * for deterministic tests (default to the live clock).
 */
function weeklyDigest(now, weekStart) {
  load();
  const today = new Date(now || Date.now());
  today.setHours(0, 0, 0, 0);
  const ws = weekStart ? new Date(weekStart) : (() => {
    const d = new Date(today);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    d.setHours(0, 0, 0, 0);
    return d;
  })();
  const tonight = new Date(today.getTime() + 86_400_000);
  const nextMon = new Date(ws.getTime() + 7 * 86_400_000);
  const nextMonPlus7 = new Date(nextMon.getTime() + 7 * 86_400_000);
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
  const all = __data.tasks || [];
  const reminders = (__data.reminders || []).slice();
  const safeDay = (iso) => {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      d.setHours(0, 0, 0, 0);
      return d;
    } catch { return null; }
  };
  const completedThisWeek = all
    .filter((t) => t.done && t.completedAt && new Date(t.completedAt).getTime() >= weekAgo.getTime() && new Date(t.completedAt).getTime() < tonight.getTime())
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""))
    .map((t) => ({ id: t.id, text: t.text, completedAt: t.completedAt }));
  const pending = all
    .filter((t) => !t.done)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
    .map((t) => ({ id: t.id, text: t.text }));
  const overdue = all
    .filter((t) => !t.done && safeDay(t.dueDate) && safeDay(t.dueDate) < today)
    .sort((a, b) => safeDay(a.dueDate) - safeDay(b.dueDate)) // oldest (most overdue) first
    .map((t) => ({ id: t.id, text: t.text, dueDate: t.dueDate }));
  const dueNextWeek = all
    .filter((t) => !t.done && safeDay(t.dueDate) && safeDay(t.dueDate).getTime() >= nextMon.getTime() && safeDay(t.dueDate).getTime() < nextMonPlus7.getTime())
    .sort((a, b) => safeDay(a.dueDate) - safeDay(b.dueDate))
    .map((t) => ({ id: t.id, text: t.text, dueDate: t.dueDate }));
  const remindersUpcoming = reminders
    .filter((r) => {
      const at = new Date(r.dueAt).getTime();
      return at >= today.getTime() && at < tonight.getTime() + 6 * 86_400_000;
    })
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
    .map((r) => ({ id: r.id, text: r.text, dueAt: r.dueAt, fired: !!r.fired }));
  return { completedThisWeek, pending, overdue, dueNextWeek, remindersUpcoming, weekStart: ws.toISOString() };
}

/** Delete a note; returns its content for undo/telemetry. */
function deleteNote(id) {
  load();
  const idx = __data.notes.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  const [removed] = __data.notes.splice(idx, 1);
  save();
  return stripInternal(removed);
}

/** Delete a task; returns its content for undo/telemetry. */
function deleteTask(id) {
  load();
  const idx = __data.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const [removed] = __data.tasks.splice(idx, 1);
  save();
  return stripInternal(removed);
}

/** Cancel (un-arm) a reminder without deleting it. */
function cancelReminder(id) {
  load();
  const item = __data.reminders.find((r) => r.id === id);
  if (!item) return null;
  item.fired = true; // marks it as handled → scheduler skips it
  item.updatedAt = nowISO();
  save();
  return stripInternal(item);
}

/**
 * Fuzzy task search (Round 30) — matches query tokens against task text.
 * Score per token: 10 for a full word hit, 5 for a substring hit (whole query
 * word must appear in the text). Done tasks excluded unless opts.includeDone.
 * Result order: score desc, then most-recently-updated desc. Capped at 10.
 */
function searchTasks(query, opts = {}) {
  load();
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  // query tokens with noise words dropped (voice padding like "find tasks about")
  const tokens = q.split(/[^a-z0-9]+/).filter((w) => w && !STOP_TOKENS.has(w));
  if (tokens.length === 0) return [];
  const includeDone = !!(opts && opts.includeDone);
  const matches = [];
  for (const t of __data.tasks) {
    if (!includeDone && t.done) continue;
    const text = String(t.text || "").toLowerCase();
    let score = 0;
    let hit = false;
    for (const w of tokens) {
      if (new RegExp(`(^|[^a-z0-9])${escapeRe(w)}($|[^a-z0-9])`).test(text)) {
        score += 10; hit = true;
      } else if (text.includes(w)) { score += 5; hit = true; }
    }
    if (hit) matches.push({ task: stripInternal(t), score, matchedTokens: tokens.length });
  }
  matches.sort((a, b) => b.score - a.score || new Date(b.task.updatedAt) - new Date(a.task.updatedAt));
  return matches.slice(0, 10);
}
const STOP_TOKENS = new Set(["the","a","an","is","are","my","tasks","task","find","search","look","for","about","with","show","list","all","in"]); // voice padding
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Keyword search over note text (case-insensitive substring OR over words). */
function searchNotes(query) {
  load();
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const matches = __data.notes.filter((n) => {
    const t = n.text.toLowerCase();
    return words.some((w) => t.includes(w));
  });
  return matches.map(stripInternal);
}

// Round 33: ranked TOPICAL note search — mirrors the R30 task-search ladder
// (whole-word 10 / substring 5, stop-token strip, recency tiebreak, cap 10)
// over note text. Note-specific stop tokens drop voice padding like "my notes
// about" so "find notes about the dog" scores on "dog", not "notes"/"about".
const NOTES_STOP_TOKENS = new Set(["the", "a", "an", "is", "are", "my", "me", "i", "note", "notes", "find", "search", "look", "for", "about", "with", "on", "show", "any", "tell", "in"]);
function topicSearchNotes(subject) {
  load();
  const q = String(subject || "").trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/[^a-z0-9]+/).filter((w) => w && !NOTES_STOP_TOKENS.has(w));
  if (tokens.length === 0) return [];
  const matches = [];
  for (const n of __data.notes) {
    const text = String(n.text || "").toLowerCase();
    let score = 0;
    let hit = false;
    for (const w of tokens) {
      if (new RegExp(`(^|[^a-z0-9])${escapeRe(w)}($|[^a-z0-9])`).test(text)) {
        score += 10; hit = true;
      } else if (text.includes(w)) { score += 5; hit = true; }
    }
    if (hit) matches.push({ note: stripInternal(n), score });
  }
  matches.sort((a, b) => b.score - a.score || new Date(b.note.updatedAt) - new Date(a.note.updatedAt));
  return matches.slice(0, 10);
}

/** Notes content for an explicit "summarize my notes" request. */
function summarizeOf(ids) {
  load();
  const list = (ids || __data.notes.map((n) => n.id))
    .map((id) => __data.notes.find((n) => n.id === id))
    .filter(Boolean);
  return list.map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt }));
}

/** Reminders due now or in the past that haven't fired. */
function dueReminders(at = new Date()) {
  load();
  return __data.reminders
    .filter((r) => !r.fired && new Date(r.dueAt) <= at)
    .map(stripInternal);
}

/** Mark reminders as fired by id list; returns count. */
function markFired(ids) {
  load();
  let n = 0;
  for (const id of ids) {
    const r = __data.reminders.find((x) => x.id === id);
    if (r && !r.fired) { r.fired = true; r.updatedAt = nowISO(); n++; }
  }
  if (n) save();
  return n;
}

function stripInternal(item) {
  const { __internal, ...rest } = item;
  return rest;
}

/** Wipe the store — tests only. */
function resetForTesting() {
  __data = { notes: [], reminders: [], tasks: [] };
  __loaded = true;
  if (__filePath && fs.existsSync(filePath())) {
    try { fs.unlinkSync(filePath()); } catch { /* ignore */ }
  }
}

/**
 * Round 29: focus sessions (Pomodoro-style) — fully local, on-device.
 * Records are append-only: a session is created with `running` status and
 * closed (completed or cancelled) by stopFocus — the history is never
 * edited, so a focus log is an honest time record.
 *
 * `startFocus(durationMin, now?)` → {id, durationMin, startedAt, status}.
 * At most ONE running session at a time: starting while one runs cancels it
 * first (recorded as cancelled — the user swapped mid-session). `now` is an
 * injected epoch or ISO for deterministic tests; defaults to the live clock.
 */
function startFocus(durationMin, now) {
  load();
  durationMin = Number(durationMin);
  if (!Number.isFinite(durationMin) || durationMin <= 0) {
    throw new Error("focus duration must be a positive number of minutes");
  }
  if (durationMin > 600) durationMin = 600; // 10 h cap — sessions longer than a work day are a mistake
  const running = (__data.focus || []).find((f) => f.status === "running");
  if (running) stopFocusInternal(running.id, "cancelled", now); // swap: old session ends candidly
  const when = now != null ? new Date(now) : liveNow();
  const item = { id: genId(), durationMin, status: "running", startedAt: when.toISOString(), stoppedAt: null };
  __data.focus.push(item);
  save();
  return stripInternal(item);
}

function stopFocusInternal(id, status, now) {
  const item = (__data.focus || []).find((f) => f.id === id);
  if (!item) return null;
  if (item.status !== "running") return stripInternal(item);
  const when = now != null ? new Date(now) : liveNow();
  item.status = status;
  item.stoppedAt = when.toISOString();
  item.updatedAt = when.toISOString();
  save();
  return stripInternal(item);
}

/**
 * Close the currently running session. status is "completed" (finished the
 * full duration, caller's word for it) or "cancelled" (stopped early).
 * No running session → null. `now` is the test-clock seam.
 */
function stopFocus(status = "completed", now) {
  load();
  const running = (__data.focus || []).find((f) => f.status === "running");
  if (!running) return null;
  return stopFocusInternal(running.id, status === "cancelled" ? "cancelled" : "completed", now);
}

/** All sessions, newest first (history view / side panel). */
function focusHistory(limit) {
  load();
  const list = (__data.focus || []).slice().sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  if (Number.isFinite(limit) && limit > 0) return list.slice(0, limit).map(stripInternal);
  return list.map(stripInternal);
}

/** Most recent running session, or null when nothing is in progress. */
function latestFocus() {
  load();
  const list = (__data.focus || []).slice().sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return list[0] ? stripInternal(list[0]) : null;
}

/** Sum of completed-focus minutes started within the trailing 7 days (for stats). */
function focusMinutesThisWeek(now) {
  load();
  const cutoff = (now != null ? new Date(now) : liveNow()).getTime() - 7 * 86_400_000;
  let mins = 0;
  for (const f of __data.focus || []) {
    if (f.status !== "completed") continue;
    const started = new Date(f.startedAt).getTime();
    if (isNaN(started) || started < cutoff) continue;
    // Real elapsed in MINUTES when stoppedAt exists (ternary branch must be
    // parenthesized — without the parens the / 60_000 binds only to the
    // false branch and real-elapsed milliseconds beat durationMin in the
    // min()).
    const actual = Math.min(Number(f.durationMin) || 0, !!f.stoppedAt ? (new Date(f.stoppedAt).getTime() - started) / 60_000 : Number(f.durationMin) || 0);
    mins += actual > 0 ? actual : Number(f.durationMin) || 0;
  }
  return mins;
}

/**
 * Round 32: completed-focus minutes started on the same local day as `now`
 * (for "my focus today"). A session counts only when completed and its
 * startedAt shares the local Y-M-D of the reference time.
 */
function focusMinutesToday(now) {
  load();
  const ref = now != null ? new Date(now) : liveNow();
  const target = `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, "0")}-${String(ref.getDate()).padStart(2, "0")}`;
  let mins = 0;
  for (const f of __data.focus || []) {
    if (f.status !== "completed") continue;
    const day = (f.startedAt || "").slice(0, 10);
    if (day !== target) continue;
    const started = new Date(f.startedAt).getTime();
    // Same parenthesization as the week helper — real elapsed in minutes.
    const actual = Math.min(Number(f.durationMin) || 0, !!f.stoppedAt ? (new Date(f.stoppedAt).getTime() - started) / 60_000 : Number(f.durationMin) || 0);
    mins += actual > 0 ? actual : Number(f.durationMin) || 0;
  }
  return mins;
}

/** Wipe the store — tests only. */
function resetForTesting() {
  __data = { notes: [], reminders: [], tasks: [], focus: [] };
  __nowForTesting = null;
  __loaded = true;
  if (__filePath && fs.existsSync(filePath())) {
    try { fs.unlinkSync(filePath()); } catch { /* ignore */ }
  }
}

module.exports = {
  all, addNote, addReminder, rearmReminder, addTask, setTaskDone, setTaskDue, taskStats,
  dailyBriefing, weeklyDigest,
  deleteNote, deleteTask, cancelReminder, searchNotes, searchTasks, topicSearchNotes, summarizeOf,
  dueReminders, markFired,
  startFocus, stopFocus, focusHistory, latestFocus, focusMinutesThisWeek, focusMinutesToday,
  setStorePathForTesting, resetForTesting, filePath,
  setNowForTesting, // test-only: pins the clock for end-time math
};
