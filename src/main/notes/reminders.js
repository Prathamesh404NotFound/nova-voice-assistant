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

let __timer = null;
let __notify = null;           // (title, body, { focused }) → void
let __requestPermissionDone = false;

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
  log.info(`[notes] reminder fired: "${reminder.text}" (focused=${focused})`);
}

/** Scan once: fire everything due. Returns fired reminders. */
function scanOnce(mainWindow) {
  const due = store.dueReminders();
  if (!due.length) return [];
  const ids = due.map((r) => r.id);
  const n = store.markFired(ids);
  for (const r of due) fireReminder(r, mainWindow);
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

module.exports = { start, stop, scanOnce, setNotifierForTesting, SCAN_MS };
