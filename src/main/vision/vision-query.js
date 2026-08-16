"use strict";
// ----------------------------------------------------------------------------
// vision-query.js — the full "screen vision" pipeline:
//
//   1. Capture the primary screen via desktopCapturer  (Level 0 READ action
//      through the permission gate; logged to the Action Log)
//   2. Extract visible text with offline tesseract.js OCR  (works in Private
//      Mode, no network)
//   3. Detect basic UI elements (button-like / input-like regions)
//   4. If Private Mode is OFF and a free vision model is available:
//        → POST the screenshot + the user's question to the vision model via
//          OpenRouter, streamed back as plain text
//      else: compose an OCR-only answer locally
//
// All vision actions are read-only and route through the permission framework.
// The Action Log records a lightweight NOTE about the capture, never the
// image data.
// ----------------------------------------------------------------------------

const screenshot = require("./screenshot");
const ocr = require("./ocr");
const { detectUIElements } = require("./ui-detector");
const { runAction } = require("../permissions/gate");
const settings = require("../settings");
const router = require("../router");
const log = require("electron-log");

const VISION_ACTION_ID = "vision:capture-screen";

/**
 * Run the full vision query pipeline.
 * @param {string} question  user's natural-language question
 * @returns {Promise<{ answer: string, mode: "vision"|"ocr", ocrText: string, uiElements: object }>}
 */
async function runVisionQuery(question) {
  const inPrivate = settings.isPrivateMode();

  // --- 1. Capture (through the gate: immediate for Level 0, logged)
  const gateResult = await runAction(VISION_ACTION_ID, {});
  if (gateResult.outcome !== "success") {
    throw new Error(`Screen capture was ${gateResult.outcome} (permissions: ${gateResult.outcome === "blocked" ? "Private Mode blocks outbound vision work" : "cancelled by user"}).`);
  }

  // Re-capture the raw buffer now (the gate logs metadata only; keep the
  // image in memory just for this request — never persisted).
  const shot = await screenshot.captureScreen();

  // --- 2. OCR — fully offline
  let ocrText = "";
  let words = [];
  try {
    const result = await ocr.recognizeText(shot.buffer);
    ocrText = result.confidentText || result.text || "";
    words = result.words || [];
  } catch (err) {
    log.warn("[vision] OCR failed:", err?.message || err);
    ocrText = "";
  }

  // --- 3. Basic UI element detection (buttons / inputs from bounding boxes)
  const uiElements = words.length ? detectUIElements({ text: ocrText, words, confidentText: ocrText }) : { buttons: [], inputs: [] };

  // --- 4. Answer: vision model (network) vs. OCR-only (offline)
  let answer;
  let mode;

  const screenSummary = describeScreenForLocal(ocrText, uiElements);

  if (!inPrivate) {
    // Network branch — only outside Private Mode.
    try {
      const model = router.pickModel("vision");
      if (model && !router.isFallbackInUse()) {
        answer = await askVisionModel(model, shot.buffer, question, screenSummary);
        mode = "vision";
      }
    } catch (err) {
      log.warn("[vision] Vision model branch failed:", err?.message || err);
    }
  }

  if (!answer) {
    // Offline fallback — works even in Private Mode.
    mode = "ocr";
    answer = buildOcrOnlyAnswer(question, ocrText, uiElements, inPrivate);
  }

  return { answer, mode, ocrText, uiElements, width: shot.width, height: shot.height, permissionMissing: shot.permissionMissing };
}

// ----------------------------------------------------------------------------
// Network branch: OpenRouter vision model
// ----------------------------------------------------------------------------

/**
 * POST the screenshot (base64) + question to the vision model via OpenRouter,
 * returning the full streamed content. Uses a small system hint to steer the
 * model toward plain-language answers.
 */
async function askVisionModel(model, pngBuffer, question, screenSummary) {
  const { getKey } = require("../keys");
  const key = getKey();
  if (!key) throw new Error("No OpenRouter key configured");

  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are Nova, a desktop assistant describing the user's screen. " +
          "Answer the user's question about the screenshot in plain, conversational language, " +
          "2-4 sentences. Mention visible text, apps, errors, buttons or inputs when relevant. " +
          "Do not invent content that is not visible. If the image is mostly blank, say so.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${screenSummary ? `For reference, on-screen text (OCR): "${screenSummary}". ` : ""}Question: ${question}`,
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${pngBuffer.toString("base64")}` },
          },
        ],
      },
    ],
    max_tokens: 500,
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "HTTP-Referer": "https://github.com/nova-assistant",
      "X-Title": "Nova",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Vision model request failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Vision model returned an empty answer");
  return String(content).trim();
}

// ----------------------------------------------------------------------------
// Offline branch: compose an answer purely from OCR + UI detection
// ----------------------------------------------------------------------------

/**
 * Concatenate detected elements into a compact summary suitable as extra
 * context for the vision model.
 */
function describeScreenForLocal(ocrText, uiElements) {
  if (!ocrText && !uiElements.buttons.length && !uiElements.inputs.length) return "";
  const parts = [];
  if (ocrText) parts.push(`Text on screen: ${ocrText}`);
  if (uiElements.buttons.length) {
    parts.push(`Buttons visible: ${uiElements.buttons.slice(0, 8).map((b) => `"${b.label}"`).join(", ")}`);
  }
  if (uiElements.inputs.length) {
    parts.push(`Input fields near labels: ${uiElements.inputs.slice(0, 5).map((i) => `"${i.label}"`).join(", ")}`);
  }
  return parts.join("\n");
}

/**
 * Build a plain-language answer from OCR results alone. Heuristics:
 *   - error-detection questions: look for ERROR / failed / couldn't keywords
 *   - general "what's on screen": report first visible text, buttons, inputs
 */
function buildOcrOnlyAnswer(question, ocrText, uiElements, inPrivate) {
  const q = question.toLowerCase();
  const isErrorQuery = /error|what(?:'s| does| is)? (this|that) (error|message)|what does this say/i.test(q);

  if (!ocrText && !uiElements.buttons.length && !uiElements.inputs.length) {
    return inPrivate
      ? "The screen looks mostly empty, or I could not read any text on it. Private Mode is on, so I can only analyze what I see locally."
      : "The screen looks mostly empty, or I could not read any text on it. I could not reach a vision model either.";
  }

  const sentences = [];

  if (isErrorQuery) {
    const errMatch = ocrText.match(/((?:error|failed|couldn\u2019t|cannot|unable to|unfortunately)[^.!?]{0,140})/i);
    if (errMatch) {
      sentences.push(`I found this on your screen: "${errMatch[1].trim()}".`);
    } else {
      sentences.push("I did not find any obvious error message in the visible text.");
      if (ocrText) sentences.push(`Here is what I could read: "${ocrText.slice(0, 200)}".`);
    }
  } else {
    if (ocrText) sentences.push(`Visible text: "${ocrText.slice(0, 240)}".`);
    if (uiElements.buttons.length) {
      sentences.push(`I can see buttons: ${uiElements.buttons.slice(0, 6).map((b) => `"${b.label}"`).join(", ")}.`);
    }
    if (uiElements.inputs.length) {
      sentences.push(`I can see input fields near: ${uiElements.inputs.slice(0, 4).map((i) => `"${i.label}"`).join(", ")}.`);
    }
  }

  sentences.push(inPrivate
    ? "Private Mode is on, so this description came entirely from local OCR — nothing left this machine."
    : "No free vision model was available right now, so this description came from local OCR only.");
  return sentences.join(" ");
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

module.exports = { runVisionQuery, askVisionModel, VISION_ACTION_ID };
