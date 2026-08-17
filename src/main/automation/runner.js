// Nova — automation/runner.js (Stage 9)
//
// Executes an automation's step list through the EXISTING dispatchers —
// vision (runVisionQuery), files (runFileAction), notes (runNoteAction),
// kb (runKbAction), control (compilePlan only — blocked from executing).
//
// Risk model (Req 2):
//   - Level 0–2 steps run unattended — their own toast/dry-run safety
//     nets already apply inside each stage's dispatcher.
//   - Level 3+ steps (any files:delete-files-class step, any control
//     sequence) are NEVER executed unattended: the automation pauses with
//     status "awaiting-confirmation" and the scheduler emits a
//     "automation-pending" event; main.js shows an OS notification and a
//     side-panel card. The user confirms in-app and the sequence runs once.
//   - A run where some steps succeed but confirmation is pending is
//     recorded as status "partial" up to the pause point.
//
// Levels are resolved per step from each stage's action registry so the
// automation can never downgrade a step's original risk level.

const log = require("electron-log");
const { EventEmitter } = require("events");
const actionLog = require("../permissions/action-log");
const actionRegistry = require("../permissions/action-registry");
const { RISK_LEVEL, riskLabel } = require("../permissions/risk-levels");
const { LEVEL_STATUS } = require("./types");
const store = require("./store");

const emitter = new EventEmitter();

// ---------------------------------------------------------------------------
// Step-level resolution
// ---------------------------------------------------------------------------

/** Best-effort level for a files/notes/kb step, from the stage's planner. */
// Verb-based floors: even when a stage's planner cannot resolve a step,
// wording that mentions destructive/reversible operations is NEVER treated
// as read-only. This stops an automation from being created as "unattended"
// just because the planner could not disambiguate its text.
const DELETE_VERBS = /\b(?:delete|remove|trash|get rid of|erase)\b/i;
const REVERSIBLE_VERBS = /\b(?:move|rename|copy|organize|clean up|cleanup|tidy|sort|add this folder|re[- ]?index|remove this folder)\b/i;

function verbFloor(step) {
  if (step.kind === "files") {
    if (DELETE_VERBS.test(step.text)) return RISK_LEVEL.DESTRUCTIVE;
    if (REVERSIBLE_VERBS.test(step.text)) return RISK_LEVEL.REVERSIBLE;
    return RISK_LEVEL.READ;
  }
  if (step.kind === "kb") {
    if (DELETE_VERBS.test(step.text)) return RISK_LEVEL.DESTRUCTIVE;
    if (REVERSIBLE_VERBS.test(step.text)) return RISK_LEVEL.REVERSIBLE;
    return RISK_LEVEL.SAFE;
  }
  if (step.kind === "notes") {
    if (DELETE_VERBS.test(step.text) || REVERSIBLE_VERBS.test(step.text)) return RISK_LEVEL.REVERSIBLE;
    return RISK_LEVEL.SAFE;
  }
  if (step.kind === "vision") return RISK_LEVEL.READ;
  if (step.kind === "control") return RISK_LEVEL.SENSITIVE;
  return RISK_LEVEL.READ;
}

function resolveStepLevel(step) {
  try {
    if (step.kind === "files") {
      const planned = require("../files/plan").planFileAction(step.text, {});
      if (planned && planned.actionId) {
        try { return actionRegistry.getAction(planned.actionId).level; } catch {}
      }
      return verbFloor(step);
    }
    if (step.kind === "notes") {
      const planned = require("../notes/plan").planNoteAction(step.text, {});
      if (planned && planned.actionId) {
        try { return actionRegistry.getAction(planned.actionId).level; } catch {}
      }
      return verbFloor(step);
    }
    if (step.kind === "kb") {
      const planned = require("../kb/plan").planKbAction(step.text, {});
      if (planned && planned.actionId) {
        try { return actionRegistry.getAction(planned.actionId).level; } catch {}
      }
      return verbFloor(step);
    }
    // vision: always READ; control: always SENSITIVE (conservative)
    return verbFloor(step);
  } catch (err) {
    log.warn(`[automation] level resolution failed for ${step.kind}: ${err?.message || err}`);
  }
  return verbFloor(step);
}

function annotateLevels(steps) {
  return steps.map((s) => ({ ...s, level: resolveStepLevel(s) }));
}

// ---------------------------------------------------------------------------
// Dispatch helpers — each bridges one existing stage's dispatcher
// ---------------------------------------------------------------------------

function stepLevelName(level) { return riskLabel(level); }

async function runVisionStep(text, deps) {
  const res = await deps.runVisionQuery(text);
  const answer = res && res.ok && res.value ? (res.value.answer || "") : "";
  if (!answer) {
    return { ok: false, text: "I could not read the screen for this automation step." };
  }
  return { ok: true, text: answer };
}

async function runFilesStep(text) {
  try {
    const res = await require("../files/dispatch").runFileAction(text, {});
    return { ok: !!res && res.ok !== false, text: res?.text || res?.report || "" };
  } catch (err) {
    return { ok: false, text: `File step failed: ${err?.message || err}` };
  }
}

async function runNotesStep(text) {
  try {
    const res = await require("../notes/dispatch").runNoteAction(text, {});
    return { ok: !!res && res.ok !== false, text: res?.text || "" };
  } catch (err) {
    return { ok: false, text: `Notes step failed: ${err?.message || err}` };
  }
}

async function runKbStep(text) {
  try {
    const res = await require("../kb/dispatch").runKbAction(text, {});
    return { ok: !!res && res.ok !== false, text: res?.text || "" };
  } catch (err) {
    return { ok: false, text: `Knowledge base step failed: ${err?.message || err}` };
  }
}

async function runControlStep(text) {
  // Control SEQUENCES may never run unattended in an automation — the full
  // execute path requires in-app review in the normal agent loop. Inside an
  // automation this step always pauses for confirmation.
  return { ok: false, paused: true, text: "control step needs your confirmation" };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

async function runAutomation(autoId, deps = {}) {
  const auto = store.get(autoId);
  if (!auto) return { ok: false, error: "Automation not found.", status: "failed" };

  const taskId = `auto-run-${autoId}-${Date.now()}`;
  const steps = annotateLevels(auto.steps);
  const maxLevel = Math.max(...steps.map((s) => s.level));
  const needsConfirmation = maxLevel >= RISK_LEVEL.SENSITIVE;

  actionLog.append({
    actionId: "automation:run",
    level: maxLevel,
    outcome: needsConfirmation ? "dry-run" : "success",
    startedAt: Date.now(),
    taskId,
    detail: { automationId: autoId, name: auto.name, steps: steps.length, gated: needsConfirmation },
  });

  if (needsConfirmation && !deps.confirming) {
    // Pause BEFORE executing anything at L3+ or beyond an L3+ step.
    // Run all L0–2 steps up to (but not including) the first L3+ step so the
    // user still gets the "check" part, then pause for confirmation.
    const results = [];
    for (const step of steps) {
      if (step.level >= RISK_LEVEL.SENSITIVE) break;
      const res = await executeStep(step, deps);
      results.push({ ...step, result: res });
    }
    store.updateRun(autoId, "awaiting-confirmation");
    actionLog.append({
      actionId: "automation:run",
      level: maxLevel,
      outcome: "blocked",
      taskId,
      reason: "awaiting-confirmation",
      detail: { automationId: autoId, name: auto.name, completedSteps: results.length },
    });
    emitter.emit("automation-pending", { id: autoId, name: auto.name, maxLevel, completedSteps: results.length });
    const summary = results.map((r) => r.result?.text || "").filter(Boolean).join(" — ");
    return {
      ok: true, status: "awaiting-confirmation",
      text: summary || `I checked the first ${results.length} step(s) of "${auto.name}" — the rest needs your confirmation before running.`,
      results,
    };
  }

  // Confirming run: execute every step, in order.
  const results = [];
  let status = "success";
  for (const step of steps) {
    const res = await executeStep(step, deps);
    results.push({ ...step, result: res });
    if (!res.ok) {
      if (res.paused) { status = "awaiting-confirmation"; break; }
      status = "partial";
    }
  }
  if (status === "partial" || status === "awaiting-confirmation") {
    store.updateRun(autoId, status, { confirming: true });
  } else {
    store.updateRun(autoId, "success", { confirming: true });
  }
  actionLog.append({
    actionId: "automation:run",
    level: maxLevel,
    outcome: status === "success" ? "success" : "failed",
    startedAt: Date.now(),
    taskId,
    detail: { automationId: autoId, name: auto.name, status, stepsRun: results.length },
  });
  const finalText = buildSummary(auto.name, results);
  return { ok: true, status, text: finalText, results };
}

async function executeStep(step, deps) {
  try {
    if (step.kind === "vision") return await runVisionStep(step.text, deps);
    if (step.kind === "files") return await runFilesStep(step.text);
    if (step.kind === "notes") return await runNotesStep(step.text);
    if (step.kind === "kb") return await runKbStep(step.text);
    if (step.kind === "control") return await runControlStep(step.text);
    return { ok: false, text: `Unknown step kind "${step.kind}".` };
  } catch (err) {
    log.error(`[automation] step "${step.kind}" failed:`, err?.message || err);
    return { ok: false, text: `Step failed: ${err?.message || err}` };
  }
}

function buildSummary(name, results) {
  const texts = results.map((r) => r.result?.text || "").filter(Boolean);
  const fails = results.filter((r) => !r.result?.ok).length;
  const base = texts.length ? texts.join(" · ") : `"${name}" finished with no readable output.`;
  return fails ? `${base} (${fails} step${fails === 1 ? "" : "s"} failed.)` : base;
}

module.exports = {
  runAutomation, resolveStepLevel, annotateLevels, executeStep,
  emitter, on: (ev, fn) => emitter.on(ev, fn),
};
