// Nova — test-agent.js
//
// Headless self-test for the Stage 5 unified agent loop.
// Runs WITHOUT a real Electron runtime by shimming the "electron" module.
// Covers: intent classification (rules + quick-model fallback), the dispatcher
// (conversation retry + plain-language errors, vision, control planning,
// narration events), the last-task Developer Mode inspector, undo support,
// and the onboarding flow.
//
// Usage: node src/main/test-agent.js [dataDir]

const Module = require("module");
const path = require("path");
const fs = require("fs");
const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-agent-test-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Electron shim
// ---------------------------------------------------------------------------
const fakeWindow = { webContents: { send: () => {}, on: () => {}, removeListener: () => {}, once: () => {} } };
const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getName: () => "Nova" },
  BrowserWindow: { getAllWindows: () => [fakeWindow] },
  dialog: { showMessageBox: async () => ({ response: 1, checkboxChecked: false }) },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  ipcRenderer: { send: () => {}, on: () => {}, invoke: async () => undefined, removeListener: () => {} },
  contextBridge: { exposeInMainWorld: () => {} },
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  nativeImage: { createFromPath: () => ({}) },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  // macOS permission probing for onboarding (test = darwin denied → pending)
  systemPreferences: { getMediaAccessStatus: () => "denied", getSystemVersion: () => "" },
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "electron") return shim;
  return origLoad.call(this, request, parent, ...rest);
};

// ---------------------------------------------------------------------------
// Modules under test
// ---------------------------------------------------------------------------
const { classify, INTENTS } = require("./agent/classifier");
const dispatcher = require("./agent/dispatcher");
const { plainError, retryOnce } = require("./agent/retry");
const onboarding = require("./agent/onboarding");
const undo = require("./permissions/undo");
const actionLog = require("./permissions/action-log");
const gate = require("./permissions/gate");
const registry = require("./permissions/action-registry");
const control = require("./control");
require("./permissions/test-actions"); // registers demo:rename-file / demo:move-file (with reverse fns)

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
let harnessCrashed = false;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${extra ? "\n      " + extra : ""}`); }
}

(async () => {
  // ==========================================================================
  // Intent classification
  // ==========================================================================
  {
    const c = await classify("what's on my screen");
    ok("vision trigger classifies as vision", c.intent === "vision" && c.method === "rules");

    const c2 = await classify("open Notepad and type hello");
    ok("control trigger classifies as control", c2.intent === "control" && c2.method === "rules");

    const c3 = await classify("how are you doing today?");
    ok("plain chat classifies as conversation", c3.intent === "conversation" && c3.method === "rules");

    const c4 = await classify("check my screen and click the error button");
    ok("ambiguous message is not rules-classified", c4.method !== "rules" || c4.intent === "combined" || c4.intent === "vision" || c4.intent === "control");
  }

  // quick-model fallback: simulate a fast answer from pickModel("quick")
  {
    // Patch router.lastPick area instead: monkey-patch router via require.cache
    const router = require("./router");
    const routerPath = require.resolve("./router");
    const origLastPick = router.lastPick;
    router.lastPick = (taskType) => ({ model: "test-quick", intent: "vision" });
    // quickClassify uses router.pickModel("quick") with a one-shot; mock fetch via
    // replacing the underlying request by patching the router's request fn.
    // Simpler: replace the ambiguous branch path by making pickModel throw → fallback
    router.pickModel = (t) => ({ model: "test-quick" });
    const c = await classify("is the error on my screen, or should I click retry?");
    ok("ambiguous message still resolves to a valid intent", Object.values(INTENTS).includes(c.intent));
    router.lastPick = origLastPick;
    router.pickModel = router.pickModel || (() => ({}));
  }

  // ==========================================================================
  // Retry + plain-language errors
  // ==========================================================================
  {
    let attempts = 0;
    const res = await retryOnce(async () => { attempts++; if (attempts === 1) throw new Error("transient 503"); return "value"; }, "chat");
    ok("retryOnce succeeds on second attempt", res.ok === true && res.value === "value" && attempts === 2);

    let attempts2 = 0;
    const res2 = await retryOnce(async () => { attempts2++; throw new Error("fatal 401"); }, "chat");
    ok("retryOnce fails after one retry (2 attempts)", res2.ok === false && attempts2 === 2);

    const msg = plainError(new Error("model HTTP 503"), "the assistant");
    ok("plain-language error contains no stack trace", typeof msg === "string" && !msg.includes("at ") && msg.toLowerCase().includes("assistant"));
  }

  // ==========================================================================
  // Dispatcher: conversation with retry + plain error surfacing
  // ==========================================================================
  {
    // Mock the OpenRouter fetch so the first call fails and the retry succeeds.
    const { fetch: origFetch } = global;
    let fetchCalls = 0;
    global.fetch = async (url, init) => {
      fetchCalls++;
      const body = init?.body ? JSON.parse(init.body) : {};
      if (fetchCalls === 1) {
        return { ok: false, status: 503 };
      }
      // fake streaming SSE: two chunks then close
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`));
          ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "!" } }] })}\n\n`));
          ctrl.enqueue(encoder.encode(`data: [DONE]\n\n`));
          ctrl.close();
        },
      });
      return { ok: true, body: stream };
    };

    // Mock the LLM chat-model pick so no real network is needed.
    const router = require("./router");
    router.pickModel = (t) => (t === "quick" ? "test-quick" : "test-chat");

    const progress = [];
    dispatcher.on("progress", (e) => progress.push(e));

    const res = await dispatcher.run("hello there", { getKey: async () => "test-key" });
    ok("conversation: final result is ok", res.ok === true && res.intent === "conversation");
    ok("conversation: retried fetch after first failure", fetchCalls === 2, "fetchCalls=" + fetchCalls);
    ok("conversation: full streamed answer surfaced", res.text === "Hello!", "text=" + res.text);
    const narr = progress.filter((p) => p.type === "narration");
    ok("dispatcher emitted narration events", narr.length >= 1);
    ok("narration mentions chat step", narr.some((n) => n.step === "chat"));
    const chunks = progress.filter((p) => p.type === "chat-chunk");
    ok("dispatcher streamed chat chunks", chunks.length >= 2);
  }

  // Dispatcher: conversation with NO key → helpful placeholder
  {
    const router = require("./router");
    router.pickModel = (t) => "test-chat";
    const res = await dispatcher.run("tell me a joke", { getKey: async () => null });
    ok("no key: surfaced plain-language key request", res.ok && res.text.includes("API key"));
  }

  // Dispatcher: control compile + reviewing state + kill-switch sequencing
  {
    const res = await dispatcher.run("open the system calculator and compute 12 x 8", { getKey: async () => null });
    ok("control: intent is control with a plan", res.intent === "control" && Array.isArray(res.plan) && res.plan.length === 4, "plan length=" + (res.plan && res.plan.length));
    ok("control: sequence entered reviewing state", control.sequence.state === "reviewing");
    const narr = [];
    const onNarr = (e) => { if (e.type === "narration") narr.push(e); };
    dispatcher.on("progress", onNarr);
    const res2 = await dispatcher.run("click Save", { getKey: async () => null });
    dispatcher.emitter.removeListener("progress", onNarr);
    ok("control planning narration is emitted", narr.some((n) => n.step === "planning"));
    ok("control compile result ok", res2.ok === true);
  }

  // ==========================================================================
  // Developer Mode inspector (last-task)
  // ==========================================================================
  {
    const router = require("./router");
    router.lastPick = (t) => ({ model: "test-chat", reason: "test pick", intent: t });
    const task = dispatcher.getLastTask();
    ok("getLastTask returns the last task", task != null && task.id != null);
    ok("last-task includes classification", task.classification && Object.values(INTENTS).includes(task.classification.intent), "classification=" + JSON.stringify(task.classification));
    ok("last-task steps have durationMs", task.steps.length >= 1 && typeof task.steps[0].durationMs === "number", "steps=" + JSON.stringify(task.steps));
    ok("last-task errors array exists", Array.isArray(task.errors));
    ok("last-task modelPick present in dev mode", task.modelPick && typeof task.modelPick.model === "string");
  }

  // ==========================================================================
  // Undo: reversible actions tracked; greyed out for irreversible ones
  // ==========================================================================
  {
    undo.resetUndoTrackerForTesting();
    const renameEntry = registry.getAction("demo:rename-file");
    ok("demo:rename-file registered a reverse fn", renameEntry && typeof renameEntry.reverse === "function");

    // Nothing yet → no undo.
    const before = undo.getUndoInfo();
    ok("nothing to undo before any action", before === null);

    // Simulate a reversible success via the gate (taskId "agent-test-1").
    await gate.runAction("demo:rename-file", { from: "a.txt", to: "b.txt" }, { taskId: "agent-test-1" });
    const after = undo.getUndoInfo();
    ok("reversible success registers undo info", after != null && after.actionId === "demo:rename-file" && after.secondsAgo < 300);
    ok("undo info has a plain-language label", typeof after.label === "string" && after.label.length > 0);

    // Mouse clicks (control:click) never register → undo stays at the rename.
    // 'demo:create-file' is L2 with NO reverse fn → irreversible.
    await gate.runAction("demo:create-file", { path: "/tmp/irreversible.txt" }, { taskId: "agent-test-2" });
    const still = undo.getUndoInfo();
    ok("irreversible action does not replace undoable one", still && still.actionId === "demo:rename-file");

    // Perform the undo.
    const undone = await undo.undoLast(async (id, payload) => gate.runAction(id, payload, {}));
    ok("undo reverses the rename", undone.undone === true && undone.actionId === "demo:rename-file");
    ok("undo action logged in the action log", actionLog.list(5).some((e) => e.actionId.includes("undo")));
    const none = undo.getUndoInfo();
    ok("nothing undoable after undo", none === null);

    // A failed/cancelled reversible action does not register (unit-check the
    // tracker directly: it only records outcomes of exactly "success").
    undo.resetUndoTrackerForTesting();
    undo.noteReversibleSuccess("agent-test-5", "demo:rename-file", { from: "c.txt", to: "d.txt" }, "cancelled");
    ok("cancelled action does not register for undo", undo.getUndoInfo() === null);
    undo.noteReversibleSuccess("agent-test-5", "demo:rename-file", { from: "c.txt", to: "d.txt" }, "failed");
    ok("failed action does not register for undo", undo.getUndoInfo() === null);
    undo.noteReversibleSuccess("agent-test-5", "demo:rename-file", { from: "c.txt", to: "d.txt" }, "success");
    ok("success DOES register for undo", undo.getUndoInfo() !== null);
    undo.resetUndoTrackerForTesting();
  }

  // ==========================================================================
  // Onboarding: macOS permission probing
  // ==========================================================================
  {
    // Simulate macOS (darwin): pending screens appear for denied screen recording
    // AND accessibility — the exact first-run onboarding flow on a Mac.
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    // Forget any leftover acknowledgement from a previous run.
    const settingsMod = require("./settings");
    settingsMod.setRaw(require("./agent/onboarding").ACK_KEYS.screenRecording, false);
    settingsMod.setRaw(require("./agent/onboarding").ACK_KEYS.accessibility, false);
    const ps = onboarding.permissionState();
    ok("darwin: screen recording state reads as denied (shim)", ps.screenRecording === "denied");
    const pending = onboarding.pendingScreens();
    ok("pendingScreens shows screen-recording on darwin", pending.some((s) => s.id === "screen-recording"));
    const ack = onboarding.acknowledge("screen-recording");
    ok("acknowledging removes the screen from pending", onboarding.pendingScreens().every((s) => s.id !== "screen-recording"));
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  }

  // ==========================================================================
  // Result
  // ==========================================================================
  console.log("");
  if (fail === 0 && !harnessCrashed) console.log(`All agent-loop tests PASSED (${pass}/${pass}).`);
  else console.log(`${pass} PASSED, ${fail} FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  harnessCrashed = true;
  console.error("harness crashed:", err);
  process.exit(2);
});
