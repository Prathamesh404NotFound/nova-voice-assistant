// Nova — action registry.
//
// Tools register themselves here with:
//   - a unique action id
//   - a risk level (RISK_LEVEL enum)
//   - an execute(payload) function
//   - an optional simulate(payload) function (dry run) — Level 2+ actions
//     MUST provide simulate(); it reports what WOULD happen without doing it.
//
// This module holds no state about permissions — that lives in `gate.js`.

const { RISK_LEVEL } = require("./risk-levels");
const log = require("electron-log");

const registry = new Map(); // id -> { id, level, description, execute, simulate }

function registerAction({ id, level, description, execute, simulate, physical, reverse }) {
  if (typeof id !== "string" || !id.trim()) throw new Error("Action needs a string id");
  if (registry.has(id)) throw new Error(`Action "${id}" already registered`);
  if (![0, 1, 2, 3, 4].includes(level)) {
    throw new Error(`Action "${id}" has invalid risk level ${level}`);
  }
  if (typeof execute !== "function") throw new Error(`Action "${id}" needs an execute function`);
  if (level >= RISK_LEVEL.REVERSIBLE && typeof simulate !== "function") {
    throw new Error(`Level ${level} action "${id}" MUST provide a simulate() dry-run function`);
  }
  // Extra registration metadata (e.g. physical: true for input-simulation
  // actions) is preserved so consumers like the gate can branch on it.
  // `lastResult` remembers the most recent execute() outcome — undo uses it
  // to reverse bulk actions (organize/move/copy) whose reverse() needs the
  // actual moved/copied list, not just the original payload.
  registry.set(id, {
    id, level, description, execute, simulate: simulate || null, physical: !!physical,
    reverse: typeof reverse === "function" ? reverse : null, lastResult: null,
  });
  log.info(`[permissions] registered action "${id}" at level ${level}`);
}

function getAction(id) {
  const action = registry.get(id);
  if (!action) throw new Error(`Unknown action "${id}"`);
  return action;
}

function listActions() {
  return [...registry.values()].map(({ id, level, description }) => ({ id, level, description }));
}

// Round 12: headless tests replace the real screen capture (desktopCapturer)
// with a synthetic source — registered actions must be replaceable.
function unregisterActionForTesting(id) {
  return registry.delete(id);
}
module.exports = { registerAction, getAction, listActions, unregisterActionForTesting };
