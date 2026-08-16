// Nova — preload: secure bridge between renderer and main process.
// The renderer gets NO node access; only the methods below are exposed.

const { contextBridge, ipcRenderer } = require("electron");

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

  // Permission toast: main process announces L2 actions; renderer can cancel.
  onPermissionToast: (cb) => {
    const listener = (_evt, data) => cb(data);
    ipcRenderer.on("nova:permission-toast", listener);
    return () => ipcRenderer.removeListener("nova:permission-toast", listener);
  },
  cancelToast: (toastId) => ipcRenderer.send("nova:permission-toast-reply", { toastId }),
  onSettingsChanged: (cb) => {
    const listener = (_evt, data) => cb(data);
    ipcRenderer.on("nova:settings-changed", listener);
    return () => ipcRenderer.removeListener("nova:settings-changed", listener);
  },

  // --- Screen vision (Level 0 READ — every capture is logged) ---
  visionQuery: (question) => ipcRenderer.invoke("nova:vision-query", question),
  checkScreenPermission: () => ipcRenderer.invoke("nova:check-screen-permission"),
  openScreenSettings: () => ipcRenderer.invoke("nova:open-screen-settings"),

  // --- Chat (streaming, renderer-side fetch) ---
  // The renderer performs the fetch directly (avoids IPC streaming complexity).
  platform: process.platform,
});
