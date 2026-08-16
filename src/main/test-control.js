// Nova — test-control.js
//
// Headless self-test for the Stage 4 mouse & keyboard control feature.
// Runs WITHOUT a real Electron runtime by shimming the "electron" module,
// and with a mock input engine (setEngineForTesting) — so the planner,
// kill-switch and runner logic is tested deterministically and quickly.
//
// Usage: node src/main/test-control.js [dataDir]

const Module = require("module");
const path = require("path");
const fs = require("fs");

const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-ctrl-test-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Electron shim (same pattern as test-permissions.js)
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
};

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "electron") return shim;
  return origLoad.call(this, request, parent, ...rest);
};

// ---------------------------------------------------------------------------
// Modules under test (load the real ones; the shim above makes "electron"
// resolve cleanly, and test hooks exist for everything else).
// ---------------------------------------------------------------------------
// Vision mocks MUST be installed before anything loads the real modules
// (verify.js and runner.js cache their requires at module load time).
const VISION_ROOT = path.resolve(__dirname, "vision");
installVisionMocks();
const { compilePlan, normalizeExpr, DANGEROUS_COMBOS } = require("./control/planner");
const { SequenceController, SequenceAbortedError, sequence } = require("./control/kill-switch");
const input = require("./control/input");
const registry = require("./permissions/action-registry");
const gate = require("./permissions/gate");
const actionLog = require("./permissions/action-log");
const verifyModule = require("./control/verify");

// ---------------------------------------------------------------------------
// Mock input engine: records every call, moves no hardware.
// ---------------------------------------------------------------------------
const engineCalls = [];
const spyEngine = {
  Point: class { constructor(x, y) { this.x = x; this.y = y; } },
  Button: { LEFT: "left" },
  Key: new Proxy({}, { get: (_t, k) => k }),
  mouse: {
    move: async (p) => { engineCalls.push(["mouse.move", p.x, p.y]); },
    leftClick: async (n) => { engineCalls.push(["mouse.leftClick", n]); },
    rightClick: async () => { engineCalls.push(["mouse.rightClick"]); },
    scrollDown: async (n) => { engineCalls.push(["mouse.scrollDown", n]); },
    scrollUp: async (n) => { engineCalls.push(["mouse.scrollUp", n]); },
    scrollLeft: async (n) => { engineCalls.push(["mouse.scrollLeft", n]); },
    scrollRight: async (n) => { engineCalls.push(["mouse.scrollRight", n]); },
    drag: async (p) => { engineCalls.push(["mouse.drag", p.x, p.y]); },
  },
  keyboard: {
    type: async (t) => { engineCalls.push(["keyboard.type", t]); },
    pressKey: async (...k) => { engineCalls.push(["keyboard.pressKey", ...k]); },
    releaseKey: async (...k) => { engineCalls.push(["keyboard.releaseKey", ...k]); },
  },
  screen: { mousePosition: async () => ({ x: 100, y: 200 }) },
};

// ---------------------------------------------------------------------------
// Mock the gate's outcome: by default let every control action succeed, but
// allow tests to force "cancelled" or "blocked" to exercise halt paths.
// The toast/modal gate paths themselves are verified by test-permissions.js.
// ---------------------------------------------------------------------------
let gateOutcomeOverride = null;
const originalAppend = actionLog.append.bind(actionLog);
const gateCalls = [];
actionLog.append = (entry) => { gateCalls.push(entry); return originalAppend(entry); };

const realRunAction = gate.runAction;
const testRunAction = async (actionId, payload, opts = {}) => {
  gateCalls.push({ actionId, payload, dryRun: opts.dryRun });
  if (gateOutcomeOverride) return { outcome: gateOutcomeOverride, actionId };
  // Replay the real action so the mock engine gets exercised.
  return realRunAction(actionId, payload, opts);
};
gate.runAction = testRunAction;
// The runner destructures { runAction } from the gate module at load time,
// so patching `gate.runAction` alone is not enough — overwrite the export
// object that every require() of the gate module returns.
require.cache[require.resolve("./permissions/gate")].exports.runAction = testRunAction;

// ---------------------------------------------------------------------------
// Mock the vision modules so runner/verify never touch real capture/OCR.
// Mocks are installed via require.cache so any later require() of those
// paths returns the canned objects.
// ---------------------------------------------------------------------------
function installVisionMocks(ocrText = "0") {
  const ocrRes = { text: ocrText, words: [{ text: ocrText, bbox: { x0: 10, y0: 10, x1: 40, y1: 40 }, conf: 95 }] };
  require.cache[require.resolve(path.join(VISION_ROOT, "ocr"))] = {
    id: require.resolve(path.join(VISION_ROOT, "ocr")),
    filename: require.resolve(path.join(VISION_ROOT, "ocr")),
    loaded: true,
    exports: { recognizeText: async () => ocrRes },
  };
  require.cache[require.resolve(path.join(VISION_ROOT, "screenshot"))] = {
    id: require.resolve(path.join(VISION_ROOT, "screenshot")),
    filename: require.resolve(path.join(VISION_ROOT, "screenshot")),
    loaded: true,
    exports: { captureScreen: async () => ({ buffer: Buffer.from("mock"), width: 800, height: 600, permissionMissing: false }) },
  };
  require.cache[require.resolve(path.join(VISION_ROOT, "ui-detector"))] = {
    id: require.resolve(path.join(VISION_ROOT, "ui-detector")),
    filename: require.resolve(path.join(VISION_ROOT, "ui-detector")),
    loaded: true,
    exports: { detectUIElements: async () => ({ buttons: [], inputs: [] }) },
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
function assert(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`PASS: ${label}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  installVisionMocks();
  input.setEngineForTesting(spyEngine);

  const control = require("./control");
  control.init();

  // ============================================================ 1. Planner
  // The flagship demo: "open the system calculator and compute 12 x 8"
  let plan = compilePlan("open the system calculator and compute 12 x 8");
  assert(plan.ok && plan.plan.length === 4, "calculator demo compiles into 4 steps");
  const ids = plan.plan.map((s) => s.id);
  assert(ids[0].startsWith("open-") && ids[1].startsWith("wait-") && ids[2].startsWith("type-") && ids[3].startsWith("enter-"), "step IDs are ordered open/wait/type/enter");
  assert(plan.plan[0].actionId === "control:open-app", "step 1 opens the calculator app");
  assert(plan.plan[1].actionId === "control:wait-for-window", "step 2 verifies the window with vision");
  assert(plan.plan[2].actionId === "control:type-text", "step 3 types the expression");
  assert(plan.plan[3].actionId === "control:press-keys", "step 4 presses Return");
  assert(plan.plan[0].level === 1 && plan.plan[1].level === 1, "open + wait are Level 1 (safe)");
  assert(plan.plan[2].level === 2, "typing is Level 2 (reversible)");
  assert(plan.plan[3].level === 3, "submitting (Return) is Level 3 (sensitive)");
  assert(plan.plan[2].payload.text === "12 * 8", "expression normalized: 12 x 8 → 12 * 8");

  // More expression normalizations
  plan = compilePlan("calculate 5 divided by 2");
  assert(plan.ok && plan.plan[2].payload.text === "5 / 2", "normalize: divided by → /");
  plan = compilePlan("compute 100 plus 25 times 4");
  assert(plan.ok && plan.plan[2].payload.text === "100 + 25 * 4", "normalize: plus/times → +/*");

  // Refuses non-numeric payloads
  plan = compilePlan("compute rm -rf /");
  assert(!plan.ok, "compute refuses non-numeric payloads");
  plan = compilePlan("calculate hello world");
  assert(!plan.ok, "calculate refuses text without numbers");

  // Open-only
  plan = compilePlan("open Notepad");
  assert(plan.ok && plan.plan.length === 1 && plan.plan[0].actionId === "control:open-app", "open-only compiles");

  // Clicks
  plan = compilePlan("click Save");
  assert(plan.ok && plan.plan[0].actionId === "control:left-click" && plan.plan[0].level === 2, "click is L2");
  plan = compilePlan("double-click the document");
  assert(plan.ok && plan.plan[0].actionId === "control:double-click", "double-click compiles");
  plan = compilePlan("right-click the desktop");
  assert(plan.ok && plan.plan[0].actionId === "control:right-click", "right-click compiles");

  // Type
  plan = compilePlan('type "hello world" into the search box');
  assert(plan.ok && plan.plan[0].actionId === "control:type-text" && plan.plan[0].payload.into === "the search box", "type-into compiles with target field");
  plan = compilePlan("type " + "x".repeat(250));
  assert(!plan.ok, "type refuses text over 200 chars");
  plan = compilePlan("type");
  assert(!plan.ok, "type with nothing typed is refused");

  // Submit
  plan = compilePlan("submit");
  assert(plan.ok && plan.plan[0].payload.combo === "Return" && plan.plan[0].level === 3, "submit → Return at Level 3");
  plan = compilePlan("press Enter");
  assert(plan.ok && plan.plan[0].level === 3, "\"press Enter\" is Level 3");

  // Press keys: dangerous combos escalate to L3
  plan = compilePlan("press Ctrl+W");
  assert(plan.ok && plan.plan[0].level === 3, "Ctrl+W escalates to Level 3");
  plan = compilePlan("press Ctrl+Q");
  assert(plan.ok && plan.plan[0].level === 3, "Ctrl+Q escalates to Level 3");
  plan = compilePlan("press Alt+F4");
  assert(plan.ok && plan.plan[0].level === 3, "Alt+F4 escalates to Level 3");
  plan = compilePlan("press Ctrl+T");
  assert(plan.ok && plan.plan[0].level === 2, "harmless Ctrl+T stays Level 2");
  plan = compilePlan("press Ctrl+Z");
  assert(plan.ok && plan.plan[0].level === 3, "Ctrl+Z escalates to Level 3");

  // Wait for
  plan = compilePlan("wait for Notepad");
  assert(plan.ok && plan.plan[0].actionId === "control:wait-for-window" && plan.plan[0].level === 1, "wait-for-window compiles at L1");

  // Unplannable
  plan = compilePlan("make me a coffee");
  assert(!plan.ok, "unknown instructions are refused");

  // Dangerous combo regex coverage
  assert(DANGEROUS_COMBOS.some((rx) => rx.test(" ctrl+w ")), "dangerous combos matches ctrl+w");
  assert(DANGEROUS_COMBOS.some((rx) => rx.test(" alt+f4 ")), "dangerous combos matches alt+f4");
  assert(!DANGEROUS_COMBOS.some((rx) => rx.test(" ctrl+c ")), "ctrl+c is NOT dangerous");

  // ========================================================= 2. Kill-switch
  // Use the exported SINGULAR sequence controller: this is the same object
  // runSequence() drives, so its step events land in the `events` array
  // that the runner tests assert on.
  sequence.reset();
  const events = [];
  sequence.setEmitter((e) => events.push(e));
  const seq = sequence;
  assert(seq.abort("test") === false, "abort is a no-op when idle");
  seq.reviewing("p1");
  assert(seq.state === "reviewing" && seq.isRunning === false, "reviewing state entered");
  assert(seq.start() === true, "start transitions reviewing → running");
  assert(seq.isRunning, "sequence reports running");
  assert(seq.start() === false, "double start is refused");
  seq.emit({ type: "step", stepId: "s1", status: "running", note: "" });
  let aborted = null;
  try { seq.guardStep("s2"); } catch (e) { aborted = e; }
  assert(aborted === null, "guardStep passes while running");
  assert(seq.abort("test") === true, "abort returns true while running");
  assert(seq.isAborted && !seq.isRunning, "aborted state flags set");
  try { seq.guardStep("s3"); } catch (e) { aborted = e; }
  assert(aborted instanceof SequenceAbortedError, "guardStep throws SequenceAbortedError after abort");
  assert(events.some((e) => e.reason === "test"), "abort reason flows through emitter");
  assert(seq.abort("again") === false, "second abort on finished sequence is a no-op");
  seq.reset();

  // ========================================================= 3. Runner
  const { runSequence } = require("./control/runner");

  // Happy path: the calculator demo plan executes top-to-bottom.
  function calcPlan() {
    const p = compilePlan("open the system calculator and compute 12 x 8");
    return p.plan;
  }
  sequence.reset();
  sequence.reviewing("p-happy");
  sequence.start();
  let result = await runSequence({ plan: calcPlan() });
  assert(result.finished === "done", "happy path finishes done");
  assert(engineCalls.some((c) => c[0] === "keyboard.type" && c[1] === "12 * 8"), "expression was typed");
  assert(engineCalls.some((c) => c[0] === "keyboard.pressKey" && c.includes("Return")), "Return was pressed after typing");
  assert(gateCalls.some((g) => g.actionId === "control:open-app"), "app launch went through the gate");
  assert(gateCalls.some((g) => g.actionId === "control:wait-for-window"), "vision wait step went through the gate");

  // Abort mid-sequence: kill mid-run by intercepting a step.
  events.length = 0;
  gateCalls.length = 0; engineCalls.length = 0;
  result = await (async () => {
    const steps = calcPlan();
    const origType = spyEngine.keyboard.type;
    spyEngine.keyboard.type = async (t) => {
      engineCalls.push(["intercept.abort"]);
      sequence.abort("mid-step test");
      return origType(t);
    };
    sequence.reset();
    sequence.reviewing("p2");
    sequence.start();
    const r = await runSequence({ plan: steps });
    spyEngine.keyboard.type = origType;
    return r;
  })();
  assert(result.finished === "aborted", "mid-step abort yields finished=aborted");
  assert(result.failedStepId && (result.failedStepId.startsWith("type-") || result.failedStepId.startsWith("enter-")), "the interrupted step is reported");
  assert(events.some((e) => e.status === "aborted"), "remaining steps are marked aborted");

  // Cancelled outcome (user cancelled the toast/modal) halts the sequence.
  events.length = 0;
  gateCalls.length = 0;
  gateOutcomeOverride = "cancelled";
  sequence.reset();
  sequence.reviewing("p-cancelled");
  sequence.start();
  result = await runSequence({ plan: calcPlan() });
  gateOutcomeOverride = null;
  assert(result.finished === "failed", "cancelled step halts the sequence");
  assert(events.some((e) => e.status === "cancelled"), "remaining steps are marked cancelled, not silently skipped");

  // Blocked outcome (Private Mode) halts similarly.
  events.length = 0;
  gateCalls.length = 0;
  gateOutcomeOverride = "blocked";
  sequence.reset();
  sequence.reviewing("p-blocked");
  sequence.start();
  result = await runSequence({ plan: calcPlan() });
  gateOutcomeOverride = null;
  assert(result.finished === "failed", "private-mode block halts the sequence");

  // Vision verification failure halts after a wait step.
  events.length = 0;
  sequence.reset();
  sequence.reviewing("p-vision");
  sequence.start();
  installVisionMocks("nothing here");
  const _vKey = require.resolve("./control/verify");
  const _origVerify = require.cache[require.resolve("./control/verify")].exports.verifyWindow;
  require.cache[require.resolve("./control/verify")].exports.verifyWindow = async (opts) => ({
    ok: false, found: [], screenshotTaken: true,
    note: `expected "${opts.contains || "?"}" was not found on screen (1 check before giving up)`,
  });
  require.cache[_vKey].exports.verifyWindow = async (opts) => ({
    ok: false, found: [], screenshotTaken: true,
    note: `expected "${opts.contains || "?"}" was not found on screen (1 check before giving up)`,
  });
  result = await runSequence({ plan: calcPlan() });
  require.cache[_vKey].exports.verifyWindow = _origVerify;
  assert(result.finished === "failed", "failed vision verification halts the sequence");
  assert(events.some((e) => e.status === "failed" && /verification/i.test(e.note || "")), "verification failure note reaches the renderer events");
  installVisionMocks("0");

  // ==================================================== 4. Action registry
  // listActions() deliberately returns a plain view (id/level/description);
  // the full entries — including simulate() and the physical flag — are
  // retrieved through getAction(), which is what the gate uses.
  assert(registry.getAction("control:left-click").level === 2 && registry.getAction("control:left-click").physical, "left-click registered L2 physical");
  assert(!registry.getAction("control:cursor-position").physical, "cursor-position is non-physical (read-only)");
  assert(registry.getAction("control:press-keys").level === 3, "press-keys registered L3");
  assert(registry.getAction("control:open-app").level === 1, "open-app registered L1");
  assert(registry.getAction("control:scroll").level === 2, "scroll registered L2");
  assert(registry.getAction("control:drag").level === 2, "drag registered L2");
  // Every L2+ control action must have simulate() for the toast/modal.
  const missing = registry.listActions().filter((a) => a.id.startsWith("control:") && a.level >= 2 && typeof registry.getAction(a.id).simulate !== "function");
  assert(missing.length === 0, `every L2+ control action has simulate() (${missing.length} missing)`);

  // Describe helpers produce plain-language descriptions.
  const desc = input.describe;
  assert(desc.click({ x: 10, y: 20, label: "Save" }).title.includes("Save"), "click describe gives plain language");
  assert(desc.typeText({ text: "hello" }).title.includes("hello"), "typeText describe includes the text");
  assert(desc.pressKeys({ combo: "Ctrl+W" }).title.toLowerCase().includes("press"), "pressKeys describe names the combo");

  // ========================================================= 5. Launcher
  const launcher = require("./control/launcher");
  assert(launcher.resolveApp("calc", "darwin").resolved === "Calculator", "calc alias → Calculator on macOS");
  assert(launcher.resolveApp("calc", "win32").resolved === "calc.exe", "calc alias → calc.exe on Windows");
  assert(launcher.resolveApp("gnome-calculator", "linux").resolved === "gnome-calculator", "passthrough on Linux");

  // ===================================================== 6. Verify module
  const v = await verifyModule.verifyWindow({ contains: "0" });
  assert(v.ok === true && v.screenshotTaken, "verifyWindow reports ok + screenshotTaken on success");
  const v2 = await verifyModule.verifyWindow({ contains: "nosuchthing", waitMs: 100 });
  assert(v2.ok === false && v2.note.length > 0, "verifyWindow reports failure with a note");

  console.log("");
  if (process.exitCode) console.error("Some control tests FAILED — see above.");
  else console.log("All mouse/keyboard-control tests PASSED.");
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  process.exitCode = 1;
});
