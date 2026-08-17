const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};

(async () => {
  const embeddings = require("../src/main/kb/embeddings");
  embeddings.resetForTesting();
  const fa = await embeddings.embed("test phrase one");
  console.log("FALLBACK:", Array.isArray(fa), fa.length, "nonzero:", fa.filter((v) => v !== 0).length);

  const kbIndex = require("../src/main/kb/index");
  const INDEX_DIR = path.join(os.tmpdir(), "nova-kb-probe-index");
  kbIndex.setIndexDirForTesting(INDEX_DIR);
  kbIndex.resetForTesting();

  const SAMPLE = path.join(os.tmpdir(), "nova-kb-probe-sample");
  fs.mkdirSync(SAMPLE, { recursive: true });
  fs.writeFileSync(path.join(SAMPLE, "a.txt"), "hello world this is a probe document about project sunset phase two of the migration");

  const evts = [];
  kbIndex.onProgress((e) => evts.push(e));
  const res = await kbIndex.indexFolder(SAMPLE);
  console.log("INDEX:", JSON.stringify(res));
  console.log("PROG:", JSON.stringify(evts));
  console.log("LIST:", JSON.stringify(kbIndex.listFolders()));
  console.log("STATS:", JSON.stringify(await kbIndex.stats()));
  console.log("INDEX_DIR exists:", fs.existsSync(INDEX_DIR));
  if (fs.existsSync(INDEX_DIR)) console.log("INDEX_DIR contents:", fs.readdirSync(INDEX_DIR));

  const { search } = require("../src/main/kb/search");
  const r = await search("project sunset phase two");
  console.log("SEARCH:", r.error || `chunks=${r.chunks.length} sources=${r.sources.length}`);
  kbIndex.resetForTesting();
  const r2 = await search("anything");
  console.log("SEARCH-empty-index:", r2.error, r2.chunks?.length);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
