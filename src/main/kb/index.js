// Index management for the knowledge base (Stage 8).
//
// Per-folder index: userData/kb-index/<folderHash>.json — flat array of
// { id, text, embedding, meta }. Manifest: userData/kb-index/manifest.json
// holds folder list, per-folder file modtime map (incremental re-index) and
// stats.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { extractText } = require("./extractor");
const { chunkText } = require("./chunker");
const { embed } = require("./embeddings");

const MAX_DEPTH = 8;
const MAX_FILES = 2000;
const MAX_FOLDERS = 5;
const MAX_CHUNKS = 50000;

function dataDir() {
  const { app } = require("electron");
  return app ? app.getPath("userData") : process.cwd();
}

let _indexDirOverride = null;
function setIndexDirForTesting(dir) {
  _indexDirOverride = dir;
}

function indexDir() {
  const dir = _indexDirOverride || path.join(dataDir(), "kb-index");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function folderHash(absPath) {
  return crypto.createHash("sha1").update(path.resolve(absPath)).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(indexDir(), "manifest.json"), "utf8"));
  } catch {
    return { folders: {} };
  }
}

function saveManifest(m) {
  const tmp = path.join(indexDir(), "manifest.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, path.join(indexDir(), "manifest.json"));
}

function folderIndexFile(folderId) {
  return path.join(indexDir(), `${folderId}.json`);
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

function walkFolder(root) {
  const files = [];
  const dirs = [{ dir: root, depth: 0 }];
  while (dirs.length && files.length < MAX_FILES) {
    const { dir, depth } = dirs.shift();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith(".")) {
        dirs.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

let _progressCb = null;
function onProgress(cb) { _progressCb = cb; }
function emitProgress(folderId, status, filesDone = null, filesTotal = null) {
  if (_progressCb) {
    _progressCb({ folderId, status, filesDone, filesTotal });
  }
  // also store on global for IPC forwarding
  global.__kbIndexProgress = { folderId, status, filesDone, filesTotal, updatedAt: Date.now() };
}

async function indexFolder(absPath, opts = {}) {
  const root = path.resolve(absPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("not a valid folder");
  }
  const folderId = folderHash(root);
  const manifest = loadManifest();
  if (Object.keys(manifest.folders).length >= MAX_FOLDERS && !manifest.folders[folderId]) {
    throw new Error(`max ${MAX_FOLDERS} indexed folders`);
  }
  const entry = manifest.folders[folderId] || {
    id: folderId, root, addedAt: new Date().toISOString(), modtimes: {}, files: {},
  };
  entry.root = root;

  const files = walkFolder(root);
  const existing = entry.files || {};
  let filesDone = 0;
  const results = { added: 0, updated: 0, removed: 0, skipped: 0, filesTotal: files.length, errors: [] };
  const removedIds = new Set();

  emitProgress(folderId, "indexing", 0, files.length);

  // 1) scan files: index changed/new
  const touched = {};
  for (const f of files) {
    let stat;
    try { stat = fs.statSync(f); } catch { continue; }
    const rel = path.relative(root, f);
    const mtime = stat.mtimeMs;
    if (!opts.force && existing[rel] && existing[rel].mtime === mtime) {
      touched[rel] = existing[rel];
      filesDone++;
      continue;
    }
    const ex = await extractText(f);
    if (ex.skipped) {
      results.skipped++;
      touched[rel] = null; // tracked as seen, no chunks
      filesDone++;
      emitProgress(folderId, "indexing", filesDone, files.length);
      continue;
    }
    const chunks = chunkText(ex.text, { folderId, relPath: rel, absPath: f, title: path.basename(f) });
    if (chunks.length === 0) {
      touched[rel] = null;
      results.skipped++;
      filesDone++;
      emitProgress(folderId, "indexing", filesDone, files.length);
      continue;
    }
    // embed in small batches
    const vecs = await embed(chunks.map((c) => c.text));
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].embedding = vecs[i];
    }
    touched[rel] = { mtime, chunks: chunks.map((c) => c.id), bytes: stat.size };
    results[existing[rel] ? "updated" : "added"]++;
    filesDone++;
    emitProgress(folderId, "indexing", filesDone, files.length);
    // persist incrementally per file so a crash keeps progress
    await saveIndexIncremental(folderId, entry, { rel, file: touched[rel], chunks });
  }

  // 2) remove files no longer present
  for (const rel of Object.keys(existing)) {
    if (!(rel in touched)) {
      removedIds.add(rel);
      results.removed++;
    }
  }

  // 3) save final state
  entry.files = touched;
  entry.lastIndexedAt = new Date().toISOString();
  entry.chunkCount = Object.values(touched).filter(Boolean).reduce((a, f) => a + f.chunks.length, 0);
  manifest.folders[folderId] = entry;
  if (removedIds.size) {
    await purgeRemovedChunks(folderId, removedIds, Object.keys(existing));
  }
  saveManifest(manifest);
  emitProgress(folderId, "done", filesDone, files.length);
  return { folderId, root, ...results };
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function loadIndex(folderId) {
  try {
    return JSON.parse(fs.readFileSync(folderIndexFile(folderId), "utf8"));
  } catch {
    return [];
  }
}

function saveIndex(folderId, chunks) {
  const tmp = `${folderIndexFile(folderId)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(chunks));
  fs.renameSync(tmp, folderIndexFile(folderId));
}

// add/update chunks for a file incrementally (append-mostly; rewrite if big)
async function saveIndexIncremental(folderId, entry, { rel, file, chunks }) {
  const manifest = loadManifest();
  const existing = manifest.folders[folderId]?.files?.[rel] || null;
  let all = loadIndex(folderId);
  // remove stale chunks for this file
  if (existing && existing.chunks) {
    const stale = new Set(existing.chunks);
    all = all.filter((c) => !stale.has(c.id));
  }
  // append new chunks, dropping embedding floats to 6 decimals
  for (const c of chunks) {
    c.embedding = c.embedding.map((v) => Math.round(v * 1e6) / 1e6);
    all.push(c);
  }
  saveIndex(folderId, all);
}

async function purgeRemovedChunks(folderId, removedRels, allRels) {
  let all = loadIndex(folderId);
  let keep = 0;
  for (const rel of removedRels) {
    const file = loadManifest().folders[folderId]?.files?.[rel];
    if (file?.chunks) {
      const stale = new Set(file.chunks);
      keep += all.filter((c) => !stale.has(c.id)).length;
      all = all.filter((c) => !stale.has(c.id));
    }
  }
  if (all.length > MAX_CHUNKS) {
    // too big — truncate oldest (head), keep newest
    all = all.slice(all.length - MAX_CHUNKS);
  }
  saveIndex(folderId, all);
}

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

function listFolders() {
  const manifest = loadManifest();
  const out = [];
  for (const id of Object.keys(manifest.folders)) {
    const f = manifest.folders[id];
    const chunks = loadIndex(id);
    out.push({
      id, root: f.root, addedAt: f.addedAt, lastIndexedAt: f.lastIndexedAt || null,
      fileCount: Object.keys(f.files || {}).length,
      chunkCount: chunks.length,
      bytes: Math.round(chunks.reduce((a, c) => a + (c.text?.length || 0) * 2, 0)),
    });
  }
  return out;
}

async function removeFolder(folderId) {
  const manifest = loadManifest();
  const entry = manifest.folders[folderId];
  if (!entry) throw new Error("folder not indexed");
  const snapshot = {
    manifest: { ...entry },
    chunks: loadIndex(folderId),
    indexFile: folderIndexFile(folderId),
    manifestFile: path.join(indexDir(), "manifest.json"),
  };
  delete manifest.folders[folderId];
  saveManifest(manifest);
  try { fs.unlinkSync(folderIndexFile(folderId)); } catch {}
  return { folderId, root: entry.root, snapshot };
}

function restoreFolderSnapshot(snapshot) {
  const manifest = loadManifest();
  manifest.folders[snapshot.manifest.id] = snapshot.manifest;
  saveManifest(manifest);
  const tmp = `${snapshot.indexFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot.chunks));
  fs.renameSync(tmp, snapshot.indexFile);
  return { folderId: snapshot.manifest.id, restored: snapshot.chunks.length };
}

async function stats() {
  const folders = listFolders();
  let chunks = 0, bytes = 0;
  for (const f of folders) { chunks += f.chunkCount; bytes += f.bytes; }
  return { folders: folders.length, chunks, bytes, maxFolders: MAX_FOLDERS, maxChunks: MAX_CHUNKS };
}

async function reindexFolder(folderId, opts = {}) {
  const manifest = loadManifest();
  const entry = manifest.folders[folderId];
  if (!entry) throw new Error("folder not indexed");
  return indexFolder(entry.root, { ...opts, force: true });
}

// tests
function resetForTesting() {
  // Tests MUST call setIndexDirForTesting(dir) AFTER this, or the module falls
  // back to the real userData index directory — an easy trap for test writers.
  _indexDirOverride = null;
}

module.exports = {
  indexFolder, removeFolder, restoreFolderSnapshot, listFolders, stats,
  reindexFolder, folderHash, loadIndex, setIndexDirForTesting, resetForTesting,
  onProgress, MAX_FOLDERS, MAX_FILES, MAX_DEPTH,
};
