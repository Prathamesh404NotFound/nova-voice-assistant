// Nova — files/toolbox.js
//
// Local file-management primitives (Stage 6). Pure fs operations — every call
// still has to pass through the permission gate via files/actions.js.
//   searchFiles        — name / extension / modified-date search (L0)
//   folderStats        — size of a folder in human units (L0)
//   detectDuplicates   — SHA-256 content-hash groups within a folder (L0)
//   planOrganize       — dry-run organize plan: proposed structure + counts (L0 report;
//                        execution is a separate L2 action)
//   moveToTrash        — OS Recycle Bin / Trash (never permanent) (L4)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const os = require("os");
const log = require("electron-log");

// ---------------------------------------------------------------------------
// Search roots
// ---------------------------------------------------------------------------
const DEFAULT_ROOTS = ["Documents", "Downloads", "Desktop"].map((d) =>
  path.join(os.homedir(), d),
);
/** Override the default search roots (headless tests only). */
function setDefaultRootsForTesting(roots) {
  DEFAULT_ROOTS.length = 0;
  DEFAULT_ROOTS.push(...roots);
}

/** Roots for "search everywhere": home dir, minus obviously dangerous subtrees. */
function everywhereRoots() {
  const roots = [os.homedir()];
  // On Windows also search non-system drives that exist (best effort).
  if (process.platform === "win32") {
    try {
      const vols = execSync('wmic logicaldisk get caption 2>nul', { timeout: 5000, encoding: "utf8" });
      for (const line of vols.split(/\r?\n/)) {
        const cap = line.trim();
        if (/^[A-Z]:\\$/.test(cap) && !roots.includes(cap)) roots.push(cap);
      }
    } catch { /* wmic unavailable — home dir only */ }
  }
  return roots;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "__pycache__", ".cache"]);
const SKIP_PREFIXES = ["."];

/**
 * Walk a directory tree, yielding absolute file paths.
 */
function* walk(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    try {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKIP_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
        yield* walk(full);
      } else if (entry.isFile()) {
        yield full;
      }
    } catch { /* permission denied — skip */ }
  }
}

/**
 * Search files by name fragment, extension(s), and/or modification window.
 * @param {{ query?: string, ext?: string[], newerThanDays?: number, everywhere?: boolean, limit?: number }} opts
 * @returns {{ files: string[], scanned: number, roots: string[] }}
 */
function searchFiles(opts = {}) {
  const roots = opts.everywhere ? everywhereRoots() : DEFAULT_ROOTS.filter(fs.existsSync);
  const q = (opts.query || "").trim().toLowerCase();
  const exts = (opts.ext || []).map((e) => e.replace(/^\./, "").toLowerCase());
  const newerMs = opts.newerThanDays != null ? Date.now() - opts.newerThanDays * 86400000 : null;
  const limit = opts.limit != null ? Math.min(Math.max(opts.limit, 1), 200) : 50;
  const files = [];
  let scanned = 0;
  outer: for (const root of roots) {
    for (const full of walk(root)) {
      scanned++;
      if (files.length >= limit) break outer;
      const base = path.basename(full);
      const lower = base.toLowerCase();
      if (q && !lower.includes(q)) continue;
      if (exts.length) {
        const dotless = lower.split(".").pop();
        if (!exts.includes(dotless)) continue;
      }
      if (newerMs != null) {
        try {
          if (fs.statSync(full).mtimeMs < newerMs) continue;
        } catch {
          continue;
        }
      }
      files.push(full);
    }
  }
  return { files, scanned, roots };
}

// ---------------------------------------------------------------------------
// Folder stats
// ---------------------------------------------------------------------------
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function folderStats(dir) {
  let bytes = 0;
  let count = 0;
  for (const full of walk(dir)) {
    try {
      bytes += fs.statSync(full).size;
      count++;
    } catch { /* skip */ }
  }
  return { dir, bytes, count, human: humanSize(bytes) };
}

// ---------------------------------------------------------------------------
// Duplicate detection (SHA-256, content-based)
// ---------------------------------------------------------------------------
function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.slice(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Group files with identical content inside a folder.
 * @returns {{ groups: [{ hash, size, humanSize, files: [{ path, mtimeMs }], keep }], scanned }}
 * keep = the newest file in each group
 */
function detectDuplicates(dir, { limit = 200 } = {}) {
  const byHash = new Map();
  let scanned = 0;
  for (const full of walk(dir)) {
    scanned++;
    if (scanned > limit * 10) break; // sanity cap
    try {
      const stat = fs.statSync(full);
      const hash = sha256File(full);
      const key = `${stat.size}:${hash}`;
      const arr = byHash.get(key) || [];
      arr.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size, hash });
      byHash.set(key, arr);
    } catch { /* skip */ }
  }
  const groups = [];
  for (const [, arr] of byHash) {
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, b) => b.mtimeMs - a.mtimeMs);
    groups.push({
      hash: sorted[0].hash ? sorted[0].hash : null,
      size: sorted[0].size,
      humanSize: humanSize(sorted[0].size),
      files: sorted,
      keep: sorted[0].path, // newest stays
    });
  }
  return { groups, scanned };
}

// ---------------------------------------------------------------------------
// Organize dry-run planner
// ---------------------------------------------------------------------------
const CATEGORY_EXT = {
  Documents: ["pdf", "doc", "docx", "txt", "odt", "rtf", "md", "csv", "xls", "xlsx", "ppt", "pptx"],
  Images: ["jpg", "jpeg", "png", "gif", "svg", "webp", "bmp", "tiff", "heic"],
  Videos: ["mp4", "mkv", "mov", "avi", "webm", "wmv", "flv"],
  Audio: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "wma"],
  Archives: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
  Installers: ["exe", "msi", "dmg", "app", "pkg", "iso", "deb", "rpm"],
};

function categoryFor(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  for (const [cat, exts] of Object.entries(CATEGORY_EXT)) {
    if (exts.includes(ext)) return cat;
  }
  return "Other";
}

/**
 * Plan how `organize` would move files. Returns the dry-run preview structure.
 */
function planOrganize(dir, { onlyLoose = true } = {}) {
  const plan = {}; // category -> [ { from, to, ext } ]
  let counted = 0;
  for (const full of walk(dir)) {
    const base = path.basename(full);
    if (onlyLoose && path.dirname(full) !== dir) continue; // loose files only
    const cat = categoryFor(base);
    const targetDir = path.join(dir, cat);
    if (!path.relative(targetDir, full)) continue; // already inside its own category folder
    (plan[cat] = plan[cat] || []).push({ from: full, to: path.join(targetDir, base), ext: base.split(".").pop().toLowerCase() });
    counted++;
  }
  const summary = Object.entries(plan).map(([cat, moves]) => `${cat}/ (${moves.length} file${moves.length === 1 ? "" : "s"})`);
  return { plan, summary, movedFiles: counted };
}

// ---------------------------------------------------------------------------
// OS Recycle Bin / Trash (L4 — never permanent)
// ---------------------------------------------------------------------------
let __trashFn = null; // test injection

function setTrashForTesting(fn) {
  __trashFn = fn;
}

/**
 * Move files to the OS Recycle Bin / Trash. Resolves per-platform:
 *   win32   PowerShell [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(...SendToRecycleBin)
 *   darwin  osascript 'tell app "Finder" to delete (POSIX file ...)'
 *   linux   `gio trash` (GNOME) — fails loudly if unavailable instead of deleting permanently
 * @returns {{ ok: string[], failed: [{ path, error }] }}
 */
async function moveToTrash(files) {
  if (__trashFn) return __trashFn(files);
  const ok = [];
  const failed = [];
  for (const file of files) {
    try {
      if (process.platform === "win32") {
        const escaped = file.replace(/'/g, "''");
        execSync(
          `powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}','OnlyErrorDialogs','SendToRecycleBin')"`,
          { timeout: 30000, stdio: ["ignore", "ignore", "pipe"] },
        );
      } else if (process.platform === "darwin") {
        execSync(`osascript -e 'tell application "Finder" to delete (POSIX file "${file}" as alias)'`, {
          timeout: 30000,
          stdio: ["ignore", "ignore", "pipe"],
        });
      } else {
        execSync(`gio trash "${file}"`, { timeout: 30000, stdio: ["ignore", "ignore", "pipe"] });
      }
      ok.push(file);
      log.info("[files] moved to OS trash:", file);
    } catch (err) {
      log.warn("[files] trash failed:", file, err?.message || err);
      failed.push({ path: file, error: String(err?.message || err).split("\n")[0] });
    }
  }
  return { ok, failed };
}

module.exports = {
  DEFAULT_ROOTS,
  setDefaultRootsForTesting,
  searchFiles,
  folderStats,
  humanSize,
  detectDuplicates,
  categoryFor,
  planOrganize,
  moveToTrash,
  setTrashForTesting,
  CATEGORY_EXT,
};
