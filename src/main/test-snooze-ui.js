// Nova — Round 19 test harness: reminder snooze UI (side-panel chips).
//
// CJS-safe: electron is shimmed via Module._load BEFORE any application
// require (the renderer's snooze-ui.js is tested directly with a fake DOM).
// All harness logic is synchronous or runs inside a single async IIFE —
// Node 22's module detection treats top-level await as ESM, so none appears
// here. Pinned store path, pinned clock not needed (snooze is wall-clock).

// =========================== electron shim ===========================
const path = require("path");
const fs = require("fs");
const assert = (cond, label) => {
  if (!cond) throw new Error("ASSERT FAILED: " + label);
  console.log("PASS ", label);
};
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/tmp", name: "Nova" },
      Notification: null,
      BrowserWindow: { getAllWindows: () => [] },
      ipcRenderer: null,
      ipcMain: { handle: () => {}, on: () => {} },
      systemPreferences: { getMediaAccessStatus: () => "not-determined" },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// =========================== fixture setup ===========================
const DATA_DIR = path.resolve("/tmp/.nova-snooze-ui-test-data");
fs.mkdirSync(DATA_DIR, { recursive: true });
for (const f of ["notes.json", "actions.log.json"]) fs.rmSync(path.join(DATA_DIR, f), { force: true });

const store = require("./notes/store");
store.setStorePathForTesting(path.join(DATA_DIR, "notes.json"));

// Register actions (L1 notes:snooze-reminder) — same as main.js boot.
require("./notes/actions");
const reminders = require("./notes/reminders");
const registry = require("./permissions/action-registry");

// Seed one pending reminder and fire it through the reminder path.
const reminder = store.addReminder("take the chicken out of the freezer", new Date(Date.now() - 2000).toISOString());
assert(reminder && reminder.id, "seed reminder exists");
const fired = reminders.scanOnce({ isDestroyed: () => false, webContents: { send: () => {} }, isFocused: () => true });
assert(fired.length === 1 && fired[0].id === reminder.id, "scanOnce fires the due reminder");

// ---------------- pending snooze queue (fire registers it) ----------------
const pending = reminders.pendingSnoozesForTesting();
assert(pending.size === 1 && pending.has(reminder.id), "fired reminder is snoozable after firing");
assert(pending.get(reminder.id).text === "take the chicken out of the freezer", "queue entry carries the reminder text");

// ---------------- snoozeFired: happy path ----------------
const ok = reminders.snoozeFired(reminder.id, 600);
assert(ok.ok === true && ok.reminder && !ok.reminder.fired, "snooze re-arms the reminder unfired");
assert(new Date(ok.dueAt).getTime() > Date.now() + 590000 && new Date(ok.dueAt).getTime() < Date.now() + 610000, "new due time is now + 10 min");
assert(pending.size === 0, "snoozed reminder leaves the pending queue");

// ---------------- snoozeFired: second try on the same id fails ----------------
const again = reminders.snoozeFired(reminder.id, 300);
assert(again.ok === false && /no longer snoozable/.test(again.message), "repeat snooze of same id is refused (no stacking)");

// ---------------- snoozeFired: unknown id ----------------
const unknown = reminders.snoozeFired("reminder-that-never-existed", 300);
assert(unknown.ok === false && /no longer snoozable/.test(unknown.message), "unknown id is refused");

// ---------------- expiry window: entries age out of snoozability ----------------
reminders.resetPendingSnoozesForTesting();
const r2 = store.addReminder("call the dentist", new Date(Date.now() - 1000).toISOString());
reminders.scanOnce({ isDestroyed: () => false, webContents: { send: () => {} }, isFocused: () => false });
assert(reminders.pendingSnoozesForTesting().has(r2.id), "second fired reminder registers");
reminders.setSnoozeWindowMsForTesting(-1);
const expired = reminders.snoozeFired(r2.id, 300);
assert(expired.ok === false && /closed/.test(expired.message), "entry past the snooze window is refused");
reminders.setSnoozeWindowMsForTesting(15 * 60_000); // restore
reminders.resetPendingSnoozesForTesting();

// ---------------- defaults: seconds missing → 10 min ----------------
const r3 = store.addReminder("water the plants", new Date(Date.now() - 1000).toISOString());
reminders.scanOnce({ isDestroyed: () => false, webContents: { send: () => {} }, isFocused: () => false });
const def = reminders.snoozeFired(r3.id, 0);
assert(def.ok === true && Math.abs(new Date(def.dueAt).getTime() - (Date.now() + 600 * 1000)) < 2000, "seconds <= 0 falls back to the 10-minute default");
reminders.resetPendingSnoozesForTesting();

// ---------------- action registration: L1 + same action id as voice ----------------
const act = registry.getAction("notes:snooze-reminder");
assert(act && act.level === 1, "snooze-reminder stays at L1 SAFE");
assert(typeof act.execute === "function", "execute exists");

// ---------------- action routing: voice path still targets the newest fired ----------------
const r4 = store.addReminder("feed the dog", new Date(Date.now() - 500).toISOString());
reminders.scanOnce({ isDestroyed: () => false, webContents: { send: () => {} }, isFocused: () => false });
(async () => {
  const res = await act.execute({ seconds: 300 }); // no id — voice path
  assert(res.ok && res.reminder.text === "feed the dog", "voice path (no id) still snoozes the most recently fired reminder");

  // ---------------- action routing: fromUi targets the named id ----------------
  const r5 = store.addReminder("lock the back door", new Date(Date.now() - 500).toISOString());
  reminders.scanOnce({ isDestroyed: () => false, webContents: { send: () => {} }, isFocused: () => false });
  const ui = await act.execute({ fromUi: true, id: r5.id, seconds: 900 });
  assert(ui.ok && ui.reminder.text === "lock the back door" && ui.seconds === 900, "fromUi + id targets the named reminder");

  // fromUi with a fired but non-matching id refuses politely
  const wrong = await act.execute({ fromUi: true, id: "some-other-id", seconds: 300 });
  assert(wrong.ok === false && wrong.error === "no-fired", "fromUi with unknown id → no-fired");
  reminders.resetPendingSnoozesForTesting();

  console.log("\nAll Round 19 reminder snooze-UI tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
