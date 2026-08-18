// Nova — Round 15 command palette smart-ranking tests.
// palette-ranking.js is a renderer IIFE (window.NovaPaletteRanking) using only
// localStorage + window. We shim those, load the module source via
// new Function, and exercise scoring math, recency decay, cap pruning,
// persistence, and the catalog re-sort. No Electron needed.
const fs = require("fs");
const path = require("path");

const fakeStore = {};
global.window = global;
global.localStorage = {
  getItem: (k) => (k in fakeStore ? fakeStore[k] : null),
  setItem: (k, v) => { fakeStore[k] = String(v); },
  removeItem: (k) => { delete fakeStore[k]; },
};

// Load module source with its own (global) window.
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "js", "palette-ranking.js"), "utf8");
new Function("window", src)(global);
const R = window.NovaPaletteRanking;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}: ${err.message}`); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "not equal"} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}
function approx(a, b, msg, eps = 1e-9) {
  if (Math.abs(a - b) > eps) throw new Error(`${msg || "not approx equal"} — got ${a}, expected ${b}`);
}
const DAY = 86_400_000;
const now = 1_000_000_000_000; // fixed clock

console.log("Command palette smart-ranking tests");
R.resetForTesting();

// 1. Never-run item scores zero — no fake popularity.
check("never-run item scores 0", () => eq(R.scoreItem({ id: "x", label: "never" }, now), 0, "never-run"));

// 2. One run = sqrt(1) + 1 (recency at zero age is max).
check("single fresh run = sqrt(1)+1", () => {
  R.recordRun("fresh-item", { now });
  approx(R.scoreItem({ id: "fresh-item" }, now), Math.sqrt(1) + 1, "single fresh");
});

// 3. Recency halves every 24h but never below the floor.
check("recency halves daily, floors at MIN_RECENCY", () => {
  R.resetForTesting();
  R.recordRun("old-item", { now: now - 7 * DAY });
  // 7 half-lives (2^-7 ≈ 0.0078) is below the recency floor (0.05), so the
  // floor wins.
  const expectedRecency = Math.max(R.MIN_RECENCY, Math.pow(0.5, 7));
  const s = R.scoreItem({ id: "old-item" }, now);
  approx(s, Math.sqrt(1) + expectedRecency, "7-day score");
  // Extreme age (30 days) stays at or above the floor.
  R.resetForTesting();
  R.recordRun("ancient", { now: now - 30 * DAY });
  const s30 = R.scoreItem({ id: "ancient" }, now);
  eq(s30 >= Math.sqrt(1) + R.MIN_RECENCY, true, "30-day score keeps the floor");
  approx(s30, Math.sqrt(1) + R.MIN_RECENCY, "30-day recency == floor", 1e-9);
});

// 4. Frequency scales with sqrt — 4 runs ≈ 2× the run bonus of 1 run.
check("frequency uses sqrt — 4 runs ≈ 2× bonus of 1", () => {
  R.resetForTesting();
  for (let i = 0; i < 4; i++) R.recordRun("busy", { now });
  // fresh run bonus unchanged (lastRun just moved); compare bonus part only.
  const s1 = R.scoreEntry({ runs: 1, lastRun: now, now });
  const s4 = R.scoreEntry({ runs: 4, lastRun: now, now });
  // score = sqrt(runs) + 1 → s1=2, s4=3; the run bonus (sqrt) doubled.
  eq(s1, 2, "1 run score");
  eq(s4, 3, "4 runs score");
});

// 5. More recent identical items rank higher.
check("recent identical item ranks above older", () => {
  R.resetForTesting();
  R.recordRun("old-same", { now: now - DAY });
  R.recordRun("new-same", { now });
  const items = [{ id: "old-same" }, { id: "new-same" }];
  const sorted = R.scoreItems(items, "", { now });
  eq(sorted[0].id, "new-same", "newer first");
});

// 6. Items with NO history keep their original order (ranking never hides/reorders them against each other).
check("unranked items keep original order", () => {
  R.resetForTesting();
  R.recordRun("ranked-one", { now });
  const items = [
    { id: "alpha", label: "alpha" },
    { id: "ranked-one" },
    { id: "beta", label: "beta" },
  ];
  const sorted = R.scoreItems(items, "", { now });
  eq(sorted[0].id, "ranked-one", "ranked first");
  eq(sorted[1].id, "alpha", "alpha before beta preserved");
  eq(sorted[2].id, "beta", "beta last preserved");
});

// 7. Cap prunes oldest-by-lastRun.
check("cap prunes oldest entries", () => {
  R.resetForTesting();
  for (let i = 0; i < 6; i++) R.recordRun(`item${i}`, { now: now + i * 1000, cap: 5 });
  const entries = R.load();
  eq(Object.keys(entries).length, 5, "5 entries kept");
  eq(entries["item0"] ? "pruned item0" : "item0 pruned", "item0 pruned", "oldest pruned");
  eq(entries["item5"].runs, 1, "newest kept");
});

// 8. Duplicate key increments runs, doesn't create a second entry.
check("repeat runs increment the same entry", () => {
  R.resetForTesting();
  R.recordRun("k", { now });
  R.recordRun("k", { now });
  const e = R.getEntry("k", now);
  eq(e.runs, 2, "runs=2");
  eq(Object.keys(R.load()).length, 1, "one entry");
});

// 9. Persistence survives re-require — storage is the source of truth.
check("usage persists to localStorage and reloads", () => {
  R.resetForTesting();
  R.recordRun("persist-me", { now });
  const src2 = fs.readFileSync(path.join(__dirname, "..", "renderer", "js", "palette-ranking.js"), "utf8");
  new Function("window", src2)(global); // fresh module, same storage
  const e = window.NovaPaletteRanking.getEntry("persist-me", now);
  eq(e.runs, 1, "reload sees the run");
});

// 10. Garbage input is tolerated (ranking must never break the launcher).
check("empty/bad keys are no-ops", () => {
  R.resetForTesting();
  R.recordRun("", { now });
  R.recordRun(null, { now });
  R.recordRun(undefined, { now });
  eq(Object.keys(R.load()).length, 0, "no garbage entries");
});

// 11. scoreItems survives non-array input.
check("scoreItems rejects bad input gracefully", () => {
  eq(R.scoreItems(null, "").length, 0, "null");
  eq(R.scoreItems("oops", "").length, 0, "string");
});

// 12. Ranking + palette integration surface check (palette-setup exposes applyRanking via the setup module's public API is renderer-only — verify the ranking API contract the palette relies on exists).
check("ranking API exposes everything the palette needs", () => {
  eq(typeof R.recordRun === "function", true, "recordRun fn");
  eq(typeof R.scoreItems === "function", true, "scoreItems fn");
  eq(typeof R.resetForTesting === "function", true, "resetForTesting fn");
  eq(R.STORAGE_KEY, "nova-palette-usage", "storage key");
});

console.log(`\n${passed} palette-ranking test(s) passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
