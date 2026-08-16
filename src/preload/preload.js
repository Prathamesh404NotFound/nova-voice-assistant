// Nova — preload: secure bridge between renderer and main process.
// The renderer gets NO node access; only the methods below are exposed.

const { contextBridge, ipcRenderer } = require("electron");

// Local settings mirror: kept in sync with the main process so lightweight
// helpers (isDevMode, isPrivateMode) stay synchronous.
let __devModeCache = false;
let __privateModeCache = false;
ipcRenderer.invoke("nova:get-settings").then((s) => {
  if (s && typeof s === "object") {
    __devModeCache = !!s.developerMode;
    __privateModeCache = !!s.privateMode;
  }
}).catch(() => {});
ipcRenderer.on("nova:settings-changed", (_evt, s) => {
  if (s && typeof s === "object") {
    if (s.developerMode != null) __devModeCache = !!s.developerMode;
    if (s.privateMode != null) __privateModeCache = !!s.privateMode;
  }
});

contextBridge.exposeInMainWorld("nova", {
  // --- Window chrome (frameless) ---
  minimize: () => ipcRenderer.send("nova:minimize"),
  maximize: () => ipcRenderer.send("nova:maximize"),
  close: () => ipcRenderer.send("nova:close"),

  // --- Settings / key ---
  getSettings: () => ipcRenderer.invoke("nova:get-settings"),
  submitKey: (key) => ipcRenderer.invoke("nova:submit-key", key),
  clearKey: () => ipcRenderer.invoke("nova:clear-key"),

  // --- Model router ---
  refreshModels: () => ipcRenderer.invoke("nova:refresh-models"),
  getRouterLogs: () => ipcRenderer.invoke("nova:get-router-logs"),

  // --- Permission & safety framework ---
  getActions: () => ipcRenderer.invoke("nova:get-actions"),
  runAction: (actionId, payload = {}, opts = {}) =>
    ipcRenderer.invoke("nova:run-action", { actionId, payload, ...opts }),
  getActionLog: () => ipcRenderer.invoke("nova:get-action-log"),
  clearActionLog: () => ipcRenderer.invoke("nova:clear-action-log"),
  getPrivateMode: () => ipcRenderer.invoke("nova:get-private-mode"),
  setPrivateMode: (on) => ipcRenderer.invoke("nova:set-private-mode", on),

  // --- Unified agent loop (Stage 5) ---
  agentRun: (text) => ipcRenderer.invoke("nova:agent-run", text),
  // --- File preview confirmation (Stage 6) ---
  filesExecute: (previewToken) => ipcRenderer.invoke("nova:files-execute", previewToken),
  onAgentProgress: (cb) => {
    const listener = (_evt, event) => cb(event);
    ipcRenderer.on("nova:agent-progress", listener);
    return () => ipcRenderer.removeListener("nova:agent-progress", listener);
  },

  // --- Undo (Stage 5) ---
  getUndoInfo: () => ipcRenderer.invoke("nova:get-undo-info"),
  undoLast: (opts) => ipcRenderer.invoke("nova:undo", opts || {}),

  // --- Developer Mode (Stage 5) ---
  getLastTask: () => ipcRenderer.invoke("nova:get-last-task"),
  setDevMode: (on) => ipcRenderer.invoke("nova:set-dev-mode", on),
  // Local dev-mode mirror kept in sync via nova:settings-changed.
  isDevMode: () => __devModeCache,
  isPrivateMode: () => __privateModeCache,

  // Cached settings mirror (kept in sync via nova:settings-changed).
  onSettingsChanged: (cb) => {
    const listener = (_evt, s) => cb(s);
    ipcRenderer.on("nova:settings-changed", listener);
    return () => ipcRenderer.removeListener("nova:settings-changed", listener);
  },
  // --- First-run onboarding (Stage 5) ---
  getOnboarding: () => ipcRenderer.invoke("nova:get-onboarding"),
  ackOnboarding: (id) => ipcRenderer.invoke("nova:ack-onboarding", id),
  runAccessibilityTest: () => ipcRenderer.invoke("nova:run-accessibility-test"),
  onOnboarding: (cb) => {
    const listener = (_evt, data) => cb(data);
    ipcRenderer.on("nova:onboarding", listener);
    return () => ipcRenderer.removeListener("nova:onboarding", listener);
  },
  onPermissionToast: (cb) => {
    const listener = (_evt, data) => cb(data);
    ipcRenderer.on("nova:permission-toast", listener);
    return () => ipcRenderer.removeListener("nova:permission-toast", listener);
  },
  cancelToast: (toastId) => ipcRenderer.send("nova:permission-toast-reply", { toastId }),

  // --- Screen vision (Level 0 READ — every capture is logged) ---
  visionQuery: (question) => ipcRenderer.invoke("nova:vision-query", question),
  checkScreenPermission: () => ipcRenderer.invoke("nova:check-screen-permission"),
  openScreenSettings: () => ipcRenderer.invoke("nova:open-screen-settings"),

  // --- Mouse & keyboard control (Stage 4 — gated via the permission framework) ---
  controlPlan: (instruction) => ipcRenderer.invoke("nova:control-plan", instruction),
  controlStart: () => ipcRenderer.invoke("nova:control-start"),
  controlAbort: () => ipcRenderer.invoke("nova:control-abort"),
  controlCursor: () => ipcRenderer.invoke("nova:control-cursor"),
  // Progress events from a running sequence: step running/done/verified/failed/aborted/cancelled,
  // sequence state changes, and final finished event.
  onControlProgress: (cb) => {
    const listener = (_evt, data) => cb(data);
    ipcRenderer.on("nova:control-progress", listener);
    return () => ipcRenderer.removeListener("nova:control-progress", listener);
  },

  // --- Chat (streaming, renderer-side fetch) ---
  // The renderer performs the fetch directly (avoids IPC streaming complexity).
  platform: process.platform,
});

