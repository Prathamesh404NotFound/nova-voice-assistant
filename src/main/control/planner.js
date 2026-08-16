// Nova — control/planner.js
//
// A conservative, deterministic task planner. Given a natural-language
// instruction, it compiles an ordered list of discrete registered actions.
// It NEVER improvises: only recognized verb patterns produce steps, and the
// full plan must be reviewed by the user before anything above Level 1 runs.
//
// Supported instruction vocabulary:
//   open <app> [and ...]
//   click <label> / double-click <label>
//   type "<text>" [into <label>]
//   press <key-combo>          (e.g. "press Ctrl+T")
//   submit / send / press enter / hit enter
//   compute/calculate <expr>   (opens calculator, types the expression, presses Return)
//   wait for <window label>
//
// Example: "open the system calculator and compute 12 x 8"
//   → [ open-app:calculator, wait-for-window:Calculator, type:"12*8", press-keys:Return ]

const log = require("electron-log");

/** Normalizes arithmetic words to the calculator's input language. */
function normalizeExpr(raw) {
  return String(raw)
    .replace(/×|\*|x(?=\s*\d)|multiplied by|times/gi, "*")
    .replace(/÷|\/|divided by|over/gi, "/")
    .replace(/\bplus\b/gi, "+")
    .replace(/\bminus\b|\bsubtract\b|\bfrom\b/gi, "-");
}

/** Map of app names the planner knows how to open, per platform. */
const CALC_APPS = { darwin: "Calculator", win32: "calc", linux: "gnome-calculator" };

function calcApp() {
  return CALC_APPS[process.platform] || "gnome-calculator";
}

let stepCounter = 0;
function stepId(prefix) {
  return `${prefix}-${++stepCounter}`;
}

function resetStepCounter() {
  stepCounter = 0;
}

/**
 * Compile a natural-language instruction into an ordered action plan.
 * @param {string} instruction
 * @returns {{ ok: true, plan: PlanStep[], summary: string } | { ok: false, error: string }}
 * @typedef {{ id, label, actionId, payload, level, note }} PlanStep
 */
function compilePlan(instruction) {
  const text = String(instruction || "").trim();
  if (!text) return { ok: false, error: "The instruction is empty." };
  if (text.length > 300) return { ok: false, error: "The instruction is too long — keep it to a few short steps." };

  resetStepCounter();
  const plan = [];

  const lower = text.toLowerCase();

  // -----------------------------------------------------------------------
  // "compute / calculate <expr>" — the flagship demo pattern.
  // -----------------------------------------------------------------------
  const computeMatch = lower.match(/^(?:compute|calculate|what(?:'s| is))? ?(?:the )?(?:result of )?([\d][\d .×x*÷/+−-]+(?:\s*(?:plus|minus|times|multiplied by|divided by|over)\s*[\d .×x*÷/+−-]+)*)(?:\s*$|\s+for me$|\s*$)/);
  const computeIdx = lower.search(/(?:^| )compute |(?:^| )calculate | result of /);

  if (computeMatch || computeIdx !== -1) {
    // Extract the expression: either the matched group or the tail after the verb.
    let expr = computeMatch?.[1];
    if (!expr) {
      const m = text.match(/(?:compute|calculate|result of)\s+(.+)$/i);
      if (m) expr = normalizeExpr(m[1]);
    } else {
      expr = normalizeExpr(expr);
    }
    if (!expr || !/[\d]/.test(expr)) {
      return { ok: false, error: "I could not find a numeric expression to compute." };
    }
    // Strip anything that is not digits/operators — refuse code or text injection.
    expr = expr.replace(/[^0-9+\-*/().% ]/g, "").trim();
    if (!/^\d[\d+\-*/().% ]*$/.test(expr)) {
      return { ok: false, error: "The expression contains characters I can't safely type." };
    }

    plan.push({
      id: stepId("open"),
      label: `Open ${calcApp()}`,
      actionId: "control:open-app",
      payload: { app: calcApp() },
      level: 1,
      note: "Launch the system calculator",
    });
    plan.push({
      id: stepId("wait"),
      label: "Wait for the calculator window",
      actionId: "control:wait-for-window",
      payload: { label: "Calculator", contains: "0", verify: { contains: "0" } },
      level: 1,
      note: "Screenshot + OCR check that the calculator is open and focused",
    });
    plan.push({
      id: stepId("type"),
      label: `Type "${expr}"`,
      actionId: "control:type-text",
      payload: { text: expr },
      level: 2,
      note: "Type the expression into the calculator",
    });
    plan.push({
      id: stepId("enter"),
      label: "Press Return (=)",
      actionId: "control:press-keys",
      payload: { combo: "Return" },
      level: 3,
      note: "Press Return to evaluate",
    });
    return { ok: true, plan, summary: `Compute ${expr} in the calculator` };
  }

  // -----------------------------------------------------------------------
  // "open <app>" — possibly chained with "and ..."
  // -----------------------------------------------------------------------
  const openMatch = lower.match(/open (the system )?(the )?([a-z0-9 \-&]+?)(?:\s+and\s+(.+))?$/i);
  if (openMatch) {
    const appName = openMatch[3].trim();
    plan.push({
      id: stepId("open"),
      label: `Open ${appName}`,
      actionId: "control:open-app",
      payload: { app: appName },
      level: 1,
      note: `Launch ${appName}`,
    });
    const rest = openMatch[4];
    if (rest) {
      const sub = compilePlan(rest);
      if (!sub.ok) return sub;
      for (const s of sub.plan) s.id = stepId(s.id.split("-")[0]);
      plan.push(...sub.plan);
    }
    return { ok: true, plan, summary: `Open ${appName}` };
  }

  // -----------------------------------------------------------------------
  // "click <label>" / "double-click <label>"
  // -----------------------------------------------------------------------
  const clickMatch = lower.match(/^(double-?click|click|right-click)\s+(?:on\s+)?(.+)$/i);
  if (clickMatch) {
    const label = clickMatch[2].replace(/^"(.*)"$/, "$1").trim();
    if (!label) return { ok: false, error: "Click what, exactly? A label is required." };
    const verb = clickMatch[1].toLowerCase();
    if (verb.startsWith("double")) {
      plan.push({ id: stepId("click"), label: `Double-click "${label}"`, actionId: "control:double-click", payload: { label, x: 0, y: 0 }, level: 2, note: `Double-click on "${label}" (position from the current screen read)` });
    } else if (verb.startsWith("right")) {
      plan.push({ id: stepId("click"), label: `Right-click "${label}"`, actionId: "control:right-click", payload: { label, x: 0, y: 0 }, level: 2, note: `Right-click on "${label}"` });
    } else {
      plan.push({ id: stepId("click"), label: `Click "${label}"`, actionId: "control:left-click", payload: { label, x: 0, y: 0 }, level: 2, note: `Click on "${label}"` });
    }
    // Locating label coordinates needs a screen read first: capture → OCR →
    // find the word bbox (performed at execution time, not compile time).
    return { ok: true, plan, summary: `Click "${label}"` };
  }

  // -----------------------------------------------------------------------
  // "type <text>" / "type <text> into <label>"
  // -----------------------------------------------------------------------
  const typeMatch = lower.match(/^type\s+(?:"([^"]+)"|(.+?))(?:\s+into\s+"?([^"]+)"?)?$/i);
  if (typeMatch) {
    const typed = (typeMatch[1] || typeMatch[2] || "").trim();
    if (!typed) return { ok: false, error: "There's nothing to type." };
    if (typed.length > 200) return { ok: false, error: "Text is too long (200 character limit)." };
    const into = typeMatch[3]?.trim();
    plan.push({
      id: stepId("type"),
      label: into ? `Type "${typed}" into "${into}"` : `Type "${typed}"`,
      actionId: "control:type-text",
      payload: { text: typed, into },
      level: 2,
      note: into ? `Type into the "${into}" field` : "Type into the focused field",
    });
    return { ok: true, plan, summary: plan[0].label };
  }

  // -----------------------------------------------------------------------
  // "submit" / "send" / "press enter" / "hit enter"
  // -----------------------------------------------------------------------
  if (/^(submit|send|press (the )?enter|hit enter|hit return|press return)$/i.test(lower)) {
    plan.push({
      id: stepId("keys"),
      label: "Press Return (submit)",
      actionId: "control:press-keys",
      payload: { combo: "Return" },
      level: 3,
      note: "Press Return to submit the focused form",
    });
    return { ok: true, plan, summary: "Submit the focused form" };
  }

  // -----------------------------------------------------------------------
  // "press <combo>" — dangerous combos escalate to L3 at compile time.
  // -----------------------------------------------------------------------
  const pressMatch = lower.match(/^press\s+(.+)$/i);
  if (pressMatch) {
    const combo = pressMatch[1].trim();
    const dangerous = DANGEROUS_COMBOS.some((rx) => rx.test(` ${combo} `));
    plan.push({
      id: stepId("keys"),
      label: `Press ${combo}`,
      actionId: "control:press-keys",
      payload: { combo },
      level: dangerous ? 3 : 2,
      note: dangerous ? "This shortcut can close or quit something — Nova asks for confirmation first." : `Press ${combo} at the keyboard`,
    });
    return { ok: true, plan, summary: plan[0].label };
  }

  // -----------------------------------------------------------------------
  // "wait for <label>"
  // -----------------------------------------------------------------------
  const waitMatch = lower.match(/^wait for (?:the )?(.+)$/i);
  if (waitMatch) {
    plan.push({
      id: stepId("wait"),
      label: `Wait for "${waitMatch[1].trim()}"`,
      actionId: "control:wait-for-window",
      payload: { label: waitMatch[1].trim(), contains: waitMatch[1].trim().toLowerCase(), verify: { contains: waitMatch[1].trim().toLowerCase() } },
      level: 1,
      note: "Screenshot + OCR check that the target is visible",
    });
    return { ok: true, plan, summary: plan[0].label };
  }

  return { ok: false, error: "I can't safely plan that yet. Try: \"open the calculator and compute 12 x 8\", \"click Save\", \"type hello\", or \"press Ctrl+T\"." };
}

/**
 * Combos that can irreversibly close/quit things — always Level 3.
 * Note: these are matched loosely on the submitted combo string.
 */
const DANGEROUS_COMBOS = [
  /\sctrl\s*[+ ]\s*w\b/i, /\scommand\s*[+ ]\s*w\b/i, /\scmd\s*[+ ]\s*w\b/i,
  /\sctrl\s*[+ ]\s*q\b/i, /\scommand\s*[+ ]\s*q\b/i, /\scmd\s*[+ ]\s*q\b/i,
  /\salt\s*[+ ]\s*f4\b/i,
  /\sctrl\s*[+ ]\s*z\b/i,   // undo is not irreversible, but treat batch undo cautiously
  /\sctrl\s*[+ ]\s*shift\s*[+ ]\s*t\b/i,
];

module.exports = { compilePlan, normalizeExpr, calcApp, DANGEROUS_COMBOS, resetStepCounter };
