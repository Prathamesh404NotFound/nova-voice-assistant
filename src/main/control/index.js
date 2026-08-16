// Nova — control/index.js
//
// Entry point for the Stage 4 mouse & keyboard control feature. It registers
// every control primitive with the permission framework (so the gate decides
// immediate / toast / modal per risk level) and re-exports the planner,
// runner, kill-switch and verification surfaces used by main.js IPC.

const { registerControlActions } = require("./input");
const { compilePlan } = require("./planner");
const { runSequence } = require("./runner");
const { sequence } = require("./kill-switch");
const { verifyWindow } = require("./verify");

function init() {
  registerControlActions();
}

module.exports = {
  init,
  compilePlan,
  runSequence,
  sequence,
  verifyWindow,
};
