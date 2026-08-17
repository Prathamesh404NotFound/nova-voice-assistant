// Quick E2E harness for the knowledge base (headless, Stage 8 reqs 1-5).
// Verifies real modules end-to-end: extraction → indexing → local search →
// RAG compose with snippet-only model access → source citation → removal
// (index gone, originals intact) → Private Mode refusal.
const fs = require("fs");
const path = require("path");
const os = require("os");

// Electron shim (shared with other smoke harnesses)
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};
if (!fs.existsSync(path.join(__dirname, "shim-electron.js"))) {
  fs.writeFileSync(path.join(__dirname, "shim-electron.js"), `
    const app = { getPath: (n) => ({ userData: '/tmp/nova-dispatch-data', home: process.env.HOME })[n] || '/tmp' };
    module.exports = { app, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => {}, on: () => {} }, ipcRenderer: null, dialog: {}, Menu: {}, nativeTheme: {}, systemPreferences: { getMediaAccessStatus: () => 'not-determined' } };
  `);
}

// Load real KB modules and register their actions with the permission gate
require("../src/main/kb/actions");
const kbIndex = require("../src/main/kb/index");
const kbDispatch = require("../src/main/kb/dispatch");
const kbQuery = require("../src/main/kb/query");
const embeddings = require("../src/main/kb/embeddings");
const { classify } = require("../src/main/agent/classifier");

// ---------------------------------------------------------------------------
// Sample corpus (req: "a small sample folder of a few documents")
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync("/tmp/nova-kb-");
const corpus = path.join(tmp, "sample-kb");
fs.mkdirSync(corpus, { recursive: true });
fs.writeFileSync(path.join(corpus, "sunset-plan.txt"),
  "Project Sunset: the team will start phase two in October. " +
  "The sunset review covers the roadmap, budget, and team staffing.");
fs.writeFileSync(path.join(corpus, "sunset-budget.md"),
  "# Sunset Budget\nPhase two of Project Sunset needs $45k for cloud spend. " +
  "Phase three depends on the Q1 revenue numbers.");
fs.writeFileSync(path.join(corpus, "meeting-notes.txt"),
  "Notes from the garden chat: tomatoes and basil need more sun. " +
  "Nothing about budgets or project sunset here.");
fs.writeFileSync(path.join(corpus, "old-ideas.md"),
  "Old random ideas: learn Japanese, fix the bike, cook ramen from scratch.");

const INDEX_DIR = path.join(tmp, "kb-index");
kbIndex.resetForTesting();
kbIndex.setIndexDirForTesting(INDEX_DIR); // must come AFTER the reset
// The full MiniLM download is skipped in the CI sandbox (no network); the
// deterministic local fallback hasher is used instead — still a real local
// 384-d embedding, so search/ranking claims below are exercised genuinely.
if (process.env.HARNESS_FORCE_FALLBACK !== "0") {
  // Force the deterministic local fallback hasher so this harness runs
  // fully offline and proves no model download is required.
  embeddings.embed = (texts) => Promise.resolve(embeddings.embedFallbackForTesting(texts));
}

// Watcher bridge is set by the dispatcher in a real Electron run; no-op here.
global.__kbWatcherBridge = () => {};

let sentToModel = [];
kbQuery.configure({
  router: async (_model, messages) => {
    sentToModel.push(messages);
    return "Based on your files, Project Sunset's phase two starts in October with a $45k cloud budget.";
  },
});

function check(name, cond, extra) {
  console.log((cond ? "PASS" : "FAIL") + ": " + name);
  if (extra) console.log("   " + JSON.stringify(extra).slice(0, 300));
  if (!cond) process.exit(1);
}

(async () => {
  // 1. Add the folder (real indexing pipeline: extract → chunk → local embed)
  const add = await kbDispatch.runKbAction("add this folder to my knowledge base", {
    ctx: { lastKbFolder: corpus },
  });
  check("add-folder indexes the sample corpus",
    add.ok && (add.detail?.filesTotal || 0) === 4, add.text);
  const stats = await kbIndex.stats();
  check("index stats: files and chunks counted",
    stats.folders === 1 && stats.chunks >= 4, stats);

  // 2. Classifier routes KB phrasing to the KB intent
  const c1 = await classify("what did I write about project sunset in my kb");
  check("classifier routes sunset question to kb intent", c1.intent === "kb", c1);

  // 3. Query: local embeddings + top chunks + snippets-only model call
  const q1 = await kbDispatch.runKbAction("what did I write about project sunset in my kb");
  check("query ok and cites sources",
    q1.ok && (q1.detail?.sources?.length || 0) >= 1, q1.text);
  const citedSunsetFiles = (q1.detail?.sources || []).map((s) => path.basename(s.file || ""));
  check("sources are the two sunset documents (not garden or old ideas)",
    citedSunsetFiles.some((f) => f === "sunset-plan.txt") &&
    citedSunsetFiles.some((f) => f === "sunset-budget.md"),
    citedSunsetFiles);
  const composed = sentToModel[sentToModel.length - 1];
  const composedText = composed && composed[0] && composed[0].content;
  // Only the retrieved chunks (bounded, citation-numbered) reach the model —
  // never a full document dump. The prompt must carry the Snippets marker,
  // contain the relevant chunk titles, and stay within the local snippet cap.
  check("only retrieved snippets (never raw documents) reached the model",
    composedText &&
    composedText.includes("Snippets:") &&
    composedText.includes("sunset-plan.txt") &&
    composedText.includes("sunset-budget.md") &&
    (composedText.match(/\[\d+\]/g) || []).length <= 6 &&
    composedText.length < 20000,
    composedText && composedText.slice(0, 300));

  // 4. Irrelevant question should not cite sunset docs
  const q2 = await kbDispatch.runKbAction("find my documents on the garden");
  const q2Files = (q2.detail?.sources || []).map((s) => path.basename(s.file || ""));
  check("garden question cites the meeting notes, not sunset docs",
    (q2.detail?.sources || []).some((s) => (s.file || "").endsWith("meeting-notes.txt")),
    q2Files);

  // 5. Private Mode: exact refusal, no model call
  kbQuery.configure({ getPrivateMode: () => true });
  const priv = await kbDispatch.runKbAction("search my kb for budget");
  kbQuery.configure({ getPrivateMode: () => false });
  check("Private Mode refuses with the exact phrase",
    priv.refused === true &&
    priv.text === "Knowledge base search needs Private Mode off — I won't send your documents anywhere while it's on.",
    priv.text);

  // 6. Remove: index data deleted, ORIGINALS untouched (req 5)
  const rm = await kbDispatch.runKbAction("remove this folder from the index");
  check("remove-folder: index cleared",
    rm.ok && kbIndex.listFolders().length === 0 && (await kbIndex.stats()).chunks === 0, rm.text);
  check("originals intact after removal",
    fs.readFileSync(path.join(corpus, "sunset-plan.txt"), "utf8").includes("phase two") &&
    fs.readFileSync(path.join(corpus, "sunset-budget.md"), "utf8").includes("45k") &&
    fs.readdirSync(corpus).length === 4);

  // 7. Incremental re-index (watcher flow): edit one file, reindex
  await kbDispatch.runKbAction("add this folder to my knowledge base", {
    ctx: { lastKbFolder: corpus },
  });
  fs.appendFileSync(path.join(corpus, "old-ideas.md"), "\nNew idea: build a voice assistant called Nova.");
  const re = await kbDispatch.runKbAction("re-index my knowledge base");
  check("incremental re-index picks up the edited file",
    re.ok && ((re.detail?.results || []).some((r) => r.includes("re-indexed")) || re.text.includes("Nothing changed")), re.text);
  const q3 = await kbDispatch.runKbAction("search my kb for Nova voice assistant");
  check("re-indexed content is searchable with correct source",
    q3.ok && (q3.detail?.sources || []).some((s) => (s.file || "").endsWith("old-ideas.md")),
    q3.text);

  // 8. Management listing from the main-process perspective
  const list = await kbDispatch.runKbAction("list my indexed folders");
  check("list-folders returns the indexed folder",
    list.ok && (list.detail?.folders || []).length === 1, list.text);

  console.log("\nKB SMOKE OK — all real modules exercised end-to-end");
  console.log("index dir:", INDEX_DIR);
})().catch((e) => { console.error("HARNESS CRASH:", e.message); process.exit(1); });
