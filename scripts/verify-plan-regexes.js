// Quick one-off regex verification for kb/plan.js (used during Stage 8 wiring;
// the real suite lives in src/main/test-kb.js). Run: node scripts/verify-plan-regexes.js
const path = require("path");
const Module = require("module");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = (req, parent, isMain, opts) => {
  if (req === "electron") return path.join(__dirname, "..", "shim-electron.js");
  return originalResolveFilename(req, parent, isMain, opts);
};
const { planKbAction } = require(path.join(__dirname, "..", "src", "main", "kb", "plan"));

// Error cases return { error } instead of { actionId, payload }.
const ERROR_CASES = [
  "remove the docs folder from the index",
  "remove the docs folder from my index",
  "delete sunset from my knowledge base",
  "remove docs folder from the index",
  "remove the sunset folder from the kb",
  "unindex projects from the kb",
  "add folder to my kb", // no named folder → planner error
];

const CASES = [
  // [input, expected actionId or null, expected key fragment]
  ["add /home/docs to my kb", "kb:add-folder", "/home/docs"],
  ["add the docs folder to my kb", "kb:add-folder", "docs"],
  ["add my notes folder to the index", "kb:add-folder", "notes"],
  ["add sunset to the kb", "kb:add-folder", "sunset"],
  ["add /home/x/folder to the index", "kb:add-folder", "/home/x/folder"],
  ["add projects folder to my kb", "kb:add-folder", "projects"],
  ["include /home/a/b to my knowledge base", "kb:add-folder", "/home/a/b"],
  ["re-index my knowledge base now", "kb:reindex", null],
  ["list my indexed folders", "kb:list-folders", null],
  ["what did I write about project sunset in my kb", "kb:query", "project sunset"],
  ["find my documents on quantum physics", "kb:query", "quantum physics"],
  ["search my kb for relativity", "kb:query", "relativity"],
  ["I need to find a new job", null, null], // should NOT route to KB
  ["remind me to call mom tomorrow", null, null],
  // bare "what did I note/write about X" belongs to the NOTES stage (no kb context)
  ["what did I note about the dentist", null, null],
  ["what did I write about the sunset budget", null, null],
  // "this" is a valid plan payload — the dispatcher resolves it from context
  ["add this folder to my knowledge base", "kb:add-folder", "this"],
  ["remove this folder from the index", "kb:remove-folder", "this"],
];

let pass = 0;
for (const [input, wantId, wantKey] of CASES) {
  const r = planKbAction(input);
  const gotId = r ? r.actionId : null;
  const gotKey = r ? (r.payload.folder || r.payload.question || null) : null;
  const ok = gotId === wantId && (wantKey === null ? true : gotKey === wantKey);
  console.log(`${ok ? "OK " : "FAIL"} ${JSON.stringify(gotId + (gotKey ? "/" + gotKey : ""))} expected ${wantId}${wantKey ? "/" + wantKey : ""} :: ${input}`);
  if (ok) pass++;
}
for (const input of ERROR_CASES) {
  const r = planKbAction(input);
  const isErr = r && r.error && !r.actionId;
  console.log(`${isErr ? "OK " : "FAIL"} {error} :: ${input} → ${JSON.stringify(r)}`);
  if (isErr) pass++;
}
console.log(`PASS ${pass}/${CASES.length + ERROR_CASES.length}`);
process.exit(pass === CASES.length + ERROR_CASES.length ? 0 : 1);
