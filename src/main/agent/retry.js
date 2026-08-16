// Nova — agent/retry.js
//
// Error handling for the agent loop (Stage 5 req 4):
//   - retryOnce(fn, label): runs the async fn; on first failure retries EXACTLY
//     once. The raw error from both attempts is captured for Developer Mode.
//   - plainError(err, context): turns any error into a short, friendly,
//     plain-language message for chat. The raw error/st
// stack is NEVER shown to the user — it stays in the Dev Mode task inspector.

const log = require("electron-log");

/** Human-friendly error formatter keyed off error message patterns. */
function plainError(err, context = "the request") {
  const msg = String(err?.message || err || "").toLowerCase();
  if (!err || msg === "") {
    return "Something went wrong and I could not finish that.";
  }
  if (msg.includes("fetch") || msg.includes("network") || msg.includes("econnrefused") || msg.includes("enetunreach")) {
    return "I could not reach the network. Please check your internet connection and try again.";
  }
  if (msg.includes("api key") || msg.includes("unauthorized") || msg.includes("401") || msg.includes("forbidden")) {
    return "Your API key does not look right. Open the settings panel and check the OpenRouter key.";
  }
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many")) {
    return "The model is a little busy right now (rate limited). Try again in a moment.";
  }
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("esockettimedout")) {
    return `The ${context} took too long. I gave it one more try and it is still not answering — please retry in a bit.`;
  }
  if (msg.includes("cancelled")) return "That was cancelled.";
  if (msg.includes("blocked") || msg.includes("private mode")) {
    return "That is blocked while Private Mode is on.";
  }
  return "Something went wrong with " + context + ". The full details are in Developer Mode.";
}

/**
 * Run fn(); on first throw, wait briefly and retry once.
 * @param {() => Promise<any>} fn
 * @param {string} label — used only for logging
 * @returns {Promise<{ ok: true, value: any } | { ok: false, error: Error, retried: boolean }>}
 */
async function retryOnce(fn, label = "operation") {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    log.warn(`[agent] ${label} failed (attempt 1):`, err?.message || err);
    await new Promise((r) => setTimeout(r, 800));
    try {
      return { ok: true, value: await fn() };
    } catch (err2) {
      log.error(`[agent] ${label} failed (attempt 2):`, err2?.message || err2);
      return { ok: false, error: err2, retried: true };
    }
  }
}

module.exports = { plainError, retryOnce };
