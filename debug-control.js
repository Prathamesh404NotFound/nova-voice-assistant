// Focused debug: reproduce the halted-path runner failures.
const Module = require("module");
const path = require("path");
const fs = require("fs");
const DATA_DIR = path.resolve("/tmp/.nova-ctrl-debug");
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const fakeWindow = { webContents: { send: () => {}, on: () => {}, removeListener: () => {}, once: () => {} } };
const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {} },
  BrowserWindow: { getAllWindows: () => [fakeWindow] },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: { send: () => {}, on: () => {} },
  contextBridge: { exposeInMainWorld: () => {} },
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  nativeImage: { createFromPath: () => ({}) },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
};
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === "electron") return shim;
  return origLoad.call(this, req, parent, ...rest);
};

const VISION_ROOT = path.resolve(__dirname, "src/main/vision");
const m = (t, exports) => ({
  id: require.resolve(path.join(VISION_ROOT, t)),
  filename: require.resolve(path.join(VISION_ROOT, t)),
  loaded: true,
  exports,
});
require.cache[require.resolve(path.join(VISION_ROOT, "ocr"))] = m("ocr", { recognizeText: async (b) => ({ text: "0", words: [] }) });
require.cache[require.resolve(path.join(VISION_ROOT, "screenshot"))] = m("screenshot", { captureScreen: async () => ({ buffer: Buffer.from("x"), width: 1, height: 1, permissionMissing: false }) });
require.cache[require.resolve(path.join(VISION_ROOT, "ui-detector"))] = m("ui-detector", { detectUIElements: async () => ({ buttons: [], inputs: [] }) });

const { compilePlan } = require("./src/main/control/planner");
const { sequence } = require("./src/main/control/kill-switch");
const input = require("./src/main/control/input");
const gate = require("./src/main/permissions/gate");
const { registerControlActions } = require("./src/main/control/input");

input.setEngineForTesting({
  Point: class { constructor(x, y) { this.x = x; this.y = y; } },
  Key: new Proxy({}, { get: (_t, k) => k }),
  mouse: { move: async () => {}, leftClick: async () => {}, rightClick: async () => {}, scrollDown: async () => {} },
  keyboard: {
    type: async (t) => { console.log("[engine] typed:", t); },
    pressKey: async (...k) => { console.log("[engine] press:", ...k); },
    releaseKey: async (...k) => { console.log("[engine] release:", ...k); },
  },
  screen: { mousePosition: async () => ({ x: 0, y: 0 }) },
});

registerControlActions();

// Patch the gate module export itself (not just the local reference).
const realRunAction = gate.runAction;
let gateOutcomeOverride = null;
const testRunAction = async (actionId, payload, opts = {}) => {
  console.log(`[gate-hook] ${actionId} override=${gateOutcomeOverride}`);
  if (gateOutcomeOverride) return { outcome: gateOutcomeOverride, actionId };
  return realRunAction(actionId, payload, opts);
};
gate.runAction = testRunAction;
require.cache[require.resolve("./src/main/permissions/gate")].exports.runAction = testRunAction;

const { runSequence } = require("./src/main/control/runner");

async function runCancelled() {
  gateOutcomeOverride = "cancelled";
  const p = compilePlan("open the system calculator and compute 12 x 8");
  const r = await runSequence({ plan: p.plan });
  gateOutcomeOverride = null;
  console.log("cancelled test result:", JSON.stringify(r));
}

async function runVisionFail() {
  const ocrMod = require.cache[require.resolve(path.join(VISION_ROOT, "ocr"))];
  ocrMod.exports.recognizeText = async (b) => ({ text: "nothing here", words: [] });
  const p = compilePlan("open the system calculator and compute 12 x 8");
  const r = await runSequence({ plan: p.plan });
  ocrMod.exports.recognizeText = async (b) => ({ text: "0", words: [] });
  console.log("vision-fail test result:", JSON.stringify(r));
}

runCancelled().then(runVisionFail);
