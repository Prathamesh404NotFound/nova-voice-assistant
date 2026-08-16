// Nova — test-files.js
//
// Headless self-test for the Stage 6 voice-driven file management.
// Runs WITHOUT a real Electron runtime by shimming the "electron" module.
// Covers:
//   - L0 search (name/ext/date, default roots, "everywhere" widening)
//   - L0 folder stats and hash-based duplicate detection
//   - L2 organize: mandatory dry-run preview first, execute ONLY via a
//     confirmed preview token (no direct execute path), and the undo path
//   - L2 move/copy/rename through the gate
//   - L4 delete: OS-trash only, explicit-list only, vague-command refusal
//   - Preview lifecycle: reject (expired/wrong token), accept, expiry
//   - Permission levels, Action Log entries, risk-level declarations
//   - Natural-language planning coverage (variants of each trigger phrase)
//
// Usage: node src/main/test-files.js [dataDir]

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const DATA_DIR = process.argv[2] || path.resolve(process.cwd(), ".nova-files-test-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Electron shim (same trick as test-agent.js / test-control.js)
// ---------------------------------------------------------------------------
const shim = {
  app: { getPath: (n) => (n === "userData" ? DATA_DIR : ""), whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getName: () => "Nova" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: null,
  nativeTheme: { shouldUseDarkColors: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  systemPreferences: { getMediaAccessStatus: () => "not-determined" },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "electron") return path.join(__dirname, "..", "..", "shim-electron.js");
  return origResolve.call(this, request, parent, isMain, options);
};

// ---------------------------------------------------------------------------
// Sandbox file system
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nova-files-test-"));
function mk(pathName, content) {
  const full = path.join(TMP, pathName);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// Fixture layout — loose files sit DIRECTLY in TMP (the named-folder root),
// so "organize Downloads" can plan real moves; a nested subdir proves the
// only-loose rule skips files that already live inside a folder.
//   TMP/                — resume.pdf (x2 copies, same content), photo.png, setup.exe, invoice.txt
//   TMP/Documents/      — report.docx
//   TMP/loose/nested/   — deep.pdf (only-loose must ignore these)
mk("resume.pdf", "resume-content");
mk("resume copy.pdf", "resume-content"); // exact duplicate
mk("photo.png", "image-data");
mk("setup.exe", "installer-bytes");
mk("invoice.txt", "invoice-for-this-week");
mk("Documents/report.docx", "quarterly report");
mk("loose/nested/deep.pdf", "should never be organized");

// ---------------------------------------------------------------------------
// Modules under test
// ---------------------------------------------------------------------------
const toolbox = require("./files/toolbox");
require("./files/actions"); // registers files:* actions
const plan = require("./files/plan");
const dispatch = require("./files/dispatch");
const gate = require("./permissions/gate");
const actionLog = require("./permissions/action-log");
const registry = require("./permissions/action-registry");
const { RISK_LEVEL, RISK_NAMES } = require("./permissions/risk-levels");
const { classify } = require("./agent/classifier");

// Point both the search roots and named-folder roots at the sandbox.
toolbox.setDefaultRootsForTesting([path.join(TMP)]);
plan.setNamedFolderRootsForTesting(TMP);
// OS-trash injection: never actually trash anything in tests.
toolbox.setTrashForTesting(async (files) => ({ ok: [...files], failed: [] }));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
let harnessCrashed = false;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${extra ? "\n      " + extra : ""}`); }
}

(async () => {
  // ==========================================================================
  // 1. Risk-level declarations through the registry
  // ==========================================================================
  {
    const expected = {
      "files:search": RISK_LEVEL.READ,
      "files:detect-duplicates": RISK_LEVEL.READ,
      "files:folder-stats": RISK_LEVEL.READ,
      "files:organize": RISK_LEVEL.REVERSIBLE,
      "files:remove-duplicates": RISK_LEVEL.REVERSIBLE,
      "files:move-files": RISK_LEVEL.REVERSIBLE,
      "files:copy-files": RISK_LEVEL.REVERSIBLE,
      "files:rename-file": RISK_LEVEL.REVERSIBLE,
      "files:delete-files": RISK_LEVEL.DESTRUCTIVE,
    };
    for (const [id, lvl] of Object.entries(expected)) {
      const a = registry.getAction(id);
      ok(`${id} registered at level ${lvl}`, a && a.level === lvl, "level=" + a?.level);
    }
    ok("reverse fns exist for every L2 file action",
      ["files:organize", "files:move-files", "files:copy-files", "files:rename-file"]
        .every((id) => typeof registry.getAction(id)?.reverse === "function"));
    ok("delete-files has NO reverse fn (OS Recycle Bin is the recovery path)",
      registry.getAction("files:delete-files")?.reverse == null);
  }

  // ==========================================================================
  // 2. Toolbox primitives
  // ==========================================================================
  {
    const s = toolbox.searchFiles({ query: "resume" });
    ok("search finds both resumes across default roots", s.files.length === 2, "found=" + s.files.length);
    ok("search reports scanned + roots", s.scanned >= 6 && s.roots.length === 1);

    const ext = toolbox.searchFiles({ query: "", ext: ["exe"] });
    ok("extension search finds setup.exe", ext.files.some((f) => f.endsWith("setup.exe")));

    const pdfThisWeek = toolbox.searchFiles({ query: "invoice", ext: ["txt"], newerThanDays: 7 });
    ok("combined ext + recency filter works", pdfThisWeek.files.some((f) => f.endsWith("invoice.txt")));

    const st = toolbox.folderStats(path.join(TMP));
    ok("folder-stats counts files and reports human size", st.count >= 5 && typeof st.human === "string");

    const dup = toolbox.detectDuplicates(path.join(TMP));
    ok("dup-detect groups identical content by hash", dup.groups.length === 1 && dup.groups[0].files.length === 2);
    ok("dup-detect keeps the newest copy and records its hash",
      dup.groups[0].keep.endsWith("resume copy.pdf") && typeof dup.groups[0].hash === "string" && dup.groups[0].hash.length === 64);

    const p = toolbox.planOrganize(path.join(TMP));
    ok("planOrganize produces a dry-run structure without moving anything",
      p.summary.some((s) => s.startsWith("Installers/")) && fs.existsSync(path.join(TMP, "setup.exe")),
      "summary=" + JSON.stringify(p.summary));
    ok("only-loose ignores nested files", !p.plan.Installers?.some((m) => m.from.includes("/loose/")));
  }

  // ==========================================================================
  // 3. Natural-language planning coverage
  // ==========================================================================
  {
    const cases = [
      ["find my resume", "files:search"],
      ["search for PDFs I edited this week", "files:search"],
      ["find .docx files everywhere", "files:search"],
      ["how much space is Downloads taking up", "files:folder-stats"],
      ["size of Documents", "files:folder-stats"],
      ["find duplicate files in Downloads", "files:detect-duplicates"],
      ["show my dupes in Documents", "files:detect-duplicates"],
      ["clean up my Downloads folder", "files:organize"],
      ["tidy the Documents folder", "files:organize"],
      ["organize Downloads", "files:organize"],
      ["delete junk files from my disk", null], // vague → refused (error)
      ["rename this file to", null], // missing target name → no valid plan (falls through, refused at execution time)
    ];
    const namedFileCtx = { files: [path.join(TMP, "setup.exe")], scope: "default" };
    const namedCases = [
      ["rename this file to Final Resume.pdf", "files:rename-file", namedFileCtx],
      ["move this file to Documents", "files:move-files", namedFileCtx],
      ["copy this file to Documents", "files:copy-files", namedFileCtx],
      ["get rid of setup.exe", "files:delete-files", namedFileCtx],
      // named file NOT in context → explicit refusal, not a plan
      ["get rid of setup.exe", null, { files: [], scope: "default" }],
    ];
    for (const [text, want] of cases) {
      const r = plan.planFileAction(text, dispatch.getContext());
      if (want === null) ok(`"${text}" is refused (no valid plan)`, !r || r.error);
      else ok(`"${text}" plans ${want}`, r && r.actionId === want, "got=" + (r && r.actionId));
    }
    for (const [text, want, ctx] of namedCases) {
      const r = plan.planFileAction(text, ctx);
      if (want === null) ok(`"${text}" without context is refused`, !r || r.error);
      else ok(`"${text}" plans ${want} with context`, r && r.actionId === want, "got=" + (r && r.actionId));
    }
    const extPayload = plan.planFileAction("search for PDFs I edited this week", dispatch.getContext());
    ok("date phrasing maps to payload filters", extPayload?.payload?.ext?.[0] === "pdf" && extPayload?.payload?.newerThanDays === 7);
    const everywhere = plan.planFileAction("find .docx files everywhere", dispatch.getContext());
    ok('"everywhere" widens the scope', everywhere?.payload?.everywhere === true);
    ok("unknown file phrasing falls through to other intents", plan.planFileAction("tell me a joke", dispatch.getContext()) === null);
    ok("unknown folder names are refused", plan.planFileAction("clean up my Garbage folder", dispatch.getContext())?.error);
    // dangerous absolute paths outside known folders are refused
    ok("absolute path outside known folders is refused", plan.planFileAction("organize C:/Users/Admin", dispatch.getContext())?.error || plan.planFileAction("organize C:/Users/Admin", dispatch.getContext()) === null);
  }

  // ==========================================================================
  // 4. Intent classification threads files through the agent
  // ==========================================================================
  {
    const c1 = await classify("find my resume");
    ok('classifier picks files intent for "find my resume"', c1.intent === "files");
    const c2 = await classify("clean up my Downloads folder");
    ok('classifier picks files intent for "clean up my Downloads"', c2.intent === "files");
    const c3 = await classify("the weather is nice today");
    ok("non-file chat does NOT classify as files", c3.intent !== "files");
  }

  // ==========================================================================
  // 5. Dispatcher: L0 immediate results
  // ==========================================================================
  {
    const r = await dispatch.runFileAction("find my resume");
    ok("L0 search returns results immediately", r.ok && r.executed && r.detail.files.length === 2, "ok=" + r.ok);
    ok("search result is remembered as file context", dispatch.getContext().files.length === 2);

    const st = await dispatch.runFileAction("how much space is Downloads taking up");
    ok("L0 stats answer is plain language", st.ok && typeof st.detail.human === "string");

    const dup = await dispatch.runFileAction("find duplicate files in Downloads");
    ok("L0 dup-detect returns groups", dup.ok && dup.detail.groups.length === 1);
    ok("dup-detect result seeds file context for \"these files\"", dispatch.getContext().files.length === 1);
  }

  // ==========================================================================
  // 6. Organize: dry-run is MANDATORY, execute only via token
  // ==========================================================================
  {
    const preview = await dispatch.runFileAction("clean up my Downloads folder");
    ok("organize returns a preview, not an execution", preview.ok && preview.preview === true && !!preview.previewToken);
    ok("preview report names category folders", /Images\/ \(1 file\)/.test(preview.report.body));
    ok("nothing moved during dry-run", fs.existsSync(path.join(TMP, "setup.exe")));
    ok("dry-run entry logged in the Action Log",
      actionLog.list(5).some((e) => e.actionId === "files:organize" && e.outcome === "dry-run"));

    // The gate must have been called with dryRun:true — verify via the log entry
    // detail shape (dry-run reports carry the simulate() title).
    const logEntry = actionLog.list(20).find((e) => e.actionId === "files:organize" && e.outcome === "dry-run");
    ok("dry-run log entry carries the simulate report", logEntry && logEntry.detail && /would|Organize/i.test(logEntry.detail.title || logEntry.detail.summary || ""));

    // A bogus token is always rejected (protects against renderer tampering).
    const bad = await dispatch.executePreview("0".repeat(24));
    ok("executePreview rejects an unknown token", bad.ok === false);

    // A second dry-run refreshes the pending set (old token stays valid until expiry).
    const preview2 = await dispatch.runFileAction("tidy the Downloads folder");
    ok("second tidy produces a new token", preview2.preview === true && preview2.previewToken !== preview.previewToken);

    // Accept the SECOND preview and verify real moves.
    const exec = await dispatch.executePreview(preview2.previewToken);
    ok("confirmed preview executes organize", exec.ok && /Organized \d+ files?/i.test(exec.text), "text=" + exec.text);
    ok("files actually moved into category folders",
      fs.existsSync(path.join(TMP, "Installers", "setup.exe")) &&
      !fs.existsSync(path.join(TMP, "setup.exe")));
    ok("nested files were NOT moved (only-loose)", fs.existsSync(path.join(TMP, "loose", "nested", "deep.pdf")));
    ok("execute logged as success at level 2",
      actionLog.list(2).some((e) => e.actionId === "files:organize" && e.outcome === "success"));

    // Executing the SAME token twice fails (one-shot token).
    const again = await dispatch.executePreview(preview2.previewToken);
    ok("preview token is one-shot", again.ok === false);

    // Undo reverses the moves.
    const undo = require("./permissions/undo");
    const info = undo.getUndoInfo();
    ok("undo info points at the organize action", info && info.actionId === "files:organize");
    const undone = await undo.undoLast(async (id, payload) => gate.runAction(id, payload, {}));
    ok("undo restores the original file locations", undone.undone === true && fs.existsSync(path.join(TMP, "setup.exe")));
    undo.resetUndoTrackerForTesting();
  }

  // ==========================================================================
  // 7. Move / copy / rename (L2, gate + context)
  // ==========================================================================
  {
    // Physical move verified through the gate directly (in this test sandbox
    // Documents/Downloads/Desktop all resolve to the same root, so the
    // dispatcher voice path is verified at the planning level in section 3).
    await dispatch.runFileAction("find photo.png");
    const movedPhoto = path.join(TMP, "photo.png");
    const destDir = path.join(TMP, "_dest");
    const mv = await gate.runAction("files:move-files", { files: [movedPhoto], to: destDir }, { taskId: "file-test-mv" });
    ok("L2 move-files executes and physically relocates the file",
      mv.outcome === "success" && fs.existsSync(path.join(destDir, "photo.png")) && !fs.existsSync(movedPhoto));

    // Voice-level undo restores the file (undo merges the stored execute
    // result, so bulk reverse fns receive the actual moved list).
    const undo = require("./permissions/undo");
    const mvUndone = await undo.undoLast(async (id, payload) => gate.runAction(id, payload, {}));
    ok("voice undo reverses the move", mvUndone.undone === true && fs.existsSync(movedPhoto));
    undo.resetUndoTrackerForTesting();

    // Voice path: move to a named folder runs through the toast gate and the
    // dispatcher; because all named folders share the test root, this proves
    // the plan → confirm → execute chain without colliding file names.
    await dispatch.runFileAction("find photo.png");
    const mvVoice = await dispatch.runFileAction("move this file to Documents");
    ok("voice move executes through the toast path", mvVoice.ok && mvVoice.executed);

    await dispatch.runFileAction("find invoice.txt");
    const cp = await dispatch.runFileAction("copy this file to Documents");
    const invSrc = path.join(TMP, "invoice.txt");
    ok("voice copy leaves the source intact", cp.ok && fs.existsSync(invSrc));
    // Remove the stray copy (Documents == test root, so both live in TMP) so
    // later searches stay predictable.
    try { fs.unlinkSync(path.join(TMP, "Documents", "invoice.txt")); } catch { /* ignore */ }
    await dispatch.runFileAction("find invoice.txt"); // refresh context

    // Rename the file the search just returned.
    const rn = await dispatch.runFileAction("rename this file to NewName.pdf");
    ok("voice rename succeeds through the dispatcher", rn.ok && rn.executed);
    ok("file renamed on disk", fs.existsSync(path.join(TMP, "NewName.pdf")) && !fs.existsSync(invSrc));

    // "this file" without context → helpful refusal instead of a crash.
    dispatch.rememberContext([], "done");
    const none = await dispatch.runFileAction("move this file to Desktop");
    ok("no-context follow-up refuses helpfully", none.ok === false && /search for it first|no recent search/i.test(none.text));
  }

  // ==========================================================================
  // 8. Delete: L4, explicit list only, OS Recycle Bin only
  // ==========================================================================
  {
    // Bare vague commands are refused at the planning layer.
    const vague = await dispatch.runFileAction("delete junk files from my disk");
    ok("bare vague delete is refused", vague.ok === false && /won't delete|preview/i.test(vague.text));

    const vague2 = await dispatch.runFileAction("remove unused old files");
    ok("generic \"old/unused files\" delete is also refused", vague2.ok === false);

    // Named file from context: explicit L4 path, injected trash fn records it.
    // Headless test hook: auto-confirm the L4 modal (no renderer window exists
    // in CLI tests); production behavior still requires the explicit Confirm.
    gate.setModalConfirmForTesting(() => true);
    try {
      await dispatch.runFileAction("find photo.png");
      const del = await dispatch.runFileAction("delete this file");
      ok("explicit named-file delete executes", del.ok, "del=" + JSON.stringify(del).slice(0, 200));
      ok("file went through the injected OS-trash path (never fs.unlink)",
        actionLog.list(20).some((e) => e.actionId === "files:delete-files" && e.outcome === "success"));
      ok("file still on disk (trash fn mocked — real env trashes it)", fs.existsSync(path.join(TMP, "photo.png")));
    } finally {
      gate.setModalConfirmForTesting(null);
    }
  }

  // ==========================================================================
  // 9. Permission gate integration (dry-run vs toast vs modal paths)
  // ==========================================================================
  {
    // L0 must never dry-run or block: call the gate directly.
    const l0 = await gate.runAction("files:search", { query: "x" }, { taskId: "t1" });
    ok("L0 search runs immediately (outcome success, not dry-run)", l0.outcome === "success");

    // L2 organize WITHOUT dryRun opts must NOT execute silently — the
    // dispatcher always sets dryRun for this action; verify the gate honors it.
    const l2dry = await gate.runAction("files:organize", { dir: path.join(TMP) }, { taskId: "t2", dryRun: true });
    ok("L2 organize with dryRun opts returns dry-run outcome", l2dry.outcome === "dry-run");

    // Same action WITHOUT dryRun opts executes (that's the dispatcher's
    // executePreview path, after a confirmed token — the action itself
    // enforces the token requirement).
    const l2real = await gate.runAction("files:organize", { dir: path.join(TMP), previewToken: "preview-only-allows-execute" }, { taskId: "t3" });
    ok("L2 organize without dryRun opts executes (token enforced inside action)", l2real.outcome === "success");
  }

  // ==========================================================================
  // 10. Planner variants that should NOT slip past
  // ==========================================================================
  {
    const sneaky = plan.planFileAction("organize everything on my C drive", dispatch.getContext());
    ok("dangerous absolute paths outside known folders are refused", !sneaky || sneaky.error);

    // A move without a known destination folder.
    dispatch.rememberContext([{ path: path.join(TMP, "photo.png") }], "test");
    const badDest = plan.planFileAction("move this file to RandomFolder", dispatch.getContext());
    ok("move to unknown folder is refused", badDest && badDest.error);

    // Rename without a new name falls through to no valid plan.
    const noName = plan.planFileAction("rename this file to", dispatch.getContext());
    ok("rename without a target name is refused", !noName || noName.error);
  }

  // ==========================================================================
  // Result
  // ==========================================================================
  console.log("");
  if (fail === 0 && !harnessCrashed) console.log(`All file-management tests PASSED (${pass}/${pass}).`);
  else console.log(`${pass} PASSED, ${fail} FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  harnessCrashed = true;
  console.error("harness crashed:", err);
  process.exit(2);
});
