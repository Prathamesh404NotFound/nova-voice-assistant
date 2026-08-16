// Quick E2E harness for files dispatch (headless)
const fs = require("fs");
const path = require("path");
const os = require("os");

// Electron shim
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};
if (!fs.existsSync("shim-electron.js")) {
  fs.writeFileSync("shim-electron.js", `
    const app = { getPath: (n) => ({ userData: '/tmp/nova-dispatch-data', home: process.env.HOME, documents: process.env.HOME + '/Documents', downloads: process.env.HOME + '/Downloads', desktop: process.env.HOME + '/Desktop' })[n] || '/tmp' };
    module.exports = { app, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => {}, on: () => {} }, ipcRenderer: null, dialog: {}, Menu: {}, nativeTheme: {}, systemPreferences: { getMediaAccessStatus: () => 'not-determined' } };
  `);
}

const toolbox = require("./src/main/files/toolbox");
const { runAction } = require("./src/main/permissions/gate");
require("./src/main/files/actions");
const dispatch = require("./src/main/files/dispatch");
const plan = require("./src/main/files/plan");
const { classify } = require("./src/main/agent/classifier");

// Sandbox folder
const tmp = fs.mkdtempSync("/tmp/nova-files-");
fs.mkdirSync(path.join(tmp, "Downloads"), { recursive: true });
fs.writeFileSync(path.join(tmp, "Downloads", "resume.pdf"), "resume-content");
fs.writeFileSync(path.join(tmp, "Downloads", "resume copy.pdf"), "resume-content");
fs.writeFileSync(path.join(tmp, "Downloads", "photo.png"), "img-data");
fs.writeFileSync(path.join(tmp, "Downloads", "setup.exe"), "installer");
// Override DEFAULT_ROOTS via search opts everywhere=false
// We'll pass a helper: patch toolbox DEFAULT_ROOTS
toolbox.setDefaultRootsForTesting([tmp + "/Downloads"]);
plan.setNamedFolderRootsForTesting(tmp + "/Downloads");

function say(t) { console.log(`\n  >>> "${t}"`); }

(async () => {
  console.log("DEFAULT_ROOTS now:", JSON.stringify(toolbox.DEFAULT_ROOTS));
  say("find my resume");
  console.log(JSON.stringify(await dispatch.runFileAction("find my resume")));
  say("how much space is Downloads taking up");
  console.log(JSON.stringify(await dispatch.runFileAction("how much space is Downloads taking up")));
  say("find duplicate files in Downloads");
  const dup = await dispatch.runFileAction("find duplicate files in Downloads");
  console.log(JSON.stringify(dup));
  say("clean up my Downloads folder (dry-run)");
  const preview = await dispatch.runFileAction("clean up my Downloads folder");
  console.log(JSON.stringify(preview, null, 1));
  say("reject the preview (expired token)");
  console.log(JSON.stringify(await dispatch.executePreview("deadbeef")));
  say("accept the preview");
  console.log(JSON.stringify(await dispatch.executePreview(preview.previewToken), null, 1));
  say("leftover after organize:");
  for (const d of fs.readdirSync(tmp + "/Downloads")) {
    const full = path.join(tmp + "/Downloads", d);
    const isDir = fs.statSync(full).isDirectory();
    const inner = isDir ? ` (${fs.readdirSync(full).join(", ")})` : "";
    console.log("  ", d, isDir ? "[dir]" : "", inner);
  }
  say("bare vague delete refusal");
  console.log(JSON.stringify(await dispatch.runFileAction("delete junk files from my disk")));
  // Fresh search so "this file" resolves again (organize wiped the context).
  say("(re-search for a fresh file context)");
  await dispatch.runFileAction("find my resume");
  say("move this file to Documents");
  console.log(JSON.stringify(await dispatch.runFileAction("move this file to Documents")));
  say("SMOKE OK");
})().catch((e) => { console.error("HARNESS CRASH:", e.message); process.exit(1); });
