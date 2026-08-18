// Nova — memory/actions.js (Round 6)
//
// Registers the memory-management actions with the permission framework:
//
//   memory:stats  — Level 1 (SAFE): how many entries, since when, file path
//   memory:clear  — Level 1 (SAFE): wipe the cross-session conversation memory
//
// Both are Level 1 because they only touch Nova's own local memory file —
// they never modify user documents. "Clear" is one-way but the data is
// Nova-generated summaries, not user files; still, the confirmation toast
// names the exact entry count being deleted so it's never silent.

const { registerAction } = require("../permissions/action-registry");
const { RISK_LEVEL } = require("../permissions/risk-levels");
const memory = require("./conversation-memory");

registerAction({
  id: "memory:stats",
  level: RISK_LEVEL.SAFE,
  description: "Show conversation memory stats (entry count, age range, file location)",
  execute: () => ({ ok: true, ...memory.stats() }),
  simulate: () => ({ ok: true, detail: { wouldRead: memory.stats() } }),
});

registerAction({
  id: "memory:clear",
  level: RISK_LEVEL.SAFE,
  description: "Delete all cross-session conversation memory",
  execute: () => {
    const before = memory.list().length;
    memory.clear();
    return { ok: true, detail: { cleared: before } };
  },
  simulate: () => {
    const before = memory.list().length;
    return {
      ok: true,
      detail: { wouldDelete: before },
      text: before
        ? `would delete ${before} memory entr${before === 1 ? "y" : "ies"} (saved conversations from previous sessions)`
        : "would do nothing — conversation memory is already empty",
    };
  },
});
