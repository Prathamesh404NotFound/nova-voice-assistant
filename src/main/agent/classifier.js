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
const { planNoteAction } = require("../notes/plan");
const { planKbAction } = require("../kb/plan");

/**
 * Automations (Stage 9) route EARLY: creation requests carry an explicit
 * schedule marker ("every day at …") plus at least one step verb, so they
 * never get mistaken for a plain notes/files/kb request.
 */
const AUTOMATION_RE =
  /^\s*(?:nova,?\s*)?(?:set up|create|make|start|add)\s+(?:a |an |my )?(?:recurring |scheduled )?(?:automation|routine|scheduled task)\b|every\s+(?:day|weekday|weekend|morning|evening|night|noon|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b.*\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|weekdays?\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\s+(?:every|each)\s+(?:day|morning|evening|night)\b/i;

/** Intent names returned by classify(). */
const INTENTS = Object.freeze({
  CONVERSATION: "conversation",
  VISION: "vision",
  CONTROL: "control",
  KB: "kb",
  FILES: "files",
  NOTES: "notes",
  AUTOMATION: "automation",
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
    "Classify the user message into exactly one of: conversation, vision, control, kb, files, notes, automation, combined.\n" +
    "conversation = chat / questions / anything that needs no tooling.\n" +
    "vision = the user wants to know what is on their screen (e.g. read an error).\n" +
    "control = the user wants the assistant to do something (open an app, click, type).\n" +
    "files = the user wants file management (search, organize, move, delete files).\n" +
    "notes = the user wants to create a note, set a reminder, manage tasks, search notes, or summarize notes.\n" +
    "kb = the user wants to add, manage, or query their knowledge base (index a folder, ask what they wrote about a topic, search their documents).\n" +
    "automation = the user wants a SCHEDULED recurring routine (contains a schedule like \"every day at 9am\" or \"weekdays at 8am\" plus steps to run).\n" +
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
async function classify(text = "", opts = {}) {
  const trimmed = text.trim();
  const isVision = VISION_RE.test(trimmed);
  const isControl = CONTROL_RE.test(trimmed);
  // Notes/reminders/tasks have their own verb set and never ambiguous —
  // "note that / remind me / add to my tasks / mark done / search my notes"
  // always means NOTES. Only count it when the parser confirms it is a real
  // request (so "I'll remind you later" does not route to the notes module).
  // Knowledge base has its own dedicated planner and verb set ("add this
  // folder to my knowledge base", "what did I write about X", "search my
  // kb") and routes before FILES/NOTES so that "find my notes on X" lands
  // in the KB pipeline when a planner confirms it is a real KB request.
  // Automations: explicit schedule marker + step verbs (e.g. "every day at
  // 9 AM, check my Downloads folder"). Only count it when the parser
  // confirms a real schedule and at least one step (so "I go to the gym
  // every day at 6pm" stays conversation).
  if (!isVision && AUTOMATION_RE.test(trimmed) && parseAutomationSafe) {
    const parsed = parseAutomationSafe(trimmed);
    if (parsed && parsed.ok) {
      return { intent: INTENTS.AUTOMATION, method: "rules", confidence: "high" };
    }
    if (parsed && parsed.error && /schedule/i.test(parsed.error)) {
      // Clearly an automation attempt that failed to parse — route there so
      // the user hears the helpful nudge instead of a chat reply.
      return { intent: INTENTS.AUTOMATION, method: "rules", confidence: "high", planningError: parsed.error };
    }
  }

  const kbAction = planKbActionSafe(trimmed, opts);
  if (!isVision && kbAction) {
    if (kbAction.error) {
      // A planning ERROR is still clearly a KB request (e.g. "remove the
      // sunset folder from the index" when sunset is not indexed) — route
      // to the KB dispatcher so the user hears the friendly nudge.
      return { intent: INTENTS.KB, method: "rules", confidence: "high", planningError: kbAction.error };
    }
    return { intent: INTENTS.KB, method: "rules", confidence: "high" };
  }
  const noteAction = planNoteActionSafe(trimmed, {});
  if (!isVision && noteAction && !noteAction.error) {
    return { intent: INTENTS.NOTES, method: "rules", confidence: "high" };
  }
  // Even a notes PLANNING ERROR is still clearly a notes request (e.g.
  // "mark pay rent done" on an empty task list, "delete the note about X"
  // when nothing matches, "remind me to" with no body) — route to the
  // notes dispatcher so the user hears the friendly nudge, not a chat reply.
  if (!isVision && noteAction?.error) {
    return { intent: INTENTS.NOTES, method: "rules", confidence: "high", planningError: noteAction.error };
  }

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
  planFileActionSafe = () => null;
}

let planKbActionSafe;
try {
  // Lazy-load planKbAction: if the loader fails, no KB messages route to
  // the KB dispatcher (safer than mis-routing into files or notes).
  planKbActionSafe = planKbAction;
} catch {
  planKbActionSafe = () => null;
}

let planNoteActionSafe;
try {
  // Lazy-load planNoteAction the same way: if the loader fails, no notes
  // messages route to the notes dispatcher (safer than mis-routing).
  planNoteActionSafe = planNoteAction;
} catch {
  planNoteActionSafe = () => null;
}

let parseAutomationSafe;
try {
  // Lazy-load the automation parser; if it fails, no automation requests
  // route to the automation dispatcher (safer than mis-routing).
  parseAutomationSafe = require("../automation/parser").parseAutomation;
} catch {
  parseAutomationSafe = null;
}

module.exports = { classify, quickClassify, INTENTS, VISION_RE, CONTROL_RE, AUTOMATION_RE };
