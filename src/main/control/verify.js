// Nova — control/verify.js
//
// Mid-sequence vision verification (Stage 4 requirement 5):
//   1. Captures the screen (reuses vision/screenshot.js — no duplication).
//   2. Runs offline OCR (reuses vision/ocr.js — works in Private Mode).
//   3. Asserts the expected text is present on screen.
//
// Used by wait-for-window steps and any step with `verify: { contains }`.
// On failure the step is marked failed and the sequence stops rather than
// continuing blindly — the planner never guesses.

const log = require("electron-log");
const { captureScreen } = require("../vision/screenshot");
const { recognizeText } = require("../vision/ocr");

/** Default verification budget: milliseconds to keep retrying. */
const DEFAULT_WAIT_MS = 5000;
const POLL_MS = 500;

/**
 * Verify that expected text is visible on screen, retrying within a budget.
 * @param {{ label?: string, contains?: string, waitMs?: number }} opts
 * @returns {{ ok: boolean, found: string[], screenshotTaken: boolean, note: string }}
 */
async function verifyWindow(opts = {}) {
  const contains = String(opts.contains || opts.label || "").trim().toLowerCase();
  if (!contains) return { ok: true, found: [], screenshotTaken: false, note: "no expected text given — skipped verification" };

  const deadline = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS);
  const attempts = [];

  while (Date.now() < deadline) {
    const shot = await captureScreen();
    if (shot.permissionMissing) {
      return { ok: false, found: [], screenshotTaken: true, note: "screen recording permission missing — cannot verify" };
    }
    if (!shot.buffer) {
      // Capture failed; log and retry rather than failing the whole sequence
      log.warn("[control] verify: capture returned no buffer; retrying");
      await sleep(POLL_MS);
      continue;
    }

    const ocr = await recognizeText(shot.buffer);
    const screenText = (ocr.text || "").toLowerCase();
    const found = ocr.words
      .filter((w) => (w.text || "").toLowerCase().includes(contains))
      .map((w) => w.text);
    if (screenText.includes(contains) || found.length) {
      return { ok: true, found: [...new Set(found)], screenshotTaken: true, note: `verified "${contains}" on screen` };
    }
    attempts.push({ at: new Date().toISOString(), textLen: screenText.length });
    await sleep(POLL_MS);
  }

  return {
    ok: false,
    found: [],
    screenshotTaken: true,
    note: `expected "${contains}" was not found on screen (${attempts.length} check${attempts.length === 1 ? "" : "s"} before giving up)`,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { verifyWindow, sleep };
