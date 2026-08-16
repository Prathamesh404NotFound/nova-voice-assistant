// Nova — OpenRouter free-model router
//
// Responsibilities:
//  - GET https://openrouter.ai/api/v1/models at startup, then every 6 hours.
//  - Filter entries where pricing.prompt === "0" AND pricing.completion === "0".
//  - Cache the list locally (memory + app userData cache file) with a timestamp.
//  - pickModel(taskType) — choose from the free list by task type,
//    with a hardcoded fallback model ID if the list is empty or the fetch fails.
//  - Log every pick (model id, reason, taskType) for the Developer Mode panel.

const fs = require("fs");
const path = require("path");
const log = require("electron-log");

let appPathDataDir = null;
function dataDir() {
  if (appPathDataDir) return appPathDataDir;
  try {
    appPathDataDir = require("electron").app.getPath("userData");
  } catch {
    appPathDataDir = process.cwd();
  }
  return appPathDataDir;
}

const MODELS_URL = "https://openrouter.ai/api/v1/models";
// Hardcoded fallback: a known free-tier model on OpenRouter.
const FALLBACK_MODEL_ID = "google/gemini-2.5-flash-001";

const DEFAULT_PREFS = {
  chat:   ["gemini", "gpt", "mistral", "llama", "claude", "qwen", "deepseek"],
  coding: ["codestral", "qwen-coder", "deepseek-coder", "phi", "gemini-flash", "code"],
  vision: ["gemini", "gpt", "llava", "internvl", "minicpm", "vision"],
  quick:  ["flash", "mini", "nano", "tiny", "turbo", "small"],
};

let freeModels = [];          // { id, name, description, capabilities, architecture }
let cacheMeta = { updatedAt: null, source: null };
let pickLog = [];             // [{ ts, taskType, model, reason, fallback }]
let refreshTimer = null;
let currentId = null;
let fallbackInUse = false;

// ---------------------------------------------------------------------------
// Cache persistence (metadata only — model list is small JSON)
// ---------------------------------------------------------------------------
function cachePath() {
  return path.join(dataDir(), "free-models-cache.json");
}

function loadCache() {
  try {
    if (fs.existsSync(cachePath())) {
      const data = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
      if (Array.isArray(data.freeModels)) {
        freeModels = data.freeModels;
        cacheMeta = { updatedAt: data.updatedAt || null, source: "local-cache" };
        log.info(`Loaded ${freeModels.length} cached free models (updated ${data.updatedAt}).`);
      }
    }
  } catch (err) {
    log.warn("Failed to load free-model cache:", err?.message || err);
  }
}

function saveCache() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(
      cachePath(),
      JSON.stringify({ freeModels, updatedAt: cacheMeta.updatedAt, source: cacheMeta.source }, null, 2)
    );
  } catch (err) {
    log.warn("Failed to persist free-model cache:", err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Fetch + filter
// ---------------------------------------------------------------------------
async function fetchFreeModels() {
  const res = await fetch(MODELS_URL, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Models endpoint returned HTTP ${res.status}`);
  const json = await res.json();
  const models = Array.isArray(json?.data) ? json.data : [];

  const free = models
    .filter((m) => {
      const p = m?.pricing ?? {};
      return String(p.prompt) === "0" && String(p.completion) === "0";
    })
    .map((m) => ({
      id: m.id,
      name: m.name,
      description: (m.description || "").slice(0, 300),
      capabilities: m.capabilities ?? {},
      architecture: m.architecture ?? {},
      context_length: m.context_length,
    }));

  return free;
}

async function refresh({ force = false } = {}) {
  // Stale-while-revalidate: keep serving cached list unless forced.
  if (!force && freeModels.length > 0) return;
  try {
    const free = await fetchFreeModels();
    if (free.length === 0) {
      log.warn("OpenRouter returned zero free models — keeping current list/fallback.");
      fallbackInUse = true;
      return;
    }
    freeModels = free;
    fallbackInUse = false;
    cacheMeta = { updatedAt: new Date().toISOString(), source: "openrouter-api" };
    saveCache();
    // Re-derive current pick so stale selections don't reference vanished models.
    if (currentId && !freeModels.some((m) => m.id === currentId)) {
      pickModel("chat"); // re-pick with the fresh list
    } else if (!currentId) {
      pickModel("chat");
    }
    log.info(`Router refreshed: ${freeModels.length} free models available.`);
  } catch (err) {
    log.error("Router refresh failed:", err?.message || err);
    if (freeModels.length === 0) fallbackInUse = true;
    // Keep serving whatever we had; pick() will use the fallback if empty.
  }
}

function startPeriodicRefresh({ intervalMs = 6 * 60 * 60 * 1000 } = {}) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refresh({ force: true }).then(() => {
      log.info(`Periodic model refresh complete: ${freeModels.length} free models, fallback=${fallbackInUse}`);
    });
  }, intervalMs);
  // Don't keep the app alive just for the timer.
  if (refreshTimer.unref) refreshTimer.unref();
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------
function pickModel(taskType = "chat") {
  const prefs = DEFAULT_PREFS[taskType] ?? DEFAULT_PREFS.chat;
  const list = freeModels;

  if (list.length === 0) {
    const reason = `Free model list empty or fetch failed — using hardcoded fallback "${FALLBACK_MODEL_ID}" (taskType=${taskType})`;
    logPick(taskType, FALLBACK_MODEL_ID, reason, true);
    currentId = FALLBACK_MODEL_ID;
    fallbackInUse = true;
    return currentId;
  }

  // Heuristic: rank models whose id or description mentions preference tokens.
  const ranked = list
    .map((m) => {
      const hay = `${m.id} ${m.description || ""} ${(m.capabilities || {})}`.toLowerCase();
      let score = 0;
      for (const [rank, token] of prefs.entries()) {
        if (hay.includes(token)) score += prefs.length - rank;
      }
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);

  let picked;
  let reason;
  const topScore = ranked[0].score;
  if (topScore > 0) {
    // Among equal-top scorers prefer larger context (more capable).
    const top = ranked.filter((r) => r.score === topScore);
    top.sort((a, b) => (b.m.context_length || 0) - (a.m.context_length || 0));
    picked = top[0].m;
    reason = `taskType=${taskType} matched tokens (${prefs.filter((t) => `${picked.id} ${picked.description || ""}`.toLowerCase().includes(t)).join(",")})`;
  } else {
    // No heuristic match: pick a sensible default (largest context free model).
    picked = [...list].sort((a, b) => (b.context_length || 0) - (a.context_length || 0))[0];
    reason = `taskType=${taskType} had no keyword match — chose largest-context free model`;
  }

  logPick(taskType, picked.id, reason, false);
  currentId = picked.id;
  fallbackInUse = false;
  return currentId;
}

function logPick(taskType, model, reason, fallback) {
  const entry = { ts: new Date().toISOString(), taskType, model, reason, fallback };
  pickLog.push(entry);
  if (pickLog.length > 200) pickLog = pickLog.slice(-200);
  log.info(`[router] pick → ${model} (${reason})`);
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------
function currentModel() {
  if (!currentId) pickModel("chat");
  return currentId;
}

function freeModelCount() {
  return freeModels.length;
}

function lastUpdated() {
  return cacheMeta.updatedAt;
}

function isFallbackInUse() {
  return fallbackInUse;
}

function pickLogs() {
  return pickLog;
}

// Warm the local cache on module load (main process only).
if (process.type === "browser") loadCache();

module.exports = {
  refresh,
  startPeriodicRefresh,
  pickModel,
  currentModel,
  freeModelCount,
  lastUpdated,
  isFallbackInUse,
  pickLogs,
  FALLBACK_MODEL_ID,
};
