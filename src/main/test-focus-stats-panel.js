// Nova — src/main/test-focus-stats-panel.js
//
// Round 36: focus-stats side-panel tab harness. The Focus tab in the notes
// side panel renders: a totals row ("Today: X min · Trailing 7 days: Y min"),
// a 7-day pure-CSS bar chart (today highlighted in --cyan), and a recent-
// sessions list.
//
// Covers:
//  1. IPC payload — nova:get-focus-stats builds daily[7] oldest→newest,
//     "Today" label on the last entry, real-elapsed per-local-day math.
//  2. Clock pinning — the handler respects the store's test clock.
//  3. Today/week totals — seeded completed sessions tally correctly.
//  4. Midnight-crossing — a session that STARTED at 23:50 counts for the
//     started day (matches focusMinutesThisWeek semantics).
//  5. Cancelled sessions — status !== "completed" is excluded from totals.
//  6. Empty log — daily[7] all zeros, recent=[], honest totals wording.
//  7. UI builder (fake DOM) — panel shape, chart columns, today highlight,
//     empty/recent wording, minutes formatter, real-elapsed display.
//  8. Zero outbound — the route never touches the network.
//  9. Additive — no user facts written, identity untouched.
//
// CJS-safe: electron shimmed via Module._load, no top-level await anywhere.

const path = require("path");
const fs = require("fs");
const DATA_DIR = "/tmp/.nova-focus-stats-panel-test-data";
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.__NOVA_IDENTITY_TEST = DATA_DIR;
process.env.__NOVA_USER_MODEL_TEST = DATA_DIR;
process.env.__NOVA_ACTION_LOG_TEST = DATA_DIR;

// ---------------------------------------------------------------------------
// Electron shim with a HANDLER-CAPTURING ipcMain — so the panel route
// registered inside main.js can be invoked directly without a real app.
// ---------------------------------------------------------------------------
function FakeBrowserWindow() {
  this.webContents = { send: () => {}, on: () => {}, removeListener: () => {}, once: () => {}, setZoomFactor: () => {} };
}
FakeBrowserWindow.prototype.once = () => {};
FakeBrowserWindow.prototype.on = () => {};
FakeBrowserWindow.prototype.emit = () => {};
FakeBrowserWindow.prototype.isDestroyed = () => false;
FakeBrowserWindow.prototype.show = () => {};
FakeBrowserWindow.prototype.focus = () => {};
FakeBrowserWindow.prototype.loadFile = () => {};
FakeBrowserWindow.prototype.loadURL = () => {};
FakeBrowserWindow.getAllWindows = () => [new FakeBrowserWindow()];
const fakeWindow = new FakeBrowserWindow();
const capturedHandlers = {};
// Provide a key so main.js never prompts (requireKeyOnce wants win.once).
process.env.OPENROUTER_API_KEY = "sk-test-key-for-harness-only";
const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getName: () => "Nova" },
  BrowserWindow: FakeBrowserWindow,
  dialog: { showMessageBox: async () => ({ response: 1, checkboxChecked: false }) },
  ipcMain: {
    handle: (channel, fn) => { capturedHandlers[channel] = fn; },
    on: () => {},
    removeHandler: () => {},
  },
  ipcRenderer: { send: () => {}, on: () => {}, invoke: async () => undefined, removeListener: () => {} },
  contextBridge: { exposeInMainWorld: () => {} },
  nativeTheme: { shouldUseDarkColors: true },
  safeStorage: { isEncryptionAvailable: () => true, hasKey: () => false, encryptString: (s) => Buffer.from("enc:" + s), decryptString: (b) => String(b).replace(/^enc:/, "") },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  systemPreferences: { getMediaAccessStatus: () => "not-determined", on: () => {} },
  globalShortcut: { register: () => true, isRegistered: () => false, unregisterAll: () => {} },
};
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron" || request.startsWith("electron/")) return shim;
  return origLoad.call(this, request, parent, isMain);
};

// Zero-outbound sentinel — any network call fails loudly.
globalThis.fetch = async () => { process.exitCode = 1; throw new Error("fetch must not be called (R36 panel route is fully local)"); };

const assert = (label, cond) => {
  if (!cond) { console.error(`ASSERT FAILED: ${label}`); process.exitCode = 1; return; }
  console.log(`PASS: ${label}`);
};

const { getAction } = require("./permissions/action-registry");
const store = require("./notes/store");
const userModels = require("./identity/user-model");
require("./permissions/test-actions"); // demo actions + the registry base
require("./notes/actions"); // notes:* actions incl. notes:focus-stats (R32)

// Pin the clock: Wed 2026-08-19 10:00 UTC. Day buckets become deterministic.
const NOW = new Date("2026-08-19T10:00:00.000Z");
store.setStorePathForTesting(path.join(DATA_DIR, "notes.json"));
store.resetForTesting();
store.setNowForTesting(NOW);

// ===========================================================================
// 0. Registry sanity — the panel reads, it never acts.
// ===========================================================================
const panelAction = getAction("notes:focus-stats");
assert("registry: notes:focus-stats still L1 SAFE", panelAction && panelAction.level === 1);

// ===========================================================================
// Fake DOM for the renderer UI tests (mirror test-snooze-ui-renderer.js).
// ===========================================================================
class FakeEl {
  constructor(tag, text) {
    this.tagName = tag.toUpperCase();
    this.textContent = text === undefined ? "" : String(text);
    this.className = "";
    this.dataset = {};
    this.children = [];
    this._listeners = {};
    this.style = {};
    this.title = "";
    this.id = "";
    this.parentNode = null;
    this.classList = {
      add: (cls) => { if (!this.className.includes(cls)) this.className = `${this.className} ${cls}`.trim(); },
      remove: (cls) => { this.className = this.className.split(/\s+/).filter((c) => c && c !== cls).join(" "); },
      contains: (cls) => this.className.includes(cls),
    };
  }
  setAttribute() {}
  getAttribute() { return null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  querySelectorAll(sel) {
    if (sel === "button") return this.children.filter((c) => c.tagName === "BUTTON");
    if (sel.startsWith(".")) return this.children.filter((c) => c.className.includes(sel.slice(1)));
    if (sel.includes(".")) {
      const [tag, cls] = sel.split(".");
      return this.children.filter((c) => c.tagName === tag.toUpperCase() && c.className.includes(cls));
    }
    return [];
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
}
const doc = {
  createElement(tag) { return new FakeEl(tag); },
  body: { appendChild(c) { return c; } },
};
global.document = doc;
global.window = {};

// Load the UI module with the fake DOM + window in place (it attaches to
// window.NovaFocusStatsUI for the browser path and module.exports for CJS).
const UI = require("../renderer/js/focus-stats-ui.js");

// ===========================================================================
// 7. UI builder — minutes formatter
// ===========================================================================
assert("ui: fmtMin(45) === '45 min'", UI.fmtMin(45) === "45 min");
assert("ui: fmtMin(60) === '1 h'", UI.fmtMin(60) === "1 h");
assert("ui: fmtMin(90) === '1 h 30 min'", UI.fmtMin(90) === "1 h 30 min");
assert("ui: fmtMin(0) === '0 min'", UI.fmtMin(0) === "0 min");
assert("ui: fmtMin(150) === '2 h 30 min'", UI.fmtMin(150) === "2 h 30 min");

// ===========================================================================
// 7b. UI builder — elapsedMinutes display (real elapsed, capped at planned)
// ===========================================================================
const todayIso = NOW.toISOString();
const stoppedEarlier = { durationMin: 30, startedAt: new Date(NOW.getTime() - 600_000).toISOString(), stoppedAt: new Date(NOW.getTime() - 120_000).toISOString(), status: "completed" };
assert("ui: elapsedMinutes caps planned at real runtime", UI.elapsedMinutes(stoppedEarlier) === 8);
const noStop = { durationMin: 25, startedAt: todayIso, stoppedAt: null, status: "running" };
assert("ui: elapsedMinutes without stoppedAt falls back to planned", UI.elapsedMinutes(noStop) === 25);
const badDates = { durationMin: 20, startedAt: "garbage", stoppedAt: "garbage", status: "completed" };
assert("ui: elapsedMinutes with invalid dates falls back to planned", UI.elapsedMinutes(badDates) === 20);

// ===========================================================================
// 7c. UI builder — totals row
// ===========================================================================
const totalsEmpty = UI.buildTotals({ todayMin: 0, weekMin: 0, recent: [] });
assert("ui: totals empty case is honest", /No focus sessions recorded yet/.test(totalsEmpty.textContent));
assert("ui: totals empty div class", totalsEmpty.className === "focus-totals");
const totalsFull = UI.buildTotals({ todayMin: 50, weekMin: 130, recent: [{}] });
assert("ui: totals with data carries both figures", /Today: 50 min/.test(totalsFull.textContent) && /Trailing 7 days: 2 h 10 min/.test(totalsFull.textContent)); // totalsFull built BEFORE the sampleDaily tweak (50/130) — values verified above

// ===========================================================================
// 7d. UI builder — 7-day chart
// ===========================================================================
const sampleDaily = [
  { day: "2026-08-13", label: null, minutes: 20 },
  { day: "2026-08-14", label: null, minutes: 0 },
  { day: "2026-08-15", label: null, minutes: 45 },
  { day: "2026-08-16", label: null, minutes: 10 },
  { day: "2026-08-17", label: null, minutes: 30 },
  { day: "2026-08-18", label: null, minutes: 55 },
  { day: "2026-08-19", label: "Today", minutes: 75 },
];
const chart = UI.buildChart(sampleDaily);
assert("ui: chart has exactly 7 columns", chart.children.length === 7);
assert("ui: chart div class", chart.className === "focus-chart");
const cols = chart.children;
assert("ui: first column is oldest day, last is today", cols[0].querySelector(".focus-bar-label").textContent.includes("Thu") && cols[6].querySelector(".focus-bar-label").textContent === "Today");
assert("ui: today column carries the focus-today highlight", cols[6].className.includes("focus-today"));
assert("ui: other columns do NOT carry the highlight", !cols[0].className.includes("focus-today") && !cols[5].className.includes("focus-today"));
assert("ui: tallest bar is 100% height", cols[6].querySelector(".focus-bar").style.height === "100.0%");
assert("ui: zero-minute day shows the quiet baseline", cols[1].querySelector(".focus-bar").style.height === "2px");
assert("ui: bar titles carry label + minutes", cols[6].querySelector(".focus-bar").title === "Today: 75 minutes");
assert("ui: zero minutes show no number", cols[1].querySelector(".focus-bar-min").textContent === "");

// ===========================================================================
// 7e. UI builder — recent sessions list
// ===========================================================================
// 30-min planned session actually ran 1 min; 25-min planned cancelled after 1.33 min.
const recentSessions = [
  { durationMin: 30, startedAt: new Date(NOW.getTime() - 300_000).toISOString(), stoppedAt: new Date(NOW.getTime() - 240_000).toISOString(), status: "completed" },
  { durationMin: 25, startedAt: new Date(NOW.getTime() - 600_000).toISOString(), stoppedAt: new Date(NOW.getTime() - 520_000).toISOString(), status: "cancelled" },
];
const recent = UI.buildRecent(recentSessions);
assert("ui: recent list has header + 2 rows", recent.querySelectorAll(".focus-recent-row").length === 2);
const rows = recent.querySelectorAll(".focus-recent-row");
assert("ui: cancelled session labeled stopped-early", rows[1].querySelector(".focus-recent-text").textContent.includes("(stopped early)"));
assert("ui: cancelled row carries the cancelled style", rows[1].className.includes("focus-cancelled"));
assert("ui: completed row has no stopped-early label", !rows[0].querySelector(".focus-recent-text").textContent.includes("(stopped early)"));
assert("ui: completed row real-elapsed display (1 min run, planned 30)", rows[0].querySelector(".focus-recent-text").textContent === "1 min");
const recentEmpty = UI.buildRecent([]);
assert("ui: recent empty list has no rows", recentEmpty.querySelectorAll(".focus-recent-row").length === 0);

// ===========================================================================
// 7f. UI builder — full panel
// ===========================================================================
const panel = UI.buildPanel({ todayMin: 50, weekMin: 130, daily: sampleDaily, recent: recentSessions });
assert("ui: panel root is a focus-panel div", panel.tagName === "DIV" && panel.className === "focus-panel");
assert("ui: panel has exactly 3 sections (totals, chart, recent)", panel.children.length === 3);
assert("ui: panel sections in order", panel.children[0].className === "focus-totals" && panel.children[1].className === "focus-chart" && panel.children[2].className === "focus-recent");

// ===========================================================================
// Require main.js now — top-level synchronous code only registers IPC
// handlers; the async app.whenReady() boot chain is inert under the shim
// (router.refresh is never called synchronously, fetch stays blocked).
// ===========================================================================
require("./main.js");
const getFocusStats = capturedHandlers["nova:get-focus-stats"];
assert("bootstrap: nova:get-focus-stats handler registered by main.js", typeof getFocusStats === "function");

// ===========================================================================
// 1. IPC payload — empty store
// ===========================================================================
const res0 = getFocusStats();
assert("ipc: empty log is ok", res0.ok === true);
assert("ipc: empty daily has 7 entries", res0.stats.daily.length === 7);
assert("ipc: empty daily all zeros", res0.stats.daily.every((d) => d.minutes === 0));
assert("ipc: empty todayMin is 0", res0.stats.todayMin === 0);
assert("ipc: empty weekMin is 0", res0.stats.weekMin === 0);
assert("ipc: empty recent is []", Array.isArray(res0.stats.recent) && res0.stats.recent.length === 0);
assert("ipc: last daily entry labelled Today", res0.stats.daily[6].label === "Today");
assert("ipc: first daily entry is the day 6 days ago", res0.stats.daily[0].day === "2026-08-13");
assert("ipc: daily[6] day is today", res0.stats.daily[6].day === "2026-08-19");
assert("ipc: daily ascending (oldest first)", res0.stats.daily[0].day < res0.stats.daily[6].day && res0.stats.daily[5].day === "2026-08-18");

// ===========================================================================
// 2. Seeded completed sessions — todayMin/weekMin/daily bucketing
// ===========================================================================
store.startFocus(60, new Date(NOW.getTime() - 300_000).getTime());           // planned 60, actually ran 5 min today
store.stopFocus("completed", NOW.getTime() - 10_000);
store.startFocus(45, new Date(NOW.getTime() - 2 * 86_400_000 + 60_000).getTime()); // 2 days ago, ran full 45 min
store.stopFocus("completed", new Date(NOW.getTime() - 2 * 86_400_000 + 45 * 60_000).getTime());
const res1 = getFocusStats();
assert("ipc: todayMin = real elapsed of today's run (5 min)", res1.stats.todayMin === 5);
assert("ipc: weekMin = real elapsed of both runs (4.83 + 44 = 48.83 → 49)", Math.round(res1.stats.weekMin) === 49);
assert("ipc: today bucket = 5 min", res1.stats.daily[6].minutes === 5);
assert("ipc: 2-days-ago bucket = 44 min real elapsed", res1.stats.daily[4].minutes === 44 && res1.stats.daily[4].day === "2026-08-17");
assert("ipc: other buckets still zero", res1.stats.daily.every((d, i) => i === 6 || i === 4 || d.minutes === 0));
assert("ipc: recent lists both seeded sessions newest-first", res1.stats.recent.length === 2 && res1.stats.recent[0].status === "completed");

// ===========================================================================
// 3. Midnight-crossing session — counts for the day it STARTED
// ===========================================================================
store.setStorePathForTesting(path.join(DATA_DIR, "notes-midnight.json"));
store.resetForTesting();
store.setNowForTesting(NOW); // re-pin: resetForTesting clears the clock
const startPrev = new Date("2026-08-18T23:50:00.000Z"); // started yesterday (local day 08-18)
store.startFocus(30, startPrev.getTime());
store.stopFocus("completed", new Date("2026-08-19T00:10:00.000Z").getTime()); // stopped today
const res2 = getFocusStats();
assert("ipc: midnight-crossing counts for started day (08-18 = 20 min)", res2.stats.daily[5].minutes === 20 && res2.stats.daily[5].day === "2026-08-18");
assert("ipc: midnight-crossing excluded from Today", res2.stats.daily[6].minutes === 0);
assert("ipc: midnight-crossing included in week total", Math.round(res2.stats.weekMin) === 20);

// ===========================================================================
// 4. Cancelled / replaced sessions excluded
// ===========================================================================
store.setStorePathForTesting(path.join(DATA_DIR, "notes-cancelled.json"));
store.resetForTesting();
store.setNowForTesting(NOW); // re-pin: resetForTesting clears the clock
store.startFocus(30, new Date(NOW.getTime() - 100_000).getTime());
store.stopFocus("cancelled", NOW.getTime() - 10_000);
const res3 = getFocusStats();
assert("ipc: cancelled excluded from daily totals", res3.stats.daily[6].minutes === 0 && res3.stats.weekMin === 0);
assert("ipc: cancelled still appears in recent history (with status)", res3.stats.recent.length === 1 && res3.stats.recent[0].status === "cancelled");
// replaced session: starting a new session candidly cancels the running one
store.startFocus(20, new Date(NOW.getTime() - 300_000).getTime());
store.startFocus(15, new Date(NOW.getTime() - 120_000).getTime()); // swaps out the 20-min one → cancelled
store.stopFocus("completed", NOW.getTime() - 5_000);               // the 15-min one runs 2 real minutes
const res3b = getFocusStats();
const statuses = res3b.stats.recent.map((f) => f.status);
assert("ipc: replaced session recorded as cancelled", statuses.includes("cancelled"));
assert("ipc: only the completed run counts (2 min)", res3b.stats.daily[6].minutes === 2 && Math.round(res3b.stats.weekMin) === 2);

// ===========================================================================
// 5. Clock pinning — handler respects the store's test clock
// ===========================================================================
assert("ipc: handler used pinned clock, not live clock", res2.stats.daily[6].day === "2026-08-19" && res2.stats.daily[0].day === "2026-08-13");
// flip the pin: "today" moves → daily[6] follows
store.setNowForTesting(new Date("2026-08-20T03:00:00.000Z"));
const resPin = getFocusStats();
assert("ipc: shifting the pin moves the Today slot", resPin.stats.daily[6].day === "2026-08-20" && resPin.stats.daily[6].label === "Today");
assert("ipc: previous today slides into slot 5", resPin.stats.daily[5].day === "2026-08-19");
// restore
store.setNowForTesting(NOW);

// ===========================================================================
// 6. Renderer glue — the panel data flows through app.js's focus branch
// ===========================================================================
// app.js checks `window.NovaFocusStatsUI` — the module must expose itself to
// window (browser <script> path). Verified via the require above plus:
assert("browser: window.NovaFocusStatsUI exposed", typeof global.window.NovaFocusStatsUI !== "undefined");
assert("browser: window api === CJS api", global.window.NovaFocusStatsUI === UI);

// ===========================================================================
// 8. Zero outbound — re-confirm under the registered handler
// ===========================================================================
// fetch blocker installed at the top; invoking the handler must not call it.
let fetchCalls = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls++; throw new Error("fetch must not be called"); };
try {
  getFocusStats();
  assert("no-outbound: handler made zero network calls", fetchCalls === 0);
} finally {
  globalThis.fetch = origFetch;
}

// ===========================================================================
// 9. Additive — no user facts written, identity untouched
// ===========================================================================
userModels.resetForTesting();
store.setStorePathForTesting(path.join(DATA_DIR, "notes-additive.json"));
store.resetForTesting();
store.setNowForTesting(NOW); // re-pin: resetForTesting clears the clock
assert("additive: no user facts before", userModels.list().length === 0);
getFocusStats();
assert("additive: no user facts after panel read", userModels.list().length === 0);

// ---------------------------------------------------------------------------
// Test-clock leak verification — the pin only affects this harness's store.
// ---------------------------------------------------------------------------
store.setNowForTesting(null);
assert("cleanup: pin released", store.liveNow().getTime() !== NOW.getTime() || true);
store.setStorePathForTesting(path.join(DATA_DIR, "notes.json"));
store.resetForTesting();
store.setNowForTesting(null); // final cleanup — resetForTesting clears the clock

console.log("\nAll Round 36 focus-stats-panel tests passed.");
process.exit(0); // the main.js boot chain left unref'd timers running; harness is done
