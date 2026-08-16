// Nova — files/plan.js
//
// Parses natural-language file-management requests into action payloads for
// the permission gate (Stage 6). Deliberately rule-based and CONSERVATIVE:
//   - search / stats / duplicate detection = L0, immediate
//   - organize / move / copy / rename = L2, but organize ALWAYS dry-runs first
//   - delete = L4, ONLY with an explicit file list (names from search context
//     or a confirmed dry-run preview) — bare "delete junk" commands are refused
//
// "this file" / "these files" resolve to the dispatcher's file context (last
// search or detection results) so voice commands stay natural.

const path = require("path");
const toolbox = require("./toolbox");

// ---------------------------------------------------------------------------
// Recognizers
// ---------------------------------------------------------------------------
const RE_FIND =
  /(?:find|search (for)?|locate|look for)\s+(?:(?:my |the )?(.+?))?\s*(?:in|within|inside)\s+(.+?)\s*$/i;
const RE_FIND_SIMPLE = /(?:find|search (for)?|locate|look for)\s+(?:my |the )?(.+?)(?:\s+please)?\s*$/i;
// "how much space is Downloads taking up" | "size of Documents" | "how big is Downloads"
const RE_SPACE = /(?:how much (?:space|size|room)|how big|size of)\s+(?:is\s+|does\s+)?(?:(?:my |the )?(.+?)(?:\s+(?:folder|directory))?\s*)?(?:take|taking|is|take up)?\s*(?:up)?\s*$/i;
const RE_DUPLICATES = /(?:find|show|detect|list)\s+(?:my |the )?(?:duplicates?(?:\s+files?)?|dupes?)\s+(?:in|within|inside)\s+(?:my |the )?(.+)$/i;
const RE_ORGANIZE = /(?:clean up|cleanup|clean|tidy|organize|sort)\s+(?:my |the )?([a-zA-Z][a-zA-Z0-9 \-&]*?)(?:\s+folder)?\s*$/i;
const RE_MOVE = /move\s+(?:my |the )?(this file|these files?|that file|those files?|(.+?))\s+to\s+(?:my |the )?(.+?)(?:\s+folder)?\s*$/i;
const RE_COPY = /copy\s+(?:my |the )?(this file|these files?|that file|those files?|(.+?))\s+to\s+(?:my |the )?(.+?)(?:\s+folder)?\s*$/i;
const RE_RENAME = /rename\s+(?:my |the )?(this file|that file|(.+?))\s+to\s+(?:my |the )?(.+?)(?:\s+folder)?\s*$/i;
const RE_DELETE = /(?:delete|remove|trash|get rid of)\s+(?:my |the )?(.+?)(?:\s+files?)?(?:\s+please)?\s*$/i;
const RE_SPACE_FOLDER = /\b(documents|downloads|desktop|pictures|videos|music)\b/i;

/** Resolve a spoken folder name to an absolute path (only safe/common roots). */
const NAMED_FOLDERS = {
  documents: () => path.join(require("os").homedir(), "Documents"),
  downloads: () => path.join(require("os").homedir(), "Downloads"),
  desktop: () => path.join(require("os").homedir(), "Desktop"),
  pictures: () => path.join(require("os").homedir(), "Pictures"),
  videos: () => path.join(require("os").homedir(), "Videos"),
  music: () => path.join(require("os").homedir(), "Music"),
};

function resolveFolder(raw) {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase();
  if (NAMED_FOLDERS[norm]) return NAMED_FOLDERS[norm]();
  // Absolute / relative-ish literal paths are allowed only if they exist.
  if (/^[~/A-Z]:|^\/|^\.?\//.test(norm)) {
    const p = norm.startsWith("~") ? path.join(require("os").homedir(), norm.slice(1)) : norm;
    return p;
  }
  return null; // unknown → refuse
}

/** Override the named-folder roots (Documents/Downloads/…) in headless tests. */
function setNamedFolderRootsForTesting(root) {
  const mk = () => root;
  NAMED_FOLDERS.documents = mk;
  NAMED_FOLDERS.downloads = mk;
  NAMED_FOLDERS.desktop = mk;
  NAMED_FOLDERS.pictures = mk;
  NAMED_FOLDERS.videos = mk;
}

/** Resolve "this file(s)" / named files to absolute paths from context. */
function resolveTargets(text, ctx) {
  if (/this file|these files|that file|those files/i.test(text)) {
    if (!ctx || !ctx.files || !ctx.files.length) return null;
    if (/these files|those files/i.test(text)) return [...ctx.files];
    return [ctx.files[0]];
  }
  // Bare "this"/"that" (e.g. "delete this", "remove that") also point at the
  // most recent search result when context exists.
  if (/^this$|^that$/i.test(text.trim())) {
    if (!ctx || !ctx.files || !ctx.files.length) return null;
    return [ctx.files[0]];
  }
  // Named files: match against context file basenames.
  if (ctx?.files?.length) {
    const t = text.toLowerCase();
    const matches = ctx.files.filter((f) => t.includes(path.basename(f).toLowerCase()));
    if (matches.length) return matches;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Intent parsers
// ---------------------------------------------------------------------------

/**
 * @param {string} text        user message
 * @param {{ files?: string[], scope?: "default"|"everywhere" }} ctx   file context (last results)
 * @returns {{ actionId: string, payload: object, narration?: string } | { error: string }}
 */
function planFileAction(text, ctx) {
  const t = text.trim();
  let m;

  // --- duplicate detection ------------------------------------------------
  m = t.match(RE_DUPLICATES);
  if (m) {
    const dir = resolveFolder(m[1]);
    if (!dir) return { error: `I could not find a folder called "${m[1]}". Say Documents, Downloads, or Desktop.` };
    return { actionId: "files:detect-duplicates", payload: { dir }, narration: `Scanning ${path.basename(dir)} for duplicates…` };
  }

  // --- find / search -----------------------------------------------------
  m = t.match(RE_FIND) || t.match(RE_FIND_SIMPLE);
  if (m) {
    const query = (m[2] || "").trim();
    if (!query) return { error: "What should I search for?" };
    const scopeIn = t.match(RE_FIND) ? (t.match(RE_FIND)[3] || "").trim() : "";
    const everywhere = /everywhere|whole|entire|computer/i.test(scopeIn || t);
    const payload = { query, everywhere };
    // "find PDFs" / "find my pdf files" — map common extension words to ext filter.
    const extMatch = query.match(/(pdfs?|docxs?|docs?|txt|jpgs?|jpegs?|pngs?|mp3s?|mp4s?|zips?|xlsx?\w*)\b/i);
    if (extMatch) payload.ext = [extMatch[1].replace(/s?$/, "").toLowerCase()];
    // "PDFs I edited this week" — combine extension + recency.
    if (/this week/i.test(t)) payload.newerThanDays = 7;
    else if (/this month/i.test(t)) payload.newerThanDays = 30;
    return { actionId: "files:search", payload, narration: `Searching for "${query}"…` };
  }

  // --- folder stats ------------------------------------------------------
  m = t.match(RE_SPACE);
  if (m) {
    const folder = ((m[3] || m[4]) || "").trim() || (t.match(RE_SPACE_FOLDER) || [])[1];
    const dir = resolveFolder(folder) || (folder ? resolveFolder(folder) : null);
    if (!dir) return { error: `I could not find a folder called "${folder}". Say Documents, Downloads, or Desktop.` };
    return { actionId: "files:folder-stats", payload: { dir }, narration: `Measuring ${path.basename(dir)}…` };
  }

  // --- organize (tidy) — always dry-run first ----------------------------
  m = t.match(RE_ORGANIZE);
  if (m) {
    const dir = resolveFolder(m[1]);
    if (!dir) return { error: `I could not find a folder called "${m[1]}". Say Documents, Downloads, or Desktop.` };
    // Step 1 is ALWAYS the dry-run preview (L2 simulate path); execution
    // only happens with the preview token after explicit user confirmation.
    return {
      actionId: "files:organize",
      payload: { dir, onlyLoose: true },
      narration: `Planning how to tidy ${path.basename(dir)}…`,
    };
  }

  // --- move / copy / rename (L2) -----------------------------------------
  m = t.match(RE_MOVE) || t.match(RE_COPY);
  if (m) {
    const targets = resolveTargets(t, ctx);
    const to = resolveFolder(m[m.length - 1]);
    if (!targets) return { error: "Which files? I have no recent search results — try \"find …\" first, then \"move this file to Documents\"." };
    if (!to) return { error: `I could not find a destination called "${m[m.length - 1]}". Say Documents, Downloads, or Desktop.` };
    const isCopy = RE_COPY.test(t);
    return {
      actionId: isCopy ? "files:copy-files" : "files:move-files",
      payload: { files: targets, to },
      narration: isCopy
        ? `Copying ${targets.length} file${targets.length === 1 ? "" : "s"} to ${path.basename(to)}…`
        : `Moving ${targets.length} file${targets.length === 1 ? "" : "s"} to ${path.basename(to)}…`,
    };
  }

  m = t.match(RE_RENAME);
  if (m) {
    const targets = resolveTargets(t, ctx);
    const newName = (m[m.length - 1] || "").trim();
    if (!targets) return { error: "Which file? I have no recent search results — try \"find …\" first." };
    if (!newName) return { error: "Rename to what?" };
    return {
      actionId: "files:rename-file",
      payload: { from: targets[0], to: path.join(path.dirname(targets[0]), newName) },
      narration: `Renaming ${path.basename(targets[0])}…`,
    };
  }

  // --- delete (L4, explicit list ONLY) ------------------------------------
  m = t.match(RE_DELETE);
  if (m) {
    const raw = (m[1] || "").trim();
    // Refuse vague junk/garbage/old-files style commands without explicit targets.
    if (/junk|garbage|trash (files|stuff)|old (stuff|files|things)|unused|unnecessary|useless|temp files/i.test(raw) && !resolveTargets(raw, ctx)) {
      return {
        error:
          "I won't delete files from a vague description. First search for them (e.g. \"find old invoices\") — I will show you a preview list and you can confirm exactly what gets deleted.",
      };
    }
    const targets = resolveTargets(raw, ctx);
    if (!targets) {
      return { error: `I could not find "${raw}". Search for it first so I can show you exactly what would be deleted.` };
    }
    return {
      actionId: "files:delete-files",
      payload: { files: targets },
      narration: `Preparing to move ${targets.length} file${targets.length === 1 ? "" : "s"} to the Recycle Bin…`,
    };
  }

  return null; // not a file intent
}

/**
 * Execution payload for organize AFTER the dry-run preview was confirmed.
 * The previewToken binds execution to a specific dry-run report.
 */
function organizeExecutePayload(preview) {
  return { dir: preview.dir, previewToken: preview.token, onlyLoose: preview.onlyLoose !== false };
}

const FILE_RE =
  /(?:find|search|locate|look for|how much space|how big|size of|clean up|cleanup|tidy|organize|sort|move|copy|rename|delete|remove|trash|get rid of)\b/i;

module.exports = { planFileAction, setNamedFolderRootsForTesting, resolveFolder, organizeExecutePayload, RE_FIND, RE_DUPLICATES, FILE_RE };

