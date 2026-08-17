// Query composition for the knowledge base (Stage 8).
//
// Privacy contract:
//   1. Whole documents are NEVER sent to any model.
//   2. Only the top-matching chunks (+ the question) are sent, and only when
//      Private Mode is OFF.
//   3. Private Mode ON → graceful refusal with the exact phrase the user
//      asked for: "Knowledge base search needs Private Mode off."
//
// Uses pickModel("chat") through the existing router (retry + Action Log).

let _privateModeGetter = null;
let _router = null; // injectable for tests: async (model, messages) => answerText

function configure({ getPrivateMode, router } = {}) {
  // A deliberate undefined keeps whatever was injected earlier — this lets
  // tests (and the headless dispatcher path) inject a fake getter/router once
  // without it being silently wiped by a no-arg configure() call.
  if (getPrivateMode !== undefined) _privateModeGetter = getPrivateMode;
  if (router !== undefined) _router = router;
}

function isPrivateMode() {
  // Injected getter wins (tests + headless dispatcher). Otherwise read the
  // real app setting — Private Mode refusal must follow the user's toggle.
  if (_privateModeGetter) return _privateModeGetter();
  try {
    const settings = require("../settings");
    return typeof settings.isPrivateMode === "function" ? settings.isPrivateMode() : false;
  } catch {
    return false;
  }
}

async function defaultRouter(answerPrompt) {
  const router = require("../router");
  const pick = router.pickModel ? router.pickModel("chat") : "chat";
  const send = router.send || (router.default && router.default.send);
  if (typeof send !== "function") throw new Error("no chat send available");
  const res = await send(pick, [{ role: "user", content: answerPrompt }]);
  return (res && (res.content || res.text || res.answer)) || "";
}

/**
 * Compose an answer from retrieved chunks.
 * @param {string} question
 * @param {{ chunks: object[], sources: object[] }} results
 * @returns {Promise<{ok:true,text,sources}|{ok:false,text,refused:true}>}
 */
async function compose(question, results) {
  if (isPrivateMode()) {
    return {
      ok: false,
      text: "Knowledge base search needs Private Mode off — I won't send your documents anywhere while it's on.",
      refused: true,
      sources: [],
    };
  }
  if (!results.chunks.length) {
    return { ok: true, text: "I searched your knowledge base but found nothing relevant to that.", sources: [] };
  }
  const snippets = results.chunks
    .map((c, i) => `[${i + 1}] ${c.meta.title}: ${c.text}`)
    .join("\n\n");
  const prompt = [
    `You are Nova, a voice-first desktop assistant. Answer the user's question using ONLY the snippets below, which are chunks retrieved from their local knowledge base. Keep the answer under 3 short sentences and speak naturally (it will be read aloud). Cite the snippet numbers you used, e.g. "(from snippet 1)". If the snippets don't answer the question, say so plainly.\n\n`,
    `Snippets:\n${snippets}\n\nQuestion: ${question}`,
  ].join("");

  const routerFn = _router || defaultRouter;
  let answer;
  try {
    answer = (await routerFn("chat", [{ role: "user", content: prompt }])).trim();
  } catch (err) {
    return {
      ok: false,
      text: `I found relevant snippets but couldn't compose an answer: ${err?.message || err}.`,
      sources: results.sources,
      error: true,
    };
  }
  if (!answer) {
    answer = "I found relevant snippets but couldn't compose an answer.";
  }
  return { ok: true, text: answer, sources: results.sources };
}

module.exports = { compose, configure, isPrivateMode };
