// Quick E2E smoke harness for the notes/reminders/tasks module (Stage 7).
// Mirrors scripts/smoke-files-e2e.js: headless, electron shim, runs the
// dispatcher the same way the real app's agent loop does.
const fs = require("fs");
const path = require("path");

// Electron shim
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};
if (!fs.existsSync(path.join(__dirname, "..", "shim-electron.js"))) {
  fs.writeFileSync(path.join(__dirname, "..", "shim-electron.js"), `
    const app = { getPath: (n) => ({ userData: '/tmp/nova-notes-data', home: process.env.HOME })[n] || '/tmp' };
    module.exports = { app, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => {}, on: () => {} }, ipcRenderer: null, dialog: {}, Menu: {}, nativeTheme: {}, systemPreferences: {} };
  `);
}

const store = require("../src/main/notes/store");
const gate = require("../src/main/permissions/gate");
require("../src/main/notes/actions");
const dispatch = require("../src/main/notes/dispatch");
const { classify } = require("../src/main/agent/classifier");

// Sandbox data dir
const tmp = fs.mkdtempSync("/tmp/nova-notes-");
store.setStorePathForTesting(path.join(tmp, "notes.json"));
store.resetForTesting();

// Record notifications instead of showing them; headless confirms are on.
const fired = [];
const reminders = require("../src/main/notes/reminders");
reminders.setNotifierForTesting((title, body) => fired.push({ title, body }));
gate.setModalConfirmForTesting(true);

function say(t) { console.log(`\n  >>> "${t}"`); }

(async () => {
  console.log("DATA_DIR:", path.join(tmp, "notes.json"));

  say("Nova, note that my sister's birthday is June 12");
  const note = await dispatch.runNoteAction("Nova, note that my sister's birthday is June 12");
  console.log(JSON.stringify(note));
  if (!note.ok) throw new Error("note creation failed");

  say("add pick up the dry cleaning to my tasks");
  const task = await dispatch.runNoteAction("add pick up the dry cleaning to my tasks");
  console.log(JSON.stringify(task));
  if (!task.ok) throw new Error("task creation failed");

  say("remind me to take the chicken out at 3pm");
  const rem = await dispatch.runNoteAction("remind me to take the chicken out at 3pm");
  console.log(JSON.stringify(rem));
  if (!rem.ok) throw new Error("reminder creation failed");

  // Force the reminder to already be due and scan once (real app does this
  // on a timer; the notification must fire + be narrated when focused).
  say("(forcing reminder due + scanning scheduler)");
  const r = store.all().reminders[0];
  store.rearmReminder(r.id, new Date(Date.now() - 1000).toISOString());
  reminders.scanOnce(null);
  const ev = fired.find((f) => String(f.body || "").includes("chicken"));
  console.log("notification fired:", !!ev, ev ? { title: ev.title } : "");
  if (!ev) throw new Error("reminder notification never fired");

  say("mark pick up the dry cleaning done");
  const done = await dispatch.runNoteAction("mark pick up the dry cleaning done");
  console.log(JSON.stringify(done));
  if (!done.ok || !done.detail?.task?.done) throw new Error("task completion failed");

  say("what did I note about birthday");
  const search = await dispatch.runNoteAction("what did I note about birthday");
  console.log(JSON.stringify(search));
  if (!search.ok || !(search.detail?.matches?.length >= 1) ||
      !search.detail.matches.some((m) => m.text.toLowerCase().includes("birthday"))) {
    throw new Error("keyword search did not return the right note");
  }

  say("delete my note about my sister's birthday");
  const del = await dispatch.runNoteAction("delete my note about my sister's birthday");
  console.log(JSON.stringify(del));
  if (!del.ok) throw new Error("note deletion failed");

  say("classify: intent routing for notes phrases");
  for (const t of [
    "note that the garage code changed",
    "remind me in 5 minutes to stretch",
    "add call the vet to my tasks",
    "what's on my task list",
    "what did I note about pizza",
  ]) {
    const c = await classify(t);
    console.log(`  "${t}" → ${c.intent}`);
    if (c.intent !== "notes") throw new Error(`misclassified: ${t}`);
  }

  say("SMOKE OK");
  reminders.stop();
})().catch((e) => { console.error("HARNESS CRASH:", e.message); process.exit(1); });
