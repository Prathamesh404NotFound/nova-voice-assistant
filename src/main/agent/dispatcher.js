// Nova — agent/dispatcher.js
//
// The unified agent loop (Stage 5 req 1). Every voice or text message flows
// through `run(text)` instead of the old renderer-side regex routing:
//
//   classify(text)            ── rules, offline; quick model only when ambiguous
//   dispatch(intent)          ── conversation / vision / control / combined
//   narration(text)           ── Nova speaks AND transcripts each step out loud
//   lastTask / getTaskInfo()  ── feeds the Developer Mode inspector
//   retryOnce                 ── one automatic retry before plain-language error
//
// The dispatcher never shows stack traces to the user: raw errors live only
// in the last-task view (Developer Mode).

const { EventEmitter } = require("events");
const log = require("electron-log");
const router = require("../router");
const settings = require("../settings");
const actionLog = require("../permissions/action-log");
const undo = require("../permissions/undo");
const { classify, INTENTS } = require("./classifier");
const { plainError, retryOnce } = require("./retry");
const control = require("../control");
const memory = require("../memory/conversation-memory");
const { runFileAction, executePreview, getContext } = require("../files/dispatch");
const notesDispatch = require("../notes/dispatch");
const kbDispatch = require("../kb/dispatch");
const { planKbAction } = require("../kb/plan");

// Lazy read of the live index — avoids hard-loading the kb modules when the
// knowledge base feature is never used, and keeps tests free of surprises.
function kbIndexList() {
  try { return require("../kb/index").listFolders(); } catch { return []; }
}

const emitter = new EventEmitter();

/** Last-task inspector state (Stage 5 req 2), refreshed on every run. */
let lastTask = null;
let taskIdCounter = 0;

function nextTaskId() {
  return `task-${++taskIdCounter}-${Date.now()}`;
}

/** Human narration + progress event. Spoken by the renderer (first time). */
function narrate(taskId, step, text) {
  emitter.emit("progress", { type: "narration", taskId, step, text });
  log.info(`[agent:narrate] [${step}] ${text}`);
}

function recordStep(taskId, label, level, ms) {
  if (!lastTask) return;
  lastTask.steps.push({ label, level, durationMs: ms, ts: new Date().toISOString() });
}

/** Human file answer + preview card. Spoken by the renderer (first time). */
function narrateFiles(taskId, step, text) {
  emitter.emit("progress", { type: "narration", taskId, step, text });
  log.info(`[agent:narrate] [${step}] ${text}`);
}

function narrateNotes(taskId, step, text) {
  emitter.emit("progress", { type: "narration", taskId, step, text });
  log.info(`[agent:narrate] [${step}] ${text}`);
}

function narrateKb(taskId, step, text) {
  emitter.emit("progress", { type: "narration", taskId, step, text });
  log.info(`[agent:narrate] [${step}] ${text}`);
}

/** Notes/reminders/tasks: fully local except the explicit summarize flow. */
async function dispatchNotes(text, opts = {}) {
  // The classifier may have already detected a notes planning error (empty
  // list, no match, incomplete phrase) — honor it directly so the user hears
  // the friendly nudge without a redundant re-plan pass.
  if (opts.planningError) {
    return {
      ok: false, intent: "notes",
      text: opts.planningError,
      detail: { planningError: opts.planningError },
    };
  }
  const planned = notesDispatch.planNoteAction(text, notesDispatch.storeContext());
  // The ONLY notes path that ever leaves the machine. Private Mode refuses
  // it outright (Stage 7 req 5) — no model call, nothing sent.
  if (planned?.actionId === "notes:summarize-notes" && settings.isPrivateMode()) {
    return {
      ok: false, intent: "notes", actionId: planned.actionId,
      text: "Private Mode is on — I can't send your notes anywhere, not even to summarize them. Turn Private Mode off first if you want this.",
      detail: { kind: "summarize", privateMode: true },
    };
  }
  const res = await notesDispatch.runNoteAction(text, {
    taskId: lastTask?.id,
    getKey: opts.getKey,
    mainWindow: opts.mainWindow,
  });
  recordStep(lastTask?.id, "notes " + (res.actionId || "plan"), null, Date.now() - (lastTask?.startedAt || Date.now()));
  return res;
}

/** Knowledge base: fully local indexing/search; RAG sends only snippets. */
async function dispatchKb(text, opts = {}) {
  // The classifier may have already detected a KB planning error (no indexed
  // folder matches a named reference) — honor it directly like the notes path.
  if (opts.planningError) {
    return {
      ok: false, intent: "kb",
      text: opts.planningError,
      detail: { planningError: opts.planningError },
    };
  }
  // Bridge progress/watcher events from the main-process modules to the
  // renderer (index progress line, watcher start/stop).
  if (opts.mainWindow) {
    try {
      global.__kbProgressBridge = (evt) => { try { opts.mainWindow.webContents.send("kb:index-progress", evt); } catch {} };
      global.__kbWatcherBridge = (action, id) => {
        try {
          const watcher = require("../kb/watcher");
          if (action === "stop") watcher.stopWatching(id);
          else watcher.startWatching(id);
        } catch {}
      };
    } catch {}
  }
  narrateKb(lastTask.id, "kb", opts.step || "Checking your knowledge base…");
  const started = Date.now();
  const res = await kbDispatch.runKbAction(text, {
    taskId: lastTask?.id,
    ctx: opts.ctx || {},
  });
  recordStep(lastTask?.id, "kb " + (res.actionId || "plan"), null, Date.now() - started);
  if (res.narration) narrateKb(lastTask.id, "kb", res.narration);
  return res;
}

function recordError(taskId, ctx, err) {
  if (!lastTask) return;
  lastTask.errors.push({
    context: ctx,
    message: String(err?.message || err),
    stack: err?.stack || null,
    ts: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Dispatchers per intent
// ---------------------------------------------------------------------------

/** Plain conversation: stream the chat answer, narrating when it starts. */
async function dispatchConversation(text, opts) {
  const model = router.pickModel("chat");
  const key = await opts.getKey();
  if (!key) {
    return { text: "I need your OpenRouter API key before I can chat. Open the side panel settings to set it.", model };
  }
  narrate(lastTask.id, "chat", "Working on your message…");
  // Round 6: rolling conversation memory — previous sessions' user/assistant
  // exchanges are appended as context so follow-ups across restarts still
  // make sense. Private Mode sends ONLY the current message (memory context
  // is never included when privacy is on).
  const memoryContext = settings.isPrivateMode() ? [] : memory.recentContext();
  const memoryUsed = memoryContext.length > 0;
  const attempt = async () => {
    // Same stream contract the renderer used in Stage 1: POST to OpenRouter,
    // collect the full assistant message, stream chunks to the renderer.
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
        stream: true,
        messages: [...memoryContext, { role: "user", content: text }],
      }),
    });
    if (!res.ok) throw new Error(`model HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const data = line.replace(/^data: /, "").trim();
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta?.content || "";
          if (delta) {
            full += delta;
            emitter.emit("progress", { type: "chat-chunk", taskId: lastTask.id, text: delta });
          }
        } catch { /* malformed SSE line — skip */ }
      }
    }
    return full;
  };
  const started = Date.now();
  const res = await retryOnce(attempt, "chat stream");
  recordStep(lastTask.id, "chat stream (model " + model + ")", null, Date.now() - started);
  if (!res.ok) {
    recordError(lastTask.id, "chat stream", res.error);
    return { text: plainError(res.error, "the assistant"), error: res.error, model };
  }
  // Round 6: persist this exchange so future sessions remember it.
  memory.append({ intent: "conversation", input: text, output: res.value, taskId: lastTask.id });
  return { text: res.value, model, memoryUsed };
}

/** Vision query: capture + OCR (+ vision model when available). */
async function dispatchVision(text, opts) {
  if (!opts.runVisionQuery) throw new Error("vision pipeline unavailable");
  narrate(lastTask.id, "vision", "Taking a look at your screen…");
  const started = Date.now();
  const res = await retryOnce(() => opts.runVisionQuery(text), "vision query");
  recordStep(lastTask.id, "vision query", null, Date.now() - started);
  if (!res.ok) {
    recordError(lastTask.id, "vision query", res.error);
    return { text: "I could not read the screen: " + plainError(res.error, "the screen capture"), error: res.error };
  }
  const answer = res.value?.answer || "I could not read anything on the screen.";
  return { text: answer, mode: res.value?.mode };
}

/** Control task: compile the plan; execution starts after user review. */
async function dispatchControl(text) {
  narrate(lastTask.id, "planning", "Let me plan the steps…");
  const started = Date.now();
  const result = control.compilePlan(text);
  recordStep(lastTask.id, "compile plan", null, Date.now() - started);
  if (!result.ok) {
    const msg = "I could not plan that: " + plainError(new Error(result.error || "unknown planner error"), "the planner");
    return { text: msg, error: new Error(result.error) };
  }
  narrate(lastTask.id, "planning", result.summary || `Ready: ${result.plan.length} step${result.plan.length === 1 ? "" : "s"}.`);
  control.sequence.reviewing(`agent-${lastTask.id}`);
  return { plan: result.plan, summary: result.summary };
}

/** File management: search / stats / organize with dry-run previews. */
async function dispatchFiles(text) {
  narrate(lastTask.id, "files", "Checking your files…");
  const started = Date.now();
  const attempt = async () => {
    const res = await runFileAction(text, { taskId: lastTask.id });
    if (res === null) throw new Error("not a file request"); // caller fallback
    return res;
  };
  const res = await retryOnce(attempt, "file action");
  recordStep(lastTask.id, "file action", null, Date.now() - started);
  if (!res.ok || res.value.error) {
    const err = res.value?.error || (res.error && new Error(String(res.error)));
    if (res.error) recordError(lastTask.id, "file action", res.error);
    return { text: res.value?.text || "I could not handle that file request.", error: err };
  }
  const out = res.value;
  if (out.narration) narrateFiles(lastTask.id, "files", out.narration);
  if (out.preview) return { preview: true, actionId: out.actionId, report: out.report, previewToken: out.previewToken, narration: out.narration };
  if (out.text) return { text: out.text };
  return { actionId: out.actionId, detail: out.detail, narration: out.narration };
}

/** Combined: vision check first, then control plan. */
async function dispatchCombined(text, opts) {
  narrate(lastTask.id, "vision", "Let me check your screen first…");
  const vis = await dispatchVision(text, opts);
  if (vis.error) return vis;
  return { visionAnswer: vis.text, ...(await dispatchControl(text)) };
}

/** Automation management (Stage 9) — local only, works in Private Mode. */
async function dispatchAutomation(text, opts = {}) {
  // The classifier may already carry a planning error (failed parse with a
  // clear schedule attempt) — surface the friendly nudge directly.
  if (opts.planningError) {
    return {
      ok: false, intent: "automation",
      text: opts.planningError,
      detail: { planningError: opts.planningError },
    };
  }
  const automationDispatch = require("../automation/dispatch");
  const res = await automationDispatch.addAutomation(text, { mainWindow: opts.mainWindow });
  narrate(lastTask.id, "automation", res.ok ? `Setting up "${res.detail?.name || "the automation"}"…` : "");
  return res;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the full agent loop for one message.
 * @param {string} text
 * @param {{ getKey: () => Promise<string|null>, runVisionQuery?: (q) => Promise<any> }} opts
 * @returns {Promise<object>} intent + payload + (plan | text) + (error only raw)
 */
async function run(text, opts = {}) {
  const taskId = nextTaskId();
  lastTask = { id: taskId, input: text.trim(), startedAt: Date.now(), intent: null, classification: null, steps: [], errors: [] };

  let intent;
  try {
    let kbFolders = [];
    try { kbFolders = kbIndexList().map((f) => f.root); } catch {}
    const c = await classify(text, { kbFolders });
    intent = c.intent;
    lastTask.classification = { intent: c.intent, method: c.method, confidence: c.confidence };
  } catch (err) {
    recordError(taskId, "classification", err);
    intent = INTENTS.CONVERSATION;
    lastTask.classification = { intent, method: "fallback", confidence: "low" };
  }
  lastTask.intent = intent;
  log.info(`[agent] task ${taskId} intent=${intent}`);

  try {
    if (intent === INTENTS.CONVERSATION) {
      const out = await dispatchConversation(text, opts);
      lastTask.output = { type: "conversation", text: out.text, model: out.model, error: !!out.error };
      return { ok: true, intent, ...lastTask.output, memoryUsed: !!out.memoryUsed };
    }
    if (intent === INTENTS.VISION) {
      const out = await dispatchVision(text, opts);
      lastTask.output = { type: "vision", text: out.text, mode: out.mode, error: !!out.error };
      return { ok: true, intent, ...out };
    }
    if (intent === INTENTS.CONTROL) {
      const out = await dispatchControl(text);
      lastTask.output = { type: "control", plan: out.plan, summary: out.summary, error: !!out.error };
      return { ok: true, intent, ...out };
    }
    if (intent === INTENTS.FILES) {
      const out = await dispatchFiles(text);
      lastTask.output = { type: "files", ...out, error: !!out.error };
      return { ok: true, intent, ...out };
    }
    if (intent === INTENTS.KB) {
      const out = await dispatchKb(text, opts);
      lastTask.output = { type: "kb", ...out, error: !out.ok };
      return { ok: true, intent, ...out };
    }
    if (intent === INTENTS.NOTES) {
      const out = await dispatchNotes(text, opts);
      lastTask.output = { type: "notes", ...out, error: !out.ok };
      if (out.narration) narrateNotes(taskId, "notes", out.narration);
      // Round 6: remember notes requests too — "did I note something about X?"
      if (out.ok) memory.append({ intent: "notes", input: text, output: out.text || "", taskId });
      return { ok: true, intent, ...out };
    }
    // Automations (Stage 9): creation/management through the automation
    // dispatcher; scheduling is local so this works fully offline.
    if (intent === INTENTS.AUTOMATION) {
      const out = await dispatchAutomation(text, opts);
      lastTask.output = { type: "automation", ...out, error: !out.ok };
      return { ok: true, intent, ...out };
    }
    // COMBINED
    const out = await dispatchCombined(text, opts);
    lastTask.output = { type: "combined", ...out, error: !!out.error };
    return { ok: true, intent, ...out };
  } catch (err) {
    return { ok: false, intent, text: plainError(err, "that request"), error: err };
  }
}

function getLastTask() {
  if (!lastTask) return null;
  return {
    ...lastTask,
    logEntries: actionLog.list(500).filter((e) => e.taskId === lastTask.id),
    modelPick: lastTask.intent ? router.lastPick(lastTask.intent) : null,
  };
}

module.exports = { run, getLastTask, on: (ev, fn) => emitter.on(ev, fn), emitter };
