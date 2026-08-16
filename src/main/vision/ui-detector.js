"use strict";
// ----------------------------------------------------------------------------
// ui-detector.js — basic UI element detection from OCR results only.
//
// No ML: buttons and inputs are inferred from word bounding boxes and heuristics:
//   - buttons: short, isolated phrases (1-3 words) that look like labels —
//     Title-Case/CAPS/verbs, not surrounded by dense body text.
//   - inputs: label-like text followed by an empty gap (no words within
//     ~40px to the right / below), typical of a field next to a label.
// Words are grouped into line-clusters (same baseline band) first, then
// clustered horizontally into phrases.
// ----------------------------------------------------------------------------

/**
 * Group words into "line clusters" — words whose vertical bands overlap
 * significantly, then sort left-to-right inside each cluster.
 */
function clusterLines(words) {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const lines = [];
  for (const word of sorted) {
    const yMid = (word.bbox.y0 + word.bbox.y1) / 2;
    let line = lines.find((l) => Math.abs((l.yTop + l.yBot) / 2 - yMid) < l.lineHeight * 0.9);
    if (!line) {
      line = { words: [], yTop: word.bbox.y0, yBot: word.bbox.y1,
               lineHeight: Math.max(word.bbox.y1 - word.bbox.y0, 12) };
      lines.push(line);
    }
    line.words.push(word);
    line.yTop = Math.min(line.yTop, word.bbox.y0);
    line.yBot = Math.max(line.yBot, word.bbox.y1);
  }
  for (const line of lines) {
    line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    line.lineHeight = line.yBot - line.yTop || 12;
    line.xRight = line.words.reduce((m, w) => Math.max(m, w.bbox.x1), line.words[0].bbox.x1);
  }
  return lines;
}

/**
 * Split a line's words into phrases by horizontal gaps: consecutive words
 * closer than `gapTh` belong to the same phrase.
 */
function clusterPhrases(lineWords, gapTh = 60) {
  const phrases = [];
  for (const word of lineWords) {
    const last = phrases[phrases.length - 1];
    if (last && word.bbox.x0 - last.x1 < gapTh) {
      last.words.push(word);
      last.x1 = word.bbox.x1;
    } else {
      phrases.push({ words: [word], x0: word.bbox.x0, x1: word.bbox.x1 });
    }
  }
  for (const p of phrases) {
    p.text = p.words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
    p.bbox = {
      x0: p.x0, y0: p.words[0].bbox.y0,
      x1: p.x1, y1: p.words[p.words.length - 1].bbox.y1,
      w: p.x1 - p.x0, h: p.words[p.words.length - 1].bbox.y1 - p.words[0].bbox.y0,
    };
    p.avgConf = Math.round(p.words.reduce((s, w) => s + w.conf, 0) / p.words.length);
  }
  return phrases;
}

/**
 * Is this phrase text "label-like" — short, title-cased / verb-like, not a
 * sentence fragment of body text?
 */
function looksLikeLabel(text) {
  // Strip a common trailing colon — field labels like "Username:" should still
  // read as label-like, while body-text phrases keep their punctuation.
  const t = text.trim().replace(/:$/, "");
  if (t.length === 0 || t.length > 45) return false;
  const words = t.split(/\s+/);
  if (words.length > 3) return false;
  // Title-case or ALL-CAPS (with allowed small words), or common verb starters
  const titleOrCaps = words.every((w) => /^[A-Z][A-Za-z0-9'"-]*$|^[A-Z]{2,}$/.test(w));
  const isAction = /^(Save|Cancel|OK|Ok|Apply|Close|Next|Back|Done|Submit|Open|Close|Sign|Log|Search|Send|Copy|Paste|Edit|Delete|Add|Create|Continue|Skip|Yes|No|OK!?$|Sign\s+in|Log\s+in|Get\s+started)$/i.test(t);
  const allCaps = t === t.toUpperCase() && /[A-Z]{2,}/.test(t);
  return isAction || titleOrCaps || allCaps;
}

/**
 * Detect button-like and input-like regions from OCR words.
 *
 * @param {{ text: string, words: Word[], confidentText: string }} ocrResult
 * @param {object} [opts]  maxButtons / maxInputs caps
 * @returns {{ buttons: ButtonRegion[], inputs: InputRegion[] }}
 */
function detectUIElements(ocrResult, { maxButtons = 15, maxInputs = 10 } = {}) {
  const lines = clusterLines(ocrResult.words);

  const buttons = [];
  const inputs = [];

  // Build a set of all word boxes to test "isolation" around a phrase.
  function wordsNear(b, radiusX = 30, radiusY = 18) {
    let n = 0;
    for (const line of lines) {
      for (const w of line.words) {
        if (Math.abs(((w.bbox.y0 + w.bbox.y1) / 2) - ((b.y0 + b.y1) / 2)) > line.lineHeight * 0.6 + radiusY) continue;
        const overlap = !(w.bbox.x1 < b.x0 - radiusX || w.bbox.x0 > b.x1 + radiusX);
        if (overlap) n++;
      }
    }
    return n;
  }

  for (const line of lines) {
    const phrases = clusterPhrases(line.words, 25);
    for (const p of phrases) {
      // --- Button: label-like, short, reasonably isolated, confident
      if (
        buttons.length < maxButtons &&
        p.text &&
        looksLikeLabel(p.text) &&
        p.avgConf >= 45 &&
        p.bbox.w <= 260 &&
        wordsNear(p.bbox) <= 2 &&
        !/:$/.test(p.text) // trailing colon → form label, not a button
      ) {
        buttons.push({
          label: p.text,
          bbox: p.bbox,
          conf: p.avgConf,
        });
        continue;
      }

      // --- Input: label phrase with an empty region after it (typical of a
      //     text field that sits to the right of its label, possibly empty)
      if (inputs.length < maxInputs && p.text && p.avgConf >= 40) {
        // Is there any word further right on the same line?
        const hasWordAfter = line.words.some((w) => w.bbox.x0 > p.x1 + 8);
        const rightEmpty = !hasWordAfter;
        // Reserve a plausible field width to the right of the label
        const fieldW = 160;
        const freeSpace = wordsNear({ x0: p.x1 + 24, x1: p.x1 + fieldW, y0: p.bbox.y0, y1: p.bbox.y1, w: fieldW, h: 0 }, 10) === 0;
        if (rightEmpty && freeSpace && p.text.length <= 40 && p.words.length <= 3) {
          inputs.push({
            label: p.text,
            bbox: {
              x0: p.x1 + 16, y0: p.bbox.y0,
              x1: p.x1 + fieldW,
              y1: p.bbox.y1,
              w: fieldW - 16,
              h: Math.max(p.bbox.h, 20),
            },
            conf: p.avgConf,
          });
        }
      }
    }
  }

  return {
    buttons: buttons.slice(0, maxButtons),
    inputs: inputs.slice(0, maxInputs),
  };
}

module.exports = { clusterLines, clusterPhrases, looksLikeLabel, detectUIElements };
