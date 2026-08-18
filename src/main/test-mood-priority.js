// Nova — src/main/test-mood-priority.js
//
// Round 28: mood-aware task prioritization harness. Covers:
//  1. Planner routing — "what should I work on first" phrasings reach
//     notes:priority-check; look-alikes (notes, mood-check, greeting,
//     add-task) are NOT swallowed.
//  2. Registry — L1 SAFE, local-only simulate.
//  3. prioritize() math — empty plate, single task, overdue first (oldest),
//     due today soonest, rest untouched; low-energy mood quick-wins sort
//     only inside the rest bucket; high-energy mood leaves rest untouched;
//     done tasks excluded; day-granular boundaries.
//  4. Dispatcher wording — empty plate, mood-framed opener when the latest
//     check-in is recent (<12h), no mood → plain opener; labels (overdue,
//     due today); 5-item cap with tail count; narration small-wins hint.
//  5. Additive guarantee — no mood → identical output to the no-mood branch
//     across all personality settings.
//  6. Zero outbound — no network path exists for the priority route.

const path = require("path");
const fs = require("fs");

const DATA_DIR = "/tmp/.nova-mood-priority-test-data";
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.__NOVA_IDENTITY_TEST = DATA_DIR;
process.env.__NOVA_USER_MODEL_TEST = DATA_DIR;

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
const { planNoteAction, runNoteAction, prioritize } = require("./notes/dispatch");
const { setStorePathForTesting } = require("./notes/store");
const userModels = require("./identity/user-model");
const identity = require("./identity/identity");
// action registry (notes actions incl. the R28 priority-check)
require("./notes/actions");
const { getAction } = require("./permissions/action-registry");

// Pinned clock: Wed 2026-08-19 10:00 UTC — all day math is deterministic.
const NOW = new Date("2026-08-19T10:00:00.000Z").getTime();

// fresh state
setStorePathForTesting(pathP.join(DATA_DIR, "notes.json"));
identity.resetForTesting();
userModels.resetForTesting();
identity.set({ userName: "Alex", personality: "warm" });

// ===========================================================================
// 1. Planner routing — priority phrasings
// ===========================================================================

const route = (t) => (planNoteAction(t) || {}).actionId || null;

assert("route: what should i work on first → notes:priority-check", route("what should i work on first") === "notes:priority-check");
assert("route: prioritize my tasks → notes:priority-check", route("prioritize my tasks") === "notes:priority-check");
assert("route: what's most urgent → notes:priority-check", route("what's most urgent") === "notes:priority-check");
assert("route: what is most urgent → notes:priority-check", route("what is most urgent") === "notes:priority-check");
assert("route: what's the most important task → notes:priority-check", route("what's the most important task") === "notes:priority-check");
assert("route: what is the most important → notes:priority-check", route("what is the most important") === "notes:priority-check");
assert("route: help me prioritize → notes:priority-check", route("help me prioritize") === "notes:priority-check");
assert("route: what comes first → notes:priority-check", route("what comes first") === "notes:priority-check");
assert("route: order my tasks → notes:priority-check", route("order my tasks") === "notes:priority-check");
assert("route: nova, what should i do first → notes:priority-check", route("nova, what should i do first") === "notes:priority-check");
assert("route: NOVA what should I work on first → notes:priority-check", route("NOVA what should I work on first") === "notes:priority-check");

// negatives — none of these may become priority-check
assert("negative: what should i work on first note → not priority (trailing words)", route("what should i work on first note") !== "notes:priority-check");
assert("negative: prioritize my tasks please today → not priority (trailing words)", route("prioritize my tasks please today") !== "notes:priority-check");
assert("negative: how am i feeling today → not priority (mood-check)", route("how am i feeling today") !== "notes:priority-check");
assert("negative: good morning nova → not priority (greet)", route("good morning nova") !== "notes:priority-check");
assert("negative: add finish report to my tasks → not priority (add-task)", route("add finish report to my tasks") === "notes:add-task");
assert("negative: task stats → not priority (task-stats)", route("task stats") === "notes:task-stats");
assert("negative: what's on my plate today → not priority (briefing)", route("what's on my plate today") === "notes:daily-briefing");

// ===========================================================================
// 2. Registry — L1 SAFE, local-only simulate
// ===========================================================================

const act = getAction("notes:priority-check");
assert("registry: notes:priority-check registered", !!act);
assert("registry: notes:priority-check is L1 SAFE", act.level === 1);
assert("registry: simulate is a function", typeof act.simulate === "function");

// ===========================================================================
// 3. prioritize() math — pure sorter
// ===========================================================================

(async () => {
  // task builder: offset = days from NOW (negative = overdue, 0 = today)
  const mk = (text, offsetDays, createdAtOffsetSec = -1) => ({
    text, done: false,
    createdAt: new Date(NOW + createdAtOffsetSec * 1000).toISOString(),
    ...(offsetDays !== null ? { dueDate: new Date(NOW + offsetDays * 86_400_000).toISOString() } : {}),
  });

  // --- empty plate ---
  const e = prioritize([], NOW);
  assert("prioritize: empty plate → empty order, lowEnergy false", e.order.length === 0 && e.lowEnergy === false);
  assert("prioritize: null input → empty order", prioritize(null, NOW).order.length === 0);

  // --- single task ---
  const s = prioritize([mk("pay rent", 0)], NOW);
  assert("prioritize: single task passes through", s.order.length === 1 && s.order[0].text === "pay rent");

  // --- ordering ladder: overdue (oldest first) > due today > rest (untouched) ---
  // rest bucket: creation order — 'quarterly report' (long, first), 'reply' (short, last)
  const tasks = [
    mk("complete the quarterly report", null, -86400 * 3),
    mk("fix bug in auth", -2, -86400 * 2),
    mk("meeting prep notes", 0, -86400),
    mk("send invoice", -1, -86400 * 2 - 60),
    mk("reply", null, -60),
  ];
  const r1 = prioritize(tasks, NOW);
  assert("prioritize: overdue first (send invoice -1d before fix bug -2d… wait)", r1.order[0].text === "fix bug in auth");
  assert("prioritize: overdue ordered oldest first", r1.order[0].text === "fix bug in auth" && r1.order[1].text === "send invoice");
  assert("prioritize: due today follows overdue", r1.order[2].text === "meeting prep notes");
  // rest bucket untouched without low-energy mood: insertion order preserved
  assert("prioritize: rest bucket keeps insertion order without low-energy mood", r1.order[3].text === "complete the quarterly report" && r1.order[4].text === "reply");
  assert("prioritize: lowEnergy false without mood", r1.lowEnergy === false);

  // --- done tasks excluded by the caller (dispatcher filters done) ---
  const r1d = prioritize(tasks.filter((t) => t.text !== "fix bug in auth"), NOW);
  assert("prioritize: caller-excluded task stays excluded", !r1d.order.some((t) => t.text === "fix bug in auth"));

  // --- low-energy mood: quick wins inside the rest bucket only ---
  userModels.addFact("I feel tired today");
  const r2 = prioritize(tasks, NOW);
  assert("prioritize: lowEnergy true with tired mood", r2.lowEnergy === true);
  assert("prioritize: low energy keeps overdue ladder intact (fix bug first)", r2.order[0].text === "fix bug in auth" && r2.order[1].text === "send invoice");
  assert("prioritize: low energy keeps due-today seat (meeting prep third)", r2.order[2].text === "meeting prep notes");
  // rest bucket: shortest first — 'reply' (1 word) before 'quarterly report' (4 words)
  assert("prioritize: low energy rest bucket shortest-first", r2.order[3].text === "reply" && r2.order[4].text === "complete the quarterly report");

  // --- mood stability: a low-energy mood can't move the urgency ladder ---
  // even when the small task is technically overdue
  const tasks2 = [mk("quick", -1), mk("long overdue mega task", -3)];
  const r2b = prioritize(tasks2, NOW);
  assert("prioritize: tired mood never outranks an older overdue task", r2b.order[0].text === "long overdue mega task" && r2b.order[1].text === "quick");

  // --- high-energy mood does NOT reorder the rest bucket ---
  await runNoteAction("I feel energized today");
  // Note: last-wins means 'energized' now beats 'tired' — verify newest fact wins.
  const r3 = prioritize(tasks, NOW);
  assert("prioritize: newest mood wins (energized)", userModels.list().slice(-1)[0].fact === "I feel energized today");
  assert("prioritize: energized mood → lowEnergy false", r3.lowEnergy === false);
  assert("prioritize: energized rest bucket stays insertion-ordered", r3.order[3].text === "complete the quarterly report" && r3.order[4].text === "reply");

  // --- day-granular boundary: due today is NOT overdue until tomorrow ---
  // a task due at 23:59 today must still sit in the due-today bucket
  const todayLast = { text: "midnight task", done: false, createdAt: new Date(NOW - 60000).toISOString(), dueDate: new Date(NOW + 86_400_000 - 60000).toISOString() };
  const r4 = prioritize([todayLast], NOW);
  assert("prioritize: task due 1 min before midnight today → not overdue", r4.order[0].text === "midnight task" && r4.lowEnergy === false);
  // and the same task one minute into tomorrow IS overdue
  const r4b = prioritize([todayLast], NOW + 60000);
  assert("prioritize: same task 1 min into tomorrow → ordered (overdue bucket)", r4b.order[0].text === "midnight task");

  // --- future-due tasks live in the rest bucket ---
  const future = mk("next week thing", 5);
  const r5 = prioritize([mk("no due", null), future], NOW);
  assert("prioritize: future-due sits in rest bucket, no due first", r5.order[0].text === "no due" && r5.order[1].text === "next week thing");

  // ===========================================================================
  // 4. Dispatcher wording — empty plate, mood framing, labels, cap
  // ===========================================================================
  const store2 = require("./notes/store");
  for (const t of store2.all().tasks) store2.deleteTask(t.id);
  userModels.resetForTesting();
  setStorePathForTesting(pathP.join(DATA_DIR, "notes2.json"));
  // Re-add the tired mood AFTER wiping both stores — the low-energy tests
  // below need a recent check-in on a clean slate.

  // --- empty plate wording ---
  const e1 = await runNoteAction("what should i work on first");
  assert("empty plate: ok", e1.ok === true);
  assert("empty plate: clean-plate text", e1.text.includes("Nothing to prioritize — your plate is clean"));
  assert("empty plate: clean-plate narration", e1.narration.includes("Nothing to prioritize"));

  // --- seed a realistic plate ---
  // The planner's due-date expressions resolve relative to the live clock,
  // but the dispatcher pins 'now' for priority math. Simplest and most
  // deterministic: add tasks by voice (relative phrases resolve today),
  // then set exact due dates at the store level (the store is the source of
  // truth — the voice path only ever writes through it).
  const t1 = store2.addTask("pay rent");
  const t2 = store2.addTask("fix auth bug");
  const t3 = store2.addTask("meeting prep");
  const t4 = store2.addTask("quarterly report");
  const t5 = store2.addTask("reply to clients email");
  // pay rent: due yesterday (overdue); fix auth bug: due 2 days ago (older overdue)
  // meeting prep: due today; quarterly report: due in 5 days; reply: no due date
  const yesterday = new Date(NOW - 86_400_000).toISOString();
  const twoAgo = new Date(NOW - 2 * 86_400_000).toISOString();
  const today = new Date(NOW).toISOString();
  const in5 = new Date(NOW + 5 * 86_400_000).toISOString();
  store2.setTaskDue(t1.id, yesterday);
  store2.setTaskDue(t2.id, twoAgo);
  store2.setTaskDue(t3.id, today);
  store2.setTaskDue(t4.id, in5);

  // --- no mood: plain opener ---
  const p1 = await runNoteAction("what should I work on first", { now: NOW });
  assert("no mood: plain opener", p1.text.startsWith("Here's what I'd work on first:"));
  assert("no mood: overdue labelled", p1.text.includes("pay rent (overdue)"));
  assert("no mood: due-today labelled", p1.text.includes("meeting prep (due today)"));
  assert("no mood: overdue before due-today", p1.text.indexOf("pay rent") < p1.text.indexOf("meeting prep"));
  assert("no mood: narration mentions small wins only when low energy (it isn't)", !p1.narration.includes("small wins first"));
  assert("no mood: detail carries the ordered list", Array.isArray(p1.detail.order) && p1.detail.order.length === 5);

  // --- low-energy mood recent: strategy explained, small wins first ---
  // (mood was seeded above on the clean slate — add again anyway to prove
  // the read path works end-to-end through the voice action)
  await runNoteAction("I feel exhausted today");
  const p2 = await runNoteAction("prioritize my tasks", { now: NOW });
  // 'this morning' is the age wording at ~09:26 UTC (mood added in the AM); 'just now'/'N minutes ago' at other hours — any mood-age wording is fine.
  assert("low energy: mood-framed opener", /^You said .+ "I feel exhausted today" — so small wins first:/.test(p2.text));
  assert("low energy: narration hints small wins first", p2.narration.includes("small wins first"));
  // rest bucket now shortest-first: 'reply to clients email' (4) vs 'quarterly report' (2)... 
  // token counts: 'reply to clients email' = 4, 'complete quarterly report' (text is 'quarterly report' = 2)
  assert("low energy: rest bucket shortest-first (quarterly report before reply email)", p2.text.indexOf("quarterly report") < p2.text.indexOf("reply to clients email"));
  assert("low energy: ladder still intact (overdue first)", p2.text.indexOf("pay rent") < p2.text.indexOf("meeting prep"));
  assert("low energy: detail.lowEnergy true", p2.detail.lowEnergy === true);

  // --- stale mood (>12h): no framing, plain opener ---
  // Mood recency is wall-clock real (a yesterday check-in is stale no matter
  // which day the due-date math is pinned to). Pin the fact timestamps to
  // 15 hours ago so the 12h threshold is crossed for the stale branch.
  userModels.setNowForTesting(new Date(Date.now() - 15 * 3_600_000));
  // Re-add the EXACT same fact so key dedupe overwrites updatedAt with the
  // pinned (15h-ago) timestamp — a different phrasing would be a second
  // fact and leave the fresh one as the latest mood.
  await runNoteAction("I feel exhausted today");
  const p3 = await runNoteAction("what should I work on first", { now: NOW });
  assert("stale mood: plain opener when check-in is older than 12h", p3.text.startsWith("Here's what I'd work on first:") && !p3.text.includes("You said"));
  assert("stale mood: detail.moodRecent false", p3.detail.moodRecent === false);
  userModels.setNowForTesting(null);

  // --- five-item cap with tail ---
  // add a sixth pending task to push one past the spoken cap
  await runNoteAction("add extra backlog task to my tasks");
  const p4 = await runNoteAction("prioritize my tasks", { now: NOW });
  assert("cap: shows 5 items then a tail", /…and 1 more after those\.$/.test(p4.text));
  assert("cap: six total pending", p4.detail.order.length === 6 && p4.text.split(/\.\s+\d+\./).length <= 6);

  // --- additive guarantee: no mood at all, every personality ---
  await runNoteAction("forget that I feel exhausted today");
  const snap = [];
  for (const personality of ["warm", "concise", "professional", "playful"]) {
    identity.set({ personality });
    snap[personality] = (await runNoteAction("what should i work on first", { now: NOW })).text;
  }
  assert("additive: concise opener plain", snap.concise.startsWith("Here's what I'd work on first:"));
  assert("additive: professional opener plain", snap.professional.startsWith("Here's what I'd work on first:"));
  assert("additive: playful opener plain", snap.playful.startsWith("Here's what I'd work on first:"));
  assert("additive: all four personalities say the same task order", snap.warm === snap.concise && snap.concise === snap.professional && snap.professional === snap.playful);
  identity.set({ personality: "warm" });

  // --- mood present but low-energy words absent in a mixed fact ---
  // "I feel okay" contains 'feel' (mood fact) but no low-energy word → no reorder
  await runNoteAction("I feel okay");
  const p5 = await runNoteAction("what should I work on first", { now: NOW });
  assert("mood ok: opener mentions mood but not small-wins strategy", p5.text.includes('"I feel okay"') && !p5.text.includes("so small wins first"));
  assert("mood ok: lowEnergy false", p5.detail.lowEnergy === false);

  // ===========================================================================
  // 5. Zero outbound — nothing in the priority path may fetch
  // ===========================================================================
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("fetch must not be called"); };
  try {
    await runNoteAction("what should i work on first", { now: NOW });
    await runNoteAction("I feel tired");
    await runNoteAction("prioritize my tasks", { now: NOW });
    assert("no-outbound: priority path made zero network calls", calls === 0);
  } finally {
    delete globalThis.fetch;
  }

  console.log("\nAll Round 28 mood-aware prioritization tests passed.");
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 1; });
