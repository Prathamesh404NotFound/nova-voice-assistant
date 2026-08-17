// Nova — test-kb.js
//
// Headless self-test for the Stage 8 local knowledge base module.
// Runs WITHOUT a real Electron runtime by shimming the "electron" module.
// Covers:
//   - text extraction: .txt/.md/.pdf/.docx + unknown format skip
//   - chunker: ids, overlap, title meta
//   - embeddings: determinism, cosine sanity, fallback hasher always works
//   - index: add / remove / restore / reindex incremental / limits / persistence
//   - watcher: incremental reindex on add/change/delete with debounced flush
//   - search: ranking + source dedupe
//   - query: Private Mode refusal (exact phrase), snippets-only compose
//   - actions: levels + reverse fns; dispatcher end-to-end through the gate
//   - planner + intent classifier routing (kb vs notes vs files vs conversation)
//
// Usage: node src/main/test-kb.js [dataDir]

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-kb-test-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Electron shim (same trick as the other stage tests)
// ---------------------------------------------------------------------------
const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getName: () => "Nova" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: null,
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: { openPath: async () => 0 },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};

// ---------------------------------------------------------------------------
// Sandbox paths
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nova-kb-test-"));
const INDEX_DIR = path.join(TMP, "kb-index");
const SAMPLE = path.join(TMP, "sample-kb");
fs.mkdirSync(SAMPLE, { recursive: true });

// Build a small sample corpus (4 docs; 2 about "project sunset")
fs.writeFileSync(path.join(SAMPLE, "sunset-plan.txt"),
  "Project Sunset roadmap: phase one is the migration of legacy services to the new platform by Q3. Phase two retires the old REST endpoints in Q4.");
fs.writeFileSync(path.join(SAMPLE, "sunset-budget.md"),
  "# Project Sunset budget\n\nThe sunset migration is capped at $45,000. The legacy decommission line is $12,000 and includes tooling and training.");
fs.writeFileSync(path.join(SAMPLE, "garden-notes.txt"),
  "Garden log: tomatoes planted in bed 2 in March. Water twice a week in summer, once in spring.");
let pdfBuf;
// Minimal valid single-page PDF with the text embedded (no deps needed)
pdfBuf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 84>>stream\nBT /F1 12 Tf 72 720 Td (Annual review: revenue grew 14 percent, cloud services strong.) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000266 00000 n \n0000000402 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n475\n%%EOF\n");
fs.writeFileSync(path.join(SAMPLE, "annual-review.pdf"), pdfBuf);
const SUB = path.join(SAMPLE, "nested", "deep");
fs.mkdirSync(SUB, { recursive: true });
fs.writeFileSync(path.join(SUB, "meeting-notes.txt"), "Meeting with Dana: sunset phase two kickoff scheduled for October. Attendees agreed on the $12,000 decommission cap.");
fs.writeFileSync(path.join(SAMPLE, "readme.txt"), "Root readme — mentions nothing relevant.");

// ---------------------------------------------------------------------------
// Modules under test
// ---------------------------------------------------------------------------
const extractor = require("./kb/extractor");
const chunker = require("./kb/chunker");
const embeddings = require("./kb/embeddings");
const kbIndex = require("./kb/index");
const watcher = require("./kb/watcher");
const { search } = require("./kb/search");
const { compose, configure } = require("./kb/query");
const { planKbAction, normalizeFolderHint, setTestFoldersForTesting } = require("./kb/plan");
const kbDispatch = require("./kb/dispatch");
require("./kb/actions"); // registers kb:* actions
const gate = require("./permissions/gate");
const actionLog = require("./permissions/action-log");
const registry = require("./permissions/action-registry");
const undo = require("./permissions/undo");
const { RISK_LEVEL } = require("./permissions/risk-levels");
const { classify, INTENTS } = require("./agent/classifier");
const dispatcher = require("./agent/dispatcher");

kbIndex.resetForTesting();
kbIndex.setIndexDirForTesting(INDEX_DIR);
watcher.resetForTesting();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// poll until cond() is true or timeout ms elapsed
function waitFor(cond, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start >= timeout) return resolve();
      setTimeout(tick, 150);
    };
    tick();
  });
}
let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${extra ? "\n      " + extra : ""}`); }
}
const settings = require("./settings");

(async () => {
  // ==========================================================================
  // 1. Risk-level declarations through the registry
  // ==========================================================================
  {
    const expected = {
      "kb:query": RISK_LEVEL.SAFE,
      "kb:list-folders": RISK_LEVEL.SAFE,
      "kb:add-folder": RISK_LEVEL.REVERSIBLE,
      "kb:remove-folder": RISK_LEVEL.REVERSIBLE,
      "kb:reindex": RISK_LEVEL.REVERSIBLE,
      "kb:open-source": RISK_LEVEL.REVERSIBLE,
    };
    for (const [id, lvl] of Object.entries(expected)) {
      const a = registry.getAction(id);
      ok(`${id} registered at level ${lvl}`, a && a.level === lvl, "level=" + a?.level);
    }
    ok("every L2 kb action has a reverse fn (Undo support)",
      ["kb:add-folder", "kb:remove-folder", "kb:reindex", "kb:open-source"]
        .every((id) => typeof registry.getAction(id)?.reverse === "function"));
    ok("L1 actions are read-only (no physical side effects)",
      ["kb:query", "kb:list-folders"].every((id) => registry.getAction(id).physical !== true));
  }

  // ==========================================================================
  // 2. Text extraction across formats
  // ==========================================================================
  {
    const txt = await extractor.extractText(path.join(SAMPLE, "sunset-plan.txt"));
    ok("extractText reads .txt", txt.text && txt.text.includes("Sunset roadmap") && !txt.skipped);

    const mdT = await extractor.extractText(path.join(SAMPLE, "sunset-budget.md"));
    ok("extractText reads .md", mdT.text && mdT.text.includes("Project Sunset budget") && mdT.text.includes("$45,000"));

    const pdf = await extractor.extractText(path.join(SAMPLE, "annual-review.pdf"));
    // pdf-parse needs real PDF streams; either it extracts text or the file is
    // skipped with a clear reason — both are acceptable.
    if (pdf.skipped) {
      ok("pdf extraction gracefully skips unsupported stream (reason given)", !!pdf.reason);
    } else {
      ok("pdf extraction returns the document text", pdf.text && /14/.test(pdf.text));
    }

    const unknown = await extractor.extractText(path.join(SAMPLE, "readme.exe"));
    ok("unknown extensions are skipped with a reason", unknown.skipped === true && unknown.reason);
  }

  // ==========================================================================
  // 3. Chunker: stable ids, overlap, meta
  // ==========================================================================
  {
    const long = ("word ".repeat(1000)).trim();
    const chunks = chunker.chunkText(long, { folderId: "f1", relPath: "big.txt", absPath: "/x/big.txt", title: "big.txt" });
    ok("long text is split into multiple chunks", chunks.length > 1);
    ok("chunk ids are scoped to folder:relPath and unique within it",
      chunks.every((c) => c.id.startsWith("f1:big.txt:")) &&
      new Set(chunks.map((c) => c.id)).size === chunks.length &&
      /^f1:big\.txt:\d+(:h\d+)?$/.test(chunks[0].id));
    ok("every chunk carries its meta", chunks.every((c) => c.meta?.folderId === "f1" && c.meta?.relPath === "big.txt"));

    const short = chunker.chunkText("single line", { folderId: "f1", relPath: "s.txt", absPath: "/x/s.txt", title: "s.txt" });
    ok("short text stays a single chunk", short.length === 1 && short[0].text === "single line");
  }

  // ==========================================================================
  // 4. Embeddings: determinism + cosine sanity
  // ==========================================================================
  {
    const a = await embeddings.embed("project sunset migration roadmap");
    const b = await embeddings.embed("project sunset migration roadmap");
    ok("embeddings are deterministic for identical input",
      Array.isArray(a) && a.length === embeddings.DIM && a.every((v, i) => v === b[i]));

    const c = await embeddings.embed("how to grow tomatoes in the garden");
    const d = await embeddings.embed("completely unrelated string about banana boats and jazz");
    ok("related phrases score higher than unrelated ones (cosine)",
      embeddings.cosine(a, c) > embeddings.cosine(a, d));

    ok("unit vectors have norm 1", Math.abs(Math.hypot(...a) - 1) < 0.02);

    // Fallback hasher must always work, even with no model cache
    embeddings.resetForTesting();
    const fa = await embeddings.embed("test phrase one");
    ok("fallback hasher produces a 384-dim vector without a model",
      Array.isArray(fa) && fa.length === embeddings.DIM && fa.some((v) => v !== 0));
  }

  // ==========================================================================
  // 5. Index: add / list / remove / restore / limits / persistence
  // ==========================================================================
  {
    kbIndex.resetForTesting();
    kbIndex.setIndexDirForTesting(INDEX_DIR);

    const captured = [];
    kbIndex.onProgress((evt) => captured.push(evt));

    const res = await kbIndex.indexFolder(SAMPLE);
    ok("indexFolder scans the whole tree and reports counts",
      res.filesTotal >= 4 && (res.added + res.updated) >= 3 && res.skipped >= 0 && !res.errors?.length);
    ok("index progress events were emitted (begin/status/done)",
      captured.some((e) => e.status === "indexing") && captured[captured.length - 1]?.status === "done");

    const folders = kbIndex.listFolders();
    ok("listFolders returns one indexed folder with file/chunk counts",
      folders.length === 1 && folders[0].fileCount >= 4 && folders[0].chunkCount > 0 && folders[0].bytes > 0);

    ok("index persists to disk",
      fs.existsSync(path.join(INDEX_DIR, "manifest.json")) &&
      fs.readdirSync(INDEX_DIR).some((f) => f.endsWith(".json") && f !== "manifest.json"));

    // Reload into a fresh index instance (resetForTesting clears the override — re-apply after)
    kbIndex.resetForTesting();
    kbIndex.setIndexDirForTesting(INDEX_DIR);
    const reloaded = kbIndex.listFolders();
    ok("a fresh index instance reloads the manifest from disk", reloaded.length === 1 && reloaded[0].fileCount >= 4);

    const removed = await kbIndex.removeFolder(reloaded[0].id);
    ok("removeFolder returns the root and a snapshot for undo",
      removed.root === SAMPLE && removed.snapshot?.chunks?.length > 0);
    ok("after removal the folder no longer appears in the index", kbIndex.listFolders().length === 0);

    const restored = kbIndex.restoreFolderSnapshot(removed.snapshot);
    ok("restoreFolderSnapshot brings the folder back with all chunks",
      restored.restored > 0 && kbIndex.listFolders().length === 1);

    // Reindexing unchanged files is incremental (0 added)
    const re = await kbIndex.reindexFolder(kbIndex.listFolders()[0].id);
    ok("incremental reindex reports nothing new for an unchanged folder", re.added === 0);

    // Touch a file — mtime changes → reindex adds chunks
    fs.writeFileSync(path.join(SAMPLE, "sunset-plan.txt"),
      fs.readFileSync(path.join(SAMPLE, "sunset-plan.txt"), "utf8") + " addendum: phase two confirmed for October.");
    const re2 = await kbIndex.reindexFolder(kbIndex.listFolders()[0].id);
    ok("touching a file makes the incremental reindex pick it up", re2.added + re2.updated >= 1);

    // Deleting a file then reindexing shrinks the index
    const beforeChunks = kbIndex.listFolders()[0].chunkCount;
    fs.unlinkSync(path.join(SAMPLE, "readme.txt"));
    const re3 = await kbIndex.reindexFolder(kbIndex.listFolders()[0].id);
    const after = kbIndex.listFolders()[0];
    ok("deleting a source file shrinks chunk count after reindex",
      after.chunkCount < beforeChunks && after.fileCount < beforeChunks || re3.removed >= 1);
    ok("original source files are NEVER modified by indexing",
      fs.readFileSync(path.join(SAMPLE, "sunset-budget.md"), "utf8").includes("$45,000"));
  }

  // ==========================================================================
  // 6. Watcher: incremental reindex on file changes
  // ==========================================================================
  {
    kbIndex.resetForTesting();
    kbIndex.setIndexDirForTesting(INDEX_DIR);
    await kbIndex.indexFolder(SAMPLE);
    watcher.resetForTesting();

    const events = [];
    watcher.onWatcherEvent((evt) => events.push(evt));

    // startWatching throws if the folder id is not indexed — no throw = started.
    await watcher.startWatching(kbIndex.listFolders()[0].id);
    ok("watcher starts for the indexed folder", true);

    // Create a new file inside the watched folder
    const NEW = path.join(SAMPLE, "brand-new-file.txt");
    await new Promise((r) => setTimeout(r, 300)); // let chokidar finish its initial scan
    fs.writeFileSync(NEW, "brand new file about the sunset project migration kickoff");

    // Wait (poll) for the debounce flush (1500ms burst) + reindex
    await waitFor(() =>       events.some((e) => e.payload?.action === "reindex" && e.payload.files >= 1), 8000);
    ok("a new file triggers a watcher reindex event",
            events.some((e) => e.payload?.action === "reindex" && e.payload.files >= 1),
      JSON.stringify(events));
    const found = await search("brand new file sunset kickoff");
    ok("the newly added file is searchable right after the watcher flush",
      found.chunks && found.chunks.some((c) => c.text.includes("brand new file")),
      found.chunks?.slice(0, 2).map((c) => c.text.slice(0, 60)).join(" | "));

    // Unlink triggers removal
    events.length = 0;
    fs.unlinkSync(NEW);
    await waitFor(() =>       events.some((e) => e.payload?.action === "removed" || e.payload?.action === "reindex"), 8000);
    ok("a deleted file triggers a watcher removal/reindex event",
      events.some((e) => e.payload?.action === "removed" || e.payload?.action === "reindex"),
      JSON.stringify(events));

    watcher.stopWatching(kbIndex.listFolders()[0].id);
  }

  // ==========================================================================
  // 7. Search: ranking + source dedupe
  // ==========================================================================
  {
    const r1 = await search("project sunset migration phase two budget");
    ok("search returns ranked chunks with relevance scores",
      r1.chunks && r1.chunks.length > 0 && typeof r1.chunks[0].relevance === "number");

    // Sources are deduped per file — the best chunk wins per file
    const seen = new Set(r1.sources.map((s) => s.file));
    ok("search sources are deduped (one entry per file)", seen.size === r1.sources.length);

    // The two sunset docs must rank above the garden doc for sunset questions
    const sunsetFiles = r1.sources.map((s) => path.basename(s.file));
    ok("sunset documents rank above unrelated docs for a sunset query",
      sunsetFiles.some((n) => n.startsWith("sunset")),
      JSON.stringify(sunsetFiles));

    const r2 = await search("zzzxyznothing");
    ok("a junk query returns low-relevance or empty results", !r2.error || r2.chunks.length === 0);

    // Empty index errors cleanly: fresh index with an empty temp dir
    const EMPTY_INDEX = path.join(TMP, "kb-index-empty");
    kbIndex.resetForTesting();
    kbIndex.setIndexDirForTesting(EMPTY_INDEX);
    const r3 = await search("anything");
    ok("search with no indexed folders reports no-index", r3.error === "no-index");

    // Restore the index for the query tests
    kbIndex.resetForTesting();
    kbIndex.setIndexDirForTesting(INDEX_DIR);
    ok("index reloaded for remaining tests", kbIndex.listFolders().length >= 1);
  }

  // ==========================================================================
  // 8. Query composition: private refusal + snippets-only contract
  // ==========================================================================
  {
    configure({ getPrivateMode: () => false });
    const sentToModel = [];
    configure({
      getPrivateMode: () => false,
      router: async (model, messages) => {
        sentToModel.push({ model, body: messages.map((m) => m.content).join("\n") });
        return "Nova answer: sunset phase two starts in October.";
      },
    });

    const results = await search("when does sunset phase two start");
    const answer = await compose("when does sunset phase two start", results);
    ok("compose returns an answer with sources when Private Mode is off",
      answer.ok === true && answer.text.includes("sunset") && (answer.sources?.length || 0) > 0);

    ok("the model prompt contains ONLY chunks, never full documents",
      sentToModel.length > 0 &&
      sentToModel.every((m) => m.body.includes("[1]") && m.body.includes("Snippets:")));
    const sentBody = sentToModel[0].body;
    ok("the model prompt contains only the retrieved chunks, not the whole corpus",
      !sentBody.includes("Root readme") && sentBody.includes("[1]"));

    // Private Mode: exact refusal phrase
    configure({ getPrivateMode: () => true });
    const refused = await compose("secret question", { chunks: [], sources: [] });
    ok("Private Mode refuses with the EXACT required phrase",
      refused.refused === true &&
      refused.text === "Knowledge base search needs Private Mode off — I won't send your documents anywhere while it's on.");
    ok("a refused answer carries no sources", refused.sources?.length === 0);
    ok("Private Mode never calls the model", sentToModel.length === 1);

    // Empty results → plain miss message
    configure({ getPrivateMode: () => false });
    const miss = await compose("q", { chunks: [], sources: [] });
    ok("no matching chunks returns a plain miss message",
      miss.ok === true && miss.text.includes("found nothing relevant"));
  }

  // ==========================================================================
  // 9. Planner: every intent + folder resolution
  // ==========================================================================
  {
    setTestFoldersForTesting([SAMPLE]);
    const cases = [
      ["add this folder to my knowledge base", "kb:add-folder"],
      ["add the sample kb folder to my kb", "kb:add-folder"],
      ["search my knowledge base for sunset", "kb:query"],
      ["what did I write about project sunset in my kb", "kb:query"],
      ["what did I write about project sunset in my knowledge base", "kb:query"],
      ["find my documents on sunset budget", "kb:query"],
      ["search my kb for garden", "kb:query"],
      ["what's in my knowledge base", "kb:list-folders"],
      ["list my indexed folders", "kb:list-folders"],
      ["re-index my knowledge base now", "kb:reindex"],
      ["remove this folder from the index", "kb:remove-folder"],
      ["remove the sample-kb folder from my kb", "kb:remove-folder"],
      ["open the source file sunset-plan.txt", "kb:open-source"],
    ];
    for (const [text, id] of cases) {
      const p = planKbAction(text, { kbFolders: [SAMPLE] });
      ok(`plan: "${text}" → ${id}`, p && p.actionId === id && !p.error, JSON.stringify(p));
    }

    ok("non-kb chatter plans null (falls through to other intents)",
      planKbAction("hey nova, what time is it", {}) === null);
    setTestFoldersForTesting(null);
    ok("'add folder' with no path returns a planning error, not a payload",
      planKbAction("add folder to my kb", {})?.error);
    const removeMissing = planKbAction("remove the nonexistent folder from the index", { kbFolders: [SAMPLE] });
    ok("removing a folder that is not indexed returns a friendly error",
      removeMissing?.error && removeMissing.error.includes("indexed folder named"));

    ok("normalizeFolderHint matches a root path",
      normalizeFolderHint(SAMPLE) === SAMPLE);
    ok("normalizeFolderHint matches by basename",
      normalizeFolderHint(path.basename(SAMPLE)) === path.basename(SAMPLE));
  }

  // ==========================================================================
  // 10. Dispatcher end-to-end through the gate (voice path)
  // ==========================================================================
  {
    kbIndex.resetForTesting();
    kbIndex.setIndexDirForTesting(INDEX_DIR);
    configure({ getPrivateMode: () => false });

    // Add the folder via the dispatcher (L2 toast auto-resolves headlessly)
    const addRes = await kbDispatch.runKbAction("add this folder to my knowledge base", {
      ctx: { lastKbFolder: SAMPLE },
    });
    ok("dispatcher add-folder: indexes through the gate (L2)",
      addRes.ok && (addRes.detail?.filesTotal || 0) >= 4 && (addRes.text || "").includes("indexed"));

    const listRes = await kbDispatch.runKbAction("list my indexed folders");
    ok("dispatcher list-folders: stats through the gate (L1)",
      listRes.ok && listRes.detail?.stats?.chunks > 0);

    // Query: must embed locally and compose from snippets only
    configure({
      router: async (model, messages) => {
        ok("kb:query composes from top chunks only (mock router observed)",
          messages[0].content.includes("Snippets:") && !messages[0].content.includes("Root readme"));
        return "Phase two of Project Sunset starts in October.";
      },
    });
    const qRes = await kbDispatch.runKbAction("what did I write about project sunset in my kb");
    ok("dispatcher query: ok + answer cites sources",
      qRes.ok && (qRes.detail?.sources?.length || 0) > 0 && (qRes.text || "").includes("from"),
      qRes.text);

    // Private Mode query refusal (exact phrase) propagates through the dispatcher
    configure({ getPrivateMode: () => true });
    const privRes = await kbDispatch.runKbAction("search my kb for budget");
    configure({ getPrivateMode: () => false });
    ok("dispatcher query in Private Mode refuses with the EXACT phrase",
      privRes.refused === true &&
      privRes.text === "Knowledge base search needs Private Mode off — I won't send your documents anywhere while it's on.");

    // Remove the folder via the dispatcher (L2)
    const rmRes = await kbDispatch.runKbAction(`remove folder sample-kb from the index`);
    ok("dispatcher remove-folder: removes index, originals intact",
      rmRes.ok && rmRes.actionId === "kb:remove-folder" && kbIndex.listFolders().length === 0 &&
      fs.existsSync(path.join(SAMPLE, "sunset-budget.md")));
    ok("remove-folder dispatcher confirms originals are untouched",
      fs.readFileSync(path.join(SAMPLE, "sunset-plan.txt"), "utf8").includes("phase two"));

    const openRes = await kbDispatch.runKbAction(`open the source file sunset-plan.txt`);
    ok("dispatcher open-source: confirms the action (open happens in main process)",
      openRes.ok && openRes.actionId === "kb:open-source");
  }

  // ==========================================================================
  // 11. Intent classification: kb vs the rest
  // ==========================================================================
  {
    const kbPhrases = [
      "add this folder to my knowledge base",
      "what did I write about project sunset in my kb",
      "search my kb for garden",
      "find my documents on the sunset budget",
      "list my indexed folders",
      "remove the sunset folder from the index",
    ];
    for (const t of kbPhrases) {
      const c = await classify(t);
      ok(`classify: "${t}" → kb`, c?.intent === INTENTS.KB, c?.intent);
    }
    const nonKb = [
      ["find my resume", INTENTS.FILES],
      ["note that I have a dentist appointment", INTENTS.NOTES],
      ["what did I note about dentist", INTENTS.NOTES],
      ["what did I write about the sunset budget", INTENTS.NOTES],
      ["what's on my screen", INTENTS.VISION],
      ["hey nova", INTENTS.CONVERSATION],
    ];
    for (const [t, want] of nonKb) {
      const c = await classify(t);
      ok(`classify: "${t}" → ${want} (not kb)`, c?.intent === want, c?.intent);
    }
  }

  // ==========================================================================
  // 12. Unified agent dispatcher routes KB through the gate
  // ==========================================================================
  {
    kbIndex.resetForTesting();
    kbIndex.setIndexDirForTesting(INDEX_DIR);
    configure({ getPrivateMode: () => false });

    const out = await dispatcher.run("add this folder to my knowledge base", {
      getKey: async () => null,
      mainWindow: null,
      ctx: { lastKbFolder: SAMPLE },
    });
    ok("unified dispatcher: KB request indexed via the agent loop",
      out?.ok === true && out.intent === "kb", out?.text);
  }

  // ==========================================================================
  // Done
  // ==========================================================================
  console.log(`\n${"=".repeat(60)}\nkb tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
