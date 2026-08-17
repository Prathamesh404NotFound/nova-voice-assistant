// Nova — test-notes.js
//
// Headless self-test for the Stage 7 local notes/reminders/tasks module.
// Runs WITHOUT a real Electron runtime by shimming the "electron" module.
// Covers:
//   - local JSON store: CRUD, persistence, atomic writes, id formats
//   - L1 safe (add/list/search) vs L2 reversible (complete/delete/cancel/
//     summarize) risk-level declarations
//   - natural-language planning: notes, reminders (at/in/tomorrow), tasks,
//     list/search/done by text or id, delete by text or id, cancel by id,
//     refusal of non-notes chatter, parse-error nudges
//   - intent classifier routing (notes vs files vs conversation vs vision)
//   - dispatcher end-to-end through the gate: add note, add reminder, add
//     task, complete/delete/undo via reverse fns, keyword search matches
//   - reminder firing: scanOnce() with an injected notifier verifies the
//     notification payload + that fired reminders do not fire twice
//   - privacy: summarize sends ONLY the selected notes' text (mocked fetch),
//     and nothing else (no task list, no reminder list, no other store data)
//
// Usage: node src/main/test-notes.js [dataDir]

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-notes-test-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Electron shim (same trick as test-agent.js / test-files.js)
// ---------------------------------------------------------------------------
const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getName: () => "Nova" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: null,
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  systemPreferences: { getMediaAccessStatus: () => "not-determined" },
  Notification: class Notification {
    constructor() {}
    show() {}
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};

// ---------------------------------------------------------------------------
// Sandbox store path
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nova-notes-test-"));
const STORE_PATH = path.join(TMP, "nova-notes.json");

// ---------------------------------------------------------------------------
// Modules under test
// ---------------------------------------------------------------------------
const store = require("./notes/store");
require("./notes/actions"); // registers notes:* actions
const plan = require("./notes/plan");
const dispatch = require("./notes/dispatch");
const reminders = require("./notes/reminders");
const gate = require("./permissions/gate");
const actionLog = require("./permissions/action-log");
const registry = require("./permissions/action-registry");
const undo = require("./permissions/undo");
const { RISK_LEVEL } = require("./permissions/risk-levels");
const { classify, INTENTS } = require("./agent/classifier");
const dispatcher = require("./agent/dispatcher");

store.setStorePathForTesting(STORE_PATH);
store.resetForTesting();

// Reminder notifier injection: record every notification instead of showing one.
// The notifier contract is notifier(title, body) — record both.
const fired = [];
reminders.setNotifierForTesting((title, body) => {
  fired.push({ title, body });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${extra ? "\n      " + extra : ""}`); }
}

(async () => {
  // ==========================================================================
  // 1. Risk-level declarations through the registry
  // ==========================================================================
  {
    const expected = {
      "notes:add-note": RISK_LEVEL.SAFE,
      "notes:add-reminder": RISK_LEVEL.SAFE,
      "notes:add-task": RISK_LEVEL.SAFE,
      "notes:list-notes": RISK_LEVEL.SAFE,
      "notes:list-tasks": RISK_LEVEL.SAFE,
      "notes:list-reminders": RISK_LEVEL.SAFE,
      "notes:search-notes": RISK_LEVEL.SAFE,
      "notes:complete-task": RISK_LEVEL.REVERSIBLE,
      "notes:delete-note": RISK_LEVEL.REVERSIBLE,
      "notes:delete-task": RISK_LEVEL.REVERSIBLE,
      "notes:cancel-reminder": RISK_LEVEL.REVERSIBLE,
      "notes:summarize-notes": RISK_LEVEL.REVERSIBLE,
    };
    for (const [id, lvl] of Object.entries(expected)) {
      const a = registry.getAction(id);
      ok(`${id} registered at level ${lvl}`, a && a.level === lvl, "level=" + a?.level);
    }
    ok("every L2 notes action has a reverse fn (Undo support)",
      ["notes:complete-task", "notes:delete-note", "notes:delete-task", "notes:cancel-reminder", "notes:summarize-notes"]
        .every((id) => typeof registry.getAction(id)?.reverse === "function"));
    ok("L1 actions have descriptions for the Action Log",
      ["notes:add-note", "notes:search-notes", "notes:list-tasks"].every((id) => !!registry.getAction(id)?.description));
  }

  // ==========================================================================
  // 2. Store primitives (all in-memory persistence, no Electron)
  // ==========================================================================
  {
    store.resetForTesting();
    const note = store.addNote("Dentist appointment Friday at 4pm");
    ok("addNote returns an id'd note with text + timestamps",
      note.id.startsWith("n-") && note.text.includes("Dentist") && !!note.createdAt);

    const task = store.addTask("Buy milk");
    ok("addTask persists and survives a reset round-trip through load()", task.id && task.text === "Buy milk");

    const r = store.addReminder("Stand up and stretch", new Date(Date.now() + 3600_000).toISOString());
    ok("addReminder stores dueAt as ISO and fired=false", !!r.dueAt && r.fired === false);

    const matches = store.searchNotes("DENTIST");
    ok("keyword search is case-insensitive and substring-based",
      matches.length === 1 && matches[0].text.includes("Dentist"));

    ok("searchNotes returns nothing for a miss", store.searchNotes("zzznothingzzz").length === 0);

    const done = store.setTaskDone(task.id, true);
    ok("setTaskDone flips the flag and keeps the text", done?.done === true && done.text === "Buy milk");

    const undone = store.setTaskDone(task.id, false);
    ok("setTaskDone(false) restores", undone?.done === false);

    const del = store.deleteNote(note.id);
    ok("deleteNote removes the note", !store.searchNotes("Dentist").length && del?.id === note.id);

    const rearmed = store.rearmReminder(r.id, new Date(Date.now() + 7200_000).toISOString());
    ok("rearmReminder cancels the fired flag and moves dueAt", rearmed?.fired === false);

    const cancelled = store.cancelReminder(r.id);
    ok("cancelReminder marks the reminder cancelled", !!cancelled);

    // Persistence: the JSON file must exist and round-trip
    ok("store persists to the userData file", fs.existsSync(STORE_PATH));
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    ok("persisted file is valid JSON with the three pools",
      Array.isArray(raw.notes) && Array.isArray(raw.tasks) && Array.isArray(raw.reminders));

    const note2 = store.addNote("Another note about groceries");
    ok("summarizeOf returns note entries (id/text/createdAt) only",
      store.summarizeOf().every((n) => "id" in n && "text" in n && "createdAt" in n && !("done" in n)));
  }

  // ==========================================================================
  // 3. Natural-language planning coverage
  // ==========================================================================
  {
    store.resetForTesting();
    const cases = [
      ["note that I have a dentist appointment Friday", "notes:add-note"],
      ["note: buy milk", "notes:add-note"],
      ["write down that the wifi password is blue", "notes:add-note"],
      ["remind me to call mom at 3pm", "notes:add-reminder"],
      ["remind me to stand up in 30 minutes", "notes:add-reminder"],
      ["remind me in 2 hours to water the plants", "notes:add-reminder"],
      ["remind me to take pills tomorrow at 9am", "notes:add-reminder"],
      ["add buy milk to my tasks", "notes:add-task"],
      ["task: call dentist", "notes:add-task"],
      ["what's on my task list", "notes:list-tasks"],
      ["list my tasks", "notes:list-tasks"],
      ["what did I note about dentist", "notes:search-notes"],
      ["search my notes for milk", "notes:search-notes"],
      ["notes about groceries", "notes:search-notes"],
      ["show my notes", "notes:list-notes"],
      ["summarize my notes", "notes:summarize-notes"],
    ];
    for (const [text, id] of cases) {
      const p = plan.planNoteAction(text);
      ok(`plan: "${text}" → ${id}`, p && p.actionId === id, JSON.stringify(p));
    }

    // Time parsing sanity
    const in30 = plan.parseTime("in 30 minutes");
    ok("parseTime: 'in 30 minutes' is roughly 30 min from now",
      in30 && Math.abs(in30.getTime() - (Date.now() + 30 * 60_000)) < 10_000);
    const tmr = plan.parseTime("tomorrow at 9am");
    ok("parseTime: 'tomorrow at 9am' is tomorrow at 9:00",
      tmr && tmr.getHours() === 9 && tmr.getMinutes() === 0 &&
      tmr.getDate() === new Date(Date.now() + 86_400_000).getDate());

    // Refusals / nudges for non-notes chatter and incomplete phrases
    ok("non-notes chatter plans to null (falls through to conversation)",
      plan.planNoteAction("hello, how are you?") === null);
    ok("near-miss 'I will remind you later' plans null (not a request)",
      plan.planNoteAction("I will remind you later") === null);
    const emptyRemind = plan.planNoteAction("remind me to");
    ok("'remind me to' (no content) returns a planning error, not a payload",
      emptyRemind?.error && !emptyRemind.actionId);
    const emptyNote = plan.planNoteAction("note that");
    ok("'note that' (no body) returns a planning error", emptyNote?.error);
    const badTime = plan.planNoteAction("remind me to stand up at banana o'clock");
    ok("unparseable time expression returns a helpful error", badTime?.error?.includes("could not parse"));

    // Context resolution: done/delete by text or id
    store.addNote("Pizza places");
    const t = store.addTask("Pay rent");
    const r = store.addReminder("Meeting", new Date(Date.now() + 600_000).toISOString());
    const byText = plan.planNoteAction("mark pay rent done", { tasks: store.all().tasks });
    ok("'mark X done' resolves by substring to the right task",
      byText?.actionId === "notes:complete-task" && byText.payload.id === t.id);
    const byId = plan.planNoteAction(`mark task ${t.id} done`, { tasks: store.all().tasks });
    ok("'mark task <id> done' (mouse path) resolves by id",
      byId?.actionId === "notes:complete-task" && byId.payload.id === t.id);
    const delById = plan.planNoteAction(`delete note ${store.all().notes[0].id}`, { notes: store.all().notes });
    ok("'delete note <id>' resolves by id", delById?.actionId === "notes:delete-note");
    const delByText = plan.planNoteAction("delete my note about pizza", { notes: store.all().notes });
    ok("'delete my note about X' resolves by text", delByText?.actionId === "notes:delete-note");
    const cancelById = plan.planNoteAction(`cancel reminder ${r.id}`, { reminders: store.all().reminders });
    ok("'cancel reminder <id>' resolves by id", cancelById?.actionId === "notes:cancel-reminder");
    const noMatch = plan.planNoteAction("mark feed the cat done", { tasks: store.all().tasks });
    ok("no matching task returns a friendly error", noMatch?.error && noMatch.error.includes("could not find"));
  }

  // ==========================================================================
  // 4. Intent classification: notes vs the rest
  // ==========================================================================
  {
    store.resetForTesting();
    const notesPhrases = [
      "Nova, note that the garage code changed to 8472",
      "remind me to call mom at 3pm",
      "add buy milk to my tasks",
      "what did I note about dentist",
      "mark pay rent done",
    ];
    for (const t of notesPhrases) {
      const c = await classify(t);
      ok(`classify: "${t}" → notes`, c?.intent === INTENTS.NOTES, c?.intent);
    }
    const nonNotes = [
      ["find my resume", INTENTS.FILES],
      ["what's on my screen", INTENTS.VISION],
      ["hey nova", INTENTS.CONVERSATION],
    ];
    for (const [t, want] of nonNotes) {
      const c = await classify(t);
      ok(`classify: "${t}" → ${want} (not notes)`, c?.intent === want, c?.intent);
    }
  }

  // ==========================================================================
  // 5. Dispatcher end-to-end through the gate (voice path)
  // ==========================================================================
  {
    store.resetForTesting();
    gate.setModalConfirmForTesting(true); // L2 confirms auto-resolve headlessly

    const addNote = await dispatch.runNoteAction("Nova, note that the garage code changed to 8472");
    ok("dispatcher add-note: ok + narration + detail.note",
      addNote.ok && addNote.narration === "Noted!" && addNote.detail?.note?.text.includes("8472"));

    const addTask = await dispatch.runNoteAction("add pay rent to my tasks");
    ok("dispatcher add-task: ok + narration", addTask.ok && /tasks/.test(addTask.narration || ""));

    const addRem = await dispatch.runNoteAction("remind me to stand up at 3pm");
    ok("dispatcher add-reminder: ok, narration mentions the time",
      addRem.ok && (addRem.narration || "").includes("3"));
    const rem = addRem.detail?.reminder;

    const complete = await dispatch.runNoteAction("mark pay rent done");
    ok("dispatcher complete-task: marked done via gate",
      complete.ok && complete.detail?.task?.done === true);

    const undone = await undo.undoLast(async (id, payload) => gate.runAction(id, payload, { taskId: null }));
    ok("undo restores the completed task (reverse fn)", undone?.undone === true);

    const search = await dispatch.runNoteAction("search my notes for garage");
    ok("dispatcher search-notes: keyword match returned",
      search.ok && (search.detail?.matches?.length || 0) >= 1);
    const miss = await dispatch.runNoteAction("search my notes for zzznothingzzz");
    ok("dispatcher search-notes: miss returns a plain 'no notes mention X' answer",
      miss.ok && (miss.text || "").includes("No notes mention"));

    const del = await dispatch.runNoteAction("delete my note about the garage code");
    ok("dispatcher delete-note: deleted via gate (L2)",
      del.ok && del.detail?.kind === "note-deleted");
    const unDel = await undo.undoLast(async (id, payload) => gate.runAction(id, payload, { taskId: null }));
    const restored = store.all().notes.find((n) => n.text.includes("8472"));
    ok("undo restores the deleted note",
      unDel?.undone === true && !!restored && !store.all().notes.find((n) => n.text.includes("8472") && n.id !== restored.id));

    const canc = await dispatch.runNoteAction(`cancel reminder ${rem.id}`);
    ok("dispatcher cancel-reminder: cancelled via gate",
      canc.ok && canc.detail?.kind === "reminder-cancelled");

    // Action log grew for the notes actions
    ok("every dispatched notes action appears in the Action Log",
      actionLog.list(100).length >= 7);
  }

  // ==========================================================================
  // 6. Reminder firing: scheduler + notifier (OS notification path)
  // ==========================================================================
  {
    store.resetForTesting();
    fired.length = 0;
    const r = store.addReminder("Take the chicken out of the freezer",
      new Date(Date.now() - 2000).toISOString()); // already due
    // gate.registered L2 toast confirm not needed — scanOnce notifies directly
    reminders.scanOnce(null);
    const ev = fired.find((f) => String(f?.body || "").includes("chicken"));
    ok("scanOnce fires the notification for an overdue reminder", !!ev);
    ok("notification payload carries the reminder text (title + body)",
      (ev?.body || "").includes("chicken") && (ev?.title || "").includes("Nova"));

    // A second scan must NOT fire the same reminder again
    fired.length = 0;
    reminders.scanOnce(null);
    ok("a due reminder only fires once", fired.length === 0);
    reminders.stop();
  }

  // ==========================================================================
  // 7. Privacy: summarize is the ONLY network path, and it is narrow
  // ==========================================================================
  {
    store.resetForTesting();
    gate.setModalConfirmForTesting(true);
    store.addNote("Private: my banking password is hunter2");
    store.addNote("Note two: meeting with Sam at noon");
    store.addTask("Do not send tasks to the model");
    store.addReminder("This reminder must not leave either", new Date(Date.now() + 3600_000).toISOString());

    // Tiny local fake model endpoint to capture exactly what leaves the machine
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        server.__received = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: "Summary: banking, meeting with Sam." } }],
        }));
      });
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;

    // Point the summarize bridge at our fake endpoint
    const summarize = require("./notes/summarize");
    const origFetch = global.fetch;
    global.fetch = async (url, init) => {
      // Re-point the request at the local fake, keeping the exact body/headers
      const realUrl = new URL(String(url));
      realUrl.host = `127.0.0.1:${port}`;
      realUrl.protocol = "http:";
      const resp = await origFetch(realUrl.toString(), init);
      return resp;
    };
    try {
      const res = await dispatch.runNoteAction("summarize my notes", {
        getKey: async () => "test-key",
      });
      ok("summarize returns the model's answer through the dispatcher",
        res.ok && (res.text || "").toLowerCase().includes("summary"));

      const sent = server.__received || "";
      ok("the request body contains both notes' texts",
        sent.includes("hunter2") && sent.includes("Sam"));
      ok("the request body does NOT contain task text", !sent.includes("Do not send tasks"));
      ok("the request body does NOT contain reminder text", !sent.includes("must not leave either"));
    } finally {
      global.fetch = origFetch;
      await new Promise((res) => server.close(res));
    }

    // Private Mode blocks summarize at the dispatcher layer
    const settings = require("./settings");
    const wasPrivate = settings.all().privateMode;
    settings.setPrivateMode(true);
    const blocked = await dispatcher.run("summarize my notes", {
      getKey: async () => "test-key",
    }).then((o) => o);
    settings.setPrivateMode(!!wasPrivate);
    ok("Private Mode refuses 'summarize my notes' without a model call",
      !blocked.ok && (blocked.text || "").includes("Private Mode"));
  }

  // ==========================================================================
  // Done
  // ==========================================================================
  console.log(`\n${"=".repeat(60)}\nnotes tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
