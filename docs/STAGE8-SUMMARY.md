# Stage 8 — Personal Knowledge Base (Summary)

**Commit:** `4812374` — [View on GitHub](https://github.com/Prathamesh404NotFound/nova-voice-assistant/commit/4812374)
**Date:** 2026-08-17
**Status:** Complete. Full test chain green (EXIT 0): permissions, vision, control 38/38, agent 38/38, files 82/82, notes 83/83, kb 88/88.

## What was built

A fully local personal knowledge base for Nova. The user points Nova at folders ("add this folder to my knowledge base"), and Nova indexes their documents locally. Questions like *"what did I write about X in my kb"* are answered using retrieval-augmented generation with local embeddings — raw document content never leaves the machine except the small retrieved snippet, and only when Private Mode is off.

## Architecture

The knowledge base lives in `src/main/kb/` and plugs into the existing permission framework, model router, and dispatcher.

| Module | Responsibility |
|---|---|
| `extractor.js` | Text extraction from `.txt`, `.md`, `.pdf`, `.docx` (pdf-parse, mammoth) |
| `chunker.js` | Splits documents into overlapping chunks (default ~300 words, 20% overlap) |
| `embeddings.js` | Local embeddings: `all-MiniLM-L6-v2` (DIM=384) via `@xenova/transformers` with an in-memory ONNX runtime; deterministic hash fallback when the model is unavailable |
| `index.js` | Per-folder index store on disk; add/remove/restore folders, stats, incremental reindex |
| `watcher.js` | Chokidar watches each indexed folder; debounced incremental reindex of changed/new/deleted files |
| `search.js` | Embeds the query locally, cosine similarity over all chunks, top-K with per-file dedup |
| `query.js` | RAG composition with the Private Mode guard; forwards only the retrieved snippet + question to `pickModel("chat")` |
| `plan.js` | Natural-language planner: "add folder to kb", "search my kb", "reindex", "remove folder" — query intents require an explicit kb-context marker so notes searches are not hijacked |
| `dispatch.js` / `actions.js` | End-to-end dispatcher and 6 registered actions, all wired through the permission gate and Action Log (index/remove/reindex are Level 2) |

The `kb/` branch was inserted **before** the FILES branch in `classifier.js`/`dispatcher.js`, receiving the indexed-folder context from `main.js`.

## Privacy model

1. **Indexing is fully local** — extraction, chunking, and embedding all run on-device. No document content is sent to any external API to build the index.
2. **Query path is snippet-only** — the question is embedded locally, top-K chunks are retrieved locally, and *only then* those chunks plus the question go to the model (`pickModel("chat")`). The model router never sees raw documents, and no document content is added to the system prompt or conversation history.
3. **Private Mode refusal** — with Private Mode on, every KB query fails gracefully with the exact phrase: *"Knowledge base search needs Private Mode off — I won't send your documents anywhere while it's on."* Local search and indexing still work.
4. **Management actions are Level 2** — removing a folder deletes its index data only; the original files are never touched.

## Voice commands supported

- "Add this folder / [path] to my knowledge base" → walks, extracts, chunks, embeds (progress indicator, depth/file-count limits)
- "Search my kb for [topic]" / "find my documents on [topic]" → RAG answer with source files named + view-source links in the side panel
- "Re-index my knowledge base" / "re-index [folder]" → watcher picks it up automatically anyway
- "Remove [folder] from my knowledge base" → Level 2 gated; deletes index only
- Indexing/re-indexing status ("what is Nova indexing", progress updates in chat and panel)

## Management UI

The Knowledge Base section in the side panel lists indexed folders with size and file counts, per-folder **re-index now** and **remove from index** buttons (source-gated), a live progress bar during indexing, and **view source** links next to every KB-sourced answer that open the underlying file.

## Testing

| Suite | Coverage | Result |
|---|---|---|
| `src/main/test-kb.js` | 88 headless tests: extractor, chunker, embeddings (real MiniLM + fallback), index persistence, watcher debounce, search relevance, query composition, plan regexes, dispatch end-to-end | 88/88 pass |
| `scripts/smoke-kb-e2e.js` | 13 E2E smokes: full index→query→cite loop on a sample folder; injected Private Mode → exact refusal phrase; no external calls during indexing | 13/13 pass |
| `scripts/verify-plan-regexes.js` | 25 query/plan pattern cases incl. anti-hijack of notes phrasing | 25/25 pass |
| `npm test` full chain | permissions + vision + control + agent (38) + files (82) + notes (83) + kb (88) | **EXIT 0** |
| Boot smoke | `npm start` on Xvfb | clean launch, all `kb:*` actions registered |

## Known limitations

- **First MiniLM load needs network:** `@xenova/transformers` downloads the ONNX model from the Hugging Face CDN on first use; afterwards it is cached locally and works offline. When the model cannot load, the deterministic hash embedder takes over — same workflow, lower retrieval quality (pattern matching rather than semantics).
- **Format scope:** `.txt`, `.md`, `.pdf`, `.docx` only.
- **No document-level reranking** — retrieval is pure cosine over chunks.
- KB queries require an explicit kb-context marker ("in my kb", "my documents on…"); bare "what did I write about X" routes to the local Notes module to avoid hijacking.
- Embedding dimension is fixed at 384 (MiniLM) and the hash fallback matches it.
