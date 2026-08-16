// Nova — headless self-test for the permission & safety framework.
//
// Runs WITHOUT a real Electron runtime by shimming the "electron" module.
// Verifies: registry validation, all five gate paths (L0/L1 immediate, L2
// toast cancellation, L3/L4 modal confirm/decline), dry-run, action-log
// persistence, and Private Mode blocking.
//
// Usage: node src/main/test-permissions.js [dataDir]

const Module = require("module");
const path = require("path");
const fs = require("fs");

const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-perm-test-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Electron shim: fake app/browserWindow/dialog/ipcRenderer enough for the
// modules under test (no real IPC streams are exercised here).
// ---------------------------------------------------------------------------
const toastReplyListeners = [];
const fakeWindow = {
  webContents: {
    send: (_channel, data) => {
      if (data?.type === "show") {
        toastWasShown = true;
        if (autoCancelToasts) {
          // Emulate the renderer tapping Cancel within the 5 s window.
          setTimeout(() => window_nova_cancelToast(data.toastId), 50);
        }
      }
    },
    once: (channel, listener) => { console.log("[shim] once called:", channel); if (channel === "nova:permission-toast-reply") toastReplyListeners.push(listener); },
    on: () => {},
    removeListener: () => {},
  },
};

const shim = {
  app: {
    getPath: (name) => {
      if (name === "userData") return DATA_DIR;
      throw new Error(`fake getPath(${name}) not supported`);
    },
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
    getName: () => "Nova",
  },
  BrowserWindow: {
    getAllWindows: () => [fakeWindow],
  },
  dialog: {
    showMessageBox: async (_win, opts) => {
      // For the test we record the last prompt and simulate user choice:
      // "Confirm" for demo:delete-files, "Cancel" for demo:send-message.
      lastModalPrompt = opts;
      const confirmIds = ["demo:delete-files"];
      const choice = confirmIds.includes(lastActionBeforeModal) ? 1 : 0;
      return { response: choice, checkboxChecked: false };
    },
  },
  ipcMain: {
    handle: () => {},
    on: () => {},
  },
  ipcRenderer: {
    send: () => {},
    on: () => {},
    invoke: async () => undefined,
    removeListener: () => {},
  },
  contextBridge: { exposeInMainWorld: () => {} },
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  nativeImage: { createFromPath: () => ({}) },
};

const electronResolve = require.resolve("electron");
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "electron") return electronResolve;
  if (request === "electron/common" || request === "electron/main" || request === "electron/renderer") {
    return electronResolve;
  }
  return origResolveFilename.call(this, request, parent, ...rest);
};

// Patch the electron module's exports in place so every require("electron")
// sees the shim. We do this by overwriting require.cache's entry.
const electronMod = require.cache[electronResolve] || require("electron");
const origExports = electronMod.exports;
electronMod.exports = shim;
// require("electron") already cached — but deep requires re-resolve. The
// _resolveFilename shim above makes them land on the same cache entry, whose
// exports object is shared by reference once replaced. For first-time
// requires we also ensure new entries point at the shim:
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "electron") return shim;
  return origLoad.call(this, request, parent, ...rest);
};

// ---------------------------------------------------------------------------
// Now load the framework under test.
// ---------------------------------------------------------------------------
const { RISK_LEVEL, riskLabel } = require("./permissions/risk-levels");
const registry = require("./permissions/action-registry");
const { runAction } = require("./permissions/gate");
const actionLog = require("./permissions/action-log");
const settings = require("./settings");

let lastModalPrompt = null;
let toastShown = null;      // last toast payload the gate sent (any type)
let toastWasShown = false;  // true if a type:"show" toast was announced
let autoCancelToasts = true;

// Instrument: capture the toast the gate sends for L2 and the modal prompt.
const origSend = fakeWindow.webContents.send;
fakeWindow.webContents.send = (_channel, data) => {
  origSend(_channel, data);
  toastShown = data;
};

// Override modalConfirm's dialog usage via the shim already set. The gate
// composes the human description into opts.message (title is "Nova — <level>")
// so the simulated user decision is based on the plain-language message.
shim.dialog.showMessageBox = async (win, opts) => {
  lastModalPrompt = opts;
  const text = (opts.message || "") + (opts.detail || "");
  // Confirm only demo:delete-files (level 4); decline demo:send-message (level 3)
  const confirmed = text.includes("This is permanent");
  return { response: confirmed ? 1 : 0, checkboxChecked: false };
};

function assert(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`PASS: ${label}`);
}

async function main() {
  // Wipe persisted state BEFORE loading modules that read it at require time.
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Register the same demo actions the app registers (idempotent-safe here).
  const demo = require("./permissions/test-actions");

  // --- 1. Risk levels ---
  assert(RISK_LEVEL.READ === 0 && RISK_LEVEL.DESTRUCTIVE === 4, "risk levels enum values");
  assert(riskLabel(2) === "reversible", "riskLabel human text");

  // --- 2. Registry ---
  const actions = registry.listActions();
  assert(actions.length >= 5, `registry has ${actions.length} actions registered`);
  assert(actions.some((a) => a.id === "demo:delete-files" && a.level === 4), "destructive action registered");

  // Missing simulate on a L2+ action must be rejected
  let registrationError = null;
  try {
    registry.registerAction({ id: "bad-action", level: 2, description: "x", execute: async () => {} });
  } catch (e) { registrationError = e.message; }
  assert(/simulate/i.test(registrationError || ""), "L2 action without simulate() is rejected");

  // Unknown action must fail loudly
  let unknownError = null;
  try { await runAction("no-such-action"); } catch (e) { unknownError = e.message; }
  assert(/Unknown action/i.test(unknownError || ""), "unknown action throws");

  // --- 3. Level 0/1 — immediate execution ---
  let res = await runAction("demo:read-files");
  assert(res.outcome === "success", "L0 runs immediately and succeeds");
  res = await runAction("demo:open-app", { app: "Calculator" });
  assert(res.outcome === "success" && res.detail.opened === "Calculator", "L1 runs immediately with payload");
  assert(toastShown === null, "L0/L1 never show a toast");

  // --- 4. Level 2 — toast, cancel path (cancel triggered by the 'show' send above) ---
  toastShown = null;
  toastWasShown = false;
  res = await runAction("demo:rename-file", { from: "a.txt", to: "b.txt" });
  assert(res.outcome === "cancelled" && toastWasShown, "L2 toast cancellation works");

  // --- 5. Level 2 — toast, let-it-run path (no cancel) ---
  toastShown = null;
  toastWasShown = false;
  autoCancelToasts = false;
  res = await runAction("demo:rename-file", { from: "a.txt", to: "b.txt" });
  autoCancelToasts = true;
  assert(res.outcome === "success" && toastWasShown, "L2 auto-executes after toast window elapses");

  // --- 6. Level 3 — modal decline ---
  lastModalPrompt = null;
  res = await runAction("demo:send-message", { message: "Hello!" });
  assert(res.outcome === "cancelled", "L3 modal decline cancels");
  assert(lastModalPrompt && /send/i.test((lastModalPrompt.message || "") + (lastModalPrompt.detail || "")), "L3 modal shows plain-language description");

  // --- 7. Level 4 — modal confirm (before Private Mode, which blocks L3+) ---
  res = await runAction("demo:delete-files", { files: ["f1", "f2", "f3"] });
  assert(res.outcome === "success" && res.detail.deleted.length === 3, "L4 modal confirm executes");
  assert(/permanent/i.test(lastModalPrompt?.detail || lastModalPrompt?.message || ""), "L4 modal shows plain-language destructiveness");

  // --- 8. Action log persistence ---
  const entries = actionLog.list();
  assert(entries.length >= 6, `action log has ${entries.length} entries, newest first`);
  assert(entries[0].ts && entries[0].actionId, "entries carry timestamp + actionId");
  const outcomes = new Set(entries.map((e) => e.outcome));
  assert(outcomes.has("success") && outcomes.has("cancelled"), "log captures success and cancelled outcomes");
  // Persisted to disk
  assert(fs.existsSync(path.join(DATA_DIR, "actions.log.json")), "action log persisted to userData");

  // --- 9. Dry run ---
  const logSizeBefore = actionLog.list().length;
  res = await runAction("demo:delete-files", { files: ["x1", "x2"] }, { dryRun: true });
  assert(res.outcome === "dry-run" && res.detail.wouldDelete === 2,
    "dry-run returns simulate report and does not execute the action");
  // Dry-run performs no action; it records a distinct "dry-run" audit entry
  // (nothing else new was executed, no success/cancelled entry).
  const all = actionLog.list();
  assert(all.length === logSizeBefore + 1, "dry-run adds exactly one dry-run audit entry");
  assert(all[0].outcome === "dry-run" && all[0].actionId === "demo:delete-files",
    "the new entry is the dry-run itself, newest first");

  // --- 10. Private Mode ---
  assert(!settings.isPrivateMode(), "private mode off by default");
  settings.setPrivateMode(true);
  res = await runAction("demo:read-files");
  assert(res.outcome === "success", "private mode still allows L0 reads");
  res = await runAction("demo:send-message", { message: "x" });
  assert(res.outcome === "blocked", "private mode blocks L3 with outcome=blocked");
  res = await runAction("demo:delete-files", { files: ["z"] }, { dryRun: true });
  assert(res.outcome === "dry-run", "private mode still allows dry-run previews");
  settings.setPrivateMode(false);

  // --- 11. Settings persistence ---
  const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"));
  assert(saved.privateMode === false, "settings persisted to userData");

  // --- Summary ---
  console.log("\nAction log snapshot (newest first):");
  console.log(JSON.stringify(actionLog.list().slice(0, 8), null, 2));

  if (!process.exitCode) console.log("\nAll permission-framework tests passed.");
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

function window_nova_cancelToast(toastId) {
  // Emulate the renderer tapping Cancel: fire the once() listener the gate
  // registered on "nova:permission-toast-reply", then cancelToast cleanup.
  const gate = require("./permissions/gate");
  // Fire each registered cancel listener once, then clear them so a later
  // 'hide' event from cleanup doesn't re-trigger anything.
  const pending = toastReplyListeners.splice(0);
  for (const listener of pending) listener(null, { toastId });
  gate.cancelToast(toastId);
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  process.exitCode = 1;
});
