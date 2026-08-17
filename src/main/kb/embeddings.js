// Embeddings for the local knowledge base (Stage 8).
//
// Primary: Xenova/all-MiniLM-L6-v2 via @xenova/transformers (fully local
// ONNX, ~80 MB, 384-d, cached under userData/kb-model/).
// Fallback: when the ONNX model cannot be loaded (no network yet / CI /
// sandbox), a deterministic TF-IDF-style char-ngram hasher projects into
// 384-d with L2 normalization — a real local embedding that keeps the RAG
// pipeline working end-to-end. The fallback is seeded so the same text
// always produces the same vector (important for index tests).
//
// Never sends text anywhere. The model is downloaded from the HuggingFace
// CDN the first time only when the primary path is used.

const fs = require("fs");
const path = require("path");

const DIM = 384;
let _model = null;
let _loadPromise = null;
let _fallback = false;

function dataDir() {
  const { app } = require("electron");
  return app ? app.getPath("userData") : process.cwd();
}

/** Set a custom cache dir (tests / headless). */
function setModelCacheForTesting(dir) {
  _modelCacheOverride = dir;
  _model = null;
  _loadPromise = null;
}
let _modelCacheOverride = null;

function modelCacheDir() {
  return _modelCacheOverride || path.join(dataDir(), "kb-model");
}

/**
 * Try to load the MiniLM ONNX model. Resolves null if loading is impossible
 * in this environment, which signals the deterministic fallback.
 */
async function tryLoadModel() {
  if (_model) return _model;
  if (_loadPromise) return _loadPromise;
  if (_fallback) return null;
  _loadPromise = (async () => {
    try {
      process.env.LOCAL_MODEL_PATH = ""; // never use a pre-set path
      const { pipeline } = require("@xenova/transformers");
      const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        cache_dir: modelCacheDir(),
        quantized: true,
        progress_callback: (evt) => {
          if (global.__kbModelProgress && evt.status === "progress" && evt.progress != null) {
            global.__kbModelProgress(Math.round(evt.progress));
          }
        },
      });
      _model = extractor;
      return _model;
    } catch (err) {
      _fallback = true;
      console.warn(`[kb] local embedding model unavailable (${err?.message || err}); using deterministic local fallback hasher`);
      return null;
    }
  })();
  return _loadPromise;
}

// ---------------------------------------------------------------------------
// Deterministic fallback hasher (384-d, TF-IDF-style char 3/4-grams)
// ---------------------------------------------------------------------------

function hash32(seed, s) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

// fixed seed so vectors are stable across runs
const SEED = 0xdeadbeef;

function tokenize(text) {
  const t = String(text || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  const words = t.split(/\s+/).filter(Boolean);
  const grams = [];
  for (const w of words) {
    grams.push(w);
    for (let i = 0; i + 2 < w.length; i++) grams.push(w.slice(i, i + 3));
    for (let i = 0; i + 3 < w.length; i++) grams.push(w.slice(i, i + 4));
  }
  return grams;
}

function idfWeight(token) {
  // shorter tokens get a small boost; longer = more specific
  return 1 + Math.log(1 + token.length * 0.7);
}

function embedFallback(text) {
  const vec = new Array(DIM).fill(0);
  for (const tok of tokenize(text)) {
    const idx = hash32(SEED, tok) % DIM;
    const w = idfWeight(tok);
    vec[idx] += w;
    // mix into neighbors for locality sensitivity
    vec[(idx + 1) % DIM] += w * 0.25;
    vec[(idx + DIM - 1) % DIM] += w * 0.25;
  }
  // L2 normalize
  let n = 0;
  for (let i = 0; i < DIM; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) vec[i] /= n;
  return vec;
}

/**
 * Embed a single text (or array of texts) into 384-d vectors.
 * @returns {Promise<number[][]>} array of float32 arrays
 */
async function embed(texts) {
  const single = typeof texts === "string";
  const list = single ? [texts] : texts.slice();
  const extractor = await tryLoadModel();
  if (!extractor) {
    const out = list.map((t) => embedFallback(t));
    return single ? out[0] : out;
  }
  const batch = await extractor(list, { pooling: "mean", normalize: true });
  const out = [];
  for (let i = 0; i < list.length; i++) out.push(Array.from(batch[i].data));
  return single ? out[0] : out;
}

/** Cosine similarity of two pre-normalized vectors. */
function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < DIM; i++) d += a[i] * b[i];
  return d;
}

function isUsingFallback() {
  return !_model && _fallback;
}

function resetForTesting() {
  _model = null;
  _loadPromise = null;
  _fallback = false;
}

// Testing-only direct access to the deterministic fallback hasher (used by
// the E2E smoke harness to prove the pipeline needs no model download).
function embedFallbackForTesting(texts) {
  const single = typeof texts === "string";
  const list = single ? [texts] : texts.slice();
  const out = list.map((t) => embedFallback(t));
  return single ? out[0] : out;
}

module.exports = { embed, cosine, isUsingFallback, setModelCacheForTesting, resetForTesting, DIM, embedFallbackForTesting };
