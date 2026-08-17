// Nova — notes/summarize.js
//
// THE ONLY module in src/main/notes/ allowed to touch the network.
//
// Privacy contract (Stage 7, requirement 5):
//   - Notes content NEVER enters any other OpenRouter call. The dispatcher's
//     conversation stream is built from the user's message alone; this file
//     is never imported there.
//   - "summarize my notes" sends ONLY the note text(s) for that one request.
//     No settings, no API key hints, no file paths, no other history.
//   - Private Mode blocks this entirely (the dispatcher enforces that before
//     calling summarize).
//
// This file deliberately has no dependency on router.js — the dispatcher
// calls it and passes the API key + model it picks. That makes the network
// surface auditable in one place.

const { retryOnce, plainError } = require("../agent/retry");
const log = require("electron-log");

const SUMMARIZE_PROMPT =
  "You are Nova, a local desktop assistant. Summarize these personal notes concisely (3-5 short bullets). Do not invent details not present in the notes. Reply in plain text.\n\nNotes:\n";

/**
 * Build the ONE user message that ever carries note content to the model.
 * @param {Array} noteTexts  [{id, text}] from store.summarizeOf(...)
 * @returns {string}
 */
function buildSummaryUserMessage(noteTexts) {
  const lines = noteTexts
    .map((n) => `- [${new Date(n.createdAt).toLocaleString()}] ${n.text}`)
    .join("\n");
  return SUMMARIZE_PROMPT + (lines || "(no notes yet)");
}

/**
 * Send a one-off summary request. Returns the assistant text.
 * @param {string} key   OpenRouter API key (from the dispatcher's opts.getKey)
 * @param {string} model picked via router.pickModel("chat") by the dispatcher
 * @param {string} userMessage  buildSummaryUserMessage(...)
 */
async function sendSummary(key, model, userMessage) {
  const attempt = async () => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nova.assistant.local",
        "X-Title": "Nova",
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) throw new Error(`summarize model HTTP ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("summarize model returned no content");
    }
    return content.trim();
  };
  try {
    return await retryOnce(attempt, "notes summarize");
  } catch (err) {
    return { error: plainError(err, "summarize your notes") };
  }
}

module.exports = { buildSummaryUserMessage, sendSummary };
