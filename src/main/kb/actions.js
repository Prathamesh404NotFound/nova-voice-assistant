// Knowledge base action registrations (Stage 8).
//
// Levels:
//   L1 — kb:query, kb:list-folders (read/create-safe; query's network touch
//        is refused by the privacy guard in Private Mode)
//   L2 — kb:add-folder, kb:remove-folder, kb:reindex, kb:open-source
//        (reversible: remove-folder's undo restores the index snapshot)

const { registerAction } = require("../permissions/action-registry");
const { RISK_LEVEL } = require("../permissions/risk-levels");

registerAction({
  id: "kb:add-folder",
  level: RISK_LEVEL.REVERSIBLE,
  description: (p) => `Add folder "${p.folder}" to the knowledge base index`,
  simulate: (p) => ({
    outcome: "would-index",
    detail: { description: `Would walk "${p.folder}" and build a local embeddings index. No files are modified.`, folder: p.folder },
  }),
  execute: async (p) => ({
    executed: true,
    detail: { description: `Folder "${p.folder}" registered for indexing.`, folder: p.folder },
  }),
  reverse: async (p) => ({ undone: true, detail: { description: `Index data for "${p.folder}" would be removed (auto).` } }),
});

registerAction({
  id: "kb:remove-folder",
  level: RISK_LEVEL.REVERSIBLE,
  description: (p) => `Remove index data for "${p.root || p.folderId}" (original files kept)`,
  simulate: (p) => ({
    outcome: "would-remove-index",
    detail: { description: `Would delete only the index data for "${p.root || p.folderId}". Original files are NEVER touched.`, root: p.root },
  }),
  execute: async (p) => ({
    executed: true,
    detail: { description: `Index data for "${p.root || p.folderId}" marked for removal.`, root: p.root },
  }),
  // the real removal happens in dispatch (snapshot kept for undo)
  reverse: async (p) => ({ undone: true, detail: { description: "Index snapshot restored from undo." } }),
});

registerAction({
  id: "kb:reindex",
  level: RISK_LEVEL.REVERSIBLE,
  description: () => "Re-index all indexed folders incrementally",
  simulate: () => ({ outcome: "would-reindex", detail: { description: "Would walk indexed folders and re-index changed files only." } }),
  execute: async () => ({ executed: true, detail: { description: "Re-index requested." } }),
  reverse: async () => ({ undone: true }),
});

registerAction({
  id: "kb:query",
  level: RISK_LEVEL.SAFE,
  description: (p) => `Search the knowledge base: "${p.question}"`,
  simulate: (p) => ({ outcome: "would-search", detail: { description: `Would embed the question locally and retrieve matching snippets.`, question: p.question } }),
  execute: async (p) => ({
    executed: true,
    detail: { description: `Answer composed from local snippets for: "${p.question}".`, question: p.question },
  }),
  reverse: async () => ({ undone: false }), // read-like; nothing to undo
});

registerAction({
  id: "kb:list-folders",
  level: RISK_LEVEL.SAFE,
  description: () => "List indexed folders and index stats",
  simulate: () => ({ outcome: "would-list", detail: { description: "Would list indexed folders." } }),
  execute: async () => ({ executed: true, detail: { description: "Folder list returned." } }),
  reverse: async () => ({ undone: false }),
});

registerAction({
  id: "kb:open-source",
  level: RISK_LEVEL.REVERSIBLE,
  description: (p) => `Open the source file "${p.file}"`,
  simulate: (p) => ({ outcome: "would-open", detail: { description: `Would open "${p.file}" in the default app.`, file: p.file } }),
  execute: async (p) => ({ executed: true, detail: { description: `Opened "${p.file}".`, file: p.file } }),
  reverse: async () => ({ undone: false }), // opening a file isn't reversible, but it's harmless
});

module.exports = { registered: true };
