// Nova — main process
// Voice-first desktop AI assistant. Single-screen HUD, model router, secure key storage.

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require("electron");
const path = require("path");
const log = require("electron-log");
const { getKey, requireKeyOnce, isKeyConfigured, storeKey,
  getAccessKey, isAccessKeyConfigured, storeAccessKey } = require("./keys");
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

// Mouse & keyboard control (Stage 4) — all primitives gated through the
// permission framework; plan review + progress checklist in the renderer;
// Ctrl+Shift+Escape hard kill-switch + visible STOP button.
const control = require("./control");
control.init();
// Unified agent loop (Stage 5): intent classification, dispatch, narration,
// retry + plain-language errors, undo, Dev Mode inspector, onboarding.
const dispatcher = require("./agent/dispatcher");
require("./agent/undo-bridge"); // registers the undo / dev-mode / onboarding IPCs
const onboarding = require("./agent/onboarding");
const { globalShortcut } = require("electron");

// File management (Stage 6) — every files:* action goes through the existing
// permission gate: L0 read / L2 cancellable toast / L4 modal, dry-run
// previews for organize & duplicate removal, OS Recycle-Bin deletes only,
// Nova Undo on reversible moves. Registration must happen before the first
// agent run so the gate knows the actions.
require("./files/actions");
const { executePreview } = require("./files/dispatch");

// Notes / reminders / tasks (Stage 7) — fully local (userData/nova-notes.json)
// except the explicit "summarize my notes" flow. Notes:* actions are L1 safe
// for create/read and L2 reversible for edit/delete/summarize, all gated
// through the existing permission gate. Registration must happen before the
// first agent run so the gate knows the actions.
require("./notes/actions");
const reminders = require("./notes/reminders");

// Knowledge base (Stage 8) — fully local: folder indexing with MiniLM
// embeddings (transformers.js), chokidar watchers for incremental re-index,
// RAG queries that send ONLY snippets to the model router. All kb:* actions
// go through the existing permission gate (L1 read / L2 reversible).
require("./kb/actions");
const kbWatcher = require("./kb/watcher");

// Automation engine (Stage 9) — scheduling + chaining of existing tools
// (vision / control / files / notes / kb). Local cron scheduler; Level 3+
// steps pause for in-app confirmation; run history flows into the Action Log.
const automationDispatch = require("./automation/dispatch");
const automationRunner = require("./automation/runner");
const automationScheduler = require("./automation/scheduler");
const remindersNotifier = require("./notes/reminders");

// --- Automation side panel + scheduler boot ---
ipcMain.handle("nova:auto-list", async () => {
  try {
    return { ok: true, automations: automationDispatch.listAutomations() };
  } catch (err) {
    log.error("[automation] auto-list failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle("nova:auto-run-now", async (_evt, id) => {
  try {
    return await automationDispatch.runAutomationNow(String(id), {
      mainWindow,
      runVisionQuery: async (question) => {
        try { return await runVisionQuery(question); } catch (err) { return { error: String(err?.message || err) }; }
      },
    });
  } catch (err) {
    log.error("[automation] auto-run-now failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle("nova:auto-toggle", async (_evt, req) => {
  try {
    return await automationDispatch.toggleAutomation(String(req?.id), !!req?.enabled);
  } catch (err) {
    log.error("[automation] auto-toggle failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle("nova:auto-delete", async (_evt, id) => {
  try {
    // Level 1 (SAFE): only removes the schedule — nothing past is affected.
    return await automationDispatch.deleteAutomation(String(id));
  } catch (err) {
    log.error("[automation] auto-delete failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle("nova:auto-confirm", async (_evt, id) => {
  try {
    return await automationDispatch.confirmAutomation(String(id));
  } catch (err) {
    log.error("[automation] auto-confirm failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
});

// When a scheduled L3+ automation fires, it pauses for confirmation:
// OS notification (via the reminders notifier, same channel as reminders)
// + a pending card in the side panel.
automationScheduler.emitter.on("automation-firing", async ({ id, name }) => {
  try {
    const result = await automationRunner.runAutomation(id, {
      mainWindow,
      runVisionQuery: async (question) => {
        try { return await runVisionQuery(question); } catch (err) { return { error: String(err?.message || err) }; }
      },
      getKey: async () => (await getKey().catch(() => null)) || null,
    });
    if (result.status === "awaiting-confirmation") {
      try {
        const notifier = remindersNotifier.getNotifier();
        if (notifier) {
          notifier("Nova automation needs your confirmation", `${name} wants to run sensitive steps — open Nova and confirm.`);
        }
      } catch (err) {
        log.warn("[automation] notification failed:", err?.message || err);
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send("nova:auto-run-result", { id, name, ...result });
      } catch {}
    }
  } catch (err) {
    log.error("[automation] scheduled run failed:", err?.message || err);
  }
});
automationScheduler.emitter.on("automation-pending", ({ id, name }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send("nova:auto-pending", { id, name });
    } catch {}
  }
});

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
    // Start watching all indexed folders for incremental re-indexing.
    // No folders indexed yet on a fresh launch — startAll is a no-op then.
    kbWatcher.startAll();
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
// IPC: Porcupine AccessKey (wake word, Stage 10 Round 2)
// ---------------------------------------------------------------------------
ipcMain.handle("nova:get-access-key-status", async () => {
  return { configured: isAccessKeyConfigured(), key: getAccessKey() };
});
ipcMain.handle("nova:submit-access-key", async (_evt, key) => {
  if (typeof key !== "string" || key.trim().length === 0) {
    return { ok: false, error: "AccessKey must be a non-empty string." };
  }
  storeAccessKey(key.trim());
  log.info("Porcupine AccessKey stored in memory (never persisted to disk).");
  return { ok: true };
});
ipcMain.handle("nova:clear-access-key", async () => {
  storeAccessKey(null);
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
// IPC: mouse & keyboard control (Stage 4)
// ---------------------------------------------------------------------------

// Emit control progress to the renderer (only the live window).
control.sequence.setEmitter((event) => {
  if (!mainWindow?.webContents) return;
  try {
    mainWindow.webContents.send("nova:control-progress", event);
  } catch { /* window gone */ }
});

// Hold the last compiled plan until the user confirms and execution begins.
let lastPlan = null;

/** Compile the instruction and send the plan to the renderer for review. */
ipcMain.handle("nova:control-plan", async (_evt, instruction) => {
  const result = control.compilePlan(instruction);
  if (!result.ok) return { ok: false, error: result.error };
  lastPlan = result.plan;
  control.sequence.reviewing(`plan-${Date.now()}`);
  return { ok: true, plan: result.plan, summary: result.summary };
});

/** Start executing a reviewed plan (user confirmed in the renderer). */
ipcMain.handle("nova:control-start", async () => {
  const planToRun = lastPlan;
  lastPlan = null;
  if (!planToRun?.length) return { ok: false, error: "No plan is awaiting confirmation." };
  if (!control.sequence.start()) return { ok: false, error: "No plan is awaiting confirmation." };
  // Fire-and-forget: progress events flow through the emitter above.
  control.runSequence({ plan: planToRun }).then((res) => {
    control.sequence.emit({ type: "finished", ...res });
  }).catch((err) => {
    log.error("[control] sequence errored:", err?.message || err);
    control.sequence.emit({ type: "finished", finished: "failed", failedStepId: null });
  });
  return { ok: true };
});

/** Abort the running sequence (STOP button / kill-switch / voice). */
ipcMain.handle("nova:control-abort", async () => {
  const was = control.sequence.abort("renderer abort");
  return { ok: true, aborted: was };
});

/** L0 cursor read. */
ipcMain.handle("nova:control-cursor", async () => {
  try {
    const res = await runAction("control:cursor-position", {});
    return res.outcome === "success" ? res.detail : { error: res.outcome };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
});

// ---------------------------------------------------------------------------
// IPC: unified agent loop (Stage 5)
// Every message (voice or text) routes through the agent: classify ->
// dispatch (conversation / vision / control / combined) -> narrate.
// ---------------------------------------------------------------------------
/**
 * Forward agent progress (narration steps + chat stream chunks) to the
 * renderer. The renderer speaks narrations out loud and streams chat text.
 */
dispatcher.on("progress", (event) => {
  if (!mainWindow?.webContents) return;
  try {
    mainWindow.webContents.send("nova:agent-progress", event);
  } catch { /* window gone */ }
});
/**
 * Execute a confirmed file-preview (organize / duplicate-removal dry-run).
 * The token MUST come from a preview the user explicitly confirmed in the
 * renderer — there is no direct execute path for these actions.
 */
ipcMain.handle("nova:files-execute", async (_evt, previewToken) => {
  try {
    return await executePreview(String(previewToken || ""));
  } catch (err) {
    log.error("[files] files-execute failed:", err?.message || err);
    return { ok: false, intent: "files", text: "The action could not be executed — details are in Developer Mode.", error: String(err?.message || err) };
  }
});

// ---------------------------------------------------------------------------
// IPC: notes / reminders / tasks (Stage 7)
// ---------------------------------------------------------------------------
/** Read-only mirror of the local store for the side panel (L0-equivalent). */
ipcMain.handle("nova:get-notes-store", () => {
  try {
    return { ok: true, store: require("./notes/store").all() };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/**
 * Run a notes message through the permission gate directly (side panel
 * mouse/keyboard path — same actions as the voice path, same levels).
 * Summarize is the only action that ever leaves the machine.
 */
ipcMain.handle("nova:notes-run", async (_evt, text) => {
  try {
    const { getKey } = require("./keys");
    const keyPromise = getKey().catch(() => null);
    const { runNoteAction } = require("./notes/dispatch");
    return await runNoteAction(String(text || ""), {
      getKey: async () => (await keyPromise) || null,
      mainWindow,
    });
  } catch (err) {
    log.error("[notes] notes-run failed:", err?.message || err);
    return { ok: false, intent: "notes", text: "Something went wrong — details are in Developer Mode.", error: String(err?.message || err) };
  }
});

// ---------------------------------------------------------------------------
// IPC: knowledge base (Stage 8) — side panel management + click-to-open
// ---------------------------------------------------------------------------

/** Run a KB message through the dispatcher (voice path runs it via agent). */
ipcMain.handle("nova:kb-run", async (_evt, text) => {
  try {
    const { runKbAction } = require("./kb/dispatch");
    // Bridge indexing progress + watcher start/stop to the renderer.
    global.__kbProgressBridge = (evt) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send("kb:index-progress", evt); } catch {}
      }
    };
    global.__kbWatcherBridge = (action, id) => {
      try {
        if (action === "stop") kbWatcher.stopWatching(id);
        else kbWatcher.startWatching(id);
      } catch {}
    };
    return await runKbAction(String(text || ""));
  } catch (err) {
    log.error("[kb] kb-run failed:", err?.message || err);
    return { ok: false, intent: "kb", text: "Something went wrong — details are in Developer Mode.", error: String(err?.message || err) };
  }
});

/** Open an answer's source file in the default app (L2 confirmed in dispatch). */
ipcMain.handle("nova:kb-open-source", async (_evt, filePath) => {
  try {
    await require("electron").shell.openPath(filePath);
    return { ok: true };
  } catch (err) {
    log.error("[kb] open-source failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
});

/** List indexed folders + index stats (L1 safe). */
ipcMain.handle("nova:kb-list", async () => {
  try {
    const kbIndex = require("./kb/index");
    const [folders, st] = [kbIndex.listFolders(), await kbIndex.stats()];
    return { ok: true, folders, stats: st };
  } catch (err) {
    log.error("[kb] kb-list failed:", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle("nova:agent-run", async (_evt, text) => {
  try {
    const { getKey } = require("./keys");
    const keyPromise = getKey().catch(() => null);
    const out = await dispatcher.run(text, {
      getKey: async () => (await keyPromise) || null,
      mainWindow,
      runVisionQuery: async (question) => {
        try {
          return await runVisionQuery(question);
        } catch (err) {
          return { error: String(err?.message || err) };
        }
      },
    });
    return out;
  } catch (err) {
    log.error("[agent] run failed:", err?.message || err);
    return { ok: false, intent: null, text: "Something went wrong — details are in Developer Mode.", error: String(err?.message || err) };
  }
});

/**
 * Hard kill-switch hotkey: Ctrl+Shift+Escape on both platforms.
 * Registered AFTER app.whenReady() — globalShortcut requires the ready state
 * (registering too early throws "globalShortcut cannot be used before the
 * app is ready").
 */
function registerKillHotkey() {
  try {
    globalShortcut.register("CommandOrControl+Shift+Escape", () => {
      log.info("[control] kill-switch hotkey pressed");
      control.sequence.abort("global hotkey (Ctrl+Shift+Esc)");
    });
    log.info("[control] kill-switch hotkey registered: Ctrl+Shift+Escape");
  } catch (err) {
    log.warn("[control] kill-switch hotkey registration failed:", err?.message);
  }
}

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
  // 3. Boot the automation scheduler (Stage 9) — schedules are persisted in
  // userData/automations.json; nextRunAt is recomputed at boot.
  try {
    await automationDispatch.scheduleNextRuns();
    automationScheduler.start();
    log.info(`[automation] ${automationDispatch.listAutomations().length} automation(s) loaded`);
  } catch (err) {
    log.error("[automation] boot failed:", err?.message || err);
  }

  // 2. Warm the model router (fetch free models, then refresh every 6 hours)
  try {
    await router.refresh({ force: true });
  } catch (err) {
    log.warn("Initial model fetch failed — router will use fallback model:", err?.message || err);
  }
  router.startPeriodicRefresh({ intervalMs: 6 * 60 * 60 * 1000 });
    log.info(`Model router: current=${router.currentModel()} freeModels=${router.freeModelCount()} fallback=${router.isFallbackInUse()}`);
  // 3. Register the hard kill-switch hotkey (must happen after app is ready)
  registerKillHotkey();
  createWindow();
  // 4. Start the local reminder scheduler (boots scan catches anything due
  //    while the app was closed; 15 s polling thereafter). Reminders only
  //    fire while the app is running.
  reminders.start(mainWindow);
  // First-run onboarding: tell the renderer which OS permissions are still
  // pending so the why-needed screens can appear BEFORE the OS prompts.
  try {
    mainWindow.once("show", () => {
      const pending = onboarding.pendingScreens();
      if (pending.length) {
        mainWindow.webContents.send("nova:onboarding", { pending, state: onboarding.permissionState(), platform: onboarding.platform() });
      }
    });
  } catch { /* window gone */ }

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
