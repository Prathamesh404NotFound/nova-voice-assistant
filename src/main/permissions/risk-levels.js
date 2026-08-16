// Nova — risk levels (shared enum).
//
// Every tool/action the agent can eventually call MUST declare one of these.
// The permission gate (`gate.js`) reads the level and decides how the action
// is executed: instant (0–1), toast-cancellable (2), modal-confirm (3–4).

const RISK_LEVEL = Object.freeze({
  /**
   * Level 0 — Read: inspect-only.
   * e.g. reading screen content, listing files.
   */
  READ: 0,
  /**
   * Level 1 — Safe: non-modifying everyday actions.
   * e.g. open an app, search files, read a document.
   */
  SAFE: 1,
  /**
   * Level 2 — Reversible: changes the user can undo.
   * e.g. create/move/rename a file, type non-destructive text.
   */
  REVERSIBLE: 2,
  /**
   * Level 3 — Sensitive: actions with external or lasting effect.
   * e.g. send a message, submit a form, modify settings.
   */
  SENSITIVE: 3,
  /**
   * Level 4 — Destructive: hard to undo or dangerous.
   * e.g. delete files, run shell commands, change system/security settings.
   */
  DESTRUCTIVE: 4,
});

/** Human-readable label for a risk level. */
function riskLabel(level) {
  return Object.entries(RISK_LEVEL).find(([, v]) => v === level)?.[0].toLowerCase()
    ?? `unknown(${level})`;
}

/** Plain-language description of how a level is gated (for UI/tooltips). */
function riskSummary(level) {
  switch (level) {
    case RISK_LEVEL.READ: return "read-only — runs immediately";
    case RISK_LEVEL.SAFE: return "safe — runs immediately";
    case RISK_LEVEL.REVERSIBLE: return "reversible — you can cancel within 5 s";
    case RISK_LEVEL.SENSITIVE: return "sensitive — requires your confirmation";
    case RISK_LEVEL.DESTRUCTIVE: return "destructive — requires your confirmation";
    default: return "unknown level";
  }
}

module.exports = { RISK_LEVEL, riskLabel, riskSummary };
