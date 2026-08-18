// Nova — automation/store.js (Stage 9)
//
// Persisted automation store (userData/automations.json). Enforces the
// safety limits: max steps per automation, and the refusal rule that an
// automation whose ONLY steps are Level 3+ (with no Level 0–2 step first)
// must not be created — nudging toward "check something, then maybe act".
//
// An automation's gating status is computed from its steps:
//   - all steps ≤ Level 2            → status "safe" (runs unattended)
//   - any step Level 3+              → status "needs-confirmation"
//
// The refusal rule: if the status is needs-confirmation AND the first step
// is not Level 0–2, creation is refused.

const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const { MAX_STEPS } = require("./types");
const { RISK_LEVEL } = require("../permissions/risk-levels");

const MAX_AUTOMATIONS = 25;

function validateTriggerObj(trigger) {
  if (!trigger || !trigger.type) return null;
  if (!["file", "time", "event", "idle"].includes(trigger.type)) return null;
  return {
    type: trigger.type,
    folder: trigger.type === "file" ? String(trigger.folder || "").trim() : undefined,
    depth: trigger.type === "file" ? Number(trigger.depth ?? 4) : undefined,
    debounceMs: trigger.type === "file" ? Number(trigger.debounceMs ?? 3000) : undefined,
    match: trigger.type === "file" ? (trigger.match || null) : undefined,
    at: trigger.type === "time" ? String(trigger.at || "").trim() : undefined,
    name: trigger.type === "event" ? String(trigger.name || "").trim().toLowerCase() : undefined,
    minutes: trigger.type === "idle" ? Number(trigger.minutes ?? 10) : undefined,
  };
}

function dataDir() {
  try { return require("electron").app.getPath("userData"); } catch { return process.cwd(); }
}
function storePath() { return path.join(dataDir(), "automations.json"); }

let entries = [];
let loaded = false;
let __testing = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (__testing) { entries = []; return; }
  try {
    if (fs.existsSync(storePath())) {
      entries = JSON.parse(fs.readFileSync(storePath(), "utf8"));
      if (!Array.isArray(entries)) entries = [];
    }
  } catch (err) {
    log.warn("[automation] failed to load automations:", err?.message || err);
    entries = [];
  }
}

function persist() {
  if (__testing) return;
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(entries, null, 2));
  } catch (err) {
    log.warn("[automation] failed to persist automations:", err?.message || err);
  }
}

function newId() {
  return `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Compute the gating status from a step list. */
function statusFromSteps(steps) {
  const maxLevel = Math.max(...steps.map((s) => Number(s.level ?? RISK_LEVEL.READ)));
  return maxLevel >= RISK_LEVEL.SENSITIVE ? "needs-confirmation" : "safe";
}

/**
 * Validate a candidate automation against the safety limits.
 * @returns {{ ok: boolean, error?: string }}
 */
function validateCandidate(steps) {
  if (!Array.isArray(steps) || !steps.length) {
    return { ok: false, error: "An automation needs at least one step." };
  }
  if (steps.length > MAX_STEPS) {
    return { ok: false, error: `Automations are capped at ${MAX_STEPS} steps (got ${steps.length}).` };
  }
  const status = statusFromSteps(steps);
  if (status === "needs-confirmation") {
    // Refuse if the FIRST step is not Level 0–2: nudges toward
    // "check something, then maybe act" rather than blind sensitive actions.
    const firstLevel = Number(steps[0].level ?? RISK_LEVEL.READ);
    if (firstLevel >= RISK_LEVEL.SENSITIVE) {
      return {
        ok: false,
        error: "I won\u2019t create a routine that only does sensitive or destructive things. Start it with a read-only or safe step \u2014 like \u201ccheck my Downloads folder, then \u2026\u201d.",
      };
    }
  }
  return { ok: true };
}

function add(automation) {
  ensureLoaded();
  const valid = validateCandidate(automation.steps);
  if (!valid.ok) return { ok: false, error: valid.error };
  if (entries.length >= MAX_AUTOMATIONS) {
    return { ok: false, error: `You already have ${MAX_AUTOMATIONS} automations — that's the cap.` };
  }
  const entry = {
    id: automation.id || newId(),
    name: String(automation.name || "unnamed").slice(0, 80),
    cron: String(automation.cron || "").trim(),
    // Round 5: an automation may be event-triggered (trigger object) instead
    // of cron-scheduled. Legacy cron-only entries remain valid.
    trigger: validateTriggerObj(automation.trigger) || null,
    tz: "local",
    enabled: automation.enabled !== false,
    steps: automation.steps.map((s, i) => ({ kind: s.kind, text: String(s.text || "").slice(0, 1000), level: Number(s.level ?? RISK_LEVEL.READ), order: i })),
    status: statusFromSteps(automation.steps),
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
    pendingConfirmation: false,
    nextRunAt: null,
  };
  if (!entry.trigger) {
    if (!/^[\d\*\-\/,\s]+$/.test(entry.cron) || entry.cron.split(/\s+/).length !== 5) {
      return { ok: false, error: "Invalid schedule expression." };
    }
  }
  entries.push(entry);
  persist();
  return { ok: true, automation: entry };
}

function get(id) {
  ensureLoaded();
  return entries.find((e) => e.id === id) || null;
}

function list() {
  ensureLoaded();
  return entries.slice();
}

function toggle(id, enabled) {
  ensureLoaded();
  const e = get(id);
  if (!e) return { ok: false, error: "Automation not found." };
  e.enabled = !!enabled;
  if (!e.enabled) e.pendingConfirmation = false;
  persist();
  return { ok: true, automation: e };
}

function remove(id) {
  ensureLoaded();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return { ok: false, error: "Automation not found." };
  const [removed] = entries.splice(idx, 1);
  persist();
  return { ok: true, removed };
}

function updateRun(id, status, opts = {}) {
  ensureLoaded();
  const e = get(id);
  if (!e) return { ok: false, error: "Automation not found." };
  e.lastRunAt = new Date().toISOString();
  e.lastRunStatus = status; // "success" | "partial" | "failed" | "awaiting-confirmation"
  e.pendingConfirmation = status === "awaiting-confirmation";
  if (opts.confirming) e.pendingConfirmation = false;
  persist();
  return { ok: true, automation: e };
}

function setNextRun(id, nextRunAt) {
  ensureLoaded();
  const e = get(id);
  if (!e) return;
  e.nextRunAt = nextRunAt ? new Date(nextRunAt).toISOString() : null;
  if (!__testing) persist();
}

function clearForTesting() {
  __testing = true;
  loaded = false;
  entries = [];
}

module.exports = {
  add, get, list, toggle, remove, updateRun, setNextRun, validateCandidate,
  statusFromSteps, storePath, clearForTesting, MAX_AUTOMATIONS, MAX_STEPS,
  validateTriggerObj,
};
