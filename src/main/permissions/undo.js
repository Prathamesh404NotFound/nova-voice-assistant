// Nova — permissions/undo.js
//
// Undo support for reversible actions (Stage 5 req 3):
//   - Actions that can reverse themselves register a `reverse(payload)` fn
//     at registration time (via registerAction's new `reverse` option).
//   - undo.js remembers the LAST reversible SUCCESS per task and exposes
//     getUndoInfo() (usable within 5 minutes of the action) and undoLast().
//   - Undo runs through the SAME permission gate (L2 toast) and is logged
//     with outcome "undo" so the action log stays truthful.
//   - Mouse clicks / reads / irreversible actions simply never register a
//     reverse fn — the Undo button is greyed out for them.
//
// This stage has no file-system tools yet, so undo covers the demo rename/
// move actions plus typed text (typing is NOT reversible — no reverse fn
// registered for type-text, so Undo correctly stays disabled for it).

const log = require("electron-log");
const actionLog = require("./action-log");
const { getAction } = require("./action-registry");

const UNDO_WINDOW_MS = 5 * 60 * 1000;

let lastReversible = null; // { taskId, actionId, payload, reversed, at }

/**
 * Called by runAction after a SUCCESSFUL outcome, so the undo tracker knows
 * the latest reversible action. Pure record-keeping — never executes.
 */
function noteReversibleSuccess(taskId, actionId, payload, outcome) {
  if (outcome !== "success") return;
  const action = getAction(actionId);
  if (!action || typeof action.reverse !== "function") return;
  lastReversible = { taskId, actionId, payload, reversed: false, at: Date.now() };
}

/**
 * Is there a reversible action in the last 5 minutes?
 */
function canUndo() {
  if (!lastReversible || lastReversible.reversed) return false;
  return Date.now() - lastReversible.at < UNDO_WINDOW_MS;
}

/**
 * Describe the pending undo for the renderer (plain language, button label).
 * Returns null when nothing is undoable.
 */
function getUndoInfo() {
  if (!canUndo()) return null;
  const { actionId, payload } = lastReversible;
  const action = getAction(actionId);
  const label = undoLabel(actionId, payload);
  const agoSec = Math.round((Date.now() - lastReversible.at) / 1000);
  return {
    actionId,
    label,
    reversible: true,
    secondsAgo: agoSec,
    expiresInSeconds: Math.max(0, Math.round((UNDO_WINDOW_MS - (Date.now() - lastReversible.at)) / 1000)),
  };
}

function undoLabel(actionId, payload) {
  if (actionId === "demo:rename-file") {
    return `Undo rename (${payload.to || "…"} → ${payload.from || "…"})`;
  }
  if (actionId === "demo:move-file") {
    return `Undo move (${payload.to || "…"} → ${payload.from || "…"})`;
  }
  if (actionId === "demo:create-file") {
    return `Undo create (${payload.path || payload.to || "file"})`;
  }
  return "Undo last action";
}

/**
 * Execute the undo through the permission gate. Caller decides the gate
 * options (the undo itself is a reversible-ish L2 operation, so the
 * dispatcher asks for the normal toast flow).
 * @returns {{ undone: boolean, actionId?: string, error?: string }}
 */
async function undoLast(runActionFn) {
  if (!canUndo()) return { undone: false, error: "Nothing to undo in the last 5 minutes." };
  const { actionId, payload, taskId } = lastReversible;
  const action = getAction(actionId);
  lastReversible.reversed = true;
  // Merge the stored execute() outcome (moved/copied lists) into the undo
  // payload — bulk actions (organize/move/copy) need the actual result to
  // reverse, while simple actions (rename) only use the original payload.
  const reversePayload = action.lastResult
    ? { ...payload, ...(action.lastResult && typeof action.lastResult === "object" ? action.lastResult : {}) }
    : payload;
  try {
    await action.reverse(reversePayload);
    actionLog.append({ actionId: `${actionId}::undo`, level: action.level, taskId, outcome: "undo", detail: { undid: actionId } });
    log.info(`[undo] reversed "${actionId}"`);
    lastReversible = null;
    return { undone: true, actionId, payload, label: undoLabel(actionId, payload) };
  } catch (err) {
    log.error("[undo] reversal failed:", err?.message || err);
    actionLog.append({ actionId: `${actionId}::undo`, level: action.level, taskId, outcome: "failed", detail: { error: String(err?.message || err) } });
    return { undone: false, error: String(err?.message || err), label: undoLabel(actionId, payload) };
  }
}

/** Reset tracker (tests only). */
function resetUndoTrackerForTesting() {
  lastReversible = null;
}

module.exports = { noteReversibleSuccess, canUndo, getUndoInfo, undoLast, undoLabel, resetUndoTrackerForTesting, UNDO_WINDOW_MS };
