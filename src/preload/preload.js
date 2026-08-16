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

  // --- Chat (streaming, renderer-side fetch) ---
  // The renderer performs the fetch directly (avoids IPC streaming complexity).
  platform: process.platform,
});
