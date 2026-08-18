// Round 24: user model — facts the user asks Nova to remember ("remember I
// work from home on Fridays"), and everything Nova learns to know about
// them. Local-only JSON in userData/user-model.json. Used by
// notes:remember-fact / notes:forget-fact / notes:user-model-ask and by
// greetings ("good morning, Alex").
const fs = require("fs");
const path = require("path");
const log = require("electron-log");

const MAX_FACTS = 100;

let data = { facts: [] }; // [{ key, fact, createdAt }]
// Test harnesses may set __NOVA_USER_MODEL_TEST before the first require —
// picked up at load() time so no writes ever land in the repo root.
let dataPath = process.env.__NOVA_USER_MODEL_TEST
  ? path.join(process.env.__NOVA_USER_MODEL_TEST, "user-model.json")
  : null;

function userModelPath() {
  if (dataPath) return dataPath;
  let dataDir;
  try {
    dataDir = require("electron").app.getPath("userData");
  } catch {
    dataDir = process.cwd();
  }
  return path.join(dataDir, "user-model.json");
}

function load() {
  try {
    if (fs.existsSync(userModelPath())) {
      const parsed = JSON.parse(fs.readFileSync(userModelPath(), "utf8"));
      data = { facts: Array.isArray(parsed?.facts) ? parsed.facts : [] };
    }
  } catch (err) {
    log.warn("[user-model] failed to load:", err?.message || err);
    data = { facts: [] };
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(userModelPath()), { recursive: true });
    fs.writeFileSync(userModelPath(), JSON.stringify(data, null, 2));
  } catch (err) {
    log.warn("[user-model] failed to persist:", err?.message || err);
  }
}

// Deterministic key so re-remembering the same phrasing updates the existing
// fact (last-wins) instead of duplicating it.
function factKey(fact) {
  return String(fact || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[."',;:!?-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function addFact(fact) {
  const text = String(fact || "").trim();
  if (!text) return { ok: false, error: "empty-fact" };
  if (text.length > 200) return { ok: false, error: "too-long" };
  const key = factKey(text);
  const idx = data.facts.findIndex((f) => f.key === key);
  if (idx >= 0) {
    data.facts[idx].fact = text;
    data.facts[idx].updatedAt = new Date().toISOString();
  } else {
    const item = { key, fact: text, createdAt: new Date().toISOString() };
    // oldest first (user recollection order); drop the oldest when full.
    if (data.facts.length >= MAX_FACTS) data.facts.shift();
    data.facts.push(item);
  }
  persist();
  return { ok: true, fact: data.facts[idx >= 0 ? idx : data.facts.length - 1] };
}

function removeFact(keyOrFact) {
  const key = factKey(keyOrFact);
  const idx = data.facts.findIndex((f) => f.key === key);
  if (idx < 0) return { ok: false, error: "not-found" };
  const [removed] = data.facts.splice(idx, 1);
  persist();
  return { ok: true, removed };
}

function list() {
  return data.facts.map((f) => ({ ...f }));
}

// For greetings + briefings: one-line facts about the user (user name handled
// separately in identity.js). Returns the most recent facts (up to n).
function relevantFacts(n = 3) {
  return data.facts.slice(-Math.max(0, n || 0));
}

// Testing hooks.
function setStorePathForTesting(dir) {
  dataPath = path.join(dir, "user-model.json");
  data = { facts: [] };
}

function resetForTesting() {
  if (dataPath && fs.existsSync(dataPath)) {
    try { fs.unlinkSync(dataPath); } catch { /* */ }
  }
  data = { facts: [] };
}

load();
module.exports = { addFact, removeFact, list, relevantFacts, factKey, MAX_FACTS, setStorePathForTesting, resetForTesting };
