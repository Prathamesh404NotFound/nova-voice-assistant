// Natural-language planner for the knowledge base (Stage 8).
// Maps voice/text to action payloads. Returns null when the phrase is not
// a knowledge-base intent (the classifier then falls through to FILES).


const RE_ADD_THIS = /^(?:nova,?\s*)?(?:add|include|index)\s+this\s+(?:folder|directory|path)(?:\s+to\s+(?:my\s+)?(?:knowledge\s*base|kb|index))?\s*$/i;
// folder name is captured BEFORE the trailing clause, so "add /home/docs to my kb"
// captures "/home/docs", not "to my kb".
const RE_ADD = /^(?:nova,?\s*)?(?:add|include|index)\s+(?:(?:this\s+)?(?:folder|directory|path)\s+)?["\u201c]?([^"\u201d\n]+?)["\u201d]?\s+to\s+(?:my|the|that)\s+(?:knowledge\s*base|kb|index)\s*$/i;
// Named-folder add: "add the docs folder to my kb" captures "docs" — tried
// first so the "folder" word does not get absorbed into the path capture.
const RE_ADD_NAMED = /^(?:nova,?\s*)?(?:add|include|index)\s+(?:(?:the|my|that)\s+)?["\u201c]?([^"\u201d\n]+?)\s+folder(?:s)?\s+to\s+(?:my|the|that)\s+(?:knowledge\s*base|kb|index)\s*$/i;

const RE_REMOVE_THIS = /^(?:nova,?\s*)?(?:remove|delete|unindex)\s+this\s+(?:folder|directory)(?:\s+from\s+(?:my|the|that)\s+(?:knowledge\s*base|kb|index))?\s*$/i;
// Named-folder remove: "remove the docs folder from the index", "delete
// sunset from my knowledge base" — the captured chunk is the folder hint;
// a trailing "folder/directory" word is accepted and stripped later.
const RE_REMOVE = /^(?:nova,?\s*)?(?:remove|delete|unindex)\s+(?:(?:the|my|that)\s+)?["\u201c]?(.+)["\u201d]?\s*(?:folder|directory)?\s+from\s+(?:my|the|that)\s+(?:knowledge\s*base|kb|index)\s*$/i;


const RE_REINDEX = /^(?:nova,?\s*)?(?:re-?index|rebuild|refresh|update)\s+(?:my\s+)?(?:knowledge\s*base|kb|index)(?:\s+now)?\s*$/i;

const RE_QUERY = [
  // "what did I write about X in my kb", "find my files on X", "search my knowledge
  // base for X". The bare "what did I note/write about X" phrasing belongs to the
  // NOTES stage (keyword search over stored notes) — a KB query needs an explicit
  // knowledge-base context marker so the two stages don't collide.
  // The "write/note about" phrasing requires a knowledge-base context suffix —
  // the bare form belongs to the NOTES stage. "find my docs/files on X" and
  // "search my kb" are KB-typical even without a suffix.
  /^(?:nova,?\s*)?(?:(?:(?:what|what did I|what have I)\s+(?:write|written|note|say|put|learn).{0,60}?\babout\b\s*["“]?([^"”\n]+?)["”]?\s*(?:\s+in\s+(?:my\s+)?(?:knowledge\s*base|kb|index|documents|files)|\s+on\s+(?:my\s+)?(?:documents|files))\s*$)|(?:find\s+(?:my\s+)?(?:docs|documents|files).{0,60}?\b(?:on|about)\b\s*["“]?([^"”\n]+?)["”]?\s*$)|(?:search\s+(?:my\s+)?(?:knowledge\s*base|kb|index)(?:\s+for\b)\s*["“]?([^"”\n]+?)["”]?\s*$))/i,
  /^(?:nova,?\s*)?(?:tell me about|what about|do I have anything on|what's in my knowledge base about)\s+["“]?([^"”\n]+?)["”]?\s*$/i,
];

const RE_LIST = /^(?:nova,?\s*)?(?:(?:what|which)\s+(?:folders|directories)\s+(?:are\s+)?(?:in|indexed|added to)|list\s+(?:my\s+)?(?:indexed\s+)?(?:folders|knowledge\s*base)|what's\s+(?:in|indexed in)\s+(?:my\s+)?(?:knowledge\s*base|kb|index))\s*\??\s*$/i;

const RE_OPEN = /^(?:nova,?\s*)?(?:open|show|view)\s+(?:the\s+source|source|file)\s*(?:called\s+)?["“]?([^"”\n]+?)["”]?\s*$/i;

// "the docs folder" → "docs"; "my notes folder" → "notes" — strip the
// trailing generic word so resolveFolderHint can match known folder names.
function normalizeFolderHint(name) {
  if (!name) return null;
  const n = name.replace(/\s+(?:folder|directory|path)s?\s*$/i, "").trim();
  return n || null;
}

// known folder names the user can refer to by name (resolved against listFolders,
// or the test hook below so plan tests do not need a live index)
function resolveFolderHint(name) {
  if (!name) return null;
  const kbIndex = require("./index");
  const folders = (_testFolders || kbIndex.listFolders()).map((f) => (typeof f === "string" ? { root: f } : f));
  const n = String(name).trim().toLowerCase();
  for (const f of folders) {
    if (f.root.toLowerCase() === n) return f.root;
    const base = f.root.split(/[\/\\]/).pop().toLowerCase();
    if (base === n) return f.root;
  }
  return null;
}

function planKbAction(text, ctx = {}) {
  const t = String(text || "").trim();
  if (!t) return null;

  let m;

  m = t.match(RE_ADD_THIS) || t.match(RE_ADD_NAMED) || t.match(RE_ADD);
  if (m) {
    // RE_ADD_THIS matches "add (this) folder to my kb" with no capture — that
    // is "this", resolved later by the dispatcher from conversation context.
    const named = m[1] ? m[1].trim() : null;
    const folder = normalizeFolderHint(named);
    if (named === null) {
      return { actionId: "kb:add-folder", payload: { folder: "this" } };
    }
    if (!folder || folder === "folder") {
      return { error: "Tell me which folder to add — say \"add <path> to my knowledge base\", or click \"Add folder\" in the Knowledge Base panel." };
    }
    return { actionId: "kb:add-folder", payload: { folder: resolveFolderHint(folder) || folder } };
  }

  m = t.match(RE_REMOVE_THIS) || t.match(RE_REMOVE);
  if (m) {
    const named = m[1] ? m[1].trim() : null;
    if (named === null) {
      return { actionId: "kb:remove-folder", payload: { folder: "this" } };
    }
    const folder = normalizeFolderHint(named);
    if (!folder || folder === "folder") {
      return { error: "Tell me which folder to remove — say \"remove <name> from the index\", or click \"Remove from index\" in the Knowledge Base panel." };
    }
    // Guard against a named folder that is not indexed.
    const resolved = resolveFolderHint(folder);
    const folders = (_testFolders || ((ctx && ctx.kbFolders) || [])).map((f) => (typeof f === "string" ? f : f.root));
    const hint = (resolved || folder).toLowerCase().replace(/folder|directory/gi, "").trim();
    if (!resolved && !folders.some((f) => String(f).toLowerCase().includes(hint))) {
      return { error: `I could not find an indexed folder named "${folder}". Say "what's in my knowledge base" to list them.` };
    }
    return { actionId: "kb:remove-folder", payload: { folder: resolved || folder } };
  }

  if (RE_REINDEX.test(t)) {
    return { actionId: "kb:reindex", payload: {} };
  }

  if (RE_LIST.test(t)) {
    return { actionId: "kb:list-folders", payload: {} };
  }

  m = t.match(RE_OPEN);
  if (m) {
    return { actionId: "kb:open-source", payload: { file: m[1].trim() } };
  }

  for (const re of RE_QUERY) {
    m = t.match(re);
    if (m) {
      // RE_QUERY[0] has three alternatives with captures in different groups:
      // "write/note about" → m[1], "find my docs/files on" → m[2], "search kb for" → m[3]
      const topic = (m[1] || m[2] || m[3] || "").trim();
      if (!topic) return null;
      return { actionId: "kb:query", payload: { question: `${topic}`, topic } };
    }
  }

  return null;
}

// test hook: override known folders
let _testFolders = null;
function setTestFoldersForTesting(folders) { _testFolders = folders; }

module.exports = {
  planKbAction, normalizeFolderHint, resolveFolderHint, setTestFoldersForTesting,
  RE_ADD, RE_ADD_NAMED, RE_REMOVE, RE_REINDEX, RE_QUERY, RE_LIST, RE_OPEN,
};
