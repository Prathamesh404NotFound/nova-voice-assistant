// Nova — test-identity-briefing.js
// Round 25: identity-aware briefing personalization — the daily briefing
// and weekly digest narrations weave in the user's name, Nova's personality
// tone, and remembered facts. Pure local composition, additive by design:
// empty user model === pre-R25 wording.
//
// Covers:
//   - dispatch-personal.js: additive rule (no name + no facts), userName
//     lead-ins for both readouts, all four personality tones, time-of-day
//     fact lead-in (morning/afternoon/evening/night), fact recap echo
//     (verbatim, never paraphrased), multiple facts capped at 2 in the
//     recap, no lead-in when only non-time facts exist
//   - dispatch.js daily-briefing: userName in narration, fact recap,
//     time-preference reminder reorder (afternoon flips latest-first),
//     morning keeps earliest-first, empty model leaves narration
//     byte-identical, text unaffected by personalization
//   - dispatch.js weekly-digest: same additive rules + fact recap
//   - ordering: facts recited are the most RECENT facts (relevantFacts)
//
// Usage: node src/main/test-identity-briefing.js [dataDir]
const Module = require("module");
const path = require("path");
const fs = require("fs");
const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-identity-briefing-test-data");
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.__NOVA_IDENTITY_TEST = DATA_DIR;
process.env.__NOVA_USER_MODEL_TEST = DATA_DIR;
const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getName: () => "Nova", getVersion: () => "0.9.0" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: null,
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: { openPath: async () => 0 },
  Notification: class Notification { constructor() {} show() {} },
};
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};
Module._load = function (request, parent, isMain, options) {
  if (request === "electron") return shim;
  return origLoad.call(this, request, parent, isMain, options);
};
globalThis.fetch = async () => { throw new Error("[test] outbound call blocked"); };
const assert = (cond, label) => {
  if (!cond) throw new Error("ASSERT FAILED: " + label);
  console.log("PASS  " + label);
};

const identity = require("./identity/identity");
identity.setStorePathForTesting(DATA_DIR);
identity.resetForTesting();
const userModel = require("./identity/user-model");
userModel.setStorePathForTesting(DATA_DIR);
userModel.resetForTesting();

// Fresh require of dispatch AFTER identity + user model paths are set, so
// the dispatcher picks up the test stores.
require("./notes/actions"); // register the notes:* actions (incl. greetings)
const dispatch = require("./notes/dispatch");
const store = require("./notes/store");
store.setStorePathForTesting(path.join(DATA_DIR, "nova-notes.json"));

const BASE_BRIEF = "Here's what's on your plate today\u2026";
const BASE_DIGEST = "Here's your week in review\u2026";

// ---------------- dispatch-personal.js: additive rule ----------------
{
  const { personalizeNarration, applyTimePreference } = require("./notes/dispatch-personal");
  identity.resetForTesting();
  userModel.resetForTesting();
  assert(personalizeNarration("daily-briefing", BASE_BRIEF) === BASE_BRIEF,
    "empty model + default identity: briefing narration byte-identical to pre-R25");
  assert(personalizeNarration("weekly-digest", BASE_DIGEST) === BASE_DIGEST,
    "empty model + default identity: digest narration byte-identical to pre-R25");
  assert(applyTimePreference([]).length === 0, "applyTimePreference: empty list untouched");
  assert(applyTimePreference(null) === null, "applyTimePreference: null passed through");
}

// ---------------- userName lead-ins, both readouts ----------------
{
  const { personalizeNarration } = require("./notes/dispatch-personal");
  identity.set({ userName: "Alex" });
  const nb = personalizeNarration("daily-briefing", BASE_BRIEF);
  assert(nb.startsWith("Alex, here's your day: " + BASE_BRIEF), "warm + name: briefing lead-in = 'Alex, here's your day: ' (default warm)");
  assert(nb.endsWith(BASE_BRIEF), "name-only lead-in keeps the base text intact");
  const nd = personalizeNarration("weekly-digest", BASE_DIGEST);
  assert(nd.startsWith("Alex, here's your week: " + BASE_DIGEST), "warm + name: digest lead-in = 'Alex, here's your week: '");
}

// ---------------- personality tones ----------------
{
  const { personalizeNarration } = require("./notes/dispatch-personal");
  identity.set({ userName: "Alex" });
  const check = (per, base, wantStart, wantEnd) => {
    identity.set({ personality: per });
    const out = personalizeNarration("daily-briefing", base);
    assert(out.startsWith(wantStart + base), `${per}: briefing lead-in "${wantStart}"`);
    assert(out.endsWith(base), `${per}: base text preserved`);
  };
  check("concise", BASE_BRIEF, "Alex, today: ");
  check("professional", BASE_BRIEF, "Alex, here's your briefing — ");
  check("warm", BASE_BRIEF, "Alex, here's your day: ");
  check("playful", BASE_BRIEF, "Alex, the stars align for you — ");
  identity.set({ userName: "Alex", personality: "warm" });
  const dp = personalizeNarration("weekly-digest", BASE_DIGEST);
  assert(dp.startsWith("Alex, here's your week: " + BASE_DIGEST), "warm + name: digest lead-in");
}

// ---------------- time-of-day fact lead-in ----------------
{
  const { personalizeNarration, applyTimePreference } = require("./notes/dispatch-personal");
  identity.set({ userName: "" });
  userModel.resetForTesting();
  userModel.addFact("I like mornings");
  const nb = personalizeNarration("daily-briefing", BASE_BRIEF);
  assert(nb.startsWith("here's your morning day: " + BASE_BRIEF), "warm (default) + morning fact: lead-in 'here's your morning day: '");
  assert(nb.endsWith(" Remembered about you: I like mornings."), "fact recap appended for morning fact");
  userModel.addFact("I prefer afternoons");
  const nb2 = personalizeNarration("daily-briefing", BASE_BRIEF);
  assert(nb2.startsWith("here's your afternoon day: " + BASE_BRIEF), "afternoon fact overrides earlier morning fact (last-wins time hook)");
  const ev = (() => { userModel.resetForTesting(); userModel.addFact("I work at night"); return personalizeNarration("daily-briefing", BASE_BRIEF); })();
  assert(ev.startsWith("here's your night day: " + BASE_BRIEF), "night fact → 'here's your night day' framing");
}

// ---------------- non-time facts: no lead-in, recap only ----------------
{
  const { personalizeNarration } = require("./notes/dispatch-personal");
  identity.set({ userName: "" });
  userModel.resetForTesting();
  userModel.addFact("I work from home on Fridays");
  const nb = personalizeNarration("daily-briefing", BASE_BRIEF);
  assert(nb === BASE_BRIEF + " Remembered about you: I work from home on Fridays.",
    "non-time fact: no lead-in, verbatim fact recap only");
  const nd = personalizeNarration("weekly-digest", BASE_DIGEST);
  assert(nd === BASE_DIGEST + " Remembered about you: I work from home on Fridays.",
    "weekly digest recap with a single non-time fact");
}

// ---------------- recap cap: only the 2 most recent facts ----------------
{
  const { personalizeNarration } = require("./notes/dispatch-personal");
  identity.set({ userName: "" });
  userModel.resetForTesting();
  userModel.addFact("oldest fact");
  userModel.addFact("middle fact");
  userModel.addFact("newest fact");
  const nb = personalizeNarration("daily-briefing", BASE_BRIEF);
  assert(nb === BASE_BRIEF + " Remembered about you: middle fact. newest fact.",
    "recap recites the 2 most recent facts verbatim, oldest dropped");
  assert(!nb.includes("oldest fact"), "oldest fact never appears in the recap");
}

// ---------------- applyTimePreference: ordering ----------------
{
  const { applyTimePreference } = require("./notes/dispatch-personal");
  const items = [
    { text: "early", dueAt: "2026-08-18T08:00:00.000Z", createdAt: "2026-08-17T00:00:00.000Z" },
    { text: "late", dueAt: "2026-08-18T17:00:00.000Z", createdAt: "2026-08-17T01:00:00.000Z" },
  ];
  userModel.resetForTesting();
  userModel.addFact("I like mornings");
  const morningOrder = applyTimePreference(items);
  assert(morningOrder[0].text === "early" && morningOrder[1].text === "late",
    "morning preference keeps earliest-first order");
  userModel.resetForTesting();
  userModel.addFact("I prefer evenings");
  const eveOrder = applyTimePreference(items);
  assert(eveOrder[0].text === "late" && eveOrder[1].text === "early",
    "evening preference flips to latest-first order");
  const untouched = applyTimePreference(items);
  assert(untouched[0].text === "late", "evening preference does not mutate the input array");
  userModel.resetForTesting();
  userModel.addFact("I work from home on Fridays");
  const noTimeOrder = applyTimePreference(items);
  assert(noTimeOrder[0].text === "early" && noTimeOrder[1].text === "late",
    "non-time fact leaves ordering untouched");
}

(async () => {
// ---------------- dispatch daily-briefing: end-to-end ----------------
{
  const BASE_DIR = path.join(DATA_DIR, "run1");
  fs.mkdirSync(BASE_DIR, { recursive: true });
  identity.set({ userName: "Alex", personality: "warm" });
  userModel.resetForTesting();
  userModel.addFact("I like mornings");
  store.setStorePathForTesting(path.join(BASE_DIR, "nova-notes.json"));
  store.addTask("write the quarterly report", { dueDate: new Date().toISOString() });
  const at = new Date();
  at.setHours(10, 0, 0, 0);
  store.addReminder("take the dog out", at.toISOString());
  const at2 = new Date();
  at2.setHours(16, 0, 0, 0);
  store.addReminder("call the dentist", at2.toISOString());

  // 1 task due + 2 reminders → the "Here's today's plate" branch.
  const r1 = await dispatch.runNoteAction("what's on my plate today");
  assert(r1.ok && r1.actionId === "notes:daily-briefing", "daily-briefing fires end-to-end");
  assert(r1.text.startsWith("Here's today's plate:"), "briefing text keeps its original data line");
  assert(r1.narration.startsWith("Alex, here's your morning day: "), "briefing narration woven with name + morning fact: " + r1.narration);
  assert(r1.narration.includes("Remembered about you: I like mornings."), "briefing narration recites the fact");
  // Morning preference → earliest reminder first in the text order.
  const idxDog = r1.text.indexOf('"take the dog out"');
  const idxDent = r1.text.indexOf('"call the dentist"');
  assert(idxDog >= 0 && idxDent >= 0 && idxDog < idxDent, "morning preference: earlier reminder appears first in text");

  // Flip to evening preference → latest reminder first.
  userModel.resetForTesting();
  userModel.addFact("I prefer evenings");
  const r2 = await dispatch.runNoteAction("what's on my plate today");
  const idxDog2 = r2.text.indexOf('"take the dog out"');
  const idxDent2 = r2.text.indexOf('"call the dentist"');
  assert(idxDog2 > idxDent2, "evening preference: later reminder appears first");
  assert(r2.narration.startsWith("Alex, here's your evening day: "), "evening fact woven into narration");

  // Empty model → byte-identical base narration (additive rule in dispatcher).
  userModel.resetForTesting();
  identity.set({ userName: "" });
  const r3 = await dispatch.runNoteAction("what's on my plate today");
  assert(r3.narration === "Here's what's on your plate today\u2026",
    "empty model: dispatcher briefing narration is pre-R25 wording");
  assert(r3.text.startsWith("Here's today's plate:"), "briefing text never personalized (facts only touch narration)");

  // Nothing on the plate today → the empty-case narration still honors name.
  store.setStorePathForTesting(path.join(BASE_DIR, "nova-notes-empty.json"));
  const r4 = await dispatch.runNoteAction("what's on my plate today");
  assert(r4.text === "Nothing on the plate today — clear skies.", "empty-day text preserved");
  identity.set({ userName: "Alex" });
  const r5 = await dispatch.runNoteAction("what's on my plate today");
  assert(r5.narration.startsWith("Alex, ") && r5.narration.endsWith("— clear skies."),
    "name lead-in applies even on an empty day: " + r5.narration);
}

// ---------------- dispatch weekly-digest: end-to-end ----------------
{
  const BASE_DIR = path.join(DATA_DIR, "run2");
  fs.mkdirSync(BASE_DIR, { recursive: true });
  store.setStorePathForTesting(path.join(BASE_DIR, "nova-notes.json"));
  identity.set({ userName: "Alex", personality: "concise" });
  userModel.resetForTesting();
  userModel.addFact("I review my work on Sundays");

  // Seed: 1 completed this week + 1 upcoming reminder.
  const now = new Date();
  const task = store.addTask("ship the release", {});
  store.setTaskDone(task.id, true);
  const remAt = new Date(now.getTime() + 3 * 86_400_000);
  store.addReminder("weekly standup", remAt.toISOString());

  const r1 = await dispatch.runNoteAction("my week in review");
  assert(r1.ok && r1.actionId === "notes:weekly-digest", "weekly-digest fires end-to-end");
  assert(r1.text.startsWith("Here's your week in review:"), "digest text keeps its original data line");
  assert(r1.narration.startsWith("Alex, this week: "), "concise + name: digest lead-in 'Alex, this week: ': " + r1.narration);
  assert(r1.narration.includes("Remembered about you: I review my work on Sundays."), "digest recites the fact");
  assert(!r1.narration.startsWith("Alex, Sunday"), "non-time fact doesn't hijack the digest lead-in");

  // Empty model → pre-R25 wording even in the digest.
  userModel.resetForTesting();
  identity.set({ userName: "" });
  const r2 = await dispatch.runNoteAction("my week in review");
  assert(r2.narration === "Here's your week in review\u2026", "empty model: digest narration is pre-R25 wording");
}

// ---------------- privacy: nothing reaches the network ----------------
{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args[0]); throw new Error("[test] outbound call blocked"); };
  const r = await dispatch.runNoteAction("what's on my plate today");
  globalThis.fetch = realFetch;
  assert(calls.length === 0 && r.ok, "identity-aware briefing makes zero outbound calls");
}

console.log("\nAll Round 25 identity-aware briefing tests passed.");
process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
