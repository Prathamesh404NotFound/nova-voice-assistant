// Nova — agent/classifier.js
//
// Intent classification for the unified agent loop (Stage 5): every voice or
// text message is classified BEFORE anything else happens, deciding which
// pipeline to run:
//   conversation — plain chat
//   vision       — "what's on my screen", "what does this error say" ...
//   control      — "open Notepad", "click Save", "compute 12 x 8" ...
//   combined     — a vision check plus a control plan (ambiguous requests)
//
// Classification is LOCAL and rule-based by default (no LLM round-trip, no
// latency, works in Private Mode). Only genuinely AMBIGUOUS messages — ones
// that mention both a screen question AND an action verb — go through a
// cheap one-shot model call via pickModel("quick"). If that call fails, the
// classifier falls back to the heuristic (safest default: conversation).

const router = require("../router");
const { FILE_RE } = require("../files/plan");

/** Intent names returned by classify(). */
const INTENTS = Object.freeze({
  CONVERSATION: "conversation",
  VISION: "vision",
  CONTROL: "control",
  FILES: "files",
  COMBINED: "combined",
});

/** Vision trigger phrases (rule-based, same set the renderer used in Stage 3). */
const VISION_RE =
  /what('s| is)? (on my screen|this screen|this (error|message))|what am i looking at|describe (my |the )?screen|read (my |the )?screen|what does (this|that) (error |message )?say|tell me about (my |the |this )?(screen|error|message)|can you (see|read|check) (my |the )?screen/i;

/** Control trigger phrases (rule-based, same set the planner handles). */
const CONTROL_RE =
  /^(open|click|double[- ]?click|right[- ]?click|type|press|submit|send|compute|calculate|wait for|drag|select)/i;

/** Words that make a message "screen-question-like". */
const VISION_HINTS =
  /\b(screen|display|error|message|on my monitor|looking at|what('s| is) (on|that|this))\b/i;

/** Words that make a message "action-verb-like". */
const ACTION_HINTS =
  /\b(open|click|type|press|submit|compute|calculate|drag|close|kill|move|scroll)\b/i;

/**
 * Cheap ambiguous-case classifier via pickModel("quick"). Sends a one-shot
 * prompt with fixed choices and expects one of the four intent names back.
 * @returns {Promise<string|null>} an intent name, or null on any failure
 */
async function quickClassify(text) {
  let model;
  try {
    model = router.pickModel("quick");
  } catch {
    return null; // router failure → never route on a failed model pick
  }
  const prompt =
    "Classify the user message into exactly one of: conversation, vision, control, files, combined.\n" +
    "conversation = chat / questions / anything that needs no tooling.\n" +
    "vision = the user wants to know what is on their screen (e.g. read an error).\n" +
    "control = the user wants the assistant to do something (open an app, click, type).\n" +
    "files = the user wants file management (search, organize, move, delete files).\n" +
    "combined = the user wants BOTH (check the screen AND act, e.g. verify the app opened).\n" +
    "Answer with a single lowercase word only.\n\n" +
    `Message: "${text}"`;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nova.assistant.local",
        "X-Title": "Nova",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [
          { role: "system", content: "Single-word intent classifier." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const word = (data?.choices?.[0]?.message?.content || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    return Object.values(INTENTS).includes(word) ? word : null;
  } catch {
    return null;
  }
}

/**
 * Classify a message.
 * @returns {{ intent: string, method: "rules"|"quick"|"fallback", confidence: "high"|"low" }}
 */
async function classify(text = "") {
  const trimmed = text.trim();
  const isVision = VISION_RE.test(trimmed);
  const isControl = CONTROL_RE.test(trimmed);
  // File management is recognized by its own verb set and never ambiguous —
  // "find / clean up / move / rename / delete … files" always means FILES.
  // Only count it when the parser confirms it is a real file request (so
  // "I need to find a new job" does not route to the file manager).
  if (!isVision && FILE_RE.test(trimmed)) {
    const action = planFileActionSafe(trimmed, {});
    if (action && !action.error) return { intent: INTENTS.FILES, method: "rules", confidence: "high" };
  }

  // Unambiguous: pure rules, no model call, works offline / Private Mode.
  if (isVision && !isControl) return { intent: INTENTS.VISION, method: "rules", confidence: "high" };
  if (isControl && !isVision) return { intent: INTENTS.CONTROL, method: "rules", confidence: "high" };

  // Ambiguous — contains hints of both (or neither but borderline).
  const bothHints = VISION_HINTS.test(trimmed) && ACTION_HINTS.test(trimmed);
  if (isVision && isControl) {
    const llm = await quickClassify(trimmed);
    if (llm) return { intent: llm, method: "quick", confidence: "low" };
    // Fallback heuristic: action verbs take precedence over screen questions.
    return { intent: INTENTS.COMBINED, method: "fallback", confidence: "low" };
  }
  if (bothHints) {
    const llm = await quickClassify(trimmed);
    if (llm) return { intent: llm, method: "quick", confidence: "low" };
    return { intent: INTENTS.COMBINED, method: "fallback", confidence: "low" };
  }
  // Neither: plain conversation.
  return { intent: INTENTS.CONVERSATION, method: "rules", confidence: "high" };
}

let planFileActionSafe;
try {
  // Lazy-load planFileAction for a cheap "is this a real file request?"
  // fallback check; if the loader fails, FILE_RE alone decides (Stage 6 safety:
  // a mis-routed message just lands in the files dispatcher, which replies
  // "I could not find …" instead of acting blindly).
  planFileActionSafe = require("../files/plan").planFileAction;
} catch {
  planFileActionSafe = () => true;
}

module.exports = { classify, quickClassify, INTENTS, VISION_RE, CONTROL_RE };
