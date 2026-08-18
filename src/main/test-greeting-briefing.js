// Nova — test-greeting-briefing.js (Round 26)
//
// Headless self-test for the greeting-triggered day preview:
//   - plan.js: 8 new question phrasings route to notes:daily-briefing
//   - dispatch.js: greeting carries a one-line day preview when a user name
//     is set and today has content; no name or an empty day leaves the
//     greeting byte-identical (additive rule)
//   - dispatch-personal.js: greetSnapshot() personality variants + the R25
//     time-of-day fact bridge ("your afternoon today: ...")
//
// No electron — the module resolver below shims it. Run with:
//   node src/main/test-greeting-briefing.js
const fs = require("fs");
const path = require("path");
const Module = require("module");

const DATA_DIR = process.env.__NOVA_GREET_TEST || path.join(process.cwd(), ".nova-greeting-test-data");
// The identity + user-model modules use their own env-var paths; point both
// at the same harness dir so each round's data stays fully isolated.
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.__NOVA_IDENTITY_TEST = DATA_DIR;
process.env.__NOVA_USER_MODEL_TEST = DATA_DIR;

const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};
Module._load = function (request, parent, isMain, options) {
  if (request === "electron") {
    return {
      app: {
        getPath: (n) => (n === "userData" ? DATA_DIR : ""),
        whenReady: () => Promise.resolve(),
        on: () => {},
        quit: () => {},
        getName: () => "Nova",
        getVersion: () => "0.9.0",
      },
      BrowserWindow: { getAllWindows: () => [] },
      ipcMain: { handle: () => {}, on: () => {} },
      ipcRenderer: null,
      nativeTheme: { shouldUseDarkColors: true },
      Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
      shell: { openPath: async () => 0 },
      Notification: class Notification { constructor() {} show() {} },
    };
  }
  return origLoad.call(this, request, parent, isMain, options);
};

// Block any outbound call — everything in this round is local string work.
globalThis.fetch = async () => { throw new Error("[test] outbound call blocked"); };

const identity = require("./identity/identity");
identity.setStorePathForTesting(DATA_DIR);
identity.resetForTesting();
const userModel = require("./identity/user-model");
userModel.setStorePathForTesting(DATA_DIR);
userModel.resetForTesting();

const plan = require("./notes/plan");
require("./notes/actions");
const dispatch = require("./notes/dispatch");
const store = require("./notes/store");
store.setStorePathForTesting(path.join(DATA_DIR, "nova-notes.json"));
const dp = require("./notes/dispatch-personal");

let pass = 0;
function assert(cond, label) {
  if (!cond) throw new Error("ASSERT FAILED: " + label);
  pass++;
  console.log("PASS ", label);
}

// ---------------- plan.js: question phrasings ----------------
{
  const ctx = { tasks: [], notes: [], reminders: [] };
  for (const t of [
    "how's my day looking", "how is my day looking", "how's today looking",
    "how is today looking", "how's today for me", "how does today look",
    "what's the plan for today", "what is the plan for today", "nova, how's my day looking",
  ]) {
    const p = plan.planNoteAction(t, ctx);
    assert(p && p.actionId === "notes:daily-briefing", `"${t}" → notes:daily-briefing`);
  }
  // Negatives: must NOT swallow conversation shapes that happen to contain
  // "today".
  for (const t of ["is today a good day", "how's the weather today", "what is today", "hi, how are you today"]) {
    assert(plan.planNoteAction(t, ctx) === null || plan.planNoteAction(t, ctx).error, `"${t}" never routes to the briefing`);
  }
  // Question phrasings share the full briefing family (old phrasings intact).
  assert(plan.planNoteAction("what's on my plate today", ctx)?.actionId === "notes:daily-briefing", "legacy phrasing still routes");
}

// ---------------- greetSnapshot: additive rules ----------------
{
  const nameOnly = (userName, personality) => {
    identity.set({ userName, personality });
    userModel.resetForTesting();
  };

  // No name set → no preview (byte-identical pre-R26 greeting).
  nameOnly("Alex", "warm");
  identity.set({ userName: "" });
  const empty = store.dailyBriefing();
  assert(dp.greetSnapshot(empty) === "", "empty day → no preview");
  store.addTask("finish report");
  store.setTaskDue(store.all().tasks[0].id, new Date());
  assert(dp.greetSnapshot(store.dailyBriefing()) === "", "due task but no user name → no preview");

  // Name set, empty day → still nothing.
  identity.set({ userName: "Alex" });
  store.setTaskDone(store.all().tasks[0].id, true);
  assert(dp.greetSnapshot(store.dailyBriefing()) === "", "name + all-done day → no preview");

  // Name + content → warm default.
  store.setTaskDone(store.all().tasks[0].id, false);
  const t2 = store.addTask("buy milk", { dueDate: new Date(Date.now() - 86_400_000 * 6).toISOString() }); // 6 days ago = overdue
  const rem = store.addReminder("stand up", new Date().toISOString());
  const snap = dp.greetSnapshot(store.dailyBriefing());
  assert(snap === " — today has 1 thing on the plate and 1 overdue and 1 reminder today.", "warm snapshot: due + overdue + live reminder");

  // Personality variants.
  identity.set({ userName: "Alex", personality: "concise" });
  assert(dp.greetSnapshot(store.dailyBriefing()) === " — 1 thing on the plate and 1 overdue and 1 reminder today.", "concise snapshot"); // single " and " join, em-dash prefix
  identity.set({ personality: "professional" });
  assert(dp.greetSnapshot(store.dailyBriefing()) === " — today: 1 thing on the plate and 1 overdue and 1 reminder today.", "professional snapshot");
  identity.set({ personality: "playful" });
  assert(dp.greetSnapshot(store.dailyBriefing()) === " — the cosmos wrote you 1 thing on the plate and 1 overdue and 1 reminder today!", "playful snapshot");

  // R25 bridge: a time fact renames the day word.
  userModel.addFact("I work at night");
  identity.set({ personality: "warm" });
  const nightSnap = dp.greetSnapshot(store.dailyBriefing());
  assert(nightSnap === " — night today has 1 thing on the plate and 1 overdue and 1 reminder today.", "time fact → 'night today' in snapshot");

  // Reset the user model so the "I work at night" fact from the previous
  // check doesn't bleed into these (facts are last-wins, per the model).
  userModel.resetForTesting();

  // Single-item phrasing (the store exposes its own mutation API —
  // store.all() is a snapshot copy, so mutations there never stick).
  store.deleteTask(store.all().tasks.find((x) => x.id !== t2.id).id);
  store.cancelReminder(rem.id);
  const singleOverdue = dp.greetSnapshot(store.dailyBriefing());
  // Note: the reminder was cancelled in the previous line, and the hello-
  // line preview excludes fired reminders — only the overdue task counts.
  assert(singleOverdue === " — today has 1 overdue.", "fired reminders don't count in the hello-line preview");
  // A truly single-item plate: clear the overdue task, leaving just the
  // already-fired reminder — the preview goes empty since nothing is waiting.
  store.deleteTask(t2.id);
  const emptyAgain = dp.greetSnapshot(store.dailyBriefing());
  assert(emptyAgain === "", "handled reminders + no tasks → additive empty preview");
}

// Local copy of the dispatcher's greetLine wording, so the additive rule can
// be asserted against the exact pre-R26 baseline without reaching into the
// dispatcher's internals.
function localGreetLine(personality, userName) {
  const hour = new Date().getHours();
  const tod = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const who = userName ? `, ${userName}` : "";
  if (personality === "concise") return `${tod}${who}.`;
  if (personality === "professional") return `${tod}${who} — I'm ready when you are.`;
  if (personality === "playful") return `${tod}${who}! The cosmos says it's your lucky hour 🌟`;
  return `${tod}${who} — glad you're here. What shall we do today?`;
}

// ---------------- end-to-end dispatch: greet carries the preview ----------------
// All await-bearing blocks live inside async IIFEs — Node 22's module-type
// detector treats a bare top-level await as an ESM signal and silently
// reparses the file as a module (where require() does not exist).
(async () => {
{
  identity.set({ userName: "Alex", personality: "warm" });
  userModel.resetForTesting();
  // Previous sections left a cancelled (fired) reminder that still counts on
  // today's plate — clear the store so this block starts from zero.
  store.all().tasks.forEach((x) => store.deleteTask(x.id));
  store.all().reminders.forEach((x) => store.cancelReminder(x.id));

  const emptyDay = async () => dispatch.runNoteAction("good morning nova");
  const r0 = await emptyDay();
  const base = r0.text;
  assert(r0.ok && r0.actionId === "notes:greet", "greeting fires end-to-end");
  assert(!r0.detail.snapshot, "empty day: no snapshot flag");

  // Populate a day and greet again.
  const t = store.addTask("finish report");
  store.setTaskDue(t.id, new Date());
  const r1 = await dispatch.runNoteAction("hey nova");
  assert(r1.text === base + " — today has 1 thing on the plate.", "greeting + due task: preview appended");
  assert(r1.detail.snapshot === true, "snapshot flag on populated day");
  assert(r1.narration === r1.text, "narration mirrors the previewed line");

  // Greeting order preserved: preview is a tail, never a lead-in (additive).
  assert(r1.text.startsWith(base), "greeting line comes first, preview as tail");

  // No name → pre-R26 byte-identical greeting even with a populated day.
  identity.set({ userName: "" });
  const r2 = await dispatch.runNoteAction("hi");
  assert(r2.text === localGreetLine("warm", ""), "no name → byte-identical pre-R26 greeting on a populated day");
  assert(r2.text.length === localGreetLine("warm", "").length, "no name → greeting length unchanged");
}

// ---------------- no-outbound guarantee ----------------
{
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("[test] blocked"); };
  identity.set({ userName: "Alex" });
  await dispatch.runNoteAction("how's my day looking");
  await dispatch.runNoteAction("good morning nova");
  assert(calls === 0, "greeting path makes zero outbound calls");
}

console.log(`All Round 26 greeting-briefing tests passed (${pass}).`);
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

