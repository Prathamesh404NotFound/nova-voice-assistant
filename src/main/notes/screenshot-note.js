"use strict";
// ----------------------------------------------------------------------------
// screenshot-note.js — Round 12: "Nova, note what's on my screen".
//
// Captures the primary screen, runs fully offline OCR (tesseract.js — works
// in Private Mode), and saves the visible text as a timestamped local note
// tagged with [screen]. The whole path is Level 0 (capture) + Level 1 (safe
// note creation) — both already registered actions, so nothing new bypasses
// the permission framework. The OCR text never leaves the machine: it is
// written to the local store exactly like a spoken note; no network calls.
//
// The captured text is NOT sent to any model — this is intentionally a
// faithful transcript, not an AI summary (Private Mode safe by design).
// ----------------------------------------------------------------------------
const screenshot = require("../vision/screenshot");
const ocr = require("../vision/ocr");
const { runAction } = require("../permissions/gate");
const { RISK_LEVEL } = require("../permissions/risk-levels");
const { registerAction } = require("../permissions/action-registry");
const store = require("./store");
const settings = require("../settings");
const log = require("electron-log");

const ACTION_ID = "notes:screen-to-note";

registerAction({
  id: ACTION_ID,
  level: RISK_LEVEL.SAFE,
  description: "Save what is on the screen as a local note",
  simulate: async (p = {}) => {
    if (p.__describe) {
      return {
        title: "Nova wants to save your screen as a note",
        body: "Nova will take a read-only screenshot, extract the visible text locally (fully offline), and save it as a timestamped note tagged [screen]. The text is never sent anywhere — Private Mode has no effect since nothing leaves this machine.",
      };
    }
    const n = (p.text || "").length > 40 ? (p.text.slice(0, 37) + "…") : p.text;
    return { wouldDo: `capture the screen once, OCR it locally, and save a note "${n || "(visible screen text)"}" (read-only capture; note is a local-only write)` };
  },
  execute: async (p = {}) => {
    const started = Date.now();
    // 1. Capture — Level 0 READ through the existing vision gate, with
    //    { forNotes: true } so the execute() path carries the PNG buffer up
    //    to this caller (the normal vision-query path strips it to keep the
    //    Action Log lightweight — a note, never the image bytes).
    const gateResult = await runAction("vision:capture-screen", { forNotes: true });
    if (gateResult.outcome !== "success") {
      const reason = gateResult.error?.message || "screen capture failed";
      return {
        ok: false, kind: "screen-note", error: reason, durationMs: Date.now() - started,
      };
    }
    const buffer = (gateResult.detail || {}).buffer || null;
    if (!buffer) {
      return { ok: false, kind: "screen-note", error: "the capture returned no image data", durationMs: Date.now() - started };
    }
    // 2. Offline OCR (works in Private Mode; tesseract worker init is lazy).
    const recognized = await ocr.recognizeText(buffer, { minConf: 55 });
    // confidentText = HOCR-ordered words at the confidence threshold; the flat
    // text is the fallback when HOCR is empty (unreadable image).
    const ocrText = recognized.confidentText || recognized.text;
    if (!ocrText || ocrText.trim() === "") {
      return {
        ok: false, kind: "screen-note", error: "no readable text found on the screen", durationMs: Date.now() - started,
      };
    }
    // 3. Save as a timestamped note, tagged [screen]. Local only — the text
    //    is never included in anything the model router sends.
    const header = "[screen]";
    const body = (p.text || "").trim();
    const noteText = body ? `${header} ${body}\n\n${ocrText}` : `${header} ${ocrText}`;
    const note = store.addNote(noteText);
    log.info(`[notes:screen-to-note] saved note id=${note.id} (${ocrText.length} chars OCR'd)`);
    return {
      ok: true, kind: "screen-note",
      note, charCount: ocrText.length, durationMs: Date.now() - started,
      privateMode: settings.isPrivateMode(),
    };
  },
});

module.exports = { ACTION_ID };
