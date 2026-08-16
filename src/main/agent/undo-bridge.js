// Nova — agent/undo-bridge.js
//
// Undo IPC surface (Stage 5 req 3):
//   nova:get-undo-info  → is there an undoable action (reversible success,
//                          last 5 minutes)? Returns label + button state.
//   nova:undo           → runs the reversal. The reversal itself executes
//                          immediately for demo actions, but undo is always
//                          announced and logged with outcome "undo" via the
//                          gate's own path in undo.js. The renderer confirms
//                          the action with the user before invoking this
//                          (it shows the same toast pattern for undo).
//   nova:set-dev-mode   → Developer Mode toggle (settings).
//   nova:get-last-task  → the Dev Mode task inspector payload.
//   nova:get-onboarding → permission state + pending onboarding screens.
//   nova:ack-onboarding / nova:run-accessibility-test → onboarding flow.

const { ipcMain } = require("electron");
const log = require("electron-log");
const settings = require("../settings");
const { getUndoInfo, undoLast, resetUndoTrackerForTesting } = require("../permissions/undo");
const { runAction } = require("../permissions/gate");
const dispatcher = require("./dispatcher");
const onboarding = require("./onboarding");
const { plainError } = require("./retry");

ipcMain.handle("nova:get-undo-info", async () => {
  try {
    return { ok: true, info: getUndoInfo() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/**
 * Undo the last reversible action. The renderer shows its own light
 * confirmation (the action is reversible by design); the reversal runs
 * through the same logging path and is announced as outcome "undo".
 */
ipcMain.handle("nova:undo", async (_evt, opts = {}) => {
  try {
    const result = await undoLast(async (id, payload) => {
      // Run the reversal through the same gate (toast flow applies for L2).
      const res = await runAction(id, payload, opts);
      return res;
    });
    return result.undone ? { ok: true, undone: true, label: result.label } : { ok: false, undone: false, error: result.error };
  } catch (err) {
    return { ok: false, undone: false, error: plainError(err, "the undo") };
  }
});

ipcMain.handle("nova:get-last-task", async () => {
  try {
    return { ok: true, task: dispatcher.getLastTask() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("nova:set-dev-mode", async (_evt, on) => {
  settings.setDeveloperMode(!!on);
  return { ok: true, developerMode: settings.isDeveloperMode() };
});

ipcMain.handle("nova:get-onboarding", async () => {
  try {
    return { ok: true, platform: onboarding.platform(), state: onboarding.permissionState(), pending: onboarding.pendingScreens() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("nova:ack-onboarding", async (_evt, id) => {
  try {
    onboarding.acknowledge(id);
    return { ok: true, pending: onboarding.pendingScreens() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("nova:run-accessibility-test", async () => {
  try {
    const result = onboarding.runAccessibilityTest();
    return { ok: true, ...result, state: onboarding.permissionState() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// Expose for tests (reset the undo tracker between runs).
module.exports = { resetUndoTrackerForTesting };
