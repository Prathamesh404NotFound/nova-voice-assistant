// Chunking for the knowledge base (Stage 8).
// ~2000-char chunks with 10% overlap, split on sentence boundaries where
// possible so embeddings carry coherent meaning.

const CHUNK_CHARS = 2000;
const OVERLAP_FRAC = 0.1;

function splitSentences(text) {
  // keep sentence punctuation attached to the preceding sentence
  const parts = text.split(/(?<=[.!?…])\s+/);
  const out = [];
  for (const p of parts) {
    const t = p.trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * @param {string} text
 * @param {{ folderId: string, relPath: string, absPath: string, title: string }} meta
 * @returns {{ id: string, text: string, meta: object }[]}
 */
function chunkText(text, meta) {
  if (!text || text.length < 10) return [];
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const chunks = [];
  let buf = "";
  let bufSentences = [];
  const overlapChars = Math.round(CHUNK_CHARS * OVERLAP_FRAC);

  const flush = (boundary = false) => {
    if (!buf) return;
    chunks.push({
      id: `${meta.folderId}:${meta.relPath}:${chunks.length}`,
      text: buf.trim(),
      meta: { ...meta, chunkIndex: chunks.length, boundary },
    });
    // carry the tail into the next chunk (overlap)
    buf = bufSentences.length > 1 ? bufSentences[bufSentences.length - 1] : "";
    bufSentences = buf ? [buf] : [];
  };

  for (const s of sentences) {
    if (buf && buf.length + 1 + s.length > CHUNK_CHARS) {
      flush();
    }
    bufSentences.push(s);
    buf = bufSentences.join(" ");
  }
  flush();
  // single-sentence-oversize: hard-split
  return chunks.map((c) => {
    if (c.text.length <= CHUNK_CHARS) return c;
    const hard = [];
    let i = 0;
    const words = c.text.split(/\s+/);
    let acc = [];
    for (const w of words) {
      acc.push(w);
      if (acc.join(" ").length > CHUNK_CHARS) {
        hard.push({
          id: `${c.id}:h${i++}`,
          text: acc.join(" "),
          meta: { ...c.meta, chunkIndex: c.meta.chunkIndex + i - 1, hardSplit: true },
        });
        const tail = acc.slice(-Math.round(acc.length * OVERLAP_FRAC));
        acc = tail;
      }
    }
    if (acc.length) {
      hard.push({
        id: `${c.id}:h${i}`,
        text: acc.join(" "),
        meta: { ...c.meta, chunkIndex: c.meta.chunkIndex + i, hardSplit: true },
      });
    }
    return hard;
  }).flat();
}

module.exports = { chunkText, CHUNK_CHARS };
