// Nova — control/runner.js
//
// Executes a user-confirmed control plan one step at a time, driving the
// visible progress checklist in the renderer. Key properties:
//   - Every step first checks the kill-switch (abort wins, always).
//   - Each step runs through the permission gate (L2 toast / L3 modal).
//   - After click/wait steps, an optional vision check verifies the expected
//     label is on screen before the next step proceeds (Stage 4 req 5).
//   - A failed or aborted step halts the sequence; remaining steps are logged
//     as cancelled so the action log stays truthful.

const log = require("electron-log");
const { runAction } = require("../permissions/gate");
const { sequence, SequenceAbortedError } = require("./kill-switch");
const { getEngine } = require("./input");
const { recognizeText } = require("../vision/ocr");
const { captureScreen } = require("../vision/screenshot");
const { detectUIElements } = require("../vision/ui-detector");

/**
 * Execute a confirmed plan. Fires progress events on the sequence emitter.
 * @param {{ id?: string, plan: PlanStep[] }} opts
 * @returns {{ finished: "done"|"aborted"|"failed", failedStepId?: string }}
 */
async function runSequence({ plan }) {
  const maxSteps = 20; // hard ceiling — sequences never grow unbounded

  if (!Array.isArray(plan) || !plan.length) {
    return { finished: "failed", failedStepId: null };
  }

  for (let i = 0; i < Math.min(plan.length, maxSteps); i++) {
    const step = plan[i];

    sequence.emit({ type: "step", stepId: step.id, status: "running", note: "" });

    let outcome;
    try {
      // Kill-switch check BEFORE anything else — inside the try/catch so a
      // mid-sequence abort (hotkey / STOP / barge-in) reports cleanly instead
      // of crashing the runner.
      sequence.guardStep(step.id);

      // Resolve click coordinates from the screen if a label was given.
      const payload = { ...step.payload };
      if ((step.actionId === "control:left-click" || step.actionId === "control:right-click" || step.actionId === "control:double-click") && payload.label && (!payload.x || !payload.y)) {
        const coords = await locateOnScreen(payload.label);
        if (!coords) {
          sequence.emit({ type: "step", stepId: step.id, status: "failed", note: `could not locate "${payload.label}" on the current screen` });
          return finishSequence(plan, i + 1, "failed", step.id);
        }
        payload.x = coords.x;
        payload.y = coords.y;
      }

      outcome = await runAction(step.actionId, payload);
    } catch (err) {
      if (err instanceof SequenceAbortedError) return finishSequence(plan, i, "aborted", step.id);
      log.error(`[control] step "${step.id}" errored:`, err?.message || err);
      sequence.emit({ type: "step", stepId: step.id, status: "failed", note: String(err?.message || err).slice(0, 200) });
      return finishSequence(plan, i + 1, "failed", step.id);
    }

    if (outcome.outcome === "cancelled") {
      sequence.emit({ type: "step", stepId: step.id, status: "failed", note: "you cancelled this step" });
      return finishSequence(plan, i + 1, "failed", step.id);
    }
    if (outcome.outcome === "blocked") {
      sequence.emit({ type: "step", stepId: step.id, status: "failed", note: "blocked by Private Mode" });
      return finishSequence(plan, i + 1, "failed", step.id);
    }
    if (outcome.outcome === "failed") {
      sequence.emit({ type: "step", stepId: step.id, status: "failed", note: (outcome.detail?.error || "the step failed").slice(0, 200) });
      return finishSequence(plan, i + 1, "failed", step.id);
    }

    // Post-step vision verification when requested.
    // Verification spec lives on step.payload.verify (set by the planner); a
    // top-level step.verify is also accepted for compatibility.
    const verifySpec = step.payload?.verify || step.verify;
    if (verifySpec?.contains) {
      const { verifyWindow } = require("./verify");
      const v = await verifyWindow({ contains: verifySpec.contains, waitMs: 3000 });
      if (!v.ok) {
        sequence.emit({ type: "step", stepId: step.id, status: "failed", note: `verification failed: ${v.note}` });
        return finishSequence(plan, i + 1, "failed", step.id);
      }
      sequence.emit({ type: "step", stepId: step.id, status: "verified", note: v.note });
    } else {
      sequence.emit({ type: "step", stepId: step.id, status: "done", note: "" });
    }
  }

  sequence.finish();
  return { finished: "done" };
}

function finishSequence(plan, fromIndex, finished, failedStepId) {
  for (let i = fromIndex; i < plan.length; i++) {
    sequence.emit({ type: "step", stepId: plan[i].id, status: finished === "aborted" ? "aborted" : "cancelled", note: finished === "aborted" ? "stopped by the kill-switch" : "sequence halted" });
  }
  sequence.finish();
  return { finished, failedStepId };
}

/**
 * Locate a text label on the current screen via capture + OCR + UI detection.
 * @returns {{ x, y } | null}
 */
async function locateOnScreen(label) {
  try {
    const shot = await captureScreen();
    if (!shot?.buffer) return null;
    const ocr = await recognizeText(shot.buffer);
    const needle = label.toLowerCase();
    const word = (ocr.words || []).find((w) => (w.text || "").toLowerCase() === needle || (w.text || "").toLowerCase().includes(needle));
    if (word?.bbox) {
      const { x0, x1, y0, y1 } = word.bbox;
      return { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) };
    }
    // Fall back to UI-element phrases (buttons).
    const ui = await detectUIElements(ocr.words || []);
    const btn = (ui.buttons || []).find((b) => (b.label || "").toLowerCase() === needle);
    if (btn?.bbox) {
      const { x0, x1, y0, y1 } = btn.bbox;
      return { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) };
    }
    return null;
  } catch (err) {
    log.error("[control] locateOnScreen failed:", err?.message || err);
    return null;
  }
}

module.exports = { runSequence, locateOnScreen };
