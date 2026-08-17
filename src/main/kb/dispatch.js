// Knowledge base dispatcher (Stage 8).
// runKbAction(text, opts) — parses, runs the gate, composes RAG answers,
// returns { ok, intent:"kb", text, narration, ... }.

const path = require("path");
const { planKbAction, resolveFolderHint } = require("./plan");
const kbIndex = require("./index");
const { search } = require("./search");
const { compose, configure } = require("./query");
const gate = require("../permissions/gate");
const actionLog = require("../permissions/action-log");

// progress forwarding: renderer polls/streams via global hook + mainWindow
function forwardProgress(evt) {
  if (global.__kbProgressBridge && evt) {
    try { global.__kbProgressBridge(evt); } catch {}
  }
}

/**
 * Resolve a "this" folder reference from dispatcher context (last indexed
 * folder touched in this conversation), mirroring the files "this file"
 * pattern.
 */
function resolveThisFolder(ctx, folders) {
  const last = ctx && (ctx.lastKbFolder || (ctx.kbFolders && ctx.kbFolders[0]));
  if (last) {
    const hit = folders.find((f) => f.root === last || path.basename(f.root) === last);
    if (hit) return hit.root;
  }
  return null;
}

async function runKbAction(text, opts = {}) {
  const folders = kbIndex.listFolders();
  const ctx = { ...kbContext(folders), ...(opts.ctx || {}) };
  const planned = planKbAction(text, ctx);
  if (!planned) {
    return { ok: false, intent: "kb", text: null };
  }
  if (planned.error) {
    actionLog.append({ actionId: null, level: null, outcome: "planning-error", reason: planned.error });
    return { ok: false, intent: "kb", text: planned.error, detail: { planningError: planned.error } };
  }
  let { actionId, payload } = planned;

  if (actionId === "kb:add-folder") {
    if (!payload.folder || payload.folder === "this") {
      const root = resolveThisFolder(ctx, folders)
        || (ctx && ctx.lastKbFolder ? String(ctx.lastKbFolder) : null)
        || (global.__kbAddFolderOverride ? global.__kbAddFolderOverride() : null);
      if (!root) {
        return { ok: false, intent: "kb", text: "I need a folder path — say \"add <path> to my knowledge base\" or click \"Add folder\" in the Knowledge Base panel." };
      }
      payload.folder = root;
    }
    if (folders.length >= kbIndex.MAX_FOLDERS && !folders.find((f) => f.root === payload.folder)) {
      return { ok: false, intent: "kb", text: `You already have ${kbIndex.MAX_FOLDERS} indexed folders. Remove one first.` };
    }
    let res;
    try {
      res = await gate.runAction(actionId, payload, { taskId: opts.taskId });
      if (res.outcome !== "success") {
        return { ok: false, intent: "kb", text: "Adding the folder was cancelled." };
      }
      // indexing is the heavy part — run it now and emit progress
      kbIndex.onProgress(forwardProgress);
      const idx = await kbIndex.indexFolder(payload.folder);
      if (global.__kbWatcherBridge) { try { global.__kbWatcherBridge(idx.folderId); } catch {} }
      return {
        ok: true, intent: "kb", actionId,
        text: `I've indexed "${idx.root}" — ${idx.filesTotal} files scanned, ${idx.added + idx.updated} indexed, ${idx.skipped} skipped. You can ask me anything about them.`,
        narration: `Indexing ${idx.root} complete.`,
        detail: idx,
      };
    } catch (err) {
      return { ok: false, intent: "kb", text: `I couldn't index that folder: ${err.message || err}.`, error: true };
    }
  }

  if (actionId === "kb:remove-folder") {
    const target = payload.folder === "this" ? resolveThisFolder(ctx, folders) : (resolveFolderHint(payload.folder) || null);
    let entry = target ? folders.find((f) => f.root === target) : null;
    if (!entry) {
      // fallback: match by basename (ignoring stray "folder"/"directory" words) or id
      const cleaned = String(payload.folder).toLowerCase().replace(/folder|directory/gi, "").trim();
      entry = folders.find((f) => path.basename(f.root).toLowerCase() === cleaned || path.basename(f.root).toLowerCase() === String(payload.folder).toLowerCase() || f.id === payload.folder) || null;
    }
    if (!entry) {
      return { ok: false, intent: "kb", text: `I could not find an indexed folder named "${payload.folder}".` };
    }
    const res = await gate.runAction(actionId, { folderId: entry.id, root: entry.root }, { taskId: opts.taskId });
    if (res.outcome !== "success") return { ok: false, intent: "kb", text: "Removing the folder from the index was cancelled." };
    const del = await kbIndex.removeFolder(entry.id);
    if (global.__kbWatcherBridge) { try { global.__kbWatcherBridge("stop", entry.id); } catch {} }
    return {
      ok: true, intent: "kb", actionId,
      text: `I removed "${entry.root}" from the index. Your original files are untouched, and you can undo this within 5 minutes.`,
      narration: `Removed ${entry.root} from the knowledge base.`,
      detail: { root: entry.root, deletedIndexSize: del.snapshot.chunks.length },
    };
  }

  if (actionId === "kb:reindex") {
    const res = await gate.runAction(actionId, payload, { taskId: opts.taskId });
    if (res.outcome !== "success") return { ok: false, intent: "kb", text: "Re-indexing was cancelled." };
    kbIndex.onProgress(forwardProgress);
    const results = [];
    for (const f of kbIndex.listFolders()) {
      try {
        const r = await kbIndex.reindexFolder(f.id);
        results.push(`${path.basename(r.root)}: ${r.updated + r.added} re-indexed`);
      } catch (err) {
        results.push(`${path.basename(f.root)}: failed (${err.message})`);
      }
    }
    return {
      ok: true, intent: "kb", actionId,
      text: `Re-index complete. ${results.join("; ") || "Nothing changed."}`,
      narration: "Knowledge base re-indexed.",
      detail: { results },
    };
  }

  if (actionId === "kb:list-folders") {
    const res = await gate.runAction(actionId, payload, { taskId: opts.taskId });
    if (res.outcome !== "success") return { ok: false, intent: "kb", text: "Cancelled." };
    const st = await kbIndex.stats();
    const lines = kbIndex.listFolders().map((f) => `- ${f.root} (${f.fileCount} files, ${f.chunkCount} chunks)`);
    return {
      ok: true, intent: "kb", actionId,
      text: st.folders ? `Your knowledge base has ${st.folders} indexed folders with ${st.chunks} chunks. ${lines.join(" ")}` : "Your knowledge base is empty — say \"add this folder to my knowledge base\" to start.",
      narration: st.folders ? `You have ${st.folders} indexed folders.` : "No folders indexed yet.",
      detail: { stats: st, folders: kbIndex.listFolders() },
    };
  }

  if (actionId === "kb:open-source") {
    const file = payload.file;
    const res = await gate.runAction(actionId, { file }, { taskId: opts.taskId });
    if (res.outcome !== "success") return { ok: false, intent: "kb", text: "Cancelled." };
    // shell.openPath happens in main.js via nova:kb-open-source to stay in the renderer process;
    // here we just confirm the action.
    return { ok: true, intent: "kb", actionId, text: `Opening ${path.basename(file)}.`, narration: `Opening ${path.basename(file)}.`, detail: { file } };
  }

  if (actionId === "kb:query") {
    const res = await gate.runAction(actionId, { question: payload.question }, { taskId: opts.taskId });
    if (res.outcome !== "success") return { ok: false, intent: "kb", text: "Query was cancelled." };
    configure(); // wire private-mode getter before composing
    const results = await search(payload.question);
    if (results.error === "no-index") {
      return { ok: false, intent: "kb", text: "Your knowledge base has no indexed folders yet — add one first." };
    }
    const answer = await compose(payload.question, results);
    const sourcesText = results.sources.length
      ? ` (from ${results.sources.map((s) => s.title || path.basename(s.file)).join(", ")})`
      : "";
    if (answer.refused) {
      return { ok: false, intent: "kb", text: answer.text, refused: true, detail: { sources: [] } };
    }
    return {
      ok: true, intent: "kb", actionId,
      text: answer.text + sourcesText,
      narration: answer.text,
      detail: { sources: results.sources, chunks: results.chunks.slice(0, 3) },
    };
  }

  return { ok: false, intent: "kb", text: "I'm not sure what you want to do with the knowledge base." };
}

function kbContext(folders) {
  return { kbFolders: folders.map((f) => f.root) };
}

module.exports = { runKbAction };
