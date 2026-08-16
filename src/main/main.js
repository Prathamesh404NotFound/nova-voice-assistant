// Nova — main process
// Voice-first desktop AI assistant. Single-screen HUD, model router, secure key storage.

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require("electron");
const path = require("path");
const log = require("electron-log");
const { getKey, requireKeyOnce, isKeyConfigured, storeKey } = require("./keys");
const router = require("./router");

// Permission & safety framework (exists BEFORE any real tooling is added).
const settings = require("./settings");
const { listActions, getAction } = require("./permissions/action-registry");
const { runAction } = require("./permissions/gate");
const actionLog = require("./permissions/action-log");
require("./permissions/test-actions"); // demo actions for verifying gate paths

// Screen vision: desktopCapturer capture + offline tesseract.js OCR + vision
// query pipeline. All vision actions are Level 0 (read-only) and route through
// the permission framework / Action Log.
const { runVisionQuery } = require("./vision/vision-query");
require("./vision/vision-actions"); // registers vision:capture-screen (L0)
const { getScreenPermissionStatus, openScreenSettings } = require("./vision/screenshot");
const ocrShutdown = require("./vision/ocr").shutdown;

log.transports.file.level = "info";
log.transports.console.level = "info";

// ---------------------------------------------------------------------------
// Logging guard: never log the API key anywhere.
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: "Nova",
    backgroundColor: "#05060a",
    // Frameless window: custom chrome drawn in the renderer (top bar = drag region)
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      // Renderer must stay clean: no node modules, no require
      nodeIntegration: false,
      contextIsolation: true,
      // Web Speech API needs microphone + autoplay permissions
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Graceful show once rendered to avoid flash
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Minimal app menu (required on macOS for a usable app)
  if (process.platform === "darwin") {
    const menu = Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
    ]);
    Menu.setApplicationMenu(menu);
  } else {
    Menu.setApplicationMenu(null);
  }
}

// ---------------------------------------------------------------------------
// IPC: settings / API key
// ---------------------------------------------------------------------------
ipcMain.handle("nova:get-settings", async () => {
  return {
    keyConfigured: isKeyConfigured(),
    model: router.currentModel(),
    freeModelCount: router.freeModelCount(),
    updatedAt: router.lastUpdated(),
    fallbackInUse: router.isFallbackInUse(),
    privateMode: settings.isPrivateMode(),
  };
});

// ---------------------------------------------------------------------------
// IPC: permission & safety framework
// ---------------------------------------------------------------------------
ipcMain.handle("nova:get-actions", async () => listActions());

ipcMain.handle("nova:run-action", async (_evt, req) => {
  const { actionId, payload = {}, dryRun = false } = req || {};
  if (typeof actionId !== "string") {
    return { outcome: "failed", detail: { error: "actionId is required" } };
  }
  try {
    return await runAction(actionId, payload, { dryRun: !!dryRun });
  } catch (err) {
    log.error(`[permissions] nova:run-action failed:`, err?.message || err);
    return { outcome: "failed", detail: { error: String(err?.message || err) } };
  }
});

ipcMain.handle("nova:get-action-log", async () => actionLog.list());
ipcMain.handle("nova:clear-action-log", async () => { actionLog.clear(); return { ok: true }; });

ipcMain.handle("nova:get-private-mode", async () => settings.isPrivateMode());
ipcMain.handle("nova:set-private-mode", async (_evt, on) => {
  settings.setPrivateMode(!!on);
  return { ok: true, privateMode: settings.isPrivateMode() };
});

ipcMain.handle("nova:submit-key", async (_evt, key) => {
  if (typeof key !== "string" || key.trim().length === 0) {
    return { ok: false, error: "Key must be a non-empty string." };
  }
  storeKey(key.trim());
  log.info("OpenRouter key stored securely via safeStorage.");
  return { ok: true };
});

ipcMain.handle("nova:clear-key", async () => {
  storeKey(null);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: model router
// ---------------------------------------------------------------------------
ipcMain.handle("nova:refresh-models", async () => {
  try {
    await router.refresh({ force: true });
    return { ok: true, model: router.currentModel(), freeModelCount: router.freeModelCount(), updatedAt: router.lastUpdated(), fallbackInUse: router.isFallbackInUse() };
  } catch (err) {
    log.error("Model refresh failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("nova:get-router-logs", async () => {
  return router.pickLogs();
});

// ---------------------------------------------------------------------------
// IPC: window chrome (frameless)
// ---------------------------------------------------------------------------
ipcMain.on("nova:minimize", () => mainWindow?.minimize());
ipcMain.on("nova:maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("nova:close", () => mainWindow?.close());

// ---------------------------------------------------------------------------
// IPC: screen vision (Level 0 — read-only, logged to the Action Log)
// ---------------------------------------------------------------------------
ipcMain.handle("nova:vision-query", async (_evt, question) => {
  try {
    return await runVisionQuery(question);
  } catch (err) {
    return { error: String(err?.message || err) };
  }
});

ipcMain.handle("nova:check-screen-permission", async () => {
  return { platform: process.platform, status: getScreenPermissionStatus() };
});

ipcMain.handle("nova:open-screen-settings", async () => {
  return openScreenSettings();
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  // 1. Resolve API key: env var > keychain > prompt once
  const envKey = process.env.OPENROUTER_API_KEY || undefined;
  if (envKey) {
    log.info("OpenRouter key loaded from OPENROUTER_API_KEY env var (env takes precedence).");
    storeKey(envKey); // cache securely so settings screen isn't nagged
  } else if (!isKeyConfigured()) {
    requireKeyOnce(mainWindow);
  }

  log.info(`[permissions] ${listActions().length} actions registered; privateMode=${settings.isPrivateMode()}`);

  // 2. Warm the model router (fetch free models, then refresh every 6 hours)
  try {
    await router.refresh({ force: true });
  } catch (err) {
    log.warn("Initial model fetch failed — router will use fallback model:", err?.message || err);
  }
  router.startPeriodicRefresh({ intervalMs: 6 * 60 * 60 * 1000 });
  log.info(`Model router: current=${router.currentModel()} freeModels=${router.freeModelCount()} fallback=${router.isFallbackInUse()}`);

  createWindow();

  // Hidden verification flag: `electron . --run-demo-action <id>` fires a single
  // demo action through the permission gate once the window is ready to show.
  // Used to visually verify toast/modal confirmation flows (e.g. in Xvfb).
  const demoIdx = process.argv.indexOf("--run-demo-action");
  if (demoIdx !== -1) {
    const actionId = process.argv[demoIdx + 1];
    if (actionId) {
      mainWindow.once("show", async () => {
        await new Promise((r) => setTimeout(r, 2500));
        log.info(`[verify] firing demo action through the gate: ${actionId}`);
        const res = await runAction(actionId, { from: "notes.txt", to: "notes-new.txt" }, { dryRun: false });
        log.info(`[verify] demo action result:`, JSON.stringify(res));
      });
    }
  }
});

app.on("before-quit", () => {
  // Release the tesseract.js worker (WASM memory) on shutdown.
  ocrShutdown().catch(() => {});
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
