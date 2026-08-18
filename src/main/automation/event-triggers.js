// Nova — automation/event-triggers.js (Round 5)
//
// Event-triggered automations, sitting alongside the existing cron
// scheduler. An automation can now declare a `trigger` instead of (or in
// addition to) a `cron`:
//
//   { type: "file"    , folder, depth, debounceMs }  — fires when a file is
//                                                    added/changed/removed
//                                                    inside `folder` (chokidar)
//   { type: "time"    , at }                         — fires once when the
//                                                    clock reaches `at`
//                                                    (HH:MM 24h, e.g. "17:30")
//   { type: "event"   , name }                       — fires when Nova emits
//                                                    `automation:event:<name>`
//                                                    (app events such as
//                                                    "startup", "wake",
//                                                    "screen-capture")
//   { type: "idle"    , minutes }                    — fires after the system
//                                                    has been idle >= `minutes`
//
// Safety is inherited unchanged: the runner keeps every step's original risk
// level and pauses before the first Level 3+ step. An automation whose only
// steps are Level 3+ with no Level 0–2 first step is still refused at
// creation (store.js validates `steps` regardless of trigger).
//
// A cooldown (per automation) prevents event floods: each trigger type fires
// at most once per COOLDOWN_MIN_MS (5 min), and file triggers additionally
// debounce bursts into a single run per window.
//
// Testing: start()/stop() with injected clock + injected idler, resetForTesting().

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const log = require("electron-log");
const store = require("./store");
const { runAutomation } = require("./runner");

const COOLDOWN_MIN_MS = 5 * 60 * 1000;

let __now = null;            // injected clock for testing
let __idleFn = null;         // injected idle detector for testing
let __fileWatcher = null;    // one chokidar watcher, routing to all file triggers
let __timeTimer = null;      // poll for "time" triggers
let __idleTimer = null;      // poll for "idle" triggers
let __running = false;
let __cooldowns = new Map(); // autoId → last fired timestamp (ms)
let __fileDebounce = new Map(); // autoId → timer handle
let __appListener = null;    // bound reference so we can detach cleanly

let __appEmitter = null;     // application-wide emitter bridge (set in main.js)

const VALID_TRIGGERS = new Set(["file", "time", "event", "idle"]);

function setNowForTesting(fn) { __now = fn; }
function setIdleForTesting(fn) { __idleFn = fn; }
/** Optional injected deps for runAutomation (used by tests). */
let __deps = null;
function setDepsForTesting(deps) { __deps = deps; }
function setAppEmitter(em) { __appEmitter = em; }

function now() { return __now ? new Date(__now()) : new Date(); }

function parseHHMM(at) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(at || "").trim());
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

function validateTrigger(trigger) {
  if (!trigger || !VALID_TRIGGERS.has(trigger.type)) {
    return { ok: false, error: "Trigger must be one of: file, time, event, idle." };
  }
  switch (trigger.type) {
    case "file": {
      const folder = String(trigger.folder || "").trim();
      if (!path.isAbsolute(folder)) {
        return { ok: false, error: "File trigger folder must be an absolute path." };
      }
      try {
        const st = fs.statSync(folder);
        if (!st.isDirectory()) return { ok: false, error: "File trigger folder does not exist." };
      } catch {
        return { ok: false, error: "File trigger folder does not exist." };
      }
      const depth = Math.min(12, Math.max(0, Number(trigger.depth ?? 4)));
      const debounceMs = Math.min(60_000, Math.max(1000, Number(trigger.debounceMs ?? 3000)));
      return { ok: true, trigger: { type: "file", folder, depth, debounceMs, match: trigger.match || null } };
    }
    case "time": {
      const p = parseHHMM(trigger.at);
      if (!p) return { ok: false, error: "Time trigger needs 'at' in HH:MM (24h)." };
      return { ok: true, trigger: { type: "time", at: `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}` } };
    }
    case "event": {
      const name = String(trigger.name || "").trim().toLowerCase();
      if (!/^[a-z0-9\-\._]{1,60}$/.test(name)) {
        return { ok: false, error: "Event trigger name must be 1–60 alphanumeric/dash/dot/underscore characters." };
      }
      if (name === "startup") return { ok: true, trigger: { type: "event", name } };
      return { ok: true, trigger: { type: "event", name } };
    }
    case "idle": {
      const minutes = Math.min(120, Math.max(1, Number(trigger.minutes ?? 10)));
      return { ok: true, trigger: { type: "idle", minutes } };
    }
  }
}

function lastFired(autoId) { return Number(__cooldowns.get(autoId) || 0); }
function markFired(autoId) { __cooldowns.set(autoId, Number(now())); }

function fire(autoId, meta = {}) {
  const auto = store.get(autoId);
  if (!auto || !auto.enabled) return;
  const lf = lastFired(autoId);
  if (lf && Number(now()) - lf < COOLDOWN_MIN_MS) {
    log.info(`[automation] event trigger cooldown for "${auto.name}" (${(Number(now()) - lf) / 1000}s)`);
    return;
  }
  markFired(autoId);
  log.info(`[automation] event trigger "${auto.name}" (${meta.source || "event"})`);
  emitter.emit("automation-event-firing", { id: autoId, name: auto.name, ...meta, firedAt: new Date(now()).toISOString() });
  // Bridge vision steps to the renderer's runVisionQuery IPC when the main
  // window is available; otherwise fall back to a hard fail so the Action Log
  // records the failed run rather than silently succeeding.
  const deps = { runVisionQuery: null };
  try {
    const { BrowserWindow } = require("electron");
    const win = BrowserWindow?.getAllWindows()?.[0];
    if (win && !win.isDestroyed()) {
      deps.runVisionQuery = async (question) => {
        try {
          return await win.webContents.executeJavaScript(`
            window.nova && window.nova.runVisionQuery
              ? window.nova.runVisionQuery(${JSON.stringify(question)})
              : Promise.reject(new Error("renderer vision IPC unavailable"))`, true);
        } catch (err) { return { error: String(err?.message || err) }; }
      };
    }
  } catch {}
  runAutomation(autoId, __deps || deps).then((result) => {
    store.updateRun(autoId,
      result.status === "awaiting-confirmation" ? "awaiting-confirmation" : (result.status === "success" ? "success" : "partial"));
    actionLogAppend(autoId, result);
  }).catch((err) => {
    log.error(`[automation] event run failed for "${auto.name}":`, err?.message || err);
    store.updateRun(autoId, "failed");
  });
}

function actionLogAppend(autoId, result) {
  try {
    const actionLog = require("../permissions/action-log");
    const auto = store.get(autoId);
    actionLog.append({
      actionId: "automation:event-run",
      level: auto ? Math.max(...auto.steps.map((s) => s.level)) : 0,
      outcome: result?.status === "success" ? "success" : "failed",
      detail: { automationId: autoId, name: auto?.name, status: result?.status },
    });
  } catch (err) {
    log.warn("[automation] event run log append failed:", err?.message || err);
  }
}

// ---------- file triggers ----------

function rebuildFileWatcher() {
  stopFileWatcher();
  const fileAutos = store.list().filter((a) => a.enabled && a.trigger && a.trigger.type === "file");
  if (!fileAutos.length) return;
  try {
    const chokidar = require("chokidar");
    __fileWatcher = chokidar.watch(fileAutos.map((a) => a.trigger.folder), {
      ignoreInitial: true,
      persistent: true,
      depth: 8,
      ignored: /(^|[\/\\])\../,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });
    const route = (ev, absPath) => {
      for (const a of fileAutos) {
        if (!a.enabled) continue;
        const tr = a.trigger;
        if (!absPath.startsWith(tr.folder)) continue;
        const rel = path.relative(tr.folder, absPath);
        if (rel.split(path.sep).length > tr.depth + 1) continue;
        if (tr.match) {
          const re = new RegExp(tr.match, "i");
          if (!re.test(rel)) continue;
        }
        scheduleFileRun(a.id, `${ev}:${rel}`);
      }
    };
    for (const ev of ["add", "change"]) __fileWatcher.on(ev, (p) => route(ev, p));
    __fileWatcher.on("unlink", (p) => route("unlink", p));
    __fileWatcher.on("error", (err) => log.warn("[automation] file watcher error:", err?.message || err));
  } catch (err) {
    log.warn("[automation] could not start file watcher:", err?.message || err);
  }
}

function scheduleFileRun(autoId) {
  const auto = store.get(autoId);
  if (!auto) return;
  const existing = __fileDebounce.get(autoId);
  if (existing) clearTimeout(existing);
  __fileDebounce.set(autoId, setTimeout(() => {
    __fileDebounce.delete(autoId);
    fire(autoId, { source: `file:${auto.trigger.folder}` });
  }, auto.trigger.debounceMs));
}

function stopFileWatcher() {
  for (const t of __fileDebounce.values()) clearTimeout(t);
  __fileDebounce.clear();
  if (__fileWatcher) { __fileWatcher.close().catch(() => {}); __fileWatcher = null; }
}

// ---------- time triggers ----------

function rebuildTimePoller() {
  stopTimePoller();
  const timeAutos = store.list().filter((a) => a.enabled && a.trigger && a.trigger.type === "time");
  if (!timeAutos.length) return;
  __timeTimer = setInterval(() => {
    const t = now();
    const key = t.toISOString().slice(0, 16); // once per minute
    for (const a of timeAutos) {
      if (a.trigger.at !== `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`) continue;
      if (a.lastRunAt && new Date(a.lastRunAt).toISOString().slice(0, 16) === key) continue;
      fire(a.id, { source: "time" });
    }
  }, 1000);
}

function stopTimePoller() {
  if (__timeTimer) { clearInterval(__timeTimer); __timeTimer = null; }
}

// ---------- idle triggers ----------

function defaultIdleDetector() {
  // Electron powerMonitor works in main process only; when unavailable we
  // fall back to "never idle" (idle triggers stay dormant until wired).
  try {
    const { powerMonitor } = require("electron");
    if (powerMonitor && powerMonitor.getSystemIdleTime) {
      return () => powerMonitor.getSystemIdleTime();
    }
  } catch {}
  return null;
}

function rebuildIdlePoller() {
  stopIdlePoller();
  const idleAutos = store.list().filter((a) => a.enabled && a.trigger && a.trigger.type === "idle");
  if (!idleAutos.length) return;
  const getIdle = __idleFn || (defaultIdleDetector() && (() => defaultIdleDetector())) || (() => null);
  __idleTimer = setInterval(() => {
    const seconds = (typeof getIdle === "function") ? getIdle() : null;
    if (seconds == null) return; // no idle source available
    for (const a of idleAutos) {
      if (seconds >= a.trigger.minutes * 60) fire(a.id, { source: "idle" });
    }
  }, 15_000);
}

function stopIdlePoller() {
  if (__idleTimer) { clearInterval(__idleTimer); __idleTimer = null; }
}

// ---------- app event triggers ----------

function onAppEvent(evt) {
  const name = String(evt && evt.name || "").toLowerCase();
  if (!name) return;
  for (const a of store.list()) {
    if (!a.enabled || !a.trigger || a.trigger.type !== "event") continue;
    if (a.trigger.name !== name) continue;
    if (name === "startup" && a.trigger.name === "startup") fire(a.id, { source: "event:startup" });
    else fire(a.id, { source: `event:${name}` });
  }
}

function attachAppListener() {
  if (__appListener) return;
  const bus = __appEmitter || (global.__novaAppEvents instanceof EventEmitter ? global.__novaAppEvents : null);
  if (!bus) return;
  __appListener = onAppEvent.bind(null);
  bus.on("app-event", __appListener);
}

// ---------- lifecycle ----------

function start() {
  if (__running) return;
  __running = true;
  attachAppListener();
  rebuildFileWatcher();
  rebuildTimePoller();
  rebuildIdlePoller();
  log.info("[automation] event triggers started");
}

function stop() {
  __running = false;
  stopFileWatcher();
  stopTimePoller();
  stopIdlePoller();
  if (__appListener) {
    const bus = __appEmitter || (global.__novaAppEvents instanceof EventEmitter ? global.__novaAppEvents : null);
    if (bus) bus.removeListener("app-event", __appListener);
    __appListener = null;
  }
  log.info("[automation] event triggers stopped");
}

function refreshForAutomation() {
  if (!__running) return;
  rebuildFileWatcher();
  rebuildTimePoller();
  rebuildIdlePoller();
}

function resetForTesting() {
  stop();
  __now = null;
  __idleFn = null;
  __cooldowns = new Map();
  __running = false;
}

const emitter = new EventEmitter();

module.exports = {
  validateTrigger, start, stop, fire, refreshForAutomation,
  setNowForTesting, setIdleForTesting, setAppEmitter, resetForTesting,
  setDepsForTesting, rebuildFileWatcher, emitter, COOLDOWN_MIN_MS, VALID_TRIGGERS,
};
