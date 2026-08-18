// Nova — memory/conversation-memory.js (Round 6)
//
// Cross-session conversation memory. Every agent run can remember what the
// user asked and what Nova answered, so a later session picks up where the
// last one left off. Design, deliberately kept small and local:
//
//   1. Every run appends an entry to `userData/nova-memory.json`:
//        { ts, intent, input, output, taskId, tokens? }
//      The output is capped at 1000 chars — we persist the gist, not a
//      transcript dump. Entries older than MAX_AGE_DAYS (30) are pruned.
//
//   2. `recentContext(limit)` returns the last N entries, newest first,
//      formatted for the chat model as a conversation summary preamble.
//      It is ONLY used to enrich CONVERSATION intents; vision/control/files
//      answers never get memory context (they don't need chat history).
//
//   3. Privacy: entries never leave the machine by themselves. They are only
//      ever included in the messages array of a model call when Private Mode
//      is OFF; Private Mode forces an empty context. The user can "clear my
//      memory" (action: memory:clear) to wipe it.
//
//   4. The chat call in dispatcher.js is rewritten to pass the full rolling
//      window (memory preamble + last K turns) instead of a single message.

const fs = require("fs");
const path = require("path");
const log = require("electron-log");

const MAX_ENTRIES = 500;
const MAX_OUTPUT_CHARS = 1000;
const MAX_AGE_DAYS = 30;
const MEMORY_FILE = "nova-memory.json";

function dataDir() {
  try { return require("electron").app.getPath("userData"); } catch { return process.cwd(); }
}

let __entries = [];
let __loaded = false;
let __testing = false;
let __pathOverride = null;

function filePath() {
  return __pathOverride || path.join(dataDir(), MEMORY_FILE);
}

function ensureLoaded() {
  if (__loaded) return;
  __loaded = true;
  if (__testing && !__pathOverride) { __entries = []; return; }
  try {
    if (fs.existsSync(filePath())) {
      const raw = JSON.parse(fs.readFileSync(filePath(), "utf8"));
      __entries = Array.isArray(raw) ? raw : [];
    }
  } catch (err) {
    log.warn("[memory] failed to load memory:", err?.message || err);
    __entries = [];
  }
}

function persist() {
  if (__testing && !__pathOverride) return;
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(__entries, null, 2));
  } catch (err) {
    log.warn("[memory] failed to persist memory:", err?.message || err);
  }
}

function prune() {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
  __entries = __entries.filter((e) => e.ts >= cutoff);
  if (__entries.length > MAX_ENTRIES) {
    __entries = __entries.slice(__entries.length - MAX_ENTRIES);
  }
}

function append(entry) {
  ensureLoaded();
  __entries.push({
    ts: Date.now(),
    intent: String(entry.intent || "conversation").slice(0, 20),
    input: String(entry.input || "").slice(0, 500),
    output: String(entry.output || "").slice(0, MAX_OUTPUT_CHARS),
    taskId: String(entry.taskId || "").slice(0, 60),
  });
  prune();
  persist();
}

function list() {
  ensureLoaded();
  return __entries.slice();
}

function clear() {
  ensureLoaded();
  __entries = [];
  persist();
}

/**
 * Build chat-model context from memory:
 *   - a compact "past conversations" summary (last `summaryEntries`),
 *   - the last `turns` user/assistant exchanges as real messages.
 * Only call when Private Mode is off; returns [] when memory is empty.
 */
function recentContext(turns = 6, summaryEntries = 8) {
  ensureLoaded();
  if (!__entries.length) return [];
  const recent = __entries.slice().reverse();
  const out = [];
  const summaryLines = recent
    .slice(0, summaryEntries)
    .map((e) => `user: ${e.input} | nova: ${e.output}`)
    .join("\n");
  if (summaryLines) {
    out.push({
      role: "system",
      content: "Continuing from previous sessions (stored locally on this machine). " +
        `Recent history:\n${summaryLines}\n` +
        "If the user refers to something from earlier (\"that thing I asked about\"), " +
        "use this history. Do not repeat old answers; be concise.",
    });
  }
  const history = recent.slice(0, turns * 2); // alternate user/nova roughly
  for (const e of history) {
    out.push({ role: "user", content: e.input });
    if (e.output) out.push({ role: "assistant", content: e.output });
  }
  return out;
}

function stats() {
  ensureLoaded();
  return {
    entries: __entries.length,
    since: __entries.length ? new Date(__entries[0].ts).toISOString() : null,
    file: filePath(),
  };
}

function clearForTesting() {
  __testing = true;
  __loaded = false;
  __entries = [];
}
function setPathForTesting(p) { __pathOverride = p; }
function resetForTesting() {
  __testing = false;
  __loaded = false;
  __entries = [];
  __pathOverride = null;
}

module.exports = {
  append, list, clear, recentContext, stats,
  clearForTesting, setPathForTesting, resetForTesting,
  MAX_ENTRIES, MAX_OUTPUT_CHARS,
};
