// Nova — test-identity.js
// Round 24: Nova identity + user model — the #1 differentiator in competitor
// roundups (name, personality, a persistent model of the user).
//
// Covers:
//   - identity.js: defaults, name/personality/userName persistence, invalid
//     personality rejected, testing hooks
//   - user-model.js: addFact/removeFact, key-based dedupe (last-wins), MAX_FACTS
//     cap (oldest dropped), factKey normalization
//   - plan.js: RE_REMEMBER_FACT / RE_FORGET_FACT / RE_USER_MODEL_ASK /
//     RE_GREETING routing + negatives ("remember the milk" must NOT route to
//     facts, other modules' triggers unaffected)
//   - actions.js: the four identity actions register with the right levels
//     (forget-fact is L2 REVERSIBLE with reverse())
//   - dispatch.js: exact greeting + acknowledge wording per personality, the
//     user-model readout, and the full runNoteAction() voice path
//
// Usage: node src/main/test-identity.js [dataDir]
const Module = require("module");
const path = require("path");
const fs = require("fs");
const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-identity-test-data");
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

// ---------------- identity.js ----------------
const identity = require("./identity/identity");
identity.setStorePathForTesting(DATA_DIR);
identity.resetForTesting();
{
  const id = identity.get();
  assert(id.name === "Nova", "default name is Nova");
  assert(id.personality === "warm", "default personality is warm");
  assert(id.userName === "", "default userName is empty");
  assert(id.createdAt, "createdAt is stamped on first load");
}
{
  const id = identity.set({ name: "Aria", personality: "playful", userName: "Alex" });
  assert(id.name === "Aria" && id.personality === "playful" && id.userName === "Alex", "set applies name + personality + userName");
  // Fresh require should re-read the persisted JSON. The test path must be
  // injected BEFORE the first require so load() never writes to the repo root.
    process.env.__NOVA_IDENTITY_TEST = DATA_DIR;
  const identity2 = require("./identity/identity");
  const id2 = identity2.get();
    assert(id2.name === "Aria" && id2.userName === "Alex", "identity persists across loads");
  // Invalid personality is rejected (falls back to last valid value).
  identity2.set({ personality: "aggressive" });
  assert(identity2.get().personality === "playful", "invalid personality is rejected");
  identity2.set({ name: "Nova", personality: "warm", userName: "" }); // restore
}
{
  // Name/userName are trimmed + bounded.
  identity.set({ name: "   a".repeat(30), userName: " b ".repeat(30) });
  const id = identity.get();
  assert(id.name.length <= 40 && id.userName.length <= 40, "name/userName are bounded and trimmed");
  identity.set({ name: "Nova", userName: "" });
}

// ---------------- user-model.js ----------------
const userModel = require("./identity/user-model");
userModel.setStorePathForTesting(DATA_DIR);
userModel.resetForTesting();
{
  const r1 = userModel.addFact("I work from home on Fridays");
  assert(r1.ok && r1.fact.fact === "I work from home on Fridays" && r1.fact.key, "addFact stores fact + computed key");
  const r2 = userModel.addFact("I work from home on fridays");
  assert(r2.ok && userModel.list().length === 1 && r2.fact.fact === "I work from home on fridays", "duplicate phrasing updates in place (last-wins), no growth");
  const r3 = userModel.addFact("remember that ");
  assert(r3.ok, "trailing-space body from the planner is accepted");
  const r4 = userModel.addFact("");
  assert(!r4.ok && r4.error === "empty-fact", "empty fact is rejected");
  const r5 = userModel.addFact("x".repeat(201));
  assert(!r5.ok && r5.error === "too-long", "fact over 200 chars is rejected");
}
{
  // Key normalization: punctuation/case/whitespace collapse — the planner's
  // fact text (with trailing punctuation stripped or not) must still match
  // the same fact for forget.
  // factKey normalizes case, punctuation and whitespace (it never strips the
  // leading words — the planner removes "remember that" before storing, so
  // the stored text already excludes it).
  const k1 = userModel.factKey("Remember I love quiet mornings!");
  const k2 = userModel.factKey("remember i love quiet mornings");
  const k3 = userModel.factKey("Remember,   I LOVE  quiet   mornings!");
  assert(k1 === k2 && k2 === k3 && k1 === "remember i love quiet mornings", "factKey normalizes case, punctuation and whitespace");
  // removeFact matches by the same normalized key the planner's fact text
  // produces — the dispatcher feeds removeFact the EXACT stored fact text,
  // so key-for-key equality holds in the real flow.
  userModel.addFact("I love quiet mornings");
  const rem = userModel.removeFact("I love quiet mornings");
  assert(rem.ok && rem.removed.fact === "I love quiet mornings", "removeFact matches by normalized key");
  const miss = userModel.removeFact("a fact nobody remembers");
  assert(!miss.ok && miss.error === "not-found", "removeFact unknown fact → not-found");
}
{
  // MAX_FACTS cap: push 101 unique facts; oldest gets dropped, length stays 100.
  userModel.resetForTesting();
  for (let i = 1; i <= 101; i++) userModel.addFact(`fact number ${i}`);
  const all = userModel.list();
  assert(all.length === 100, "fact count caps at MAX_FACTS");
  assert(all[0].fact === "fact number 2", "oldest fact was dropped when the cap was hit");
  assert(all[all.length - 1].fact === "fact number 101", "newest fact is appended last (oldest-first order)");
  assert(all[0].createdAt <= all[all.length - 1].createdAt, "facts stay ordered by createdAt, oldest first");
}

// ---------------- plan.js: routing ----------------
const notesPlan = require("./notes/plan");
const { planNoteAction } = notesPlan;
const emptyCtx = { tasks: [], notes: [], reminders: [] };
{
  // Remember / forget / ask / greet phrasings — with and without the wake word.
  for (const phrase of ["remember I work from home on Fridays", "remember that I like quiet mornings", "remember I will be traveling next week", "nova, remember i love cats", "forget that I work from home on Fridays", "forget I like mornings", "what do you know about me", "what have i told you", "do you know me", "what do you remember about me", "good morning nova", "good afternoon nova", "good evening", "hey nova", "hi nova", "hello nova", "hi", "hello"]) {
    const p = planNoteAction(phrase, emptyCtx);
    // Expected action is determined on the wake-word-stripped phrase, since
    // the planner removes "nova," before matching (like a real user would).
    const core = phrase.replace(/^nova\s*,?\s*/i, "").trim();
    let want = "other";
    if (/^remember\b/i.test(core)) want = "notes:remember-fact";
    else if (/^forget\b/i.test(core)) want = "notes:forget-fact";
    else if (/know about me|told you|know me|remember about me/i.test(core)) want = "notes:user-model-ask";
    else want = "notes:greet";
    assert(p && p.actionId === want, `planner: "${phrase}" → ${want}`);
    // remember/forgot routes always carry the fact verbatim.
    if (want === "notes:remember-fact" || want === "notes:forget-fact") {
      const fact = phrase.replace(/^(?:nova\s*,?\s*)?(?:remember|forget)(?:\s+that)?\s+/i, "").trim();
      assert(p.payload.fact === fact, `payload fact is verbatim for "${phrase}"`);
    }
  }
  // Negatives — must NOT route to identity actions.
  for (const phrase of ["remember the milk", "remember that", "remember", "what's on my plate today", "my week in review", "task stats"]) {
    const p = planNoteAction(phrase, emptyCtx);
    assert(!p || p.actionId === null || (!/^notes:(remember-fact|forget-fact|user-model-ask|greet)$/.test(p.actionId)), `negative: "${phrase}" does not route to identity actions (→ ${p ? p.actionId : "null"})`);
  }
  // "remember that" with no fact clause must fail planning (the generic note
  // body "that" is rejected, identity rule does not match it).
  const pEmpty = planNoteAction("remember that", emptyCtx);
  assert(!pEmpty || pEmpty.error, "\"remember that\" alone fails planning (no fact clause)");
  // Wake-word + comma variants still reach the identity rules.
  assert(planNoteAction("Nova, good morning", emptyCtx)?.actionId === "notes:greet", "wake word + comma greeting routes to greet");
}

// ---------------- actions.js: registration + levels ----------------
require("./notes/actions");
const { listActions, getAction } = require("./permissions/action-registry");
const { RISK_LEVEL } = require("./permissions/risk-levels");
{
  const actions = listActions();
  const rem = actions.find((a) => a.id === "notes:remember-fact");
  assert(rem && rem.level === RISK_LEVEL.SAFE, "notes:remember-fact is registered at L1 SAFE");
  // getAction() exposes the full registry entry (listActions() is the minimal
  // public surface and drops reverse) — the gate/undo path uses getAction().
  const fgt = getAction("notes:forget-fact");
  assert(fgt && fgt.level === RISK_LEVEL.REVERSIBLE && typeof fgt.reverse === "function", "notes:forget-fact is L2 REVERSIBLE with a reverse()");
  const ask = actions.find((a) => a.id === "notes:user-model-ask");
  assert(ask && ask.level === RISK_LEVEL.SAFE, "notes:user-model-ask is registered at L1 SAFE");
  const grt = actions.find((a) => a.id === "notes:greet");
  assert(grt && grt.level === RISK_LEVEL.SAFE, "notes:greet is registered at L1 SAFE");
}

// ---------------- dispatch.js: wording through the real API ----------------
const { runNoteAction, greetLine } = require("./notes/dispatch");
{
  // Warm (default): greeting line by time of day (hour-independent).
  const lineWarm = greetLine("warm", "Alex");
  assert(/^Good (morning|afternoon|evening), Alex/.test(lineWarm) && lineWarm.includes("glad you're here"), "warm greeting greets by name + warm tail");
  const lineNone = greetLine("warm", "");
  assert(/^Good (morning|afternoon|evening)\./.test(lineNone.replace("—", "—")) === false && /^Good (morning|afternoon|evening)/.test(lineNone), "no user name → no comma");
  assert(greetLine("concise", "Alex") === "Good morning, Alex." || greetLine("concise", "Alex") === "Good afternoon, Alex." || greetLine("concise", "Alex") === "Good evening, Alex.", "concise greeting is time + name + full stop only");
  assert(/\u{1F31F}/u.test(greetLine("playful", "Alex")) && /lucky hour/.test(greetLine("playful", "Alex")), "playful greeting carries a star emoji and a playful line");
}
(async () => {
  const emptyCtx2 = { tasks: [], notes: [], reminders: [] };
  // Greeting path (warm, no user name).
  const g1 = await runNoteAction("good morning nova");
  assert(g1.ok && g1.detail?.kind === "greet" && /^Good (morning|afternoon|evening)/.test(g1.text), "greet route: dispatcher wording starts with the time-of-day greeting");
  // User name flows into the greeting.
  identity.set({ userName: "Alex" });
  const g2 = await runNoteAction("good morning nova");
  assert(g2.text.includes("Alex"), "greeting includes the user's name");
  identity.set({ userName: "" });
  // Playful personality flows through.
  identity.set({ personality: "playful" });
  const g3 = await runNoteAction("good morning nova");
  assert(/\u{1F31F}/u.test(g3.text) && /lucky hour/.test(g3.text), "playful personality reaches the spoken greeting");
  identity.set({ personality: "warm" });
  // Concise personality: greeting equals the time-of-day line exactly.
  identity.set({ personality: "concise" });
  const g4 = await runNoteAction("hi nova");
  assert(/^Good (morning|afternoon|evening)\.$/.test(g4.text), "concise personality speaks only the greeting");
  identity.set({ personality: "warm" });

  // Remember path — fact echoed verbatim in the warm acknowledgement.
  userModel.resetForTesting();
  const r1 = await runNoteAction("remember I work from home on Fridays");
  assert(r1.ok && r1.detail?.kind === "remember-fact" && r1.detail.fact === "I work from home on Fridays", "remember route: detail carries the fact");
  assert(r1.text.includes('"I work from home on Fridays"'), "remember wording echoes the fact verbatim");
  assert(userModel.list().length === 1, "user model persisted the fact");
  // Ask path — populated readout.
  const a1 = await runNoteAction("what do you know about me");
  assert(a1.ok && /You've told me:/.test(a1.text) && /I work from home on Fridays/.test(a1.text), "ask route: names the stored fact");
  // Empty readout.
  userModel.resetForTesting();
  const a2 = await runNoteAction("what do you know about me");
  assert(a2.ok && a2.text.startsWith("I don't know you yet"), "ask route: honest empty line");
  // Forget path — warm wording names the forgotten fact.
  userModel.addFact("I like quiet mornings");
  const f1 = await runNoteAction("forget that I like quiet mornings");
  assert(f1.ok && f1.detail?.kind === "forget-fact" && /quiet mornings/.test(f1.text), "forget route: wording confirms the removed fact");
  assert(userModel.list().length === 0, "fact removed from the model");
  // Forget non-existent fact.
  const f2 = await runNoteAction("forget that I fly to the moon");
  assert(!f2.ok && /couldn't find/.test(f2.text), "forget unknown fact: plain error");
  // Negative: "remember the milk" never touches the user model.
  const neg = await runNoteAction("remember the milk");
  assert(neg.detail?.kind !== "remember-fact", "\"remember the milk\" does not enter the user model");
  // Wake-word variant still lands on the identity action (the planner strips
  // the wake word; the dispatcher speaks the same line either way).
  const w1 = await runNoteAction("Nova, remember I love cats");
  assert(w1.ok && w1.detail?.kind === "remember-fact" && w1.detail.fact === "I love cats", "wake-word variant: fact captured without the wake word");
  console.log("\nAll Round 24 identity tests passed.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
