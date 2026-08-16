// Nova — main process
// Voice-first desktop AI assistant. Single-screen HUD, model router, secure key storage.

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require("electron");
const path = require("path");
const log = require("electron-log");
const { getKey, requireKeyOnce, isKeyConfigured, storeKey } = require("./keys");
const router = require("./router");

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
  };
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

  // 2. Warm the model router (fetch free models, then refresh every 6 hours)
  try {
    await router.refresh({ force: true });
  } catch (err) {
    log.warn("Initial model fetch failed — router will use fallback model:", err?.message || err);
  }
  router.startPeriodicRefresh({ intervalMs: 6 * 60 * 60 * 1000 });
  log.info(`Model router: current=${router.currentModel()} freeModels=${router.freeModelCount()} fallback=${router.isFallbackInUse()}`);

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
