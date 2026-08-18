#!/usr/bin/env node
//
// Round 29: focus mode / Pomodoro harness. Covers:
//  1. Planner routing — start variants (with/without duration, hours, pomodoro
//     wording, "start a focus session") and stop variants, plus negatives
//     ("note focus mode" stays a note; "I feel focused" stays a mood note).
//  2. Duration parsing — default 25, minutes, hours, 0.5h = 30, cap at 10h.
//  3. Store math — session record, endsAt derived from duration, running→
//     completed/cancelled history, only-one-running (swap cancels the old).
//  4. Dispatcher wording — start announcement with local times, stop with
//     real elapsed minutes, "no session running" on a second stop.
//  5. Action log + zero outbound — every start/stop is logged locally, no
//     network path exists for the focus route.

process.env.__NOVA_IDENTITY_TEST = "/tmp/.nova-focus-test-data";
process.env.__NOVA_USER_MODEL_TEST = "/tmp/.nova-focus-test-data";
process.env.__NOVA_ACTION_LOG_TEST = "/tmp/.nova-focus-test-data";

const fs = require("fs");
const path = require("path");
const Module = require("module");
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron" || request.startsWith("electron/")) {
    return path.join(__dirname, "../..", "shim-electron.js");
  }
  return origResolve.call(this, request, parent, isMain, options);
};
const requireElectron = require(path.join(__dirname, "..", "..", "shim-electron.js"));
Module._load = function (request, parent, isMain, options) {
  if (request === "electron" || request.startsWith("electron/")) return requireElectron;
  return origLoad.call(this, request, parent, isMain, options);
};

const assert = (label, cond) => {
  if (!cond) { console.error(`ASSERT FAILED: ${label}`); process.exitCode = 1; return; }
  console.log(`PASS: ${label}`);
};

// ---------------------------------------------------------------------------
const { planNoteAction, runNoteAction } = require("./notes/dispatch");
const store = require("./notes/store");
const identity = require("./identity/identity");
const userModels = require("./identity/user-model");
// action registry (notes actions incl. the new focus ones)
require("./notes/actions");
const { getAction } = require("./permissions/action-registry");
// action log lives in permissions/log.js — require after shim
const actionLog = require("./permissions/action-log");

// fresh state — a FILE path for the notes store (directory would throw EISDIR)
const TEST_DIR = "/tmp/.nova-focus-test-data";
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });
const storeFile = path.join(TEST_DIR, "notes.json");
store.setStorePathForTesting(storeFile);
identity.resetForTesting();
userModels.resetForTesting();
identity.set({ userName: "Jordan", personality: "warm" });
// wipe the in-memory action log too (loaded once at require time)
actionLog.clear();

const NOW = new Date("2026-08-19T10:00:00Z").getTime(); // Wed 10:00 UTC = 12:00 CEST

// ===========================================================================
// 1. Planner routing — start and stop phrases
// ===========================================================================

const route = (t) => (planNoteAction(t) || {}).actionId || null;
const plan = (t) => planNoteAction(t) || {};

assert("route: start focus mode → notes:focus-start", route("start focus mode") === "notes:focus-start");
assert("route: start focus session → notes:focus-start", route("start focus session") === "notes:focus-start");
assert("route: start a focus session → notes:focus-start", route("start a focus session") === "notes:focus-start");
assert("route: focus mode → notes:focus-start", route("focus mode") === "notes:focus-start");
assert("route: focus mode for 45 min → notes:focus-start", route("focus mode for 45 min") === "notes:focus-start");
assert("route: focus mode for 2 hours → notes:focus-start", route("focus mode for 2 hours") === "notes:focus-start");
assert("route: start a pomodoro → notes:focus-start", route("start a pomodoro") === "notes:focus-start");
assert("route: start pomodoro for 25 min → notes:focus-start", route("start pomodoro for 25 min") === "notes:focus-start");
assert("route: pomodoro → notes:focus-start", route("pomodoro") === "notes:focus-start");
assert("route: pomodoro for 50 min → notes:focus-start", route("pomodoro for 50 min") === "notes:focus-start");
assert("route: focus for 30 min → notes:focus-start", route("focus for 30 min") === "notes:focus-start");
assert("route: focus for 0.5 hour → notes:focus-start (0.5h = 30min)", route("focus for 0.5 hour") === "notes:focus-start");
assert("route: nova, start focus mode → notes:focus-start", route("nova, start focus mode") === "notes:focus-start");

// stop phrases
assert("route: stop focus → notes:focus-stop", route("stop focus") === "notes:focus-stop");
assert("route: end focus → notes:focus-stop", route("end focus") === "notes:focus-stop");
assert("route: stop focus mode → notes:focus-stop", route("stop focus mode") === "notes:focus-stop");
assert("route: end focus mode → notes:focus-stop", route("end focus mode") === "notes:focus-stop");
assert("route: quit focus mode → notes:focus-stop", route("quit focus mode") === "notes:focus-stop");
assert("route: end my focus session → notes:focus-stop", route("end my focus session") === "notes:focus-stop");
assert("route: stop my session → notes:focus-stop", route("stop my session") === "notes:focus-stop");
assert("route: pomodoro done → notes:focus-stop", route("pomodoro done") === "notes:focus-stop");
assert("route: pomodoro over → notes:focus-stop", route("pomodoro over") === "notes:focus-stop");

// negatives — look-alikes that must NOT route to focus
assert("negative: note focus mode → not focus (it is a note)", route("note focus mode") === "notes:add-note");
assert("negative: I feel focused → not focus-start (mood note)", route("I feel focused") === "notes:mood-statement");
assert("negative: focus on the report → not focus-start", route("focus on the report") === null);
assert("negative: list my tasks → not focus-start", route("list my tasks") !== "notes:focus-start");
assert("negative: stop → not focus-stop", route("stop") === null);
assert("negative: end my tasks → not focus-stop", route("end my tasks") === null);
assert("negative: pomodoro technique → not focus-start", route("pomodoro technique") === null);

// ===========================================================================
// 2. Duration parsing
// ===========================================================================

assert("duration default: start focus mode → 25 min", plan("start focus mode").payload.durationMin === 25);
assert("duration default: focus mode → 25 min", plan("focus mode").payload.durationMin === 25);
assert("duration default: pomodoro → 25 min", plan("pomodoro").payload.durationMin === 25);
assert("duration: focus mode for 45 min → 45", plan("focus mode for 45 min").payload.durationMin === 45);
assert("duration: focus for 30 minutes → 30", plan("focus for 30 minutes").payload.durationMin === 30);
assert("duration: focus mode for 2 hours → 120", plan("focus mode for 2 hours").payload.durationMin === 120);
assert("duration: focus for 0.5 hour → 30", plan("focus for 0.5 hour").payload.durationMin === 30);
assert("duration: focus mode for 1.5 hours → 90", plan("focus mode for 1.5 hours").payload.durationMin === 90);
assert("duration: start pomodoro for 50 min → 50", plan("start pomodoro for 50 min").payload.durationMin === 50);
assert("duration: start a focus session for 10 min → 10", plan("start a focus session for 10 min").payload.durationMin === 10);
assert("duration: start a pomodoro for 25 min → 25", plan("start a pomodoro for 25 min").payload.durationMin === 25);

// ===========================================================================
// 3. Store math — sessions, running state, history, swap
// ===========================================================================

const s1 = store.startFocus(25);
assert("store: first session is running", latestRunning() && latestRunning().id === s1.id && latestRunning().status === "running");
assert("store: startedAt is ISO", typeof latestRunning().startedAt === "string" && latestRunning().startedAt.includes("T"));

// a second start candidly ends the first (swap)
const s2 = store.startFocus(30);
const hist = store.focusHistory();
assert("store: second start swaps — first ended as cancelled", hist.find((f) => f.id === s1.id).status === "cancelled");
assert("store: first session got a stoppedAt on swap", hist.find((f) => f.id === s1.id).stoppedAt !== null);
assert("store: newest session is running", latestRunning() && latestRunning().id === s2.id);

// pinned-clock stop
const t2 = new Date("2026-08-19T10:20:00Z").toISOString();
const ended = store.stopFocus("completed", t2);
assert("store: stop closes the running session", ended && ended.status === "completed");
assert("store: stoppedAt respects pinned clock", ended.stoppedAt === t2);
assert("store: no running session after stop", latestRunning() === null);
assert("store: stop with no running session returns null", store.stopFocus() === null);

// invalid input protection
let threw = false;
try { store.startFocus(0); } catch { threw = true; }
assert("store: duration 0 rejected", threw);
const big = store.startFocus(1200);
assert("store: 10 h cap — 1200 min clamped to 600", big.durationMin === 600);

// ===========================================================================
// 4. Dispatcher wording — start announcement, stop, no-session stop
// ===========================================================================

// fresh run for dispatch checks (deterministic clock via opts.now)
store.resetForTesting();

(async () => {
  const start = await runNoteAction("start focus mode", { now: NOW });
  assert("dispatch: start ok", start.ok === true);
  assert("dispatch: start session has id+duration+times", start.detail.session && start.detail.session.durationMin === 25 && start.detail.session.startedAt === "2026-08-19T10:00:00.000Z" && start.detail.session.endsAt === "2026-08-19T10:25:00.000Z");
  assert("dispatch: start text carries local times", /10:00/.test(start.text) && /10:25/.test(start.text));
  assert("dispatch: start text mentions 25 minutes", /25 minutes/.test(start.text));

  const start2 = await runNoteAction("focus mode for 2 hours", { now: new Date("2026-08-19T14:15:00Z").getTime() });
  assert("dispatch: 2-hour start says '2 hours'", /2 hours/.test(start2.text));
  assert("dispatch: 2-hour start ends at 4:15 PM (local rendering of 16:15Z)", /4:15 ?PM/.test(start2.text) || /16:15/.test(start2.text));

  const stop = await runNoteAction("stop focus", { now: new Date("2026-08-19T14:50:00Z").getTime() });
  assert("dispatch: stop ok", stop.ok === true);
  assert("dispatch: stop reports real elapsed (35 min, not the 120 planned)", /35 minutes/.test(stop.text));

  const stopAgain = await runNoteAction("end focus mode");
  assert("dispatch: second stop is ok + 'no session running'", stopAgain.ok === true && /no focus session was running/i.test(stopAgain.text));

  // mood note alongside focus — both work side by side
  const mood = await runNoteAction("I feel tired today", { now: Date.now() });
  assert("dispatch: mood statement still works next to focus", mood.actionId === "notes:mood-statement");
  const note = await runNoteAction("note focus mode rules", { now: Date.now() });
  assert("dispatch: 'note focus mode rules' is a note, not a session", note.actionId === "notes:add-note");

  // =========================================================================
  // 5. Action log + zero outbound
  // =========================================================================

  // zero outbound — the focus route never touches fetch: patch it to fail loud
  const fetchBefore = global.fetch;
  global.fetch = async () => { assert("zero outbound: fetch was called", false); throw new Error("fetch intercepted"); };
  const r = await runNoteAction("start focus mode", { now: Date.now() });
  const r2 = await runNoteAction("stop focus", { now: Date.now() });
  global.fetch = fetchBefore;
  assert("zero outbound: focus start works with fetch patched", r.ok === true);
  assert("zero outbound: focus stop works with fetch patched", r2.ok === true);

  // log checks run LAST so every entry (incl. the candid swap-cancel written
  // during the zero-outbound swap) is visible in actionLog.list()
  const log = actionLog.list();
  assert("log: start logged at level 1", log.some((e) => e.actionId === "notes:focus-start" && e.level === 1 && e.outcome === "success"));
  assert("log: swap cancel logged candidly", log.some((e) => e.outcome === "cancelled" && e.actionId === "notes:focus-start" && e.level === 1));
  assert("log: stop logged", log.some((e) => e.actionId === "notes:focus-stop" && e.outcome === "success"));

  console.log("\nRound 29 focus-mode harness done.");
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 1; });

// --- tiny helpers ----------------------------------------------------------
function latestRunning() {
  const list = store.focusHistory();
  return list.find((f) => f.status === "running") || null;
}
