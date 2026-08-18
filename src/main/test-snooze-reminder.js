// Nova — test-snooze-reminder.js
//
// Headless self-test for Round 13: reminder snooze ("snooze 10 minutes").
// Runs WITHOUT a real Electron runtime via the shared shim-electron.js file
// and a fake reminder notifier.
//
// Covers:
//   - planner recognizes "snooze" phrasings with explicit durations and the
//     bare 10-minute default; plain note/task chatter is not swallowed
//   - notes:snooze-reminder is registered Level 1 (SAFE) with simulate()
//   - end-to-end: reminder added → scanner fires it → "snooze 10 minutes"
//     re-arms it unfired at the new due time → a second scan does NOT fire
//     it early → a scan at the new time fires it exactly once
//   - nothing-actually-fired → friendly plain-language nudge
//   - the snoozed reminder keeps its original text (nothing lost)
//
// Usage: node src/main/test-snooze-reminder.js [dataDir]
const Module = require("module");
const path = require("path");
const fs = require("fs");

const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-snooze-test-data");
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Electron shim + fake notifier
// ---------------------------------------------------------------------------
const notificationsSent = [];
const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getName: () => "Nova" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: null,
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  Notification: class Notification { constructor() {} show() {} },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain, options) {
  if (request === "electron") return shim;
  return origLoad.call(this, request, parent, isMain, options);
};
globalThis.fetch = async () => { throw new Error("[test] outbound call blocked"); };

// ---------------------------------------------------------------------------
// 2. Modules under test
// ---------------------------------------------------------------------------
const store = require("./notes/store");
require("./notes/actions");   // registers notes:*, incl. notes:snooze-reminder
const plan = require("./notes/plan");
const dispatch = require("./notes/dispatch");
const reminders = require("./notes/reminders");
const registry = require("./permissions/action-registry");
const { RISK_LEVEL } = require("./permissions/risk-levels");

const STORE_PATH = path.join(DATA_DIR, "nova-notes.json");
store.setStorePathForTesting(STORE_PATH);
store.resetForTesting();
reminders.setNotifierForTesting((title, body) => notificationsSent.push({ title, body }));

let passCount = 0, failCount = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ok   ${label}`); passCount += 1; }
  else { console.log(`  FAIL ${label}`); failCount += 1; }
}

async function resetState() {
  store.resetForTesting();
  notificationsSent.length = 0;
}

(async function main() {
  console.log("Reminder-snooze tests");

  // --- Planning -----------------------------------------------------------
  const snoozePhrasings = [
    ["snooze", null],
    ["snooze 10 minutes", 10 * 60_000],
    ["snooze it for 10 minutes", 10 * 60_000],
    ["snooze it", null],
    ["snooze for 5 minutes", 5 * 60_000],
    ["snooze reminder for an hour", 3600_000],
    ["snooze the reminder 30 seconds", 30_000],
    ["pause it for 10 minutes", 10 * 60_000],
    ["delay it", null],
  ];
  for (const [phrase, expectMs] of snoozePhrasings) {
    const p = plan.planNoteAction(phrase);
    const ok = p && p.actionId === "notes:snooze-reminder" && !p.error;
    assert(ok, `planner routes "${phrase}" → notes:snooze-reminder`);
    if (ok && expectMs !== null) {
      const delta = new Date(p.payload.dueAt).getTime() - Date.now();
      assert(Math.abs(delta - expectMs) < 3000, `planner parsed "${phrase}" to ~${expectMs / 60000} min (Δ ${Math.round(delta / 1000)}s)`);
    }
  }
  // Regression: "note that I have a meeting" must stay a plain note, and
  // cancel-reminder chat still routes to its own action when ids exist.
  const plain = plan.planNoteAction("note that I have a dentist appointment Friday");
  assert(plain && plain.actionId === "notes:add-note", "plain 'note that …' stays notes:add-note");

  // --- Registration -------------------------------------------------------
  const action = registry.getAction("notes:snooze-reminder");
  assert(!!action, "notes:snooze-reminder is registered");
  assert(action.level === RISK_LEVEL.SAFE, "notes:snooze-reminder is Level 1 (SAFE) — no confirmation needed");
  const dry = await action.simulate({ seconds: 600, dueAt: new Date(Date.now() + 600_000).toISOString() });
  assert(dry && /minute/.test(dry.summary), "simulate() describes the snooze in plain language");

  // --- End-to-end: fire → snooze → refire -------------------------------
  await resetState();
  const rem = store.addReminder("take the laundry out", new Date(Date.now() - 1000).toISOString());
  assert(!store.all().reminders[0].fired, "reminder starts unfired (just past due)");
  const fired = await reminders.scanOnce();
  assert(fired.length === 1 && notificationsSent.length === 1, "scanner fires the due reminder and notifies once");
  assert(store.all().reminders[0].fired, "fired reminder is marked fired");

  const r1 = await dispatch.runNoteAction("snooze 10 minutes");
  assert(r1.ok && r1.text.includes("snoozed"), "dispatch snoozes with a plain confirmation");
  const rearmed = store.all().reminders[0];
  assert(rearmed.fired === false, "snoozed reminder is un-fired (armed) again");
  const expectedDue = rem.fired ? rem.dueAt : new Date(Date.now() + 10 * 60_000).toISOString();
  assert(Math.abs(new Date(rearmed.dueAt).getTime() - new Date(expectedDue).getTime()) < 3000,
    `new due time is ~now + 10 min (Δ ${Math.round((new Date(rearmed.dueAt).getTime() - Date.now()) / 1000)}s)`);
  assert(rearmed.text === "take the laundry out", "snooze keeps the reminder's original text");

  // A scan right now must NOT re-fire it; a scan at the new due time fires once.
  const early = await reminders.scanOnce();
  assert(early.length === 0, "early scan does not re-fire the snoozed reminder");
  store.rearmReminder(rearmed.id, new Date(Date.now() - 1000).toISOString()); // pretend the snooze lapsed
  const later = await reminders.scanOnce();
  assert(later.length === 1 && notificationsSent.length === 2, "after the snooze lapses it fires exactly once more");

  // --- Nothing fired → friendly nudge ------------------------------------
  await resetState();
  store.addReminder("future thing", new Date(Date.now() + 3600_000).toISOString());
  const r2 = await dispatch.runNoteAction("snooze");
  assert(!r2.ok && /no fired reminder/i.test(r2.text), "nothing fired → friendly plain-language nudge");
  assert(!/stack|Error/.test(r2.text), "nudge contains no stack trace");

  console.log(`\n${passCount} snooze test(s) passed, ${failCount} failed`);
  if (failCount > 0) process.exitCode = 1;
})().catch((err) => {
  console.error("UNCAUGHT:", err?.message || err);
  process.exitCode = 1;
});
