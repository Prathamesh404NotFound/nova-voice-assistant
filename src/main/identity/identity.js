// Round 24: Nova identity — who Nova is, and the persistent user model that
// lets her feel like a person rather than a chatbot. This is the #1 gap
// between Nova and the top-ranked personal AI assistants of 2026 (Vellum's
// identity layer and personality score the highest in competitor roundups).
//
// Stored in userData/identity.json — fully local, never sent to OpenRouter
// (only the single note text leaves if the user explicitly asks to
// "summarize my notes" later).
//
// Personality affects ONLY greeting and acknowledgement tone; it never
// changes factual wording of briefing lines.
const fs = require("fs");
const path = require("path");
const log = require("electron-log");

const VALID_PERSONALITIES = ["concise", "professional", "warm", "playful"];
const DEFAULT_IDENTITY = {
  name: "Nova",
  personality: "warm",
  userName: "", // user's own name, shown in greetings when set
  createdAt: null,
};

let data = { ...DEFAULT_IDENTITY };
// Test harnesses may set __NOVA_IDENTITY_TEST before the first require —
// picked up at load() time so no writes ever land in the repo root.
let dataPath = process.env.__NOVA_IDENTITY_TEST
  ? path.join(process.env.__NOVA_IDENTITY_TEST, "identity.json")
  : null;

function identityPath() {
  if (dataPath) return dataPath;
  let dataDir;
  try {
    dataDir = require("electron").app.getPath("userData");
  } catch {
    dataDir = process.cwd();
  }
  return path.join(dataDir, "identity.json");
}

function load() {
  try {
    if (fs.existsSync(identityPath())) {
      const parsed = JSON.parse(fs.readFileSync(identityPath(), "utf8"));
      data = { ...DEFAULT_IDENTITY, ...(parsed || {}) };
      if (!VALID_PERSONALITIES.includes(data.personality)) data.personality = DEFAULT_IDENTITY.personality;
    } else {
      data = { ...DEFAULT_IDENTITY, createdAt: new Date().toISOString() };
      persist();
    }
  } catch (err) {
    log.warn("[identity] failed to load:", err?.message || err);
    data = { ...DEFAULT_IDENTITY, createdAt: new Date().toISOString() };
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(identityPath()), { recursive: true });
    fs.writeFileSync(identityPath(), JSON.stringify(data, null, 2));
  } catch (err) {
    log.warn("[identity] failed to persist:", err?.message || err);
  }
}

function get() {
  return { ...data };
}

function set(patch) {
  const name = String(patch.name || "").trim().slice(0, 40);
  if (name) data.name = name;
  if (VALID_PERSONALITIES.includes(patch.personality)) data.personality = patch.personality;
  if (patch.userName !== undefined) data.userName = String(patch.userName || "").trim().slice(0, 40);
  // createdAt must survive every set() — it marks when Nova came to be.
  if (!data.createdAt) data.createdAt = new Date().toISOString();
  persist();
  log.info(`[identity] name=${data.name} personality=${data.personality} userName=${data.userName || "(none)"}`);
  // Tell all renderer windows so the Identity panel updates immediately.
  try {
    const { BrowserWindow } = require("electron");
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send("nova:identity-changed", get()); } catch { /* */ }
    }
  } catch { /* before app ready */ }
  return get();
}

// Testing hooks — point identity.json at a temp file and reset memory.
function setStorePathForTesting(dir) {
  dataPath = path.join(dir, "identity.json");
  data = { ...DEFAULT_IDENTITY };
}

function resetForTesting() {
  if (dataPath && fs.existsSync(dataPath)) {
    try { fs.unlinkSync(dataPath); } catch { /* */ }
  }
  data = { ...DEFAULT_IDENTITY, createdAt: new Date().toISOString() };
}

load();
module.exports = { get, set, VALID_PERSONALITIES, setStorePathForTesting, resetForTesting, DEFAULT_IDENTITY };
