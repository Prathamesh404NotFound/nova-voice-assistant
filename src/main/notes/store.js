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
let __data = { notes: [], reminders: [], tasks: [] };
let __loaded = false;

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
  __data = { notes: [], reminders: [], tasks: [] };
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

module.exports = {
  all, addNote, addReminder, rearmReminder, addTask, setTaskDone, setTaskDue, taskStats,
  deleteNote, deleteTask, cancelReminder, searchNotes, summarizeOf,
  dueReminders, markFired,
  setStorePathForTesting, resetForTesting, filePath,
};
