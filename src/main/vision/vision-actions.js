"use strict";
// ----------------------------------------------------------------------------
// vision-actions.js — registers the vision capability as a Level 0 (Read)
// action in the permission framework. Every capture flows through the gate
// (immediate execution for L0) and the persistent Action Log, with a note
// describing WHAT was captured — never the image bytes.
// ----------------------------------------------------------------------------

const { registerAction } = require("../permissions/action-registry");
const { RISK_LEVEL } = require("../permissions/risk-levels");
const screenshot = require("./screenshot");

registerAction({
  id: "vision:capture-screen",
  level: RISK_LEVEL.READ,
  description: "Read the current screen content",
  simulate: async (payload = {}) => {
    if (payload.__describe) {
      return {
        title: `Nova wants to read what’s on your screen`,
        body: `Screen reading is read-only: Nova will take a screenshot, extract the visible text locally, and (when Private Mode is off and a free vision model is available) describe it in plain language. The image itself is never stored or kept beyond this request, and nothing is written to your disk.`,
      };
    }
    return {
      wouldDo: "capture the primary display once and extract its visible text (read-only, no writes, no network unless a vision model answer is requested outside Private Mode)",
    };
  },
  execute: async (payload = {}) => {
    const started = Date.now();
    const shot = await screenshot.captureScreen();
    // Strip the image bytes from what the gate logs — keep a lightweight note.
    // Round 12: the screenshot-to-note path sets { forNotes: true } so the
    // caller can OCR the bytes; the buffer is still excluded from the log.
    const forNotes = !!(payload && payload.forNotes);
    const detail = {
      // NOTE: the screenshot.js module returns {buffer,...}; we pass it up to
      // vision-query.js via runVisionQuery, but the ACTION LOG only records:
      durationMs: Date.now() - started,
      width: shot.width,
      height: shot.height,
      note: `captured screen ${shot.width}x${shot.height}; platform=${process.platform}; permission=${shot.status || "?"}`,
      permissionMissing: shot.permissionMissing,
      status: shot.status,
    };
    if (forNotes) detail.buffer = shot.buffer;
    return detail;
  },
});

module.exports = { ACTION_ID: screenshot.ACTION_ID };
