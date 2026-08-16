// Nova — app settings (Private Mode + misc).
//
// Private Mode: when ON, Nova must not make any outbound network calls other
// than openrouter.ai; for now ALL outbound work is refused with a placeholder
// message ("no local model configured") — local models arrive in a later stage.
// Persisted to userData/settings.json (no secrets here; the API key stays in
// safeStorage via keys.js).

const fs = require("fs");
const path = require("path");
const log = require("electron-log");

const DEFAULTS = { privateMode: false };

let data = { ...DEFAULTS };

function settingsPath() {
  let dataDir;
  try {
    dataDir = require("electron").app.getPath("userData");
  } catch {
    dataDir = process.cwd();
  }
  return path.join(dataDir, "settings.json");
}

function load() {
  try {
    if (fs.existsSync(settingsPath())) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
      data = { ...DEFAULTS, ...(parsed || {}) };
    }
  } catch (err) {
    log.warn("Failed to load settings:", err?.message || err);
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2));
  } catch (err) {
    log.warn("Failed to persist settings:", err?.message || err);
  }
}

function isPrivateMode() {
  return !!data.privateMode;
}

function isDeveloperMode() {
  return !!data.developerMode;
}

function setDeveloperMode(on) {
  data.developerMode = !!on;
  persist();
  log.info(`[settings] developerMode=${data.developerMode}`);
  // Notify all renderer windows so the Developer Mode panel updates.
  try {
    const { BrowserWindow } = require("electron");
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send("nova:settings-changed", { developerMode: data.developerMode }); } catch { /* */ }
    }
  } catch { /* before app ready */ }
}

function setPrivateMode(on) {
  data.privateMode = !!on;
  persist();
  log.info(`[settings] privateMode=${data.privateMode}`);
  // Notify all renderer windows so the PRIVATE badge updates immediately.
  try {
    const { BrowserWindow } = require("electron");
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send("nova:settings-changed", { privateMode: data.privateMode }); } catch { /* */ }
    }
  } catch { /* before app ready */ }
}

function all() {
  return { ...data };
}

/** Generic setter for misc flags (e.g. onboarding acknowledgements). */
function setRaw(key, value) {
  data[key] = value;
  persist();
}

load();

module.exports = { isPrivateMode, setPrivateMode, isDeveloperMode, setDeveloperMode, all, setRaw };

