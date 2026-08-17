const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};

const e = require("../src/main/kb/extractor");
const t = path.join(os.tmpdir(), "probe-kb");
fs.mkdirSync(t, { recursive: true });
fs.writeFileSync(t + "/a.txt", "hello world");
fs.writeFileSync(t + "/a.md", "# hi");
fs.writeFileSync(t + "/a.exe", "junk");

try { console.log("TXT:", JSON.stringify(e.extractText(t + "/a.txt"))); } catch (err) { console.log("ERR", err.message); }
try { console.log("MD :", JSON.stringify(e.extractText(t + "/a.md")).slice(0, 150)); } catch (err) { console.log("ERR", err.message); }
try { console.log("UNK:", JSON.stringify(e.extractText(t + "/a.exe"))); } catch (err) { console.log("ERR", err.message); }
