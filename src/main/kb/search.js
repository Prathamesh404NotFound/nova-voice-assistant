// Retrieval for the knowledge base (Stage 8).
// Embeds the query locally, runs cosine search across all indexed chunks,
// returns top-K chunks deduplicated by source file (top 3 files, best
// chunks first). Fully local — nothing leaves the machine.

const kbIndex = require("./index");
const { embed, cosine } = require("./embeddings");

const TOP_K = 6;
const MAX_FILES = 3;

/**
 * @param {string} query
 * @returns {Promise<{ chunks: object[], sources: object[] }>}
 */
async function search(query, opts = {}) {
  const folders = kbIndex.listFolders();
  if (folders.length === 0) {
    return { chunks: [], sources: [], error: "no-index" };
  }
  const qv = await embed(query);
  const k = opts.topK || TOP_K;
  const scored = [];
  for (const f of folders) {
    const chunks = kbIndex.loadIndex(f.id);
    for (const c of chunks) {
      if (!Array.isArray(c.embedding)) continue;
      scored.push({ chunk: c, score: cosine(qv, c.embedding) });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const chunks = [];
  const sources = [];
  for (const { chunk, score } of scored) {
    if (chunks.length >= k) break;
    if (!seen.has(chunk.meta.absPath)) {
      if (sources.length < MAX_FILES) {
        sources.push({
          file: chunk.meta.absPath,
          title: chunk.meta.title,
          relPath: chunk.meta.relPath,
          root: folders.find((f) => f.id === chunk.meta.folderId)?.root || null,
        });
      }
    }
    seen.add(chunk.meta.absPath);
    chunks.push({ ...chunk, relevance: Math.round(score * 100) / 100 });
  }
  return { chunks, sources };
}

module.exports = { search, TOP_K, MAX_FILES };
