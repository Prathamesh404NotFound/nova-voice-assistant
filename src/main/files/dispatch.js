// Nova — files/dispatch.js
//
// The file-management half of the agent loop (Stage 6). A message that
// planFileAction() recognizes is executed through the SAME permission gate
// as every other action: L0 searches run immediately, L2 moves go through
// the 5-second toast, organize ALWAYS dry-runs first, and L4 deletes go
// through the modal — with the critical extra rule that the organizer can
// only execute against a dry-run report the user explicitly confirmed.
//
//   plan text                ── planFileAction()
//   if preview needed        ── runAction(id, payload, {dryRun:true})
//                                → emit "file-preview" (token bound)
//   user confirms            ── executePreview(token) → runAction(id, p)
//
// Each dispatcher call keeps the last results as "file context" so a follow-up
// "move this file to Documents" resolves naturally (Stage 6 req 6).

const crypto = require("crypto");
const path = require("path");
const log = require("electron-log");
const { runAction } = require("../permissions/gate");
const { planFileAction, organizeExecutePayload } = require("./plan");

const { EventEmitter } = require("events");
const events = new EventEmitter();

/** Pending dry-run previews: token → { actionId, payload, taskId, createdAt }. */
const pendingPreviews = new Map();

/** Maximum time a preview token stays valid (5 minutes — same window as undo). */
const PREVIEW_TTL_MS = 5 * 60 * 1000;

/** File context for "this file" / "these files" follow-ups. */
let fileContext = { files: [], scope: "default" };

function nextToken() {
  return crypto.randomBytes(12).toString("hex");
}

function prunePreviews() {
  const now = Date.now();
  for (const [token, entry] of pendingPreviews) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) pendingPreviews.delete(token);
  }
}

/** Remember search/detection results for follow-up "this file" commands. */
function rememberContext(files, scope = "default") {
  fileContext = { files: files || [], scope };
}

function getContext() {
  return fileContext;
}

/**
 * Run one file-management request.
 * @param {string} text
 * @param {{ taskId?: string }} opts
 * @returns {Promise<object>}
 *   conversation-ish answers: { ok, intent:"files", text, narration }
 *   preview requests:          { ok, intent:"files", preview: true, actionId, report, previewToken, narration }
 *   executed actions:          { ok, intent:"files", executed: true, outcome, detail, narration }
 *   errors:                    { ok, intent:"files", text (plain), error (raw) }
 */
async function runFileAction(text, opts = {}) {
  const taskId = opts.taskId || `file-${Date.now()}`;
  const action = planFileAction(text, fileContext);
  if (!action) return null; // caller falls back to other intents
  if (action.error) {
    return { ok: false, intent: "files", text: action.error };
  }

  const { actionId, payload, narration } = action;
  try {
    const started = Date.now();
    // Organize/remove-duplicates ALWAYS preview first — the gate's dry-run
    // (simulate) path is triggered by opts.dryRun, never by the payload.
    const wantsPreview = actionId === "files:organize" || actionId === "files:remove-duplicates";
    const optsForGate = wantsPreview ? { taskId, dryRun: true } : { taskId };
    const res = await runAction(actionId, payload, optsForGate);
    log.info(`[files] "${actionId}" → ${res.outcome} (${Date.now() - started} ms)`);

    if (res.outcome === "cancelled") {
      return { ok: true, intent: "files", text: "Cancelled — nothing was changed.", narration };
    }
    if (res.outcome === "failed" || res.outcome === "blocked") {
      const msg = (res.detail?.error || "").toString();
      return {
        ok: false,
        intent: "files",
        text: res.outcome === "blocked"
          ? "Private Mode blocks this — turn it off in settings to manage files."
          : "That did not work — see Developer Mode for details.",
        error: new Error(msg || res.outcome),
        narration,
      };
    }

    // --- Preview branch (dry-run; organize is the only one that needs a
    //     confirmed token to execute afterwards) ---------------------------------
    if (res.outcome === "dry-run") {
      const report = res.detail; // action-specific simulate report
      const token = nextToken();
      pendingPreviews.set(token, {
        actionId,
        dir: payload.dir,
        onlyLoose: payload.onlyLoose !== false,
        groups: payload.groups || null,
        report,
        taskId,
        createdAt: Date.now(),
      });
      prunePreviews();
      rememberContext(report?.movedFiles || [], "preview");
      return {
        ok: true,
        intent: "files",
        preview: true,
        actionId,
        report,
        previewToken: token,
        narration: narration || `Plan ready — review it before I change anything.`,
      };
    }

    // --- Immediate answer branch (L0: search / stats / dup detection) -----
    if (actionId === "files:search") rememberContext(res.detail?.files || []);
    if (actionId === "files:detect-duplicates") {
      const groups = res.detail?.groups || [];
      rememberContext(groups.flatMap((g) => g.files.filter((f) => f.path !== g.keep).map((f) => f.path)));
    }

    return {
      ok: true,
      intent: "files",
      executed: true,
      actionId,
      detail: res.detail,
      narration: narration || `Done: ${actionId}.`,
    };
  } catch (err) {
    log.error("[files] action errored:", err?.message || err);
    return { ok: false, intent: "files", text: "Something went wrong — details are in Developer Mode.", error: err };
  }
}

/**
 * Execute a previously confirmed organize dry-run (token-bound).
 * The token must come from a preview the user explicitly confirmed in the
 * renderer — there is NO direct "execute organize" path.
 */
async function executePreview(token, opts = {}) {
  prunePreviews();
  const entry = pendingPreviews.get(token);
  if (!entry) {
    return { ok: false, intent: "files", text: "That preview has expired or was never confirmed — run the command again and confirm the plan shown to you." };
  }
  pendingPreviews.delete(token);
  let payload;
  if (entry.actionId === "files:remove-duplicates") {
    payload = { groups: entry.groups };
  } else {
    payload = organizeExecutePayload({ dir: entry.dir, token, onlyLoose: entry.onlyLoose });
  }
  const res = await runAction(entry.actionId, payload, { taskId: entry.taskId || opts.taskId });
  if (res.outcome === "success") {
    const moved = res.detail?.moved || [];
    const movedCount = moved.length;
    const summary = moved
      .map((m) => `${path.basename(m.from)} → ${path.basename(path.dirname(m.to))}/`)
      .join("  ");
    rememberContext([], "done");
    const text =
      entry.actionId === "files:remove-duplicates"
        ? `Removed ${res.detail?.trashed || 0} duplicate file${res.detail?.trashed === 1 ? "" : "s"} to the Recycle Bin — newest copies kept.`
        : `Organized ${movedCount} file${movedCount === 1 ? "" : "s"}: ${summary || "nothing deleted — files were only moved."}`;
    return {
      ok: true,
      intent: "files",
      executed: true,
      actionId: entry.actionId,
      text,
      narration: text,
    };
  }
  if (res.outcome === "cancelled") {
    return { ok: true, intent: "files", text: "Cancelled — nothing was changed." };
  }
  return {
    ok: false,
    intent: "files",
    text: "The action failed — nothing was changed. Details are in Developer Mode.",
    error: new Error(res.detail?.error || "unknown error"),
  };
}

module.exports = {
  runFileAction,
  executePreview,
  getContext,
  rememberContext,
  events,
  pendingPreviews, // exposed for tests only
};
