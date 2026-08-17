// Shim-test helper: load src/main/main.js in a headless Node process with
// the electron shim injected via Module._resolveFilename.
process.env.IS_TEST = "1";
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === "electron" || (req && req.startsWith("electron/"))) {
    return require.resolve("../shim-electron.js");
  }
  return origResolve.call(this, req, parent, ...rest);
};
(async () => {
  try {
    require("../src/main/main.js");
    console.log("main.js loads OK");
    // Give async init (router refresh) a moment, then exit clean.
    setTimeout(() => process.exit(0), 2000);
  } catch (e) {
    console.error("ERROR:", e.message);
    console.error(e.stack.split("\n").slice(0, 8).join("\n"));
    process.exit(2);
  }
})();
