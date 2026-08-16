// Nova — permission gate.
//
// Central decision point for every tool/action:
//   Level 0–1 (Read/Safe)      → execute immediately
//   Level 2   (Reversible)     → toast countdown (5 s); user can cancel
//   Level 3–4 (Sensitive/Destructive) → modal with plain-language description;
//                                       explicit Confirm required
//
// All decisions and outcomes feed the Action Log (`action-log.js`).
// Private Mode (settings) overrides: outbound work blocked (L3 actions that
// touch the network are refused even before asking).

const { dialog, BrowserWindow } = require("electron");
const log = require("electron-log");
const { RISK_LEVEL, riskLabel } = require("./risk-levels");
const { getAction } = require("./action-registry");
const actionLog = require("./action-log");
const settings = require("../settings");
const undo = require("./undo");

let toastCounter = 0;

/**
 * Run an action through the permission gate.
 * @param {string} actionId  registered action id
 * @param {object} payload   passed to execute()/simulate()
 * @param {object} opts
 * @param {boolean} opts.dryRun   if true, run simulate() only and return its report
 * @param {string}  opts.taskId   agent-task id; flows into the action log so the
 *                                Developer Mode inspector can group entries by task
 * @returns {{ outcome: "success"|"failed"|"cancelled"|"blocked", detail?: any }}
 */
async function runAction(actionId, payload = {}, opts = {}) {
  const action = getAction(actionId);

  // Dry run: never executes, but is recorded in the action log with
  // outcome="dry-run" so every gate decision is auditable.
  if (opts.dryRun) {
    const report = await action.simulate(payload);
    actionLog.append({ actionId, level: action.level, outcome: "dry-run", taskId: opts.taskId, detail: report });
    log.info(`[permissions] "${actionId}" dry-run:`, JSON.stringify(report));
    return { outcome: "dry-run", detail: report };
  }

  // Private Mode: block anything sensitive/destructive (network-touching),
  // AND any physically-invasive action (mouse/keyboard control) — controlling
  // the user's machine is invasive regardless of network reach.
  if (settings.isPrivateMode()) {
    if (action.level >= RISK_LEVEL.SENSITIVE || action.physical) {
      actionLog.append({ actionId, level: action.level, outcome: "blocked", taskId: opts.taskId, reason: "private-mode" });
      log.info(`[permissions] "${actionId}" blocked by Private Mode`);
      return { outcome: "blocked" };
    }
  }

  if (action.level <= RISK_LEVEL.SAFE) {
    // Level 0–1: immediate execution, logged afterwards.
    return executeAndLog(action, payload, opts.taskId);
  }

  if (action.level === RISK_LEVEL.REVERSIBLE) {
    // Level 2: toast with 5-second cancellation window.
    const cancelled = await toastConfirm(action, payload);
    if (cancelled) {
      actionLog.append({ actionId, level: action.level, outcome: "cancelled", taskId: opts.taskId });
      log.info(`[permissions] "${actionId}" cancelled in toast window`);
      return { outcome: "cancelled" };
    }
    return executeAndLog(action, payload, opts.taskId);
  }

  // Level 3–4: modal with explicit Confirm.
  const confirmed = await modalConfirm(action, payload);
  if (!confirmed) {
    actionLog.append({ actionId, level: action.level, outcome: "cancelled", taskId: opts.taskId });
    log.info(`[permissions] "${actionId}" declined in modal`);
    return { outcome: "cancelled" };
  }
  return executeAndLog(action, payload, opts.taskId);
}

async function executeAndLog(action, payload, taskId) {
  const started = Date.now();
  try {
    const detail = await action.execute(payload);
    actionLog.append({ actionId: action.id, level: action.level, outcome: "success", taskId, startedAt: started, detail });
    // Undo tracking: remember the last reversible SUCCESS (has a reverse fn).
    undo.noteReversibleSuccess(taskId, action.id, payload, "success");
    return { outcome: "success", detail };
  } catch (err) {
    const detail = { error: String(err?.message || err) };
    actionLog.append({ actionId: action.id, level: action.level, outcome: "failed", taskId, startedAt: started, detail });
    log.error(`[permissions] "${action.id}" failed:`, err?.message || err);
    return { outcome: "failed", detail };
  }
}

/**
 * Level 2: announce via the renderer toast and give the user 5 s to cancel.
 * Returns true if the user cancelled.
 */
function toastConfirm(action, payload) {
  const toastId = `toast-${++toastCounter}`;
  return new Promise((resolve) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win?.webContents) return resolve(false);

    const cancelledRef = { value: false };
    const timer = setTimeout(() => {
      cleanup();
      resolve(cancelledRef.value);
    }, 5000);

    function cleanup() {
      clearTimeout(timer);
      try {
        win.webContents.send("nova:permission-toast", { type: "hide", toastId });
      } catch { /* window gone */ }
    }

    // Listen once for a cancel from the renderer — registered BEFORE the toast
    // is announced so there is no race between announcement and cancellation.
    const listener = (_evt, data) => {
      if (data?.toastId !== toastId) return;
      cancelledRef.value = true;
      cleanup();
      resolve(true);
    };
    try {
      // once() removes itself after the first matching reply.
      win.webContents.once("nova:permission-toast-reply", listener);
    } catch {
      // Renderer gone; let the timer decide.
    }
    // Keep reference so cancelToast() can clean up early.
    toastTimers.set(toastId, { timer, listener, win });

    // Renderer shows the toast and calls nova:cancel-toast on click.
    describeActionPlain(action, payload).then((plain) => {
      try {
        const payload_ = {
          type: "show",
          toastId,
          level: action.level,
          message: plain && plain.title ? plain.title : `Nova wants to ${action.description.toLowerCase()}`,
          body: (plain && plain.body) || "",
        };
        log.info(`[permissions] toast send for ${action.id}:`, JSON.stringify(payload_));
        win.webContents.send("nova:permission-toast", payload_);
      } catch (err) {
        log.error("[permissions] toast send failed:", err?.message);
        cleanup();
      }
    }).catch((err) => {
      log.error("[permissions] describe failed:", err?.message);
      cleanup();
    });
  });
}

const toastTimers = new Map();

function cancelToast(toastId) {
  const entry = toastTimers.get(toastId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  toastTimers.delete(toastId);
  try { entry.win.webContents.send("nova:permission-toast", { type: "hide", toastId }); } catch { /* */ }
  return true;
}

/**
 * Level 3–4: native modal demanding explicit confirmation.
 */
async function modalConfirm(action, payload) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return false;

  const plain = await describeActionPlain(action, payload);
  const { response } = await dialog.showMessageBox(win, {
    type: action.level === RISK_LEVEL.DESTRUCTIVE ? "warning" : "question",
    title: `Nova — ${riskLabel(action.level)} action`,
    message: plain.title,
    detail: plain.body,
    buttons: ["Cancel", "Confirm"],
    defaultId: 0,
    cancelId: 0,
  });
  return response === 1;
}

/**
 * Compose a plain-language description of the action for humans.
 * Tools MAY override by returning { title, body } from simulate({ __describe: true }).
 */
async function describeActionPlain(action, payload) {
  // Ask the action itself for a human description via its simulate path.
  if (action.simulate) {
    try {
      const desc = await action.simulate({ ...payload, __describe: true });
      if (desc && typeof desc === "object" && desc.title && desc.body) return desc;
    } catch { /* fall through to generic */ }
  }
  return {
    title: `Nova wants to ${action.description.toLowerCase()}`,
    body: `Action: ${action.id}  (risk level ${riskLabel(action.level)}, requires confirmation)\nPayload: ${JSON.stringify(payload).slice(0, 300)}`,
  };
}

module.exports = { runAction, cancelToast, toastConfirm, modalConfirm, describeActionPlain };
