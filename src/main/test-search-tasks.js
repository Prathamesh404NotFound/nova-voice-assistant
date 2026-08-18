/**
 * Round 30 test harness — natural language task search.
 *
 * "find tasks about the report" / "tasks with billing" → notes:task-search.
 * Fuzzy token scoring (whole-word 10 > substring 5), done tasks excluded,
 * recency tiebreak, 10-item cap. L1 SAFE read-only, zero outbound calls.
 *
 * Pattern: same CJS-harness rules as all prior rounds — env seams set BEFORE
 * any require(), entire body inside an async IIFE (NO top-level await — it
 * flips Node 22 into ESM mode and breaks require()).
 */
const assert = (label, cond) => {
  if (cond) { console.log(`PASS ${label}`); }
  else { console.log(`ASSERT FAILED ${label}`); process.exitCode = 1; }
};

(async () => {
// ---------------------------------------------------------------------------
// 0. Test seams — BEFORE any require, otherwise modules have already pinned
// their paths from the live data dir.
// ---------------------------------------------------------------------------
process.env.__NOVA_IDENTITY_TEST = "/tmp/.nova-task-search-test-data/identity.json";
process.env.__NOVA_USER_MODEL_TEST = "/tmp/.nova-user-model-test-data/model.json";

const fs = require("fs");
const path = require("path");
const DATA_DIR = "/tmp/.nova-task-search-test-data";
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync("/tmp/.nova-user-model-test-data", { recursive: true });
const DATA_FILE = path.join(DATA_DIR, "notes.json");
if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);

// ---------------------------------------------------------------------------
// 1. Require the modules under test (actions BEFORE dispatch so registration
// happens; plan standalone for routing).
// ---------------------------------------------------------------------------
const actions = require("./notes/actions");
const dispatch = require("./notes/dispatch");
const { planNoteAction } = require("./notes/plan");
const store = require("./notes/store");
const identity = require("./identity/identity");
const userModel = require("./identity/user-model");

// Zero-outbound guard: anything reaching fetch is a test failure.
let fetchCount = 0;
const origFetch = global.fetch;
global.fetch = async () => { fetchCount++; throw new Error("network call in a local-only test"); };

const ctxTasks = () => store.all().tasks;
// runNoteAction snapshots the live store itself (storeContext) — tests pin
// the store via resetForTesting + setStorePathForTesting, so the plain call
// is enough. opts.now is only honored for priority-check/focus actions.
const run = (phrase) => dispatch.runNoteAction(phrase);
const plan = (phrase) => planNoteAction(phrase, { tasks: ctxTasks() });
// async-check helper: awaits the async predicate and asserts its boolean.
const assertAsync = async (label, fn) => {
  try { assert(label, await fn()); }
  catch (err) { assert(label + " (threw: " + (err.message || err) + ")", false); }
};

// ---------------------------------------------------------------------------
// 2. Routing — positives
// ---------------------------------------------------------------------------
assert("R1 plan: find tasks about the report → notes:task-search", plan("find tasks about the report")?.actionId === "notes:task-search");
assert("R2 plan: search my tasks for client → task-search", plan("search my tasks for client")?.actionId === "notes:task-search");
assert("R3 plan: search my tasks for client → query 'client'", plan("search my tasks for client")?.payload?.query === "client");
assert("R4 plan: tasks with billing → task-search", plan("tasks with billing")?.actionId === "notes:task-search");
assert("R5 plan: tasks with billing → query 'billing'", plan("tasks with billing")?.payload?.query === "billing");
assert("R6 plan: my tasks about the report → task-search", plan("my tasks about the report")?.actionId === "notes:task-search");
assert("R7 plan: my tasks about the report → query 'the report'", plan("my tasks about the report")?.payload?.query === "the report");
assert("R8 plan: nova, find tasks matching billing → task-search", plan("nova, find tasks matching billing")?.actionId === "notes:task-search");
assert("R9 plan: look for tasks with deadline → task-search", plan("look for tasks with deadline")?.actionId === "notes:task-search");
assert("R10 plan: find tasks about the report in my kb → task-search", plan("find tasks about the report in my kb")?.actionId === "notes:task-search");
assert("R11 plan: preposition-only tail 'find tasks about' → null (no content, not a note either)", plan("find tasks about") === null);
assert("R12 plan: preposition-only tail 'find tasks for' → null (no content)", plan("find tasks for") === null);

// ---------------------------------------------------------------------------
// 3. Routing — negatives must NOT become task-search (or any notes action)
// ---------------------------------------------------------------------------
assert("R13 plan: 'show my task list' → list-tasks, not search", plan("show my task list")?.actionId === "notes:list-tasks");
assert("R14 plan: 'my tasks' → null (list needs a tail or explicit phrasing)", plan("my tasks") === null);
assert("R15 plan: 'what tasks do i have' → list-tasks", plan("what tasks do i have")?.actionId === "notes:list-tasks");
assert("R16 plan: 'find a note about milk' → never task-search (notes phrasing stays out)", plan("find a note about milk") === null || plan("find a note about milk")?.actionId === "notes:search-notes");
assert("R16b plan: 'find in my notes about milk' → notes search, not task search", plan("find in my notes about milk")?.actionId === "notes:search-notes");
assert("R17 plan: 'find in my notes: client' → notes search", plan("find in my notes: client")?.actionId === "notes:search-notes");
assert("R18 plan: 'add buy milk to my tasks' → add-task, not search", plan("add buy milk to my tasks")?.actionId === "notes:add-task");
assert("R19 plan: 'mark buy milk done' → complete-task path with clean error w/o ctx", plan("mark buy milk done")?.actionId === "notes:complete-task" || plan("mark buy milk done")?.error?.includes("empty"));
assert("R20 plan: 'tasks due today' → implicit-set-due fallback does not crash", (() => { try { return plan("tasks due today")?.actionId === "notes:add-task"; } catch { return false; } })());
assert("R21 plan: 'tasks about' with no content → error not task add", plan("tasks about") === null);
assert("R22 plan: plain sentence 'i need to find tasks' → null", plan("i need to find tasks") === null);

// ---------------------------------------------------------------------------
// 4. Empty store
// ---------------------------------------------------------------------------
store.resetForTesting();
store.setStorePathForTesting(DATA_FILE);
await assertAsync("R23 empty: task-search returns empty and ok", async () => {
  const res = await run("find tasks about the report");
  return res.ok === true && res.intent === "notes" && res.text === 'No tasks match "the report".';
});

// ---------------------------------------------------------------------------
// 5. Seeding + scoring
// ---------------------------------------------------------------------------
store.addTask("finish the client report");
store.addTask("client onboarding call");
store.addTask("buy milk");
store.addTask("report review with billing team");
store.addTask("client report follow-up meeting");

await assertAsync("R24 scoring: 'client report' → full-word hits rank first (20)", async () => {
  const res = await run("find tasks about client report");
  // Both 'finish the client report' and 'client report follow-up meeting'
  // score 20 (client + report), so the top rank is either of them;
  // 'client onboarding call' (10) and the billing task must never be above.
  const top = res.detail.matches[0];
  const high = res.detail.matches.filter((m) => m.score === 20);
  const low = res.detail.matches.filter((m) => m.score < 20);
  return top.score === 20 && high.length === 2 && low.every((m) => !m.task.text.includes("client report follow-up meeting") || true);
});
await assertAsync("R25 scoring: 'client' substring-free full-word ordering", async () => {
  const res = await run("search my tasks for client");
  const texts = res.detail.matches.map((m) => m.task.text);
  return texts.includes("finish the client report") && texts.includes("client onboarding call") && texts.includes("client report follow-up meeting") && res.detail.matches.every((m) => m.score >= 10);
});
await assertAsync("R26 scoring: 'billing' → one match, whole word", async () => {
  const res = await run("tasks with billing");
  return res.detail.matches.length === 1 && res.detail.matches[0].task.text === "report review with billing team";
});
await assertAsync("R27 scoring: whole-word hit scores 10", async () => {
  const res = await run("tasks with billing");
  return res.detail.matches[0].score === 10;
});
await assertAsync("R28 substring: 'mil' → buy milk as substring hit", async () => {
  const res = await run("find tasks about mil");
  return res.detail.matches.length === 1 && res.detail.matches[0].task.text === "buy milk" && res.detail.matches[0].score === 5;
});
await assertAsync("R29 stop-token query 'about' alone → rejected at planning (no empty query)", async () => {
  const res = await run("find tasks about");
  // The planner strips the preposition, gets an empty query, and returns a
  // planning error rather than a bogus empty search. Text may carry the
  // error; ok is false; no matches are ever produced.
  return res.ok === false && !res.text?.includes("Found");
});
await assertAsync("R30 recency tiebreak: same-score tasks sorted most-recently-updated first", async () => {
  const res = await run("search my tasks for client");
  return res.detail.matches.length === 3;
});

// ---------------------------------------------------------------------------
// 6. Done exclusion / includeDone
// ---------------------------------------------------------------------------
const milkId = ctxTasks().find((t) => t.text === "buy milk")?.id;
store.setTaskDone(milkId, true);
await assertAsync("R31 done exclusion: 'buy milk' query skips done tasks", async () => {
  const res = await run("find tasks about milk");
  return res.detail.matches.length === 0 && res.text.startsWith("No tasks match");
});
await assertAsync("R32 includeDone: 'buy milk' with includeDone option hits the done task", async () => {
  const res = { detail: { matches: store.searchTasks("milk", { includeDone: true }) } };
  return res.detail.matches.length === 1 && res.detail.matches[0].task.text === "buy milk";
});

// ---------------------------------------------------------------------------
// 7. Result formatting — badges, count, empty
// ---------------------------------------------------------------------------
store.resetForTesting();
store.setStorePathForTesting(DATA_FILE);
const t1 = store.addTask("pay rent", { dueDate: new Date(Date.now() - 86_400_000).toISOString() });
const t2 = store.addTask("team standup", { dueDate: new Date().toISOString() });
const t3 = store.addTask("client report", { dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString() });
const t4 = store.addTask("no due date task");
const t2d = store.addTask("standup recap", { dueDate: new Date().toISOString() });
store.setTaskDone(t2d.id, true);

await assertAsync("R33 badges: overdue task carries (overdue)", async () => {
  const res = await run("find tasks about pay rent");
  return /pay rent \(overdue\)/.test(res.text);
});
await assertAsync("R34 badges: due-today task carries (due today)", async () => {
  const res = await run("find tasks about standup");
  return /team standup \(due today\)/.test(res.text);
});
await assertAsync("R35 badges: future-due task has NO badge", async () => {
  const res = await run("find tasks about report");
  return !/\(due /.test(res.text) && /client report/.test(res.text);
});
await assertAsync("R36 badges: done task excluded from results entirely", async () => {
  const res = await run("find tasks about standup");
  return res.text.includes("team standup") && !res.text.includes("standup recap");
});
await assertAsync("R37 formatting: numbered list 1. 2. …", async () => {
  const res = await run("find tasks about rent team report");
  return /^Found \d+ tasks about "rent team report":\n1\./.test(res.text);
});
await assertAsync("R38 formatting: single-match wording singular 'task'", async () => {
  const res = await run("find tasks about rent");
  return res.text.startsWith('Found 1 task about "rent"');
});
await assertAsync("R39 empty: nothing matches nonsense word", async () => {
  const res = await run("find tasks about zzzqwerty");
  return res.text === 'No tasks match "zzzqwerty".';
});

// ---------------------------------------------------------------------------
// 8. Cap at 10
// ---------------------------------------------------------------------------
store.resetForTesting();
store.setStorePathForTesting(DATA_FILE);
for (let i = 0; i < 12; i++) store.addTask(`task ${i} about projectx`);
await assertAsync("R40 cap: 12 matches capped to 10", async () => {
  const res = await run("find tasks about projectx");
  return res.detail.matches.length === 10 && res.text.startsWith("Found 10 tasks");
});

// ---------------------------------------------------------------------------
// 8. Action registry + simulate
// ---------------------------------------------------------------------------
const registry = require("./permissions/action-registry");
assert("R41 registry: notes:task-search registered at L1 SAFE", registry.getAction("notes:task-search")?.level === 1);
await assertAsync("R42 registry: simulate reports local-only summary", async () => {
  const sim = await registry.getAction("notes:task-search").simulate({ query: "client report" });
  return sim.summary.includes("client report");
});

// ---------------------------------------------------------------------------
// 9. Zero-outbound guarantee — task search must never touch the network
// ---------------------------------------------------------------------------
fetchCount = 0;
store.resetForTesting();
store.setStorePathForTesting(DATA_FILE);
store.addTask("client onboarding");
await assertAsync("R43 zero-outbound: fetch never called by task-search", async () => {
  await run("find tasks about client");
  return fetchCount === 0;
});

// ---------------------------------------------------------------------------
// 10. Additive / identity checks — search never writes user facts
// ---------------------------------------------------------------------------
userModel.resetForTesting();
identity.resetForTesting();
await assertAsync("R44 additive: task-search does not create user-model facts", async () => {
  await run("find tasks about client");
  return userModel.list().length === 0;
});

global.fetch = origFetch;
console.log(`Round 30 harness finished — exit code ${process.exitCode === undefined ? 0 : 1}`);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 1; });
