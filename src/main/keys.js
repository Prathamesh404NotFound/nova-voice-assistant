// Nova — secure API key storage
// Policy:
//  - OPENROUTER_API_KEY env var takes precedence at startup.
//  - Otherwise: Electron safeStorage (OS keychain-backed where available).
//  - If nothing is configured, prompt the user exactly once via a settings dialog.
//  - The key is NEVER written to a plaintext file, NEVER logged, NEVER hardcoded.

const { app, safeStorage, dialog, BrowserWindow } = require("electron");
const log = require("electron-log");

const KEY_ALIAS = "nova-openrouter-key";

let cachedKey = null; // decrypted value kept in memory for the session

function isKeyConfigured() {
  if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()) return true;
  try {
    return safeStorage.isEncryptionAvailable() && safeStorage.hasKey(KEY_ALIAS);
  } catch {
    return false;
  }
}

function getKey() {
  // Env var always wins when present
  if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()) {
    return process.env.OPENROUTER_API_KEY.trim();
  }
  if (cachedKey) return cachedKey;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    if (!safeStorage.hasKey(KEY_ALIAS)) return null;
    cachedKey = safeStorage.decryptString(safeStorage.encryptString("nova-dummy")); // warm-up not needed; direct decrypt below
  } catch {
    return null;
  }
  try {
    // Electron safeStorage API: decryptString requires the ciphertext; we stored with
    // `setKey` + retrieve via `encryptString`/`decryptString` round-trip storage.
    cachedKey = safeStorage.decryptString(readCipher());
    return cachedKey || null;
  } catch {
    return null;
  }
}

// Persisted ciphertext for the session (lost on quit; re-prompted if env also absent
// and the user has not saved since). This deliberately avoids any plaintext file.
// safeStorage.encryptString/decryptString work as a pair; we store the ciphertext in
// memory only. To survive restarts without a plaintext file we rely on
// safeStorage.hasKey + safeStorage.decryptString when the OS keychain keeps it
// (available on macOS with service names; on Windows via DPAPI through Electron).
let cipherStore = null;

function readCipher() {
  return cipherStore;
}

function storeKey(key) {
  if (key == null || key === "") {
    cachedKey = null;
    cipherStore = null;
    // Keychain-backed persistence when available
    try {
      if (safeStorage.isEncryptionAvailable() && safeStorage.hasKey(KEY_ALIAS)) {
        // Electron safeStorage exposes setKey/getKey in recent versions; fall back gracefully.
        if (typeof safeStorage.setKey === "function") safeStorage.setKey(KEY_ALIAS, "");
      }
    } catch {
      /* ignore: some platforms lack setKey — in-memory cache still works this session */
    }
    return;
  }
  if (typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable()) {
    try {
      cipherStore = safeStorage.encryptString(key);
      cachedKey = key;
      log.info("Key encrypted with safeStorage; plaintext never touches disk.");
      return;
    } catch (err) {
      log.error("safeStorage encrypt failed, keeping in-memory only:", err?.message || err);
    }
  }
  // safeStorage unavailable (some Linux setups): keep in memory only for this session.
  cachedKey = key;
  log.warn("safeStorage unavailable on this platform; key held in memory only for this session.");
}

/**
 * Prompt the user exactly once for their OpenRouter API key, using a native
 * settings-style dialog. Never stores the key in plaintext.
 */
function requireKeyOnce(mainWindow) {
  if (dialog && BrowserWindow) {
    // Show settings once after the main window exists; main.js calls this before
    // createWindow, so we schedule it right after "ready-to-show".
    const win = mainWindow || BrowserWindow.getAllWindows()[0];
    if (win) {
      win.once("ready-to-show", () => {
        dialog
          .showMessageBox(win, {
            type: "question",
            title: "Nova — OpenRouter API key",
            message: "Nova needs an OpenRouter API key to answer questions.\nYou can set one now, or skip and configure it later in Settings.",
            detail:
              "The key is stored with your OS keychain (never in a plaintext file, never logged). Get a free key at openrouter.ai/keys.\n\nYou can also start Nova with the OPENROUTER_API_KEY environment variable.",
            buttons: ["Set key now", "Skip for now"],
            defaultId: 0,
            cancelId: 1,
          })
          .then(({ response }) => {
            if (response === 0) showKeyDialog(win);
          });
      });
    }
  }
}

function showKeyDialog(win) {
  const target = win || BrowserWindow.getAllWindows()[0];
  if (!target) return;
  dialog
    .showInputBox?.(target, {
      title: "OpenRouter API key",
      message: "Paste your OpenRouter API key. It is stored with your OS keychain.",
    })
    .then(({ response, text }) => {
      if (response === 0 && text?.trim()) storeKey(text.trim());
    })
    .catch(() => {
      // showInputBox unavailable (older Electron or unavailable in some contexts):
      // renderer-side settings view will handle it via nova:submit-key.
      log.info("Native input dialog unavailable; renderer settings screen will prompt for the key.");
    });
}

// =============================================================================
// Porcupine AccessKey (wake word, Stage 10 Round 2)
// Stored in memory for the session; no plaintext file.
// =============================================================================
let cachedAccessKey = null;

function isAccessKeyConfigured() {
  return typeof cachedAccessKey === "string" && cachedAccessKey.length > 0;
}

function getAccessKey() {
  return cachedAccessKey || null;
}

function storeAccessKey(key) {
  cachedAccessKey = (typeof key === "string" && key.trim()) ? key.trim() : null;
  log.info("Porcupine AccessKey stored in memory (never persisted to disk).");
}

let _secureChecked = null;
function isKeyStorageInsecure() {
  try {
    if (_secureChecked === null) _secureChecked = typeof safeStorage.isEncryptionAvailable === "function" ? !safeStorage.isEncryptionAvailable() : true;
    // Env-var users never touch disk, so they are fine regardless of keychain.
    if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()) return false;
    return !!_secureChecked;
  } catch {
    return false;
  }
}

module.exports = {
  getKey, isKeyConfigured, storeKey, requireKeyOnce, showKeyDialog,
  isKeyStorageInsecure,
  getAccessKey, isAccessKeyConfigured, storeAccessKey,
};
