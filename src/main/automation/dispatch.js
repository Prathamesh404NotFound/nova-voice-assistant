// Nova — automation/dispatch.js (Stage 9)
//
// End-to-end automation dispatcher:
//   addAutomation(text, opts)    — parse → validate → store → schedule next-run
//   listAutomations()            — current store + computed next-run times
//   toggleAutomation(id, on)
//   deleteAutomation(id)         — Level 1: only removes the schedule
//   runAutomationNow(id, opts)   — "run now" test button / in-app confirm
//   confirmAutomation(id)        — approve a pending L3+ run
//
// Creation through the permission gate: adding an automation is Level 1
// (it only creates a schedule), deleting is Level 1 (same).

const log = require("electron-log");
const { RISK_LEVEL } = require("../permissions/risk-levels");
const gate = require("../permissions/gate");
const actionLog = require("../permissions/action-log");
const { parseAutomation } = require("./parser");
const { annotateLevels } = require("./runner");
const store = require("./store");
const cron = require("./cron");

async function scheduleNextRuns() {
  const t = new Date();
  for (const auto of store.list()) {
    try {
      const next = cron.nextMatch(cron.parse(auto.cron), t);
      store.setNextRun(auto.id, next);
    } catch (err) {
      log.warn(`[automation] next-run for "${auto.name}" failed:`, err?.message || err);
    }
  }
}

async function addAutomation(text, opts = {}) {
  const parsed = parseAutomation(text, { name: opts.name });
  if (!parsed.ok) {
    actionLog.append({ actionId: "automation:add", level: RISK_LEVEL.SAFE, outcome: "failed", reason: parsed.error });
    return { ok: false, text: parsed.error };
  }
  // Resolve real per-step levels so the store/status reflects each stage's
  // own action registry — the automation can never downgrade risk.
  parsed.automation.steps = annotateLevels(parsed.automation.steps);
  const res = store.add(parsed.automation);
  if (!res.ok) {
    actionLog.append({ actionId: "automation:add", level: RISK_LEVEL.SAFE, outcome: "failed", reason: res.error });
    return { ok: false, text: res.error };
  }
  const auto = res.automation;
  scheduleNextRuns();
  actionLog.append({
    actionId: "automation:add", level: RISK_LEVEL.SAFE, outcome: "success",
    detail: { automationId: auto.id, name: auto.name, steps: auto.steps.length, status: auto.status },
  });
  const gating = auto.status === "needs-confirmation"
    ? " It will ask for your confirmation before running sensitive steps."
    : "";
  return {
    ok: true, intent: "automation",
    text: `Saved "${auto.name}" — running ${auto.status === "safe" ? "unattended" : "with confirmation"} on its schedule (cron ${auto.cron}) every time it fires.${gating}`,
    detail: { automationId: auto.id, name: auto.name, cron: auto.cron, status: auto.status, steps: auto.steps },
  };
}

function listAutomations() {
  const t = new Date();
  return store.list().map((auto) => {
    let nextRunAt = null;
    try { nextRunAt = cron.nextMatch(cron.parse(auto.cron), t)?.toISOString() || null; } catch {}
    return { ...auto, nextRunAt };
  });
}

async function toggleAutomation(id, enabled) {
  const res = store.toggle(id, enabled);
  if (!res.ok) return { ok: false, text: res.error };
  actionLog.append({ actionId: "automation:toggle", level: RISK_LEVEL.SAFE, outcome: "success", detail: { automationId: id, enabled } });
  if (enabled) scheduleNextRuns();
  return { ok: true, text: enabled ? "Automation enabled." : "Automation paused.", automation: res.automation };
}

async function deleteAutomation(id) {
  // Level 1 (SAFE): only removes the schedule; nothing past is affected.
  const res = store.remove(id);
  if (!res.ok) return { ok: false, text: res.error };
  actionLog.append({ actionId: "automation:delete", level: RISK_LEVEL.SAFE, outcome: "success", detail: { automationId: id, name: res.removed?.name } });
  return { ok: true, text: `Removed "${res.removed.name}" from the schedule.`, automation: res.removed };
}

async function runAutomationNow(id, opts = {}) {
  const auto = store.get(id);
  if (!auto) return { ok: false, text: "Automation not found." };
  const { runAutomation } = require("./runner");
  const result = await runAutomation(id, { ...opts, runVisionQuery: opts.runVisionQuery || null });
  return {
    ok: result.ok,
    text: result.text || (result.error ? `Automation failed: ${result.error}` : "Done."),
    detail: { ...result },
  };
}

async function confirmAutomation(id) {
  const auto = store.get(id);
  if (!auto) return { ok: false, text: "Automation not found." };
  if (!auto.pendingConfirmation) {
    return { ok: false, text: "Nothing is waiting for confirmation on this automation." };
  }
  const { runAutomation } = require("./runner");
  const result = await runAutomation(id, { confirming: true, runVisionQuery: null });
  return {
    ok: result.ok,
    text: result.text || "Confirmed and finished.",
    detail: { ...result },
  };
}

module.exports = {
  addAutomation, listAutomations, toggleAutomation, deleteAutomation,
  runAutomationNow, confirmAutomation, scheduleNextRuns,
};
