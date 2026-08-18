// Nova — test-screenshot-note.js
//
// Headless self-test for Round 12: screenshot-to-note ("Nova, note what's on
// my screen"). Runs WITHOUT a real Electron runtime by shimming "electron"
// via the shared shim-electron.js file and by re-registering the vision
// capture action with a fake source (no desktopCapturer needed).
//
// Covers:
//   - planner recognizes screen-note phrasings BEFORE plain "note …" notes
//   - notes:screen-to-note is registered at Level 1 (SAFE), never higher
//   - end-to-end: capture (fake buffer) → OCR (mocked worker) → local note
//     with [screen] tag; note text never leaves the machine (mocked fetch)
//   - capture failure surfaces a plain-language error instead of throwing
//   - unreadable screen (empty OCR) surfaces a friendly nudge
//   - the Action Log never stores image bytes (buffer stripped at the gate)
//
// Usage: node src/main/test-screenshot-note.js [dataDir]
const Module = require("module");
const path = require("path");
const fs = require("fs");

const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-screen-note-test-data");
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Electron shim + outbound call block
// ---------------------------------------------------------------------------
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
// Block any outbound model call — the screen-note path is fully local;
// an unexpected network call is a test failure.
let fetchCallCount = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, ...rest) => {
  fetchCallCount += 1;
  throw new Error("[test] unexpected outbound call blocked in headless harness");
};

// ---------------------------------------------------------------------------
// 2. Load modules under test
// ---------------------------------------------------------------------------
const store = require("./notes/store");
const plan = require("./notes/plan");
const dispatch = require("./notes/dispatch");
const settings = require("./settings");
const gate = require("./permissions/gate");
const registry = require("./permissions/action-registry");
const actionLog = require("./permissions/action-log");
const screenshotNote = require("./notes/screenshot-note");
const visionActions = require("./vision/vision-actions");
const ocr = require("./vision/ocr");

const STORE_PATH = path.join(DATA_DIR, "nova-notes.json");
store.setStorePathForTesting(STORE_PATH);
store.resetForTesting();

// ---------------------------------------------------------------------------
// 3. Fake sources for the two external dependencies:
//      captureScreen → a synthetic PNG buffer
//      ocr → a deterministic transcript (no tesseract worker in headless)
// ---------------------------------------------------------------------------
const FAKE_PNG = buildFakePng();
let captureShouldFail = false;
let ocrText = "The quick brown fox jumps over the lazy dog";
function buildFakePng() {
  // Minimal valid PNG bytes (8x8 white image) — tesseract would choke on it,
  // but our OCR is mocked, and the buffer identity is what matters here.
  const sig = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x4b, 0x6d, 0x29, 0xde, 0x00, 0x00, 0x00,
    0x01, 0x73, 0x52, 0x47, 0x42, 0x00, 0xae, 0xce, 0x1c, 0xe9, 0x00, 0x00,
    0x00, 0x09, 0x70, 0x48, 0x59, 0x73, 0x00, 0x00, 0x0e, 0xc3, 0x00, 0x00,
    0x0e, 0xc3, 0x01, 0xc7, 0x6f, 0xa8, 0x64, 0x00, 0x00, 0x00, 0x0c, 0x49,
    0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x60, 0x60, 0xf8, 0x0f, 0x00,
    0x00, 0x01, 0x01, 0x00, 0x05, 0x18, 0xd8, 0x4e, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return sig;
}
// Replace the real vision capture action (desktopCapturer) with a fake that
// returns FAKE_PNG — same contract as the real one, unregister first so
// re-registration doesn't throw.
const realVisionAction = registry.getAction("vision:capture-screen");
registry.unregisterActionForTesting("vision:capture-screen");
registry.registerAction({
  id: "vision:capture-screen",
  level: realVisionAction.level,
  description: realVisionAction.description,
  simulate: realVisionAction.simulate,
  execute: async (payload = {}) => {
    if (captureShouldFail) throw new Error("simulated screen-capture failure");
    const detail = { durationMs: 4, width: 640, height: 240, note: "captured screen 640x240", permissionMissing: false, status: "granted" };
    if (payload && payload.forNotes) detail.buffer = FAKE_PNG;
    return detail;
  },
});
// Mock OCR: bypass the tesseract worker entirely.
ocr.recognizeText = async (buf) => {
  if (!buf || !buf.length) return { text: "", words: [], confidentText: "" };
  return { text: ocrText, words: ocrText.split(/\s+/).map((t) => ({ text: t, conf: 80 })), confidentText: ocrText };
};

// ---------------------------------------------------------------------------
// 4. Test harness helpers
// ---------------------------------------------------------------------------
let passCount = 0, failCount = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ok   ${label}`); passCount += 1; }
  else { console.log(`  FAIL ${label}`); failCount += 1; }
}

async function resetState() {
  store.resetForTesting();
  captureShouldFail = false;
  ocrText = "The quick brown fox jumps over the lazy dog";
  fetchCallCount = 0;
}

// ---------------------------------------------------------------------------
// 5. Tests
// ---------------------------------------------------------------------------
(async function main() {
  console.log("Screenshot-to-note tests");

  // --- Planning -----------------------------------------------------------
  const screenPhrasings = [
    "note what is on my screen",
    "nova, note what's on my screen",
    "note my screen",
    "save my screen",
    "capture the screen",
    "write down what is on my screen",
    "snap the screen and note it",
  ];
  for (const phrase of screenPhrasings) {
    const p = plan.planNoteAction(phrase);
    assert(p && p.actionId === "notes:screen-to-note" && !p.error, `planner routes "${phrase}" → notes:screen-to-note`);
  }
  // Regression: a plain text note must NOT be swallowed by the screen rule.
  const plain = plan.planNoteAction("note that I have a dentist appointment Friday");
  assert(plain && plain.actionId === "notes:add-note" && plain.payload.text.includes("dentist"),
    "plain 'note that …' still routes to notes:add-note, not the screen rule");
  // Vision queries ("what is on my screen") must NOT enter the notes planner.
  const visionPhrase = plan.planNoteAction("what is on my screen");
  assert(visionPhrase === null, "'what is on my screen' is a vision query, not a notes action");

  // --- Registration -------------------------------------------------------
  const action = registry.getAction("notes:screen-to-note");
  assert(!!action, "notes:screen-to-note is registered");
  const { RISK_LEVEL } = require("./permissions/risk-levels");
  assert(action.level === RISK_LEVEL.SAFE, "notes:screen-to-note is Level 1 (SAFE) — immediate, never modal");
  const dry = await action.simulate({ text: "project kickoff details" });
  assert(dry && dry.wouldDo.includes("note"), "simulate() describes the would-do plan");

  // --- End-to-end happy path ---------------------------------------------
  await resetState();
  const r1 = await dispatch.runNoteAction("note what is on my screen");
  assert(r1.ok, "dispatch happy path succeeds");
  assert(r1.intent === "notes" && r1.actionId === "notes:screen-to-note", "result carries the screen-note action id");
  assert(r1.text.includes("quick brown fox"), "chat answer echoes the OCR transcript");
  const saved = store.all().notes;
  assert(saved.length === 1, "exactly one note is created");
  assert(saved[0].text.startsWith("[screen]"), "the note is tagged [screen]");
  assert(saved[0].text.includes("quick brown fox"), "OCR transcript is saved verbatim into the note");
  assert(fetchCallCount === 0, "end-to-end path made ZERO outbound network calls (works in Private Mode)");

  // --- Optional comment body on the screen -------------------------------
  await resetState();
  const r2 = await dispatch.runNoteAction("note my screen");
  assert(r2.ok, "plain 'note my screen' also works");
  assert(store.all().notes[0].text.startsWith("[screen]"), "plain phrasing is still tagged [screen]");

  // --- Capture failure surfaces a plain-language nudge -------------------
  await resetState();
  captureShouldFail = true;
  const r3 = await dispatch.runNoteAction("note what is on my screen");
  assert(!r3.ok && !/stack|Error|at Object/.test(r3.text), "capture failure → friendly plain-language nudge (no stack trace)");
  assert(store.all().notes.length === 0, "capture failure leaves the note store empty");

  // --- Empty OCR (unreadable screen) -------------------------------------
  await resetState();
  captureShouldFail = false;
  ocrText = "";
  const r4 = await dispatch.runNoteAction("note what is on my screen");
  assert(!r4.ok && /readable text/i.test(r4.text), "unreadable screen → 'no readable text' nudge");

  // --- Action Log stays lightweight: never stores the image bytes --------
  await resetState();
  await dispatch.runNoteAction("note what is on my screen");
  const entries = actionLog.list().filter((e) => e.actionId === "vision:capture-screen" && e.outcome === "success");
  assert(entries.length > 0, "capture logged to the Action Log");
  const logged = entries[entries.length - 1];
  assert(!logged.detail.buffer, "the logged capture entry does NOT carry the image bytes");

  // --- Private Mode does not break the local path ------------------------
  await resetState();
  settings.setPrivateMode(true);
  const r5 = await dispatch.runNoteAction("note what is on my screen");
  assert(r5.ok, "Private Mode still allows the fully-local screen-to-note path");
  settings.setPrivateMode(false);

  console.log(`\n${passCount} screenshot-note test(s) passed, ${failCount} failed`);
  if (failCount > 0) process.exitCode = 1;
})().catch((err) => {
  console.error("UNCAUGHT:", err?.message || err);
  process.exitCode = 1;
});
