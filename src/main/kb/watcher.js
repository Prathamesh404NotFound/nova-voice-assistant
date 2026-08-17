// Folder watching for the knowledge base (Stage 8).
// One chokidar watcher per indexed folder. Changes are debounced in a burst
// window so many simultaneous writes become a single incremental re-index.
// Only the affected files are re-indexed (incremental), never the folder.

const path = require("path");
const fs = require("fs");
const kbIndex = require("./index");

const DEBOUNCE_MS = 1500;

const _watchers = new Map(); // folderId → { watcher, pending: Set, timer }

function startWatching(folderId) {
  stopWatching(folderId);
  const manifestFolders = require("./index").listFolders ? null : null;
  const folders = kbIndex.listFolders();
  const entry = folders.find((f) => f.id === folderId);
  if (!entry) return;
  try {
    // eslint-disable-next-line node/no-unsupported-features/node-builtins
    const chokidar = require("chokidar");
    const watcher = chokidar.watch(entry.root, {
      ignoreInitial: true,
      persistent: true,
      depth: 8,
      ignored: /(^|[\/\\])\../,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    const state = { watcher, pending: new Set(), timer: null };
    _watchers.set(folderId, state);

    const scheduleFlush = () => {
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => flushPending(folderId, state), DEBOUNCE_MS);
    };

    for (const ev of ["add", "change", "unlink"]) {
      watcher.on(ev, (absPath) => {
        if (ev === "unlink" && state.pending.size === 0 && state.timer === null) {
          // single delete: handle immediately (fast path)
          handleUnlink(folderId, absPath, entry.root);
          return;
        }
        state.pending.add(`${ev}:${absPath}`);
        scheduleFlush();
      });
    }
    watcher.on("error", (err) => {
      console.warn(`[kb] watcher error for ${entry.root}: ${err.message}`);
    });
  } catch (err) {
    console.warn(`[kb] could not start watcher for ${entry.root}: ${err.message}`);
  }
}

function flushPending(folderId, state) {
  state.timer = null;
  if (state.pending.size === 0) return;
  const pending = Array.from(state.pending);
  state.pending.clear();
  (async () => {
    try {
      await kbIndex.reindexFolder(folderId);
      emit("watcher", { folderId, action: "reindex", files: pending.length });
    } catch (err) {
      console.warn(`[kb] incremental re-index failed for ${folderId}: ${err.message}`);
    }
  })();
}

function handleUnlink(folderId, absPath, root) {
  (async () => {
    try {
      // re-index is incremental anyway; but for a lone delete keep it cheap:
      // a reindexFolder with force:false is incremental — use the regular path.
      await kbIndex.reindexFolder(folderId);
      emit("watcher", { folderId, action: "removed", file: path.relative(root, absPath) });
    } catch (err) {
      console.warn(`[kb] re-index after delete failed: ${err.message}`);
    }
  })();
}

function stopWatching(folderId) {
  const state = _watchers.get(folderId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.watcher.close().catch(() => {});
  _watchers.delete(folderId);
}

function stopAll() {
  for (const id of Array.from(_watchers.keys())) stopWatching(id);
}

function startAll() {
  for (const f of kbIndex.listFolders()) startWatching(f.id);
}

// progress/event forwarding: renderer subscribes to kb:watcher events
let _listener = null;
function onWatcherEvent(cb) { _listener = cb; }
function emit(type, payload) {
  global.__kbWatcherEvent = { type, payload, updatedAt: Date.now() };
  if (_listener) _listener({ type, payload });
}

function resetForTesting() {
  stopAll();
  _listener = null;
}

module.exports = { startWatching, stopWatching, startAll, stopAll, onWatcherEvent, resetForTesting };
