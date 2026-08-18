// Nova — persistent Action Log.
//
// Every action taken is recorded with: id, risk level, timestamp, outcome
// (success / failed / cancelled / blocked / dry-run), plus an optional detail.
// Stored in userData/actions.log.json, newest first in API responses,
// exportable as JSON.

const fs = require("fs");
const path = require("path");
const log = require("electron-log");
const { riskLabel } = require("./risk-levels");

function logPath() {
  let dataDir;
  // Round 29: test seam — env overrides the log location so harnesses run
  // with an isolated log file (same pattern as the notes store and the
  // identity/user-model modules).
  if (process.env.__NOVA_ACTION_LOG_TEST) {
    return path.join(process.env.__NOVA_ACTION_LOG_TEST, "actions.log.json");
  }
  try {
    dataDir = require("electron").app.getPath("userData");
  } catch {
    dataDir = process.cwd();
  }
  return path.join(dataDir, "actions.log.json");
}

let entries = [];
const MAX_ENTRIES = 500;
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(logPath())) {
      const data = JSON.parse(fs.readFileSync(logPath(), "utf8"));
      entries = Array.isArray(data) ? data : [];
    }
  } catch (err) {
    log.warn("Failed to load action log:", err?.message || err);
    entries = [];
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.writeFileSync(logPath(), JSON.stringify(entries, null, 2));
  } catch (err) {
    log.warn("Failed to persist action log:", err?.message || err);
  }
}

/**
 * Append an entry. Outcome must be one of:
 * success | failed | cancelled | blocked | dry-run
 */
function append({ actionId, level, outcome, startedAt, detail, reason, taskId }) {
  ensureLoaded();
  entries.unshift({
    ts: new Date().toISOString(),
    actionId,
    level,
    levelName: riskLabel(level),
    outcome,
    ...(taskId ? { taskId } : {}),
    ...(reason ? { reason } : {}),
    ...(startedAt ? { durationMs: Date.now() - startedAt } : {}),
    ...(detail !== undefined ? { detail } : {}),
  });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
  persist();
  log.info(`[action-log] ${actionId} → ${outcome} (level ${level})`);
}

/** Newest first. */
function list(limit = 100) {
  ensureLoaded();
  return entries.slice(0, Math.min(limit, MAX_ENTRIES));
}

function clear() {
  entries = [];
  persist();
}

module.exports = { append, list, clear, logPath };
