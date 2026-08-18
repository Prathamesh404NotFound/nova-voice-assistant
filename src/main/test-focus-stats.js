// Nova — src/main/test-focus-stats.js
//
// Round 32: focus-time accounting harness ("how much time did I focus this
// week"). Covers:
//  1. Planner routing — focus-stats phrasings reach notes:focus-stats;
//     look-alikes (start/stop focus, list tasks, briefing, notes) are NOT
//     swallowed.
//  2. Registry — L1 SAFE, local-only simulate.
//  3. Store math — focusMinutesThisWeek / focusMinutesToday (empty, same-
//     day bucket, trailing-7-day cutoff boundary, cancelled/running
//     exclusion, yesterday-excluded-from-today, real-elapsed math).
//  4. focusStatsSummary unit wording — zero/week-only/today-only/both.
//  5. Dispatcher wording — all four populated/empty combinations, pinned
//     clock via the plan seam, detail carries both totals.
//  6. Additive guarantee — zero case writes no user facts; identity stays
//     untouched.
//  7. Zero outbound — no network path exists on the stats route.
const path = require("path");
const fs = require("fs");
const DATA_DIR = "/tmp/.nova-focus-stats-test-data";
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.__NOVA_IDENTITY_TEST = DATA_DIR;
process.env.__NOVA_USER_MODEL_TEST = DATA_DIR;
process.env.__NOVA_ACTION_LOG_TEST = DATA_DIR;
const pathP = require("path");
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
const userModels = require("./identity/user-model");
Module._load = function (request, parent, isMain, options) {
  if (request === "electron" || request.startsWith("electron/")) return requireElectron;
  return origLoad.call(this, request, parent, isMain, options);
};
const assert = (label, cond) => {
  if (!cond) { console.error(`ASSERT FAILED: ${label}`); process.exitCode = 1; return; }
  console.log(`PASS: ${label}`);
};
// ---------------------------------------------------------------------------
const { planNoteAction, runNoteAction, setNowForTesting: setPlanNow } = require("./notes/dispatch");
const store = require("./notes/store");
const identity = require("./identity/identity");
// action registry (notes actions incl. the R32 focus-stats)
require("./notes/actions");
const { getAction } = require("./permissions/action-registry");
// Pinned clock: Wed 2026-08-19 10:00 UTC — all day math is deterministic.
const NOW = new Date("2026-08-19T10:00:00.000Z").getTime();
// fresh state
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes.json"));
identity.resetForTesting();
identity.set({ userName: "Alex", personality: "warm" });

// ===========================================================================
// 1. Planner routing — focus-stats phrasings
// ===========================================================================
const route = (t) => (planNoteAction(t) || {}).actionId || null;
assert("route: how much time did i focus this week → notes:focus-stats", route("how much time did i focus this week") === "notes:focus-stats");
assert("route: how much focus did i spend today → notes:focus-stats", route("how much focus did i spend today") === "notes:focus-stats");
assert("route: how much time did i spend focusing today → notes:focus-stats", route("how much time did i spend focusing today") === "notes:focus-stats");
assert("route: how much focus time did i have today → notes:focus-stats", route("how much focus time did i have today") === "notes:focus-stats");
assert("route: my focus stats → notes:focus-stats", route("my focus stats") === "notes:focus-stats");
assert("route: my focus minutes → notes:focus-stats", route("my focus minutes") === "notes:focus-stats");
assert("route: my focus time today → notes:focus-stats", route("my focus time today") === "notes:focus-stats");
assert("route: my focus total → notes:focus-stats", route("my focus total") === "notes:focus-stats");
assert("route: how many pomodoros did i do → notes:focus-stats", route("how many pomodoros did i do") === "notes:focus-stats");
assert("route: total focus time → notes:focus-stats", route("total focus time") === "notes:focus-stats");
assert("route: focus minutes this week → notes:focus-stats", route("focus minutes this week") === "notes:focus-stats");
assert("route: focus stats → notes:focus-stats", route("focus stats") === "notes:focus-stats");
assert("route: nova, my focus stats → notes:focus-stats", route("nova, my focus stats") === "notes:focus-stats");
// negatives — creation/control/briefing intents must stay out
assert("no-route: start focus mode → NOT stats (creates a session)", route("start focus mode") !== "notes:focus-stats");
assert("no-route: start focus for 30 min → NOT stats", route("start focus for 30 min") !== "notes:focus-stats");
assert("no-route: stop focus → NOT stats", route("stop focus") !== "notes:focus-stats");
assert("no-route: pomodoro done → NOT stats", route("pomodoro done") !== "notes:focus-stats");
assert("no-route: what's on my plate today → NOT stats", route("what's on my plate today") !== "notes:focus-stats");
assert("no-route: add buy milk to my tasks → NOT stats", route("add buy milk to my tasks") !== "notes:focus-stats");

// ===========================================================================
// 2. Registry — level and locality
// ===========================================================================
const a = getAction("notes:focus-stats");
assert("registry: notes:focus-stats exists", !!a);
assert("registry: L1 SAFE", a.level === 1);
assert("registry: local-only simulate", (async () => {
  const s = await a.simulate({});
  return s && !s.title && !s.body && typeof s.summary === "string";
})());

(async () => {
// ===========================================================================
// 3. Store math — focusMinutesThisWeek / focusMinutesToday
// ===========================================================================
// --- empty log ---
assert("store: empty → week 0", store.focusMinutesThisWeek(NOW) === 0);
assert("store: empty → today 0", store.focusMinutesToday(NOW) === 0);
// --- one completed 30-minute session from 100s ago (today + week) ---
const s1 = store.startFocus(30, NOW - 100_000);
store.stopFocus("completed", NOW - 10_000);
const round1 = (n) => Math.round((Number(n) + Number.EPSILON) * 10) / 10;
assert("store: fresh session → today 1.5 (real elapsed)", round1(store.focusMinutesToday(NOW)) === 1.5);
assert("store: fresh session → week 1.5", round1(store.focusMinutesThisWeek(NOW)) === 1.5);
// --- cancelled sessions never count ---
store.startFocus(25, NOW - 8_000);
store.stopFocus("cancelled", NOW - 2_000);
assert("store: cancelled excluded", round1(store.focusMinutesToday(NOW)) === 1.5 && round1(store.focusMinutesThisWeek(NOW)) === 1.5);
// --- running sessions never count ---
store.startFocus(45, NOW - 1_000);
assert("store: running excluded", round1(store.focusMinutesToday(NOW)) === 1.5 && round1(store.focusMinutesThisWeek(NOW)) === 1.5);
store.stopFocus("cancelled", NOW); // close it out
// --- yesterday's completed session: week yes, today no ---
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes2.json"));
const s2 = store.startFocus(60, NOW - 30 * 3600_000); // started ~yesterday, ran the full 60 minutes
store.stopFocus("completed", NOW - 30 * 3600_000 + 60 * 60_000);
assert("store: yesterday in week bucket (real elapsed = 60 min run)", Math.round(store.focusMinutesThisWeek(NOW)) === 60);
assert("store: yesterday excluded from today", store.focusMinutesToday(NOW) === 0);
// --- just-past the 7-day cutoff excluded ---
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes3.json"));
store.startFocus(120, NOW - 7 * 86_400_000 - 60_000); // started 7d + 1min ago
store.stopFocus("completed", NOW - 7 * 86_400_000 + 120 * 60_000);
assert("store: session started just past 7d cutoff excluded", store.focusMinutesThisWeek(NOW) === 0);
// --- exactly at the cutoff included (started < cutoff is the filter) ---
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes4.json"));
store.startFocus(90, NOW - 7 * 86_400_000); // started exactly 7d ago, ran full 90
store.stopFocus("completed", NOW - 7 * 86_400_000 + 90 * 60_000);
assert("store: session started exactly 7d ago included", store.focusMinutesThisWeek(NOW) === 90);
// --- real-elapsed cap: stoppedAt-startedAt is never exceeded ---
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes5.json"));
store.startFocus(60, NOW - 200_000); // 60-min session actually ran ~3.3 min
store.stopFocus("completed", NOW - 2_000);
assert("store: real-elapsed capped at actual runtime", round1(store.focusMinutesThisWeek(NOW)) === 3.3 && round1(store.focusMinutesToday(NOW)) === 3.3);
// --- hour formatting in summaries ---
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes6.json"));
store.startFocus(150, NOW - 120_000);
store.stopFocus("completed", NOW - 2_000); // real elapsed ~2 min — actual runtime is what counts
assert("store: short real run caps minutes", round1(store.focusMinutesToday(NOW)) === 2 && round1(store.focusMinutesThisWeek(NOW)) === 2);

// ===========================================================================
// 4. focusStatsSummary wording
// ===========================================================================
const { focusStatsSummary } = require("./notes/dispatch-personal");
assert("unit: zero → honest empty plate (warm)", focusStatsSummary({ weekMin: 0, todayMin: 0, personality: "warm" }) === "No focus sessions recorded yet — say \"start focus mode\" whenever you're ready, and I'll start keeping score.");
assert("unit: zero concise", focusStatsSummary({ weekMin: 0, todayMin: 0, personality: "concise" }) === "No focus sessions recorded yet.");
assert("unit: zero professional", focusStatsSummary({ weekMin: 0, todayMin: 0, personality: "professional" }) === "Your focus log is empty — no sessions have been recorded yet.");
assert("unit: zero playful", focusStatsSummary({ weekMin: 0, todayMin: 0, personality: "playful" }) === "The cosmos hasn't seen a single focus session yet — start one and it'll remember!");
assert("unit: week-only → hours formatting", focusStatsSummary({ weekMin: 150, todayMin: 0, personality: "warm" }) === "You've focused for 2 hours 30 minutes this week. Nicely done.");
assert("unit: week-only concise", focusStatsSummary({ weekMin: 135, todayMin: 0, personality: "concise" }) === "2 hours 15 minutes of focus this week.");
assert("unit: today-only", focusStatsSummary({ weekMin: 0, todayMin: 45, personality: "warm" }) === "Today's total so far: 45 minutes — nothing else in the trailing 7 days.");
assert("unit: week+today", focusStatsSummary({ weekMin: 150, todayMin: 30, personality: "warm" }) === "This week you've focused for 2 hours 30 minutes in the last 7 days — 30 minutes of that today.");
assert("unit: week+today concise", focusStatsSummary({ weekMin: 150, todayMin: 30, personality: "concise" }) === "2 hours 30 minutes this week, 30 minutes today.");
// fractional minutes speak as whole minutes (rounding is the formatter's job)
assert("unit: fractional rounds down to minutes", focusStatsSummary({ weekMin: 2.3, todayMin: 0, personality: "warm" }) === "You've focused for 2 minutes this week. Nicely done.");

// ===========================================================================
// 5. Dispatcher wording (pinned clock through the plan seam)
// ===========================================================================
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes7.json"));
store.resetForTesting();
identity.set({ userName: "Alex", personality: "warm" });
// --- empty log ---
setPlanNow(new Date(NOW));
const e1 = await runNoteAction("my focus stats", { now: NOW });
setPlanNow(null);
assert("dispatch: empty log ok", e1.ok === true);
assert("dispatch: empty log wording", e1.text === "No focus sessions recorded yet — say \"start focus mode\" whenever you're ready, and I'll start keeping score.");
assert("dispatch: empty detail totals", e1.detail.weekMin === 0 && e1.detail.todayMin === 0);
assert("dispatch: empty narration check line", e1.narration === "Checking the focus log\u2026");
// --- populated log ---
store.startFocus(150, NOW - 120_000);
store.stopFocus("completed", NOW - 2_000);
setPlanNow(new Date(NOW));
const e2 = await runNoteAction("how much time did i focus this week", { now: NOW });
setPlanNow(null);
assert("dispatch: populated wording", e2.text === "This week you've focused for 2 minutes in the last 7 days — 2 minutes of that today.");
assert("dispatch: populated detail", Math.round(e2.detail.weekMin) === 2 && Math.round(e2.detail.todayMin) === 2);
assert("dispatch: populated narration", e2.narration === "Adding up your focus time — " + e2.text);
// --- zero-week, today-only ---
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes8.json"));
store.resetForTesting();
store.startFocus(30, NOW - 120_000);
store.stopFocus("completed", NOW - 2_000); // real elapsed ~2 min
setPlanNow(new Date(NOW));
const e3 = await runNoteAction("focus minutes today", { now: NOW });
setPlanNow(null);
assert("dispatch: today-only wording", e3.text === "This week you've focused for 2 minutes in the last 7 days — 2 minutes of that today.");
assert("dispatch: today-only route payload clock", Math.round(e3.detail.todayMin) === 2 && Math.round(e3.detail.weekMin) === 2);

// ===========================================================================
// 6. Additive guarantees
// ===========================================================================
userModels.resetForTesting();
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes9.json"));
store.resetForTesting();
assert("additive: no user facts written", userModels.list().length === 0);
assert("additive: identity untouched", identity.get().userName === "Alex" && identity.get().personality === "warm");
setPlanNow(new Date(NOW));
await runNoteAction("my focus stats", { now: NOW });
setPlanNow(null);
assert("additive: still no user facts after stats read", userModels.list().length === 0);

// ===========================================================================
// 7. Zero outbound
// ===========================================================================
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error("fetch must not be called"); };
try {
  setPlanNow(new Date(NOW));
  await runNoteAction("total focus time", { now: NOW });
  setPlanNow(null);
  assert("no-outbound: focus-stats route made zero network calls", calls === 0);
} finally {
  delete globalThis.fetch;
}
console.log("\nAll Round 32 focus-stats tests passed.");
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 1; });
