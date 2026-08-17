// Nova — automation/scheduler.js (Stage 9)
//
// Local-timezone cron scheduler. Polls every SCAN_MS (10 s) and fires an
// `automation-firing` event for each enabled automation whose cron now
// matches and which has not already run this minute (lastRunAt guard).
//
// Fires only while Nova is running (documented limitation — same as the
// notes reminder scheduler from Stage 7).
//
// Testable: start()/stop() plus an injected clock via setNowForTesting().

const { EventEmitter } = require("events");
const log = require("electron-log");
const cron = require("./cron");
const store = require("./store");

const SCAN_MS = 10_000;

let __timer = null;
let __now = null; // injected clock for testing
let __firedKeys = new Set();

function setNowForTesting(fn) {
  __now = fn;
}
function resetForTesting() {
  stop();
  __now = null;
  __firedKeys = new Set();
}

function now() {
  return __now ? new Date(__now()) : new Date();
}

function keyForMinute(auto, t) {
  // Fire at most once per minute per automation, even across rescans.
  return `${auto.id}-${t.toISOString().slice(0, 16)}`;
}

function isDue(auto, t) {
  if (!auto.enabled) return false;
  const m = cron.parse(auto.cron);
  if (!m.test(t)) return false;
  // Don't fire twice for the same minute the automation already ran.
  if (auto.lastRunAt && new Date(auto.lastRunAt) >= t) return false;
  if (__firedKeys.has(keyForMinute(auto, t))) return false;
  return true;
}

function start() {
  if (__timer) return;
  const interval = Math.min(SCAN_MS, 1000); // 1 s while tests freeze the clock
  __timer = setInterval(() => {
    try {
      const t = now();
      for (const auto of store.list()) {
        store.setNextRun(auto.id, cron.nextMatch(cron.parse(auto.cron), t));
        if (!isDue(auto, t)) continue;
        __firedKeys.add(keyForMinute(auto, t));
        log.info(`[automation] firing "${auto.name}" (cron ${auto.cron})`);
        emitter.emit("automation-firing", { id: auto.id, name: auto.name, cron: auto.cron, firedAt: new Date(t).toISOString() });
      }
    } catch (err) {
      log.error("[automation] scheduler tick failed:", err?.message || err);
    }
  }, interval);
  log.info(`[automation] scheduler started (scan every ${interval / 1000} s)`);
}

function stop() {
  if (__timer) { clearInterval(__timer); __timer = null; }
}

const emitter = new EventEmitter();

module.exports = { start, stop, setNowForTesting, resetForTesting, isDue, emitter, SCAN_MS };
