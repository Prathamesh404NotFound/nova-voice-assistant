// Nova — headless self-test for the screen-vision pipeline.
//
// Runs WITHOUT a real Electron runtime by shimming the "electron" module:
//   - desktopCapturer.getSources returns a synthetic NativeImage stub
//   - systemPreferences.getMediaAccessStatus returns a controllable status
//   - dialog/BrowserWindow/app stubs as in test-permissions.js
//
// Verifies: OCR text + bounding boxes (offline), UI element detection
// (buttons/inputs), the full pipeline gate registration + action logging,
// vision-model branch skipping in Private Mode, and OCR-only fallback.
//
// Usage: node src/main/test-vision.js [dataDir]

const Module = require("module");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");
const { execSync } = require("child_process");

// Synthetic PNG images rendered by python3/PIL (libpng-compatible bytes).
// The geometry-only image has text-like bars; the real-text image carries
// actual glyphs so OCR assertions use a genuine engine output.
function buildImageWithPython(script) {
  try {
    const out = execSync(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { encoding: "utf8", timeout: 30000 });
    return Buffer.from(out.trim(), "base64");
  } catch (err) {
    console.warn("Python PNG generation unavailable:", err?.message || err);
    return null;
  }
}

function buildTestImage() {
  // Geometry-only image (deterministic dark bars on white), used for capture
  // pipeline and UI-detection tests that do not depend on real glyphs.
  return buildImageWithPython(`from PIL import Image, ImageDraw
import base64, io
im = Image.new('L', (640, 240), 255)
d = ImageDraw.Draw(im)
d.rectangle([30, 30, 209, 47], fill=0)
d.rectangle([230, 30, 319, 47], fill=0)
d.rectangle([30, 100, 89, 119], fill=0)
d.rectangle([30, 170, 149, 185], fill=0)
b = io.BytesIO()
im.save(b, format='PNG')
print(base64.b64encode(b.getvalue()).decode())`) || Buffer.from([]);
}

const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-vision-test-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Build a synthetic test image with known text layout.
//    The image itself is only used by the tesseract test; bounding-box
//    geometry tests use hand-built word lists (deterministic).
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 2. Electron shim
// ---------------------------------------------------------------------------
let captureCallCount = 0;
let captureShouldFail = false;
const capturedBuffers = [];

// A NativeImage-like stub with toPNG() returning real PNG bytes so the
// pipeline can .toString("base64") it.
function makeThumbImage() {
  return {
    getSize: () => ({ width: 640, height: 240 }),
    toPNG: () => buildTestImage(),
    toJPEG: (q) => buildTestImage(),
  };
}

let fakeScreenPermission = "granted";

const shim = {
  app: {
    getPath: (name) => {
      if (name === "userData") return DATA_DIR;
      throw new Error(`fake getPath(${name}) not supported`);
    },
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
    getName: () => "Nova",
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: { send: () => {}, on: () => {}, invoke: async () => undefined, removeListener: () => {} },
  contextBridge: { exposeInMainWorld: () => {} },
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  nativeImage: { createFromPath: () => ({}) },
  systemPreferences: {
    getMediaAccessStatus: (mediaType) => (mediaType === "screen" ? fakeScreenPermission : "granted"),
  },
  desktopCapturer: {
    getSources: async () => {
      if (captureShouldFail) throw new Error("simulated capture failure");
      captureCallCount += 1;
      const thumb = makeThumbImage();
      return [{ id: "screen:0:0", name: "Fake Display", thumbnail: thumb }];
    },
  },
  shell: { openExternal: async () => "ok" },
};

// Block outbound OpenRouter calls in the sandbox: the vision model branch
// must fall back to OCR-only here (and in Private Mode on the user's machine).
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, ...rest) => {
  const url = typeof input === "string" ? input : input?.url || "";
  if (/openrouter\.ai|api\.v1/.test(url) || url.includes("chat/completions")) {
    const err = new Error("[test] outbound OpenRouter call blocked in headless harness");
    err.code = "TEST_BLOCKED_FETCH";
    throw err;
  }
  return origFetch(input, ...rest);
};

const electronResolve = require.resolve("electron");
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "electron" || request === "electron/main" || request === "electron/renderer") {
    return electronResolve;
  }
  return origResolveFilename.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "electron") return shim;
  return origLoad.call(this, request, parent, ...rest);
};

// ---------------------------------------------------------------------------
// 3. Load modules under test
// ---------------------------------------------------------------------------
const ocr = require("./vision/ocr");
const { detectUIElements, clusterLines, looksLikeLabel } = require("./vision/ui-detector");
const screenshot = require("./vision/screenshot");
require("./vision/vision-actions"); // registers vision:capture-screen
const visionQuery = require("./vision/vision-query");
const { runAction } = require("./permissions/gate");
const { getAction } = require("./permissions/action-registry");
const actionLog = require("./permissions/action-log");
const settings = require("./settings");
const router = require("./router");

function assert(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`PASS: ${label}`);
}

// ---------------------------------------------------------------------------
// Synthetic word list (deterministic) for UI detection tests
// ---------------------------------------------------------------------------
const words = [
  { text: "Save",   conf: 92, bbox: { x0: 500, y0: 40, x1: 560, y1: 62, w: 60, h: 22 } },
  { text: "Cancel", conf: 90, bbox: { x0: 620, y0: 40, x1: 690, y1: 62, w: 70, h: 22 } },
  { text: "Username:", conf: 88, bbox: { x0: 40, y0: 120, x1: 150, y1: 140, w: 110, h: 20 } },
  { text: "the",    conf: 70, bbox: { x0: 40, y0: 200, x1: 60, y1: 216, w: 20, h: 16 } },
  { text: "quick",  conf: 68, bbox: { x0: 70, y0: 200, x1: 115, y1: 216, w: 45, h: 16 } },
  { text: "brown",  conf: 65, bbox: { x0: 125, y0: 200, x1: 170, y1: 216, w: 45, h: 16 } },
  { text: "fox",    conf: 60, bbox: { x0: 180, y0: 200, x1: 210, y1: 216, w: 30, h: 16 } },
];

function buildTextImage() {
  // Render a real-text PNG with PIL (python3) so OCR assertions use genuine
  // glyphs. Falls back to the raw-bar PNG if PIL is unavailable.
  const script = `from PIL import Image, ImageDraw, ImageFont
import base64, sys
im = Image.new('L', (800, 300), 255)
d = ImageDraw.Draw(im)
try:
    f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 48)
except Exception:
    f = ImageFont.load_default()
d.text((40, 40), "Error 404: Not Found", fill=0, font=f)
d.text((40, 130), "Save Changes", fill=0, font=f)
d.text((40, 220), "Username:", fill=0, font=f)
b = __import__("io").BytesIO()
im.save(b, format="PNG")
print(base64.b64encode(b.getvalue()).decode())`;
  try {
    const out = execSync(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { encoding: "utf8", timeout: 30000 });
    return Buffer.from(out.trim(), "base64");
  } catch {
    return buildTestImage(); // geometry-only fallback
  }
}

async function main() {
  // Wipe persisted state before loading modules that read it at require time.
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // --- 1. OCR on a real synthetic PNG (fully offline) ---
  console.log("[test] step 1: OCR ...");
  const png = buildTextImage();
  const ocrRes = await ocr.recognizeText(png);
  console.log("[test] step 1 done");
  assert(Array.isArray(ocrRes.words), "OCR returns a word list");
  const wordTexts = ocrRes.words.map((w) => w.text);
  assert(wordTexts.length >= 3, `OCR reads text from the image (${wordTexts.join(", ")})`);
  const w = ocrRes.words.find((x) => x.text.toLowerCase().startsWith("error"));
  assert(w && w.bbox && typeof w.bbox.x0 === "number", "words carry numeric bounding boxes");
  assert(typeof ocrRes.confidentText === "string", "confidentText filter works");
  console.log(`   (OCR words: ${wordTexts.join(", ")}; conf-text: "${ocrRes.confidentText.slice(0, 80)}")`);

  // --- 2. UI element detection from bounding boxes ---
  console.log("[test] step 2: UI detection ...");
  const ocrLike = { text: "Save Cancel Username: the quick brown fox", words, confidentText: "" };
  const ui = detectUIElements(ocrLike);
  assert(Array.isArray(ui.buttons) && ui.buttons.length >= 2, `detected ${ui.buttons.length} button-like regions`);
  const labels = ui.buttons.map((b) => b.label);
  assert(labels.includes("Save") && labels.includes("Cancel"), "Save and Cancel detected as buttons");
  // The dense sentence fragment should NOT appear as a button
  assert(!ui.buttons.some((b) => b.label.includes("quick")), "dense body text is not mis-detected as a button");
  // "Username:" sits alone with empty space after → input-like
  assert(ui.inputs.some((i) => i.label === "Username:"), "label followed by empty gap detected as input field");
  // Heuristics sanity
  assert(looksLikeLabel("Save") && !looksLikeLabel("the quick brown fox jumps over"), "label heuristic works");
  const lines = clusterLines(words);
  assert(lines.length === 3, "line clustering groups words by baseline");

  // --- 3. Screenshot capture through the gate ---
  console.log("[test] step 3: gate capture ...");
  captureCallCount = 0;
  captureShouldFail = false;
  const gateRes = await runAction("vision:capture-screen");
  console.log("[test] step 3 done");
  assert(gateRes.outcome === "success", "vision:capture-screen executes immediately (Level 0)");
  assert(gateRes.detail && gateRes.detail.note && !gateRes.detail.note.includes("data:"), "action log note is lightweight — no image bytes");
  assert(captureCallCount >= 1, "desktopCapturer.getSources was called");
  // Registration metadata
  const action = getAction("vision:capture-screen");
  assert(action.level === 0 && action.id === "vision:capture-screen", "vision action registered as Level 0 READ");
  const desc = await action.simulate({ __describe: true });
  assert(desc.title && /screen/i.test(desc.title), "vision action has a plain-language description");
  // Action log records a note-only entry
  const logEntries = actionLog.list();
  const visionEntry = logEntries.find((e) => e.actionId === "vision:capture-screen");
  assert(visionEntry && visionEntry.level === 0 && visionEntry.outcome === "success", "capture logged to Action Log as L0 success");
  const entryKeys = Object.keys(visionEntry);
  assert(!entryKeys.some((k) => k === "image" || k === "png" || String(visionEntry.detail?.note || "").length > 400), "log entry stays lightweight");

  // --- 4. Permission status reporting ---
  // On non-macOS platforms the OS permission check short-circuits to "granted",
  // so exercise the denied path only where it is meaningful.
  if (process.platform === "darwin") {
    fakeScreenPermission = "denied";
    let shot = await screenshot.captureScreen().catch((e) => e);
    // denied status is reported but capture still runs (OS may report falsely)
    assert(shot && (shot.permissionMissing === true || shot instanceof Error), "denied permission is reported as missing");
    fakeScreenPermission = "granted";
  } else {
    const s = screenshot.getScreenPermissionStatus();
    assert(s === "granted", `non-macOS platforms short-circuit to "granted" (got ${s})`);
    const missingShot = await screenshot.captureScreen();
    assert(missingShot.permissionMissing === false, "capture reports permission present on non-macOS");
  }

  console.log("[test] step 5: capture failure ...");
  captureShouldFail = true;
  let failRes = await runAction("vision:capture-screen");
  captureShouldFail = false;
  assert(failRes.outcome === "failed" && /screen/i.test(failRes.detail?.error || ""), "capture failure is logged and surfaced");

  console.log("[test] step 6: pipeline private mode ...");
  settings.setPrivateMode(true);
  // Force router into fallback so the network branch would be skipped anyway
  const netBefore = visionQuery.__netCalls || 0;
  const res = await visionQuery.runVisionQuery("what's on my screen?");
  assert(res && res.answer && typeof res.answer === "string", "pipeline returns a plain-language answer in Private Mode");
  assert(res.mode === "ocr", "Private Mode forces OCR-only mode (no outbound vision call)");
  assert(res.uiElements && Array.isArray(res.uiElements.buttons), "UI elements returned");
  settings.setPrivateMode(false);

  // --- 7. Vision model branch:
  //        a) askVisionModel itself propagates network errors (no silent drops);
  //        b) with the router in fallback mode (network blocked at startup),
  //           the pipeline must gracefully answer OCR-only.
  console.log("[test] step 7: network branch ...");
  try {
    await visionQuery.askVisionModel("google/gemini-2.5-flash-001", png, "q", "");
    assert(false, "askVisionModel should throw when the network is unavailable");
  } catch (err) {
    assert(err && /network|blocked|Network|No OpenRouter/i.test(err.message || ""), "askVisionModel surfaces network failures instead of hanging");
  }
  console.log("[test] step 7: pipeline normal (router in fallback) ...");
  const res2 = await visionQuery.runVisionQuery("what am I looking at");
  console.log("[test] step 7 done");
  assert(res2 && res2.answer, "pipeline answers even without free vision models");
  assert(res2.mode === "ocr", "router fallback forces the OCR-only answer path");
  console.log(`   (answer preview: "${res2.answer.slice(0, 120)}" [${res2.mode}])`);

  // --- 8. Vision queries also append to the Action Log ---
  const after = actionLog.list();
  const visionCount = after.filter((e) => e.actionId === "vision:capture-screen").length;
  assert(visionCount >= 4, `action log accumulated ${visionCount} vision capture entries`);

  // --- Summary ---
  console.log("\nVision entries in action log (newest first):");
  console.log(JSON.stringify(actionLog.list().filter((e) => e.actionId === "vision:capture-screen").slice(0, 3), null, 2));

  await ocr.shutdown();
  if (!process.exitCode) console.log("\nAll screen-vision tests passed.");
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  process.exitCode = 1;
});
