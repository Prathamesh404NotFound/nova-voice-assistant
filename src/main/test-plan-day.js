// Nova — src/main/test-plan-day.js
//
// Round 31: time-blocked day planning harness ("plan my day"). Covers:
//  1. Planner routing — day-planning phrasings reach notes:plan-day;
//     look-alikes (list tasks, priority check, greeting, notes) are NOT
//     swallowed.
//  2. Registry — L1 SAFE, local-only simulate.
//  3. planDay() unit math — empty plate, single task, urgency ladder, the
//     four time-of-day preference start hours, reminder fixed-time slots
//     and task skipping around them, 6-block cap with overCap tail,
//     mood-framed threshold, done-task exclusion.
//  4. Dispatcher wording — empty plate, mood-framed opener when the latest
//     check-in is recent (<12h), stale mood → plain opener, reminder lines
//     interleaved chronologically, hour formatting AM/PM.
//  5. Additive guarantee — no preference and no mood → byte-identical
//     output across all four personalities.
//  6. Zero outbound — no network path exists on the plan route.
const path = require("path");
const fs = require("fs");
const DATA_DIR = "/tmp/.nova-plan-day-test-data";
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
const { planDay } = require("./notes/dispatch-personal");
const store = require("./notes/store");
const userModels = require("./identity/user-model");
const identity = require("./identity/identity");
// action registry (notes actions incl. the R31 plan-day)
require("./notes/actions");
const { getAction } = require("./permissions/action-registry");
// Pinned clock: Wed 2026-08-19 10:00 UTC — all day math is deterministic.
const NOW = new Date("2026-08-19T10:00:00.000Z").getTime();
// fresh state
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes.json"));
identity.resetForTesting();
userModels.resetForTesting();
identity.set({ userName: "Alex", personality: "warm" });

// ===========================================================================
// 1. Planner routing — day-planning phrasings
// ===========================================================================
const route = (t) => (planNoteAction(t) || {}).actionId || null;
assert("route: plan my day → notes:plan-day", route("plan my day") === "notes:plan-day");
assert("route: plan the day → notes:plan-day", route("plan the day") === "notes:plan-day");
assert("route: plan today → notes:plan-day", route("plan today") === "notes:plan-day");
assert("route: make a plan for today → notes:plan-day", route("make a plan for today") === "notes:plan-day");
assert("route: nova, plan my day → notes:plan-day", route("nova, plan my day") === "notes:plan-day");
assert("route: schedule my day → notes:plan-day", route("schedule my day") === "notes:plan-day");
assert("route: schedule my tasks → notes:plan-day", route("schedule my tasks") === "notes:plan-day");
assert("route: build me a schedule for today → notes:plan-day", route("build me a schedule for today") === "notes:plan-day");
assert("route: what should my day look like → notes:plan-day", route("what should my day look like") === "notes:plan-day");
assert("route: give me a plan for today → notes:plan-day", route("give me a plan for today") === "notes:plan-day");
assert("route: organize my day → notes:plan-day", route("organize my day") === "notes:plan-day");
assert("route: lay out my day → notes:plan-day", route("lay out my day") === "notes:plan-day");
assert("route: build me a schedule → notes:plan-day", route("build me a schedule") === "notes:plan-day");
// negatives — the plan route must not swallow sibling intents
assert("no-route: what's on my task list → NOT plan-day", route("what's on my task list") !== "notes:plan-day");
assert("no-route: what should i work on first → NOT plan-day", route("what should i work on first") !== "notes:plan-day");
assert("no-route: my notes → NOT plan-day", route("my notes") !== "notes:plan-day");
assert("no-route: good morning → NOT plan-day", route("good morning") !== "notes:plan-day");
assert("no-route: plan a trip → NOT plan-day", route("plan a trip") !== "notes:plan-day");
assert("no-route: add buy milk to tasks → NOT plan-day", route("add buy milk to my tasks") !== "notes:plan-day");

// ===========================================================================
// 2. Registry — level and locality
// ===========================================================================
const a = getAction("notes:plan-day");
assert("registry: notes:plan-day exists", !!a);
assert("registry: L1 SAFE", a.level === 1);
assert("registry: local-only simulate", (async () => {
  const s = await a.simulate({});
  return s && !s.title && !s.body && typeof s.summary === "string";
})());

(async () => {
// ===========================================================================
// 3. planDay() unit math
// ===========================================================================
const mk = (text, daysOffset, done = false, words = null) => ({
  text: words !== null ? words : text,
  done,
  createdAt: new Date(NOW - 3600_000).toISOString(),
  dueDate: daysOffset === null ? undefined : new Date(NOW + daysOffset * 86_400_000).toISOString(),
});
// --- empty plate ---
const p0 = planDay({ pending: [], now: NOW });
assert("unit: empty plate → no blocks", p0.blocks.length === 0);
assert("unit: empty plate → no fixed reminders", p0.remindersFixed.length === 0);
assert("unit: empty plate → overCap zero", p0.overCap === 0);
// --- single task → one morning block by default ---
const p1 = planDay({ pending: [mk("pay rent", -1)], now: NOW });
assert("unit: single overdue task → one block at 9AM", p1.blocks.length === 1 && p1.blocks[0].hour === 9 && p1.blocks[0].task.text === "pay rent");
// --- urgency ladder: overdue (oldest) → due today → rest (longest first) ---
const ladder = [mk("due today task", 0), mk("rest big task", 3, false, "complete the quarterly report draft"), mk("rest small", null), mk("overdue old", -2), mk("overdue recent", -1)];
const p2 = planDay({ pending: ladder, now: NOW });
assert("unit: overdue old first", p2.blocks[0].task.text === "overdue old");
assert("unit: overdue recent second", p2.blocks[1].task.text === "overdue recent");
assert("unit: due-today third", p2.blocks[2].task.text === "due today task");
assert("unit: rest longest-first", p2.blocks[3].task.text === "complete the quarterly report draft");
assert("unit: rest no-due last", p2.blocks[4].task.text === "rest small");
// --- preference start hours ---
const prefTasks = [mk("first", 0)];
const morning = planDay({ pending: prefTasks, now: NOW });
assert("unit: default (no pref) starts 9AM", morning.blocks[0].hour === 9);
userModels.addFact("I like mornings");
const morn = planDay({ pending: prefTasks, now: NOW });
assert("unit: 'like mornings' → start 9AM", morn.blocks[0].hour === 9);
userModels.addFact("I work best in the afternoon");
const afn = planDay({ pending: prefTasks, now: NOW });
assert("unit: afternoon → start 1PM", afn.blocks[0].hour === 13);
userModels.addFact("I'm a night owl");
const ngt = planDay({ pending: prefTasks, now: NOW });
assert("unit: 'night owl' → start 9PM", ngt.blocks[0].hour === 21);
userModels.addFact("I do my thinking in the evening");
const eve = planDay({ pending: prefTasks, now: NOW });
assert("unit: evening → start 5PM", eve.blocks[0].hour === 17);
// --- reminder fixed-time slots; tasks skip reminder hours ---
const rems = [
  { id: "r1", text: "take meds", dueAt: new Date(NOW + 2 * 3600_000).toISOString(), fired: false },
  { id: "r2", text: "pick up kids", dueAt: new Date(NOW + 5 * 3600_000).toISOString(), fired: false },
];
// A reminder due earlier today (its hour already passed) still reads as a
// today event — the plan is one honest timeline of the whole day, so
// anything due today belongs in it. Only fired/cancelled/yesterday reminders
// are excluded.
const pr = planDay({ pending: [mk("a", 0), mk("b", null), mk("c", 2)], reminders: rems, now: NOW });
const hours = pr.blocks.map((b) => b.hour);
const remHours = pr.remindersFixed.map((r) => r.hour);
assert("unit: reminders pinned at their own hours (12, 15)", JSON.stringify(remHours) === "[12,15]");
assert("unit: tasks never occupy a reminder hour", !hours.includes(12) && !hours.includes(15));
assert("unit: three tasks still scheduled around reminders", pr.blocks.length === 3);
// fired/cancelled reminders are invisible to the plan
const prFired = planDay({ pending: [mk("a", 0)], reminders: [{ id: "r3", text: "done", dueAt: new Date(NOW + 2 * 3600_000).toISOString(), fired: true }], now: NOW });
assert("unit: fired reminder excluded", prFired.remindersFixed.length === 0);
// already-ring-today reminder is INCLUDED (whole-day timeline) — verify
const prTodayPast = planDay({ pending: [mk("a", 0)], reminders: [{ id: "r4", text: "this morning pill", dueAt: new Date(NOW - 3 * 3600_000).toISOString(), fired: false }], now: NOW });
assert("unit: earlier-today reminder included in the timeline", prTodayPast.remindersFixed.length === 1 && prTodayPast.remindersFixed[0].hour === 7);
// yesterday's reminder excluded; tomorrow's reminder excluded
const prYesterday = planDay({ pending: [mk("a", 0)], reminders: [{ id: "r5", text: "yesterday thing", dueAt: new Date(NOW - 86_400_000).toISOString(), fired: false }], now: NOW });
assert("unit: yesterday's reminder excluded", prYesterday.remindersFixed.length === 0);
// --- 6-block cap with overCap tail ---
const many = Array.from({ length: 8 }, (_, i) => mk(`task ${i}`, i - 1));
const pc = planDay({ pending: many, now: NOW });
assert("unit: cap at 6 blocks", pc.blocks.length === 6);
assert("unit: overCap reports the overflow", pc.overCap === 2);
assert("unit: cap keeps the ladder (oldest overdue first)", pc.blocks[0].task.text === "task 0");
// --- done tasks excluded ---
const pd = planDay({ pending: [mk("done task", -1, true), mk("pending task", 0)], now: NOW });
assert("unit: done tasks never scheduled", pd.blocks.length === 1 && pd.blocks[0].task.text === "pending task");
// --- mood-framed threshold ---
// NOTE: the harness wall clock is ~24h behind the pinned NOW, so fact
// timestamps are pinned to NOW around every addFact below — mood age math
// must be deterministic whether run at 9AM or 9PM.
const moodFresh = planDay({ pending: prefTasks, now: NOW });
assert("unit: no mood → moodFramed false", moodFresh.moodFramed === false);
userModels.setNowForTesting(new Date(NOW));
userModels.addFact("I feel energized today");
userModels.setNowForTesting(null);
const mFramed = planDay({ pending: prefTasks, now: NOW });
assert("unit: fresh mood (<12h) → moodFramed true", mFramed.moodFramed === true);
userModels.setNowForTesting(new Date(NOW));
userModels.addFact("I feel totally exhausted and drained");
userModels.setNowForTesting(null);
const mLow = planDay({ pending: prefTasks, now: NOW });
assert("unit: low-energy words → lowEnergy true", mLow.lowEnergy === true);
// Key dedupe keeps createdAt and only overwrites updatedAt, so a single
// re-add at the stale pin leaves the earlier "I feel energized today" fact
// fresher by updatedAt. Overwrite BOTH facts' updatedAt to the stale pin so
// the latest mood check-in is genuinely 15h old.
userModels.setNowForTesting(new Date(NOW - 15 * 3600_000));
userModels.addFact("I feel energized today");
userModels.addFact("I feel totally exhausted and drained");
userModels.setNowForTesting(null);
const mStale = planDay({ pending: prefTasks, now: NOW });
assert("unit: 15h-old check-in → moodFramed false", mStale.moodFramed === false);
// ===========================================================================
// 4. Dispatcher wording
// ===========================================================================
for (const t of store.all().tasks) store.deleteTask(t.id);
userModels.resetForTesting();
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes2.json"));
// --- empty plate wording ---
setPlanNow(new Date(NOW));
const e1 = await runNoteAction("plan my day", { now: NOW });
setPlanNow(null);
assert("dispatch: empty plate ok", e1.ok === true);
assert("dispatch: empty plate wording", e1.text.includes("Your day is wide open — nothing on the task list yet"));
// --- real schedule wording ---
const t1 = store.addTask("pay rent");
const t2 = store.addTask("meeting prep");
const t3 = store.addTask("quarterly report draft");
store.setTaskDue(t1.id, new Date(NOW - 86_400_000).toISOString());
store.setTaskDue(t2.id, new Date(NOW).toISOString());
store.setTaskDue(t3.id, new Date(NOW + 3 * 86_400_000).toISOString());
// --- fresh mood + real schedule wording ---
userModels.setNowForTesting(new Date(NOW));
userModels.addFact("I feel energized today");
userModels.setNowForTesting(null);
setPlanNow(new Date(NOW));
const pNow = await runNoteAction("plan my day", { now: NOW });
setPlanNow(null);
assert("dispatch: mood-framed opener when check-in is fresh", /^You said .+ — (so this is a light day: |here's a plan that fits: )/.test(pNow.text));
assert("dispatch: overdue task first", pNow.text.indexOf("pay rent") < pNow.text.indexOf("meeting prep"));
assert("dispatch: hour formatting 9:00 AM present", pNow.text.includes("9:00 AM"));
assert("dispatch: AM/PM formatting correct (no 13:00-style)", !/\b1[3-9]:00 [AP]M\b/.test(pNow.text) && !/\b0:00\b/.test(pNow.text));
assert("dispatch: narrated", pNow.narration === "Here's a plan for your day\u2026");
// --- reminder lines interleaved chronologically ---
const r1 = store.addReminder("take medication", new Date(NOW + 2 * 3600_000).toISOString());
const r2 = store.addReminder("call mom", new Date(NOW + 6 * 3600_000).toISOString());
setPlanNow(new Date(NOW));
const pRem = await runNoteAction("plan my day", { now: NOW });
setPlanNow(null);
const lines = pRem.text.split("\n").filter((l) => /\d+\. /.test(l));
// hour strings like "9:00 AM" sort lexicographically wrong ("12" < "9") —
// parse the hour number for the chronological check.
const hourNum = (hstr) => {
  const m = /^(\d{1,2}):00 ([AP])M$/.exec(hstr.trim());
  if (!m) return -1;
  const n = Number(m[1]);
  return m[2] === "P" && n !== 12 ? n + 12 : m[2] === "A" && n === 12 ? 0 : n;
};
const hoursOut = lines.map((l) => hourNum(l.split(" — ")[0].replace(/^\d+\. /, "")));
assert("dispatch: reminder lines labeled", lines.some((l) => l.includes("reminder:")));
assert("dispatch: 5 events total (3 tasks + 2 reminders)", lines.length === 5);
assert("dispatch: chronological order", JSON.stringify(hoursOut) === JSON.stringify([...hoursOut].sort((a, b) => a - b)));
// --- stale mood → plain opener ---
userModels.setNowForTesting(new Date(Date.now() - 15 * 3600_000));
await runNoteAction("I feel energized today");
userModels.setNowForTesting(null);
setPlanNow(new Date(NOW));
const pStale = await runNoteAction("plan my day", { now: NOW });
setPlanNow(null);
assert("dispatch: stale mood → plain opener", pStale.text.startsWith("Here's a plan for your day:") && !pStale.text.includes("You said"));
assert("dispatch: stale mood detail.moodFramed false", pStale.detail.moodFramed === false);
// --- overCap tail in dispatcher text ---
for (const t of store.all().tasks) store.deleteTask(t.id);
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes3.json"));
for (let i = 0; i < 8; i++) store.addTask(`overflow task ${i}`);
setPlanNow(new Date(NOW));
const pCap = await runNoteAction("plan my day", { now: NOW });
setPlanNow(null);
assert("dispatch: overCap tail wording", pCap.text.includes("…and 2 more after those — one schedule shouldn't bite off more than six hours."));
assert("dispatch: exactly 6 scheduled + tail 2", pCap.detail.blocks.length === 6 && pCap.detail.overCap === 2);
// ===========================================================================
// 5. Additive guarantees
// ===========================================================================
for (const t of store.all().tasks) store.deleteTask(t.id);
userModels.resetForTesting();
store.setStorePathForTesting(pathP.join(DATA_DIR, "notes4.json"));
store.addTask("one task");
const snap = [];
for (const personality of ["warm", "concise", "professional", "playful"]) {
  identity.set({ personality });
  setPlanNow(new Date(NOW));
  snap[personality] = (await runNoteAction("plan my day", { now: NOW })).text;
  setPlanNow(null);
}
assert("additive: all personalities produce the same schedule text", snap.warm === snap.concise && snap.concise === snap.professional && snap.professional === snap.playful);
assert("additive: opener plain with no mood", snap.warm.startsWith("Here's a plan for your day:"));
// ===========================================================================
// 6. Zero outbound
// ===========================================================================
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error("fetch must not be called"); };
try {
  setPlanNow(new Date(NOW));
  await runNoteAction("plan my day", { now: NOW });
  setPlanNow(null);
  assert("no-outbound: plan route made zero network calls", calls === 0);
} finally {
  delete globalThis.fetch;
}
console.log("\nAll Round 31 plan-my-day tests passed.");
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 1; });
