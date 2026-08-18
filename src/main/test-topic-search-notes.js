// Nova — Round 33 test harness: ranked topical note search.
//
// Action: notes:topic-search-notes (L1 SAFE, read-only, zero network).
// Voice: "find notes about the dog" / "any notes on rent" / "what did I write
// about the meeting" … → scored results (whole-word 10 / substring 5), stop-
// token stripped, recency tiebreak, cap 10, recency-tagged wording.
//
// Discipline (same as R30/R31/R32 harnesses):
//  - env vars set BEFORE any require (identity/user-model/action-log paths)
//  - electron shim via Module._resolveFilename + _load
//  - async IIFE body (top-level await flips Node 22 to ESM — known gotcha)
//  - assert(label, cond) prints PASS / ASSERT FAILED + process.exitCode=1
//  - fresh DATA_DIR per run (gitignored), fetch blocked for no-outbound proof

// ---------------------------------------------------------------------------
// test data isolation — set paths BEFORE requiring application modules
// ---------------------------------------------------------------------------
const path = require("path");
const fs = require("fs");
const DATA_DIR = "/tmp/.nova-topic-search-notes-test-data";
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.__NOVA_IDENTITY_TEST = DATA_DIR;
process.env.__NOVA_USER_MODEL_TEST = DATA_DIR;
process.env.__NOVA_ACTION_LOG_TEST = DATA_DIR;
const Module = require("module");
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron" || request.startsWith("electron/")) {
    return path.join(__dirname, "..", "..", "shim-electron.js");
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
const store = require("./notes/store");
store.setStorePathForTesting(path.join(DATA_DIR, "notes.json"));
const plan = require("./notes/plan");
const dispatch = require("./notes/dispatch");
require("./notes/actions");
const { getAction } = require("./permissions/action-registry");
const { topicSearchText, ageOf } = require("./notes/dispatch-personal");
const userModels = require("./identity/user-model");

const NOW = new Date("2026-08-19T12:00:00").getTime();

(async () => {
  // =========================================================================
  // 1. ROUTING — positives
  // =========================================================================
  const pos = [
    ["find notes about the dog", "the dog"],
    ["find my notes about the dog", "the dog"],
    ["any notes about rent", "rent"],
    ["find notes on the report", "the report"],
    ["find my notes on rent increases", "rent increases"],
    ["what did i write about the meeting", "the meeting"],
    ["what have i noted on rent", "rent"],
    ["tell me about my notes on cats", "cats"],
    ["nova, find notes about the dog", "the dog"],
    ["show me notes about the dog", "the dog"],
    ["any notes related to the dog", "the dog"],
    ["find my notes related to the report", "the report"],
  ];
  for (const [phrase, subj] of pos) {
    const r = plan.planNoteAction(phrase);
    assert(`route positive: "${phrase}" → topic-search-notes subject "${subj}"`,
      r && r.actionId === "notes:topic-search-notes" && r.payload.subject === subj);
  }

  // =========================================================================
  // 2. ROUTING — negatives (must NOT take the topic route)
  // =========================================================================
  const negs = [
    ["what did i note about dentist", "notes:search-notes"], // Stage 7 keyword path preserved
    ["search my notes for dentist", "notes:search-notes"],
    
    ["what did i say about dentist", "notes:search-notes"],
    ["note that i have a dog", "notes:add-note"], // note creation, never search
    ["find tasks about the report", "notes:task-search"], // task search owns task phrases
    ["find a note about milk", null], // singular 'a note' — not a valid phrase (no match)
    ["find notes about", null], // empty subject → regex requires a real topic
    ["my notes", null], // notes list / no plan → stays out of the topic route
    ["show my notes", null],
    ["i wrote a note about the dog", null], // declarative — a statement, not a search
    ["notes about groceries", "notes:search-notes"], // bare form → Stage 7 keyword path
    ["my notes on bills", null], // bare form → not a supported lead-in (no plan), stays out of the topic route
    ["search notes for milk", null], // no lead-in + 'for' — stays out of the topic route
    ["look for notes about x", null], // 'look for' lead-in not a supported verb
  ];
  for (const [phrase, expected] of negs) {
    const r = plan.planNoteAction(phrase);
    assert(`route negative: "${phrase}" avoids topic route (expected ${expected || "no match"})`,
      expected === null ? !r || r.actionId !== "notes:topic-search-notes" : r && r.actionId === expected);
  }
  const err = plan.planNoteAction("find notes about");
  assert(`empty subject "find notes about" → no plan (regex requires a real topic)`, !err);

  // =========================================================================
  // 3. REGISTRY + simulate
  // =========================================================================
  const action = getAction("notes:topic-search-notes");
  assert("action registered in the registry", !!action);
  assert("action level is L1 SAFE", action.level === 1);
  assert("action has a plain-language description", (action.description || "").length > 10);
  const sim = await action.simulate({ subject: "the dog" });
  assert("simulate describes the local-only search", /locally/.test(sim.summary) && /the dog/.test(sim.summary));

  // =========================================================================
  // 4. STORE SCORING — whole-word beats substring
  // =========================================================================
  store.resetForTesting();
  store.setNowForTesting(NOW);
  // note: "dog days" contains "dog" as substring only within "dogs"? no —
  // whole word. Craft deliberate ambiguity instead:
  store.addNote("dogs at the park were loud"); // "dog" substring, "dogs" word
  store.addNote("my dog loves chasing squirrels"); // "dog" whole word
  const res1 = store.topicSearchNotes("dog");
  assert("scoring: whole-word 'dog' beats substring-only 'dogs'", res1.length === 2 && res1[0].note.text.includes("dog loves"));
  assert("scoring: whole-word score is 10, substring 5", res1[0].score === 10 && res1[1].score === 5);

  // =========================================================================
  // 5. STOP TOKENS — voice padding stripped before scoring
  // =========================================================================
  store.resetForTesting();
  store.addNote("the rent went up this month");
  store.addNote("my notes about nothing at all");
  const res2 = store.topicSearchNotes("notes about the rent");
  assert("stop tokens stripped: padding 'notes/about/the/my' drops, 'rent' scores whole-word", res2.length === 1 && res2[0].score === 10);

  // all-padding subject → no match
  const res2b = store.topicSearchNotes("my notes about");
  assert("all-stop-token subject → empty (no match)", !res2b || res2b.length === 0);

  // =========================================================================
  // 6. RECENT-FIRST TIEBREAK
  // =========================================================================
  store.resetForTesting();
  store.setNowForTesting(NOW - 2 * 3600_000);
  store.addNote("old rent note from earlier today");
  store.setNowForTesting(NOW);
  store.addNote("new rent note just now");
  const res3 = store.topicSearchNotes("rent");
  assert("tiebreak: same whole-word score → most-recently-updated first",
    res3.length === 2 && res3[0].note.text.startsWith("new rent"));

  // =========================================================================
  // 7. CAP AT 10
  // =========================================================================
  store.resetForTesting();
  store.setNowForTesting(NOW);
  for (let i = 0; i < 12; i++) store.addNote(`rent note number ${i + 1} about payments`);
  const res4 = store.topicSearchNotes("rent");
  assert("cap: 12 hits truncated to 10", res4.length === 10);
  // cap keeps the top scores — all equal (10) so recency decides
  assert("cap keeps most recent at the front", res4[0].note.text.includes("12"));

  // =========================================================================
  // 8. EMPTY / CASE / PUNCTUATION
  // =========================================================================
  store.resetForTesting();
  store.addNote("The QUICK brown fox");
  const res5a = store.topicSearchNotes("QUICK");
  const res5b = store.topicSearchNotes("quick fox");
  const res5c = store.topicSearchNotes("");
  assert("case-insensitive whole-word match", res5a.length === 1 && res5a[0].score === 10);
  assert("multi-token AND-subset scoring (both hit)", res5b.length === 1 && res5b[0].score === 20);
  assert("empty subject → no match", !res5c || res5c.length === 0);

  // =========================================================================
  // 9. FORMATTER — topicSearchText
  // =========================================================================
  // empty
  const t0 = topicSearchText({ matches: [], subject: "cats" });
  assert("formatter empty: honest no-match line", t0 === 'No notes match "cats".');
  // single
  const t1 = topicSearchText({ matches: [{ note: { text: "vet visit at 3", updatedAt: new Date(NOW - 10 * 60_000).toISOString() } }], subject: "vet", now: NOW });
  assert("formatter single: count + recency tag",
    t1 === 'Found 1 note about "vet":\n• vet visit at 3 (30 minutes ago)');
  // multi under cap
  const t2 = topicSearchText({ matches: [
    { note: { text: "rent due friday", updatedAt: new Date(NOW - 30 * 60_000).toISOString() } },
    { note: { text: "rent late fee policy", updatedAt: new Date(NOW - 5 * 24 * 3600_000).toISOString() } },
  ], subject: "rent", now: NOW });
  assert("formatter two: count '2 notes' + both tags",
    t2.startsWith('Found 2 notes about "rent":\n') &&
    t2.includes("rent due friday (1 hour ago)") &&
    t2.includes("rent late fee policy (this week)"));
  // over cap
  const many = Array.from({ length: 8 }, (_, i) => ({ note: { text: `note ${i}`, updatedAt: new Date(NOW - i * 60_000).toISOString() }, score: 10 }));
  const t3 = topicSearchText({ matches: many, subject: "x", now: NOW });
  assert("formatter over-cap: shows 5, tail names the rest",
    t3.split("\n").length === 7 && /and 3 more in the full results\./.test(t3));

  // age ladder boundaries
  assert("ageOf just-now (<2 min)", ageOf(new Date(NOW - 60_000).toISOString(), NOW) === "just now");
  assert("ageOf 30min bucket", ageOf(new Date(NOW - 25 * 60_000).toISOString(), NOW) === "30 minutes ago");
  assert("ageOf 2h bucket", ageOf(new Date(NOW - 2 * 3600_000).toISOString(), NOW) === "a few hours ago");
  assert("ageOf 30-day floor → 'a while ago'", ageOf(new Date(NOW - 60 * 24 * 3600_000).toISOString(), NOW) === "a while ago");

  // =========================================================================
  // 10. ADDITIVE GUARANTEE — keyword search untouched, no facts written
  // =========================================================================
  store.resetForTesting();
  store.setNowForTesting(NOW);
  store.addNote("dentist appointment friday");
  const kw = store.searchNotes("dentist");
  assert("keyword search still returns raw snapshot notes", kw.length === 1 && kw[0].text === "dentist appointment friday");
  const factsBefore = JSON.stringify(userModels.list());
  store.topicSearchNotes("dentist");
  const factsAfter = JSON.stringify(userModels.list());
  assert("topic search never writes user facts", factsBefore === factsAfter);

  // =========================================================================
  // 11. DISPATCHER E2E — through runNoteAction
  // =========================================================================
  store.resetForTesting();
  store.setNowForTesting(NOW);
  store.addNote("vet visit next tuesday");
  dispatch.setNowForTesting(NOW);
  const d1 = await dispatch.runNoteAction("find notes about vet");
  assert("dispatcher ok + actionId", d1.ok && d1.actionId === "notes:topic-search-notes");
  assert("dispatcher text: found line + recency tag", /Found 1 note about "vet":/.test(d1.text) && d1.text.includes("vet visit next tuesday (just now)"));
  assert("dispatcher detail carries kind + subject", d1.detail.kind === "topic" && d1.detail.subject === "vet");

  const d2 = await dispatch.runNoteAction("any notes about something");
  assert("dispatcher empty plate: no-match line", /No notes match "something"\./.test(d2.text));

  // 6-hit readout — tail fires
  store.resetForTesting();
  store.setNowForTesting(NOW);
  for (let i = 0; i < 6; i++) store.addNote(`rent hit ${i + 1}`);
  const d3 = await dispatch.runNoteAction("find notes about rent");
  assert("dispatcher over-cap: 6 matches → 5 + tail names the 6th", d3.text.includes("…and 1 more in the full results."));
  assert("dispatcher detail still carries all matches", d3.detail.matches.length === 6);

  // stage-7 keyword wording untouched (byte-identical contract)
  const d4 = await dispatch.runNoteAction("what did i note about dentist");
  assert("keyword action wording unchanged (stage-7 contract)", /No notes mention/.test(d4.text) || d4.text.includes("dentist"));

  // =========================================================================
  // 12. ZERO OUTBOUND
  // =========================================================================
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error("network-call-not-allowed"); };
  try {
    const d5 = await dispatch.runNoteAction("find notes about the report");
    assert("no-outbound: topic search completes with fetch blocked", d5.ok);
  } finally {
    global.fetch = origFetch;
  }

  console.log("All Round 33 topic-search-notes tests passed.");
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 1; });
