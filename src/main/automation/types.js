// Nova — automation/types.js (Stage 9)
//
// Step-kind registry for the automation engine. Each kind maps to an
// EXISTING dispatcher (vision / control / files / notes / kb) — no new
// capabilities are added, only scheduling and chaining.
//
// `fixedLevel` is the risk level used when the kind has a single, known
// level (vision, notes, kb actions run through their own dispatchers, whose
// action registrations already carry levels — the fixed values here are the
// most common case, see runner.js which resolves per-step levels from the
// real registry when it can). Control steps are always treated as
// SENSITIVE so any automation containing one must be user-confirmed.
const { RISK_LEVEL } = require("../permissions/risk-levels");

const STEP_KINDS = Object.freeze({
  VISION: "vision",
  CONTROL: "control",
  FILES: "files",
  NOTES: "notes",
  KB: "kb",
});

const KIND_INFO = Object.freeze({
  [STEP_KINDS.VISION]: { label: "screen vision", defaultLevel: RISK_LEVEL.READ },
  [STEP_KINDS.CONTROL]: { label: "mouse/keyboard control", defaultLevel: RISK_LEVEL.SENSITIVE },
  [STEP_KINDS.FILES]: { label: "file management", defaultLevel: RISK_LEVEL.READ },
  [STEP_KINDS.NOTES]: { label: "notes & reminders", defaultLevel: RISK_LEVEL.SAFE },
  [STEP_KINDS.KB]: { label: "knowledge base", defaultLevel: RISK_LEVEL.SAFE },
});

const LEVEL_STATUS = Object.freeze({
  [RISK_LEVEL.READ]: "safe",
  [RISK_LEVEL.SAFE]: "safe",
  [RISK_LEVEL.REVERSIBLE]: "safe",
  [RISK_LEVEL.SENSITIVE]: "needs-confirmation",
  [RISK_LEVEL.DESTRUCTIVE]: "needs-confirmation",
});

const MAX_STEPS = 10;

module.exports = { STEP_KINDS, KIND_INFO, LEVEL_STATUS, MAX_STEPS };
