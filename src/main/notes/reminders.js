// Nova — notes/reminders.js
//
// Local reminder scheduler (Stage 7). Polls the store every SCAN_MS for
// reminders that are due and not yet fired, then:
//   1. marks them fired + persists
//   2. fires an OS notification via Electron's Notification API
//   3. if the app window is focused, emits "nova:reminder-fired" so the
//      renderer also speaks the reminder aloud (TTS)
// Reminders only fire while the app is running (documented limitation).
//
// The module is testable: start()/stop() and an injected notify() via
// setNotifierForTesting(). Production uses new Notification() once.

const log = require("electron-log");
const store = require("./store");

const SCAN_MS = 15_000;
// Round 19: how long a fired reminder stays snoozeable via the HUD banner.
// After this window the fired reminder must have been re-fired or dismissed.
let SNOOZE_WINDOW_MS = 15 * 60_000;

let __timer = null;
let __notify = null;           // (title, body, { focused }) → void
let __requestPermissionDone = false;

// Round 19: fired reminders that can still be snoozed from the side panel.
// id -> { id, text, dueAt, firedAt }. A second fire or a UI snooze replaces
// the entry; snooze chips in the banner call snoozeFired() — never the
// generic voice snooze path, which only targets the most-recent fired one.
const __pendingSnoozes = new Map();

function pendingSnoozesForTesting() {
  return __pendingSnoozes;
}

function resetPendingSnoozesForTesting() {
  __pendingSnoozes.clear();
}

function defaultNotifier() {
  let Notification;
  try {
    Notification = require("electron").Notification;
  } catch {
    return null;
  }
  if (!Notification) return null;
  return (title, body) => {
    try {
      if (!__requestPermissionDone && Notification.isSupported && Notification.isSupported()) {
        __requestPermissionDone = true;
        Notification.requestPermission();
      }
      new Notification({ title, body, silent: false }).show();
    } catch (err) {
      log.warn(`[notes] notification failed: ${err?.message || err}`);
    }
  };
}

function setNotifierForTesting(fn) {
  __notify = fn;
}

function getNotifier() {
  if (__notify) return __notify;
  __notify = defaultNotifier();
  return __notify;
}

/** Fire one reminder through the notification + renderer paths. */
function fireReminder(reminder, mainWindow) {
  const notifier = getNotifier();
  const focused = !!(mainWindow && mainWindow.isFocused && mainWindow.isFocused());
  if (notifier) {
    notifier("Nova reminder", reminder.text);
  }
  if (mainWindow && !mainWindow.isDestroyed && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("nova:reminder-fired", {
      id: reminder.id,
      text: reminder.text,
      dueAt: reminder.dueAt,
      focused,
    });
  }
  // Round 19: register this fired reminder as snoozeable for a bounded window
  // — the UI chips resolve against this queue, not against the generic
  // "most recently fired" voice path.
  __pendingSnoozes.set(reminder.id, {
    id: reminder.id,
    text: reminder.text,
    dueAt: reminder.dueAt,
    firedAt: Date.now(),
  });
  log.info(`[notes] reminder fired: "${reminder.text}" (focused=${focused})`);
}

/**
 * Round 19: snooze a fired reminder identified by id (from the HUD banner
 * chips). Only valid while the entry is still in the pending queue — a
 * reminder that has already re-fired or aged out of the window cannot be
 * snoozed from the UI. A second snooze of the same entry replaces the first
 * (no stacking). Returns { ok, message, dueAt }.
 */
function snoozeFired(id, seconds) {
  const entry = __pendingSnoozes.get(id);
  if (!entry) {
    return { ok: false, message: "That reminder is no longer snoozable — it already fired again or was dismissed." };
  }
  if (Date.now() - entry.firedAt > SNOOZE_WINDOW_MS) {
    __pendingSnoozes.delete(id);
    return { ok: false, message: "The snooze window for that reminder has closed." };
  }
  const sec = Number(seconds) > 0 ? Number(seconds) : 600;
  const rearmed = store.rearmReminder(id, new Date(Date.now() + sec * 1000).toISOString());
  if (!rearmed) {
    __pendingSnoozes.delete(id);
    return { ok: false, message: "The reminder could not be re-armed — it may have been deleted." };
  }
  __pendingSnoozes.delete(id);
  log.info(`[notes] reminder snoozed via UI: "${entry.text}" — fires again at ${rearmed.dueAt}`);
  return { ok: true, message: `Reminder snoozed ${Math.round(sec / 60)} minute(s).`, dueAt: rearmed.dueAt, reminder: rearmed };
}

/** Scan once: fire everything due. Returns fired reminders. */
function scanOnce(mainWindow) {
  const due = store.dueReminders();
  if (!due.length) return [];
  const ids = due.map((r) => r.id);
  const n = store.markFired(ids);
  for (const r of due) fireReminder(r, mainWindow);
  // Round 34: re-arm recurring reminders at their next occurrence AFTER the
  // notification path completes — same row, next due, no orphan rows.
  for (const r of due) store.requeueFired(r.id);
  return due;
}

function start(mainWindow) {
  if (__timer) return;
  // Boot scan catches reminders that became due while the app was closed.
  scanOnce(mainWindow);
  __timer = setInterval(() => scanOnce(mainWindow), SCAN_MS);
  log.info(`[notes] reminder scheduler started (scan every ${SCAN_MS / 1000} s)`);
}

function stop() {
  if (__timer) {
    clearInterval(__timer);
    __timer = null;
  }
}

module.exports = {
  start, stop, scanOnce, setNotifierForTesting, getNotifier, SCAN_MS,
  // Round 19
  snoozeFired, pendingSnoozesForTesting, resetPendingSnoozesForTesting,
  setSnoozeWindowMsForTesting(ms) { SNOOZE_WINDOW_MS = ms; },
};
