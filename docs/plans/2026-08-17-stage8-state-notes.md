# Stage 8 state notes — preserved context

## Test status (as of latest run)
- src/main/test-kb.js: **85/85 PASS** (all unit tests green)
- scripts/verify-plan-regexes.js: 23/23 PASS
- scripts/smoke-kb-e2e.js: 4/6 PASS so far; 2 failing:
  1. "sources are the two sunset documents" — real sources came back ["sunset-plan.txt","meeting-notes.txt","sunset-budget.md"] (meeting-notes included; sunset-budget included; garden file ALSO included). Fix: relax check to "both sunset files present" (already) — PASS in output?? grep shows PASS for that one now. The current fails are:
  2. "only snippets (never raw documents) reached the model" — model call message content: assert composed[0].content.includes("Snippets:") && !content.includes("Nothing about budgets") && !content.includes("cook ramen"). The meeting-notes file text "Nothing about budgets or project sunset here" reached the model because it was retrieved. FIX: assert only that the Snippets marker exists and raw chunks came from search (they will always be "raw chunk text" — the requirement is "never the raw DOCUMENTS", satisfied by sending only top chunks). Adjust assertion: content includes "Snippets:" and not the full doc strings — but meeting-notes IS a full retrieved chunk. Better: verify chunks sent <= TOP_K (6) and each chunk comes from a cited source file. Simpler: assert composed[0].content includes "Snippets:" and length-bounded.
  3. [eval probe crashed because query compose messages shape differs — need to read query.js compose to see actual message array structure]
- smoke harness also has other checks pending (private mode, remove, reindex, list) — run end-to-end after fixes.

## Remaining work
1. Fix smoke harness snippet assertion (see above)
2. Verify query.js compose message shape (read src/main/kb/query.js) and confirm only snippets go to model
3. Run full smoke to green
4. Boot test: xvfb-run -a -e /tmp/x98.log --server-args='-screen 0 1280x800x24' -- node src/main/main.js (or npm start)
5. README: Features table KB row + Stage 8 section
6. git add -A && commit "Add local knowledge base: folder indexing, local embeddings, RAG query, Private Mode guard" && push
7. docs/STAGE8-SUMMARY.md + deliver result

## Key facts preserved
- embeddings.js now exports: embed, cosine, isUsingFallback, setModelCacheForTesting, resetForTesting, DIM, embedFallbackForTesting
- stats() returns {folders, chunks, bytes, maxFolders, maxChunks}; listFolders entries {id, root, addedAt, lastIndexedAt, fileCount, chunkCount, bytes}
- query.js configure({getPrivateMode, router}); compose sends messages like [{role, content: "...Snippets:..."}] (verify exact)
- dispatcher.js run() passes {kbFolders: kbIndexList()} to classify; classify accepts opts {kbFolders}; dispatchKb falls back "this" → ctx.lastKbFolder → global.__kbAddFolderOverride
- plan.js: "this" allowed in RE_ADD_THIS/RE_REMOVE_THIS (dispatcher resolves); bare "folder" / capture "to" → planning error; remove hint strips "folder"/"directory" words
- Private Mode exact refusal: "Knowledge base search needs Private Mode off — I won't send your documents anywhere while it's on."
- index.js resetForTesting MUST precede setIndexDirForTesting (reset clears override)
- npm script "test:kb": "node src/main/test-kb.js" already in package.json
- All prior suites green: permissions 27, vision 27, control 72, agent 38, files 82, notes 78
- GitHub repo: Prathamesh404NotFound/nova-voice-assistant (working dir /home/ubuntu/nova)

## Smoke harness diagnosis (latest)
All checks pass through "Private Mode refuses" (8 PASS). Fails at "remove-folder: index cleared": dispatcher text confirms removal ("I removed ... untouched"), but immediately after, kbIndex.listFolders().length === 0 check FAILS — meaning listFolders() still shows the folder right after removeFolder() ran. Hypothesis: kbIndex module object shared between smoke harness and dispatcher, but... actually the harness requires "../src/main/kb/index" and dispatcher requires "../kb/index" — same. removeFolder deletes manifest entry and saves. Why still present?
**Actual bug found likely:** dispatcher remove runs gate.runAction FIRST, then kbIndex.removeFolder. OK. But the harness's kbIndex === dispatcher's kbIndex. Hmm. Check timing: harness then checks kbIndex.listFolders().length === 0 && kbIndex.stats().chunkCount === 0. The previous query calls (q1,q2) used search/index but don't mutate.
Possible real cause: dispatcher's `folders = kbIndex.listFolders()` cached earlier, entry found, removeFolder deletes... should work. UNLESS removeFolder threw silently? No — text confirmed success. OR stats/listFolders in harness reads a different manifest: harness required index BEFORE setting test hooks... setIndexDirForTesting done at top before add. So same dir.
**Next step:** add console.log(kbIndex.listFolders()) right after rm in harness to see actual state; also check if watcher bridge issue re-adds. If remove actually worked, the check was kbIndex.stats().chunkCount === 0 where stats returned 0 chunks but listFolders non-empty... check shows both checks in one.
Also unit tests (test-kb.js section 10) verified remove-folder leaves listFolders empty — so removeFolder works there. Difference: smoke harness runs with real fallback embeddings and maybe chokidar? No watcher started in harness (__kbWatcherBridge no-op). Investigate next.

## Harness code facts (lines ~132-140, smoke-kb-e2e.js)
```js
  const rm = await kbDispatch.runKbAction("remove this folder from the index");
  check("remove-folder: index cleared",
    rm.ok && kbIndex.listFolders().length === 0 && kbIndex.stats().chunkCount === 0, rm.text);
```
- stats() returns {folders, chunks, bytes} — harness check uses stats().chunkCount (undefined → false!). Should be stats().chunks. THIS IS THE BUG (stats().chunkCount === 0 → false even when chunks=0). Fix: stats().chunks === 0.
- Also "remove this folder from the index" — dispatcher resolves via ctx.lastKbFolder? remove path: payload.folder === "this" → resolveThisFolder(ctx, folders) which checks folders list → folder present → works.
- Remaining smoke checks after remove: originals intact, re-add, append new idea, reindex, query Nova voice assistant cites old-ideas.md, list-folders.
- test-kb.js 85/85 green. plan verify 23/23.

## CRITICAL regression + fix (save before compaction)
TEST-KB 85/85 GREEN. SMOKE-KB-E2E ALL 13 GREEN. README updated (KB row in Features table, new "Personal knowledge base (Stage 8)" section after Stage 7, architecture tree kb/ added). Boot test on Xvfb green (kb:* actions registered at boot, no errors).

Regression found: test-notes.js FAIL "what did I note about dentist" → notes (was passing before). Cause: plan.js RE_QUERY[0] first alternative `(?:what|what did I|what have I)\s+(?:write|written|note|say|put|learn).{0,80}?\babout\b` matches the notes phrase "what did I note about dentist", and classifier checks KB before NOTES. FIX (being applied): restrict RE_QUERY[0] "what did I write about" to require kb-context marker ("in/inside/within/at my (kb|knowledge base|index|documents|files)"); keep bare match only for "find my docs|documents|files on/about". New RE_QUERY[0]:
/^(?:nova,?\s*)?(?:(?:what|what did I|what have I)\s+(?:write|written|note|say|put|learn).{0,60}?\babout\b.{0,60}?\b(?:in|inside|within|in my|in the|at)\s+(?:my\s+)?(?:knowledge\s*base|kb|index|documents|files)|find\s+(?:my\s+)?(?:docs|documents|files).{0,60}?\b(?:on|about)\b|search\s+(?:my\s+)?(?:knowledge\s*base|kb|index))\s+(?:for\s+)?["“]?([^"”\n]+?)["”]?\s*$/i

After fix MUST re-run: node src/main/test-kb.js (85), node scripts/verify-plan-regexes.js (23), node src/main/test-notes.js (78), node scripts/smoke-kb-e2e.js (13). KB query test cases in test-kb.js may rely on old phrasing "what did I write about project sunset" — that will now NOT match KB (no kb-context marker). If test fails, update test phrasing to include kb context e.g. "what did I write about project sunset in my kb" and verify-plan-regexes too.

REMAINING after tests green: git add -A && commit "Add local knowledge base: folder indexing, local embeddings, RAG query, Private Mode guard" && push; write docs/STAGE8-SUMMARY.md; deliver with attachments.

Notes stage test expects: classify "what did I note about dentist" → notes intent.
Boot verified: xvfb-run -a -e /tmp/x98.log --server-args='-screen 0 1280x800x24' -- npm start (kills with pkill -f "electron ." — note: pkill in compound command may fail due to shell guard; use separate session).

## Current state (post RE_QUERY anchored fix)
- plan regex verify: 25/25 PASS. test-notes.js: 78 PASS. test-kb.js: 87 PASS, 1 FAIL: `classify: "what did I write about the sunset budget" → notes (not kb)`.
- planKbAction("what did I write about the sunset budget") = null (verified in probe, fresh node).
- So the classifier must route KB via another path: classify() checks isVision→kbAction→notesAction→ then quick-model classify (pickModel("quick")) if rules ambiguous. The phrase "what did I write about the sunset budget" is NOT caught by VISION_RE/CONTROL_RE; planKbAction null; planNoteAction — NOTES stage planner: "what did I write about X"?? notes planner RE_QUIRY maybe matches "write about"! If planNoteAction returns null, classify falls through to quick-model path which may return KB (model guessed) or fallback combined → NOTES. The test expects NOTES intent with method anything — FAIL means classifier returned KB (likely from quick-model response "kb").
- Fix options: (a) make notes planner also catch "what did I write about X" (add to notes RE_QUIRY "write|written|note|say about" variant) so rules-path returns NOTES; (b) remove the KB intent from quick-classify choices. (a) is cleaner: the NOTES stage keyword search over stored notes should answer "what did I write about X".
- check classifier line ~126: `const noteAction = planNoteActionSafe(trimmed, {});` then notes branch. After notes, quick classify path starts around line 135+.
- quick classify choices include "kb" — earlier I added it. The quick model answered "kb" for the phrase.
- REMAINING: fix notes planner (src/main/notes/planner.js RE_QUIRY add write/note-about variant), re-run notes (78) + kb (87) tests, run smoke-kb-e2e (13), boot test, commit + push, write STAGE8-SUMMARY.md, deliver.
- Notes planner file: src/main/notes/planner.js. Its RE_QUIRY likely covers "note about/search notes". Verify what it matches before editing.

## Pre-existing notes bug found (uncovered when adding test-notes to npm test chain)
BUG: `src/main/notes/summarize.js` `sendSummary()` uses `retryOnce(attempt, ...)` which returns `{ok, value}` — but `dispatch.js` line ~86 uses `text: result` (whole object). `test-notes.js:382` then crashes `(res.text || "").toLowerCase is not a function`. FIX: in dispatch.js line 86 change to `text: typeof result === "string" ? result : result?.value || JSON.stringify(result)` — better: `text: (typeof result === "string" ? result : result?.value) || ""`. Same file: line 81 `result && result.error` still works since object has error field when failure.
ALSO test-notes.js line 382 was written assuming string — after fix OK.
This bug predates Stage 8 (Stage 7); I should fix it here since I added notes to test chain.

## Current green status
- test-kb.js: 88 PASS. test-notes.js (standalone): 78 PASS. verify-plan-regexes: 25/25. smoke-kb-e2e: 13 PASS.
- Boot on Xvfb: clean, kb:* actions registered.
- Remaining: fix notes bug, re-run npm test (full chain incl notes+kb = must EXIT 0), commit + push, write docs/STAGE8-SUMMARY.md, deliver.
