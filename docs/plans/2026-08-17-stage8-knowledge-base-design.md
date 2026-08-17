# Stage 8 Design — Local Personal Knowledge Base

**Date:** 2026-08-17 · **Author:** Manus AI · **Status:** Draft

## Goal

Let the user point Nova at a folder (or several) and ask voice questions about its contents. Indexing and querying run entirely locally — whole documents are **never** sent to OpenRouter. Only, at query time, the top-matching **chunks** + the question are sent through `pickModel("chat")`, and only when Private Mode is off.

## Constraints and decisions

1. **Embeddings:** use `@xenova/transformers` (ONNX Runtime Web) with
   `Xenova/all-MiniLM-L6-v2` (~80 MB, ~384-d, sentence-transformers quality,
   runs fully offline, cached in `userData/kb-model/`).
   - Fallback strategy (CI-friendly + sandbox-friendly): if the ONNX model
     fails to load (no network in sandbox), fall back to a **deterministic
     TF-IDF bag-of-chars tokenizer with 384-d random-projection hashing**
     (`hashProjection`) seeded deterministically. This gives a real,
     reproducible "local embedding" so the RAG pipeline works end-to-end in
     tests and headless sandboxes, while real machines get MiniLM.
   - NOTE: transformers.js v3 uses `AutoModel`, v2 uses `pipeline('feature-extraction')`.
     Use v2 API (`pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')`)
     for stability; download triggered on first index (progress events).
2. **Text extraction:** `.txt`/`.md` read directly; `.pdf` via `pdf-parse`;
   `.docx` via `mammoth` (extract raw text). All extraction runs in the main
   process off the UI thread (per-file, no worker needed for v1; keep
   extraction time logged in Dev Mode).
3. **Chunking:** ~500-token (≈2000 char) chunks with 10% overlap; metadata:
   `{ folderId, relPath, absPath, chunkIndex, title (filename) }`.
4. **Limits:** max 5 indexed folders, max 2,000 files per folder, max depth 8.
   Respect a global cap of 50,000 chunks (index compaction warning beyond).
   Binary/image files skipped (logged, not failed).
5. **Index storage:** LevelDB-free single-file JSON at
   `userData/kb-index/<folderHash>.json` (chunks + embeddings flat array)
   + manifest `userData/kb-index/manifest.json` (folder list, sizes,
   lastIndexedAt, file modtimes map for incremental re-index).
   Embeddings stored as plain number arrays (flat File is overkill for v1;
   50k chunks × 384 floats × 4 B ≈ 76 MB — acceptable).
6. **Watching:** `chokidar` on each indexed folder (depth ≤ 8) → debounce
   1.5 s burst → incremental re-index of changed/added files only; deleted
   files removed from index by `relPath` key.
7. **Query flow (RAG):**
   - embed query locally
   - top-K cosine search over index (K=6, across chunks)
   - dedupe by source file, keep top-3 files
   - **Private Mode guard:** if Private Mode on → return graceful refusal
     "Knowledge base search needs Private Mode off — I won't send your
     documents anywhere while it's on." (still returns local keyword-only
     fallback matches without model? NO — spec says fail gracefully with
     that exact message; do NOT answer from model. Local retrieval can be
     echoed as "I found these files but won't compose an answer" — keep it
     simple: refusal text + the top source list is acceptable? Spec: "the
     query should fail gracefully with 'knowledge base search needs Private
     Mode off' rather than silently degrading." → return refusal only,
     no sources, no model call.)
   - else: send `question + top-K chunks` via `pickModel("chat")` (normal
     router retry/privacy rules); compose short answer; return answer +
     sources.
8. **Source citation:** answer payload carries `sources: [{file, title,
   relevance, chunkText}]`; renderer shows "Answered from: file1, file2"
   with a `view source` link → `shell.openPath()` (L1, logged).
9. **Risk levels:**
   - L1: `kb:list-folders`, `kb:query` (composing+reading an answer; the
     network-touching query is L2-equivalent concern handled by Private
     Mode guard; keep L1 because the user asks for it — consistent with
     how conversation chat is L1-ish). DECISION: `kb:query` = L1 but the
     privacy gate refuses in Private Mode (same pattern as vision).
   - L2: `kb:add-folder` (indexing = disk/CPU work, reversible-ish),
     `kb:remove-folder` (deletes index data only, never originals — toast),
     `kb:reindex` (re-runs indexing), `kb:open-source` (shell.openPath toast).
   All logged; remove-folder has a reverse fn (rebuild from manifest? No —
   reverse for remove = restore index snapshot if within undo window).
   Implementation: `remove-folder` stores the deleted index snapshot into
   `kb.lastRemoved` for a 5-minute undo restore (reverse fn re-saves it).
10. **Progress indicator:** indexing emits `kb:index-progress` IPC events
    ({folder, filesDone, filesTotal, status:'indexing|watching|done|error'});
    renderer shows inline progress in the KB tab; dispatcher narrates.
11. **Side panel:** new "Knowledge Base" tab: indexed folders list (size +
    file count + last indexed), "Add this folder…" (dialog via
    `dialog.showOpenDialog`, appends via gate L2), per-folder Remove index
    + Re-index now, KB stats line, plus query from voice.
12. **Classifier:** KB_RE phrases: "what did I write about …", "find my
    notes on …", "search my knowledge base", "what does my docs folder say
    about …", "from my knowledge base …". Intent: `kb`.
    Ambiguity: "search my files" → FILES; "search my knowledge base" → KB.
    Distinguish by "knowledge base"/"kb" keyword OR question-about-folder
    phrases; fall through to FILES for plain file searches.

## File layout

```
src/main/kb/
  embeddings.js   - model load + fallback hasher + embed(text)
  extractor.js    - txt/md/pdf/docx → text (errors recorded, not thrown)
  chunker.js      - chunk(text, meta) → chunks[]
  index.js        - folder walk, incremental re-index, manifest, storage
  watcher.js      - chokidar per-folder, debounce, incremental updates
  search.js       - embed query + top-K cosine + file dedupe
  query.js        - RAG compose (pickModel chat) + Private Mode guard
  actions.js      - 6 actions registered
  dispatch.js     - runKbAction(text, opts) narration + IPC progress
tests/smoke-kb-e2e.js, src/main/test-kb.js
```

## Test plan (mirrors Stage 7)

- test-kb.js (~80 checks): extractor each format, chunker sizes/overlap,
  embeddings fallback determinism + cosine sanity, index add/remove/reindex
  incremental (modtime map), watcher incremental update, search relevance
  ranking, query Private Mode refusal (exact phrase), query compose with
  mocked router (only top chunks in the sent messages), sources payload,
  action levels + simulate + reverse (remove-folder undo restores index),
  classifier routing.
- smoke-kb-e2e.js: create sample folder (4 docs, 2 relevant to "project
  sunset"), add folder via dispatcher, wait for indexing, query → answer
  cites the right files, remove-folder → index gone but originals intact,
  Private Mode on → exact refusal.
