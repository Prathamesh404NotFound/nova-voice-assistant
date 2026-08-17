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

/** Add a task. Returns the task. */
function addTask(text) {
  load();
  const item = { id: genId(), text: String(text).trim(), done: false, createdAt: nowISO(), updatedAt: nowISO() };
  __data.tasks.push(item);
  save();
  return stripInternal(item);
}

/** Mark a task done (or not-done). Returns updated task or null. */
function setTaskDone(id, done) {
  load();
  const item = __data.tasks.find((t) => t.id === id);
  if (!item) return null;
  item.done = !!done;
  item.updatedAt = nowISO();
  save();
  return stripInternal(item);
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
  all, addNote, addReminder, rearmReminder, addTask, setTaskDone,
  deleteNote, deleteTask, cancelReminder, searchNotes, summarizeOf,
  dueReminders, markFired,
  setStorePathForTesting, resetForTesting, filePath,
};
