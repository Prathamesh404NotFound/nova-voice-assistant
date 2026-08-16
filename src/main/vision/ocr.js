"use strict";
// ----------------------------------------------------------------------------
// ocr.js — offline OCR via tesseract.js (WASM). Fully local: no network call,
// works in Private Mode. Lazy worker init; extracts words with bounding
// boxes + confidence (parsed from the engine's HOCR output) for downstream
// UI element detection.
// ----------------------------------------------------------------------------

const path = require("path");
const fs = require("fs");
const os = require("os");
const url = require("url");

let workerPromise = null;

/**
 * Lazily create (or reuse) a tesseract worker for English.
 * The worker downloads the language data / WASM once on first use, then is
 * kept alive for subsequent captures.
 */
function getWorker() {
  if (!workerPromise) {
    // createWorker is a CJS default export on tesseract.js 7.x
    const { createWorker } = require("tesseract.js");
    // Prefer a local copy of the English language data when available
    // (ships/offline); otherwise fetch from the CDN.
    const localLangDir = path.join(__dirname, "..", "..", "..");
    const hasLocalData = fs.existsSync(path.join(localLangDir, "eng.traineddata"));
    // createWorker(lang, oem, options, config) — the config object sets
    // Tesseract engine variables; tessedit_create_hocr makes the engine
    // emit HOCR (we parse it ourselves for words + boxes + confidence).
    workerPromise = createWorker("eng", 1, {
      langPath: hasLocalData ? url.pathToFileURL(localLangDir).href : undefined,
      logger: () => {}, // keep the main-process log clean
    }, { tessedit_create_hocr: 1 });
  }
  return workerPromise;
}

// Matches <span class='ocrx_word ...' title='bbox x y x y; x_wconf N'>text</span>
const WORD_RE =
  /<span\s+class=['"]ocrx_word[^'"]*['"][^>]*title=['"]bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)[^'"]*?(?:x_wconf\s+(\d+))?['"][^>]*>([^<]+)<\/span>/g;
// Matches <span class='ocr_line ...' — for grouping words into lines
const LINE_RE = /<span\s+class=['"]ocr_line[^'"]*['"][^>]*>/g;

/**
 * Parse the engine's HOCR output into words with bboxes + confidence, and
 * group them into lines (in reading order).
 */
function parseHocr(hocr) {
  const words = [];
  const lines = [];
  if (!hocr) return { words, lines };

  // Collect line anchors in order: (span-index-in-hocr, line-title-text)
  const lineAnchors = [];
  LINE_RE.lastIndex = 0;
  let lm;
  while ((lm = LINE_RE.exec(hocr)) !== null) {
    lineAnchors.push(lm.index + lm[0].length);
  }

  WORD_RE.lastIndex = 0;
  let wm;
  while ((wm = WORD_RE.exec(hocr)) !== null) {
    const text = wm[6].trim();
    if (!text) continue;
    words.push({
      text,
      conf: wm[5] ? parseInt(wm[5], 10) : 0,
      bbox: {
        x0: parseInt(wm[1], 10), y0: parseInt(wm[2], 10),
        x1: parseInt(wm[3], 10), y1: parseInt(wm[4], 10),
        w: parseInt(wm[3], 10) - parseInt(wm[1], 10),
        h: parseInt(wm[4], 10) - parseInt(wm[2], 10),
      },
    });
    // Assign the word to the nearest preceding line anchor.
    let lineIdx = 0;
    for (let i = lineAnchors.length - 1; i >= 0; i--) {
      if (wm.index >= lineAnchors[i]) { lineIdx = i + 1; break; }
    }
    words[words.length - 1].lineIdx = lineIdx - 1;
    if (!lines[lineIdx - 1]) lines[lineIdx - 1] = [];
    lines[lineIdx - 1].push(words[words.length - 1]);
  }

  return { words, lines };
}

/**
 * Recognize text in an image buffer.
 *
 * @param {Buffer|Uint8Array} imageBuffer — PNG/JPEG bytes from screenshot.js
 * @returns {Promise<{ text: string, words: Word[], confidentText: string }>}
 *   - text: full OCR text
 *   - words: array of { text, conf, bbox: { x0, y0, x1, y1, w, h }, lineIdx }
 *   - confidentText: text filtered to words with confidence >= minConf
 */
let tmpCounter = 0;
async function recognizeText(imageBuffer, { minConf = 55 } = {}) {
  const worker = await getWorker();
  // Write the buffer to a temp PNG and recognize the file path: tesseract's
  // node adapter reliably decodes PNG/JPEG from disk, while raw buffers can
  // trip some adapter paths.
  const tmpPath = path.join(os.tmpdir(), `nova-ocr-${Date.now()}-${++tmpCounter}.png`);
  fs.writeFileSync(tmpPath, imageBuffer);
  let data;
  try {
    // recognize(image, params, output) — the third arg selects which engine
    // outputs to materialize; we only need text + hocr (no blobs/network).
    ({ data } = await worker.recognize(tmpPath, {}, { hocr: true }));
  } finally {
    fs.unlink(tmpPath, () => {});
  }

  // Tesseract.js 7.x no longer parses layout into `words`/`lines`; we parse
  // the engine's HOCR output ourselves (fully offline, in memory).
  const text = (data?.text || "").trim();
  const { words, lines } = parseHocr(data?.hocr || "");

  // Prefer HOCR-ordered words; fall back to the flat text when HOCR is empty
  // (unreadable image, decode failure, etc.).
  const finalWords = words.length ? words : text.split(/\s+/).filter(Boolean).map((t) => ({
    text: t, conf: 0, lineIdx: -1,
    bbox: { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 },
  }));

  const confidentText = finalWords
    .filter((w) => w.conf >= minConf)
    .map((w) => w.text)
    .join(" ");

  return { text, words: finalWords, confidentText };
}

/**
 * Terminate the worker (free WASM memory). Called on app quit.
 */
async function shutdown() {
  if (workerPromise) {
    try {
      const worker = await workerPromise;
      await worker.terminate();
    } catch { /* ignore */ }
    workerPromise = null;
  }
}

module.exports = { recognizeText, parseHocr, shutdown, getWorker };
