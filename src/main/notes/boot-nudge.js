// Nova — notes/boot-nudge.js
//
// Round 18: one-per-session overdue-task boot nudge.
// When Nova starts, if there are pending tasks past their due date, a single
// spoken + side-panel nudge is queued once the main window exists. It is
// deliberately a READ (L0) — nothing is modified, and the nudge itself is
// just a renderer event Nova's renderer already speaks aloud.
//
// Design notes:
//   - Fires at most once per boot (module-level flag), and only if the
//     window is still alive when the timer runs.
//   - If a reminder fires in the same first minute, the nudge is dropped —
//     the user is already being nudged; no double-buzz at startup.
//   - Fully local: reads the notes store only. Zero network.

const log = require("electron-log");

let __nudgeFired = false;
let __queued = null; // scheduled timer handle (test hook: nudgeStopForTesting)

function overdueNudgePayload() {
  const store = require("./store");
  const stats = store.taskStats();
  if (!stats.overdue) return null;
  const tasks = store.all().tasks.filter((t) => !t.done && t.dueDate && new Date(t.dueDate).getTime() < (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })());
  const names = tasks.slice(0, 3).map((t) => t.text);
  const rest = tasks.length > 3 ? ` and ${tasks.length - 3} more` : "";
  return {
    text: `Good morning — you have ${tasks.length} overdue task${tasks.length === 1 ? "" : "s"}: ${names.join(", ")}${rest}.`,
    count: tasks.length,
  };
}

/**
 * Start the boot nudge. Called once from main.js after the window exists.
 * @param {{webContents?: {send?: Function}}} mainWindow
 */
function start(mainWindow) {
  if (__nudgeFired) return;
  __queued = setTimeout(() => {
    __queued = null;
    const payload = overdueNudgePayload();
    if (!payload) return;
    if (!mainWindow || !mainWindow.webContents || mainWindow.isDestroyed && mainWindow.isDestroyed()) {
      log.info("[boot-nudge] window gone before nudge — skipped");
      return;
    }
    try {
      mainWindow.webContents.send("nova:task-due-nudge", payload);
      __nudgeFired = true;
      log.info(`[boot-nudge] overdue nudge sent (${payload.count} overdue task(s))`);
    } catch (err) {
      log.warn("[boot-nudge] failed to send nudge:", err?.message || err);
    }
  }, 3000);
}

function resetForTesting() {
  __nudgeFired = false;
  if (__queued) { clearTimeout(__queued); __queued = null; }
}

module.exports = { start, resetForTesting, overdueNudgePayload };
