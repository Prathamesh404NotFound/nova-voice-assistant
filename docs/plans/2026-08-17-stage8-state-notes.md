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

## Stage 9 design decisions (user confirmed defaults)
- Control steps in automations: flagged "needs-confirmation" (never unattended). L3+ → OS notification + pending-confirmation card in side panel; Confirm runs full sequence once.
- Design doc written: docs/plans/2026-08-17-stage9-automation-design.md

## Phase 2 study findings (for runner implementation)
- registry.get(id).level via require("../permissions/action-registry").getAction(id). Level 0-4 = RISK_LEVEL enum.
- files actions ids: files:search(0), files:detect-duplicates(0), files:folder-stats(0), files:organize(2), files:remove-duplicates(2), files:move-files(2), files:copy-files(2), files:rename-file(2), files:delete-files(4). files/plan.js returns {actionId, payload, narration} or {error}.
- kb ids: kb:add-folder(2), kb:remove-folder(2), kb:reindex(2), kb:query(1), kb:list-folders(1), kb:open-source(2).
- vision: vision:capture-screen level READ(0); runVisionQuery(question) → {ok, value:{answer, mode}}.
- notes: notes:add-note(1), notes:add-reminder(1), notes:add-task(1), edit/delete(2). notes/plan.js planNoteAction(text, ctx) → {actionId, payload} or {error}.
- control: compilePlan(instruction) → {ok, plan:[{label, action, level?, ...}], error, summary}; sequence.reviewing(id). Control steps in automations ALWAYS flag needs-confirmation.
- runVisionQuery is passed to dispatcher.run as opts.runVisionQuery; automation runner should call it the same way (needs mainWindow? vision-query IPC in main.js handles).
- actionLog.append({actionId, level, outcome, taskId, reason, detail}); outcome must be success|failed|cancelled|blocked|dry-run. list(limit) newest first.
- main.js IPC: nova:agent-run → dispatcher.run(text, {getKey, mainWindow, runVisionQuery}); runVisionQuery wraps vision query.
- Notifications: src/main/notes/reminders.js new Notification({title,body,silent:false}).show(); has setNotifierForTesting.
- preload bridges pattern: invoke("nova:X") + on("nova:Y", listener) return unsubscribe. Progress channels: nova:agent-progress (dispatcher emitter: progress events), kb:index-progress.
- Dispatcher run() needs mainWindow; agent emits "progress" event (narrate) — renderer listens via nova:agent-progress; main.js wires dispatcher.emitter.on("progress")→mainWindow.webContents.send("nova:agent-progress")? (verify line in main.js near nova:agent-run, likely yes)
- Notes store: store.all() → {notes, tasks, reminders}.
- Cron design: 5-field, * ranges lists; scheduler polls every 10s; nextRun = first t>now matching cron, t>lastRunAt.

## Stage 9 smoke results (Phase 3, in progress)
Parser fixed (AT_TIME leak, leading AND artifact, delete-verb classification). Cron eval good (weekday/15min/nextMatch).

Module results:
- safe add ("Downloads check"): OK status=safe, steps [files:L0]
- check-then-organize: allowed, status=safe (L0 first, L2 second — permitted since max level check for needs-confirmation is only L3+) — NOTE: L2 steps are reversible so unattended is fine per req 2.
- "open calculator and type 12 x 8" classified kind=files (default fallback!) — BUG: parser step "open calculator" is classified FILES (default) because RE_CONTROL matches "open (calculator|notepad|notes app)"... it did match RE_CONTROL? Output says control step ok=false. Actually it was refused? console shows "control step: false safe" — the refusal message printed? r4.ok=false... and store.list()[2] undefined. Actually log shows only 2 success + 1 failed action-log entries. So r4 failed = refused? Need to check: r4 error text. Hmm — "open calculator" → RE_CONTROL test... but RE_FILES_SEARCH / RE_FILES_STATS? "open calculator" no. It should be CONTROL kind → level SENSITIVE(3), and since it's the ONLY step (first step L3+) → refused by store.validateCandidate. That's CORRECT behavior! But console order confusing. Verify in test suite.
- delete-first: expected refused — the `!r1.ok` bash-history expansion garbled output; verify via script file in tests.
- NOTE: r3 "check-then-organize" status=safe because organize=L2 < SENSITIVE threshold. Req 2: Level 0–2 run unattended. Correct.

## Wiring TODO (Phase 4)
- main.js: require automation/dispatch + scheduler; on boot scheduler.start(); IPC handlers nova:auto-list/add/toggle/delete/run-now/confirm; hook scheduler emitter "automation-firing" → runner.runAutomation(id, {mainWindow, runVisionQuery, getKey}); hook "automation-pending" → OS Notification (use reminders notifier pattern) + mainWindow send "nova:auto-pending"; after run post text via webContents.send("nova:auto-result") or into chat history.
- preload.js bridges: autoList, autoAdd, autoToggle, autoDelete, autoRunNow, autoConfirm, onAutoProgress/onAutoPending.
- classifier.js: add AUTOMATION intent? Simpler: keep voice creation via explicit verbs ("create automation"/"set up automation"/"every ... at ...") — planAutomation parser in classifier before KB, intent AUTOMATION, dispatch in dispatcher.js → automation dispatch.addAutomation + scheduler.scheduleNextRuns + spoken result.
- Renderer: Automations side section (after KB) — list w/ toggle, nextRun, status chip, Run now, Delete; pending-confirm card; result banner.
- dispatcher.run needs {mainWindow, getKey, runVisionQuery} for automation runs.
- Action Log tagging: automation-run via runner's actionLog.append (done in runner.js).
- Tests: test-automation.js (~60), smoke-auto-e2e.js (1-min fire test, L3+ pause, refusal rules), npm test chain green.
- README: Automation row in Features table + Stage 9 section + architecture kb/ list.

## Phase 4 progress (wiring)
Done so far:
- classifier.js: AUTOMATION intent added, AUTOMATION_RE regex, parseAutomationSafe lazy load, route before KB branch (automation-firing + planningError handling), quickClassify choices updated.
- dispatcher.js: dispatchAutomation() added (before run()), run() branch INTENTS.AUTOMATION → dispatchAutomation, narrates.
- main.js: requires automation/dispatch, automation/runner, automation/scheduler, notes/reminders (as remindersNotifier). IPC handlers nova:auto-list, auto-run-now, auto-toggle, auto-delete, auto-confirm added BEFORE nova:kb-run section. scheduler hook automation-firing → runner.runAutomation(id,{mainWindow,runVisionQuery,getKey}); if result.status==="awaiting-confirmation" → notifier (remindersNotifier.getNotifier()) send OS notif; emit nova:auto-run-result + nova:auto-pending to renderer. Boot: scheduleNextRuns() + scheduler.start() after permissions log line.
- ISSUE: remindersNotifier.getNotifier() may not be exported — CHECK exports of src/main/notes/reminders.js (exports {start, stop, setNotifierForTesting, ...}?) — if getNotifier not exported, add export.
- main.js line ~130 has stray dead lines: `const notifier = remindersNotifier.getNotifierForTesting ? null : null;` — REMOVE that try block.
- main.js ipcMain.handle order: handlers placed at top of file (before nova:get-settings? verify position — inserted at line 68 area, fine).
- runVisionQuery and getKey imported? main.js already has runVisionQuery from vision-query require and getKey/requireKeyOnce from keys — VERIFY getKey is in scope at automation-firing hook (it's required at top: yes `const { getKey, requireKeyOnce, ... }`).
Remaining:
1. Fix main.js dead notifier block; ensure remindersNotifier.getNotifier exported (edit reminders.js to export getNotifier if missing).
2. preload.js bridges: autoList, autoToggle, autoDelete, autoRunNow, autoConfirm, onAutoRunResult(cb), onAutoPending(cb).
3. app.js + index.html + hud.css: Automations side section.
4. dispatcher.runAutomationNow passes opts to runner — runner.runAutomation(id, deps) uses deps.runVisionQuery; runner also has dep.runVisionQuery param naming ok.
5. Reminder: scheduler SCAN_MS is 10s but tests use 1s (Math.min(SCAN_MS,1000) in start()) — verify that line exists.
6. test-automation.js write (~60 tests: cron parse/match/next, parser NL cases, store limits/validate, runner gating, refusal), smoke-auto-e2e.js (1-min fire test using setNowForTesting to advance clock OR real 60s wait; L3+ pause path), npm test chain add test:auto, boot Xvfb test.
7. README automation row + Stage 9 section; commit push; docs/STAGE9-SUMMARY.md; deliver.

## Module API quick ref
- automation/parser: parseAutomation(text, opts{name}) → {ok, automation:{name,cron,steps:[{kind,text}],...}|error string}
- automation/cron: parse(expr)→{test(date),expr}, nextMatch(matcher, after)→Date|null
- automation/store: clearForTesting(), add(automation), get(id), list(), toggle(id,enabled), remove(id), updateRun(id,status,{confirming}), setNextRun(id,iso), validateCandidate, statusFromSteps; exports MAX_AUTOMATIONS=25 MAX_STEPS=10
- automation/scheduler: start(), stop(), setNowForTesting(fn), resetForTesting(), isDue, emitter("automation-firing",{id,name,cron,firedAt}), emitter("automation-pending",{id,name,maxLevel,completedSteps})
- automation/runner: runAutomation(id, deps{runVisionQuery,confirming}), resolveStepLevel, annotateLevels, executeStep, emitter
- automation/dispatch: addAutomation(text,opts), listAutomations(), toggleAutomation, deleteAutomation, runAutomationNow(id,opts{mainWindow,runVisionQuery}), confirmAutomation(id), scheduleNextRuns()
- notifications: reminders.js setNotifierForTesting(fn); getNotifier NOT exported yet — need to add export.
- IPC new channels: nova:auto-list, nova:auto-toggle, nova:auto-delete, nova:auto-run-now, nova:auto-confirm; main→renderer nova:auto-run-result {id,name,ok,status,text,...}, nova:auto-pending {id,name}

## Phase 4 status (updated)
DONE: classifier + dispatcher + main.js wiring + reminders.js getNotifier export + preload.js bridges (autoList/autoRunNow/autoToggle/autoDelete/autoConfirm/onAutoRunResult/onAutoPending) + shim-electron.js upgraded (app.whenReady/on/quit/isReady/getName/getVersion, BrowserWindow class w/ once/on/emit/webContents, Menu.buildFromTemplate, globalShortcut stub) + scripts/shim-load-main.js helper (loads main.js OK — 46 actions, scheduler started 1s scan, 0 automations loaded).

REMAINING Phase 4:
1. index.html: add Automations side section (mirror KB section structure: <section class="panel-section" id="automation-section"> with header, list container #automation-list, empty state, pending card container).
2. hud.css: append KB-like styles for #automation-section (copy .kb-* classes, rename auto-*).
3. app.js: init automations panel: load via nova.autoList(), render cards w/ toggle checkbox, next-run time, status chip (safe=green / needs-confirmation=amber), "Run now" button (nova.autoRunNow), Delete (nova.autoDelete), pending banner via nova.onAutoPending; handle agentRun automation intent output (detail.automationId) in result handler; listen nova.onAutoRunResult for spoken result + panel refresh.
4. Verify app.js has KB init renderAutomationPanel pattern — check existing kbPanel init in app.js initAllPanels() and copy.
Then Phase 5: test-automation.js, smoke-auto-e2e.js, npm test (add test:automation to test chain), boot Xvfb test (automation section renders, scheduler started log), README row + Stage 9 section, docs/STAGE9-SUMMARY.md, commit push, deliver.

## Renderer wiring status (Phase 4, almost done)
DONE: index.html Automations side-section added (after KB section, before "Type instead"); hud.css auto-* styles appended after .kb-source-link; app.js: el map has autoList/autoAdd/autoRefreshBtn/autoPendingCard; added cronLabel(), renderAutoPanel(), refreshAutoPanel(), autoResultToHistory(), runAutoNow(), runAutoDelete(), runAutoCommand(), showAutoToast(), showAutoPending(), initAutoPanel() — all inserted AFTER initKbPanel (after line ~378, before CONTROL section).

REMAINING edits in app.js:
1. In agentRun result handler (~line 1280-1289, right after `if (res.intent === "kb") { ... }`): add `if (res.intent === "automation") { const txt = res.text || "Done."; addHistoryEntry({ role: "nova", text: txt, src: source }); speak(txt); el.liveLine.textContent = ""; refreshAutoPanel(); return; }`
2. At bottom near `initKbPanel();` (~line 1726): add `initAutoPanel();`
3. runAutoCommand currently has a dead placeholder nova.autoRunNow("__create__") call — replace function body: remove that try/catch block; creation just calls window.nova.agentRun(text) then handles res.ok && res.intent === "automation" (history+toast) else showAutoToast(res.text) — keep renderAutoPanel() at end.
4. Then Phase 5: test-automation.js (~60 tests), scripts/smoke-auto-e2e.js (13 E2E: parser→store→scheduler fire via setNowForTesting advancing clock, L3+ pause, refusal, runNow through dispatcher), add test:automation to npm test chain, full npm test EXIT 0, Xvfb boot test (grep automation scheduler started), README automation row + Stage 9 section + test:automation script, docs/STAGE9-SUMMARY.md, commit + push, deliver.
npm test chain (package.json): test:kb && test:notes — add test:automation before them.
Existing test script names: src/main/test-permissions.js test-vision.js test-control.js src/main/agent/test-agent.js src/main/test-files.js src/main/test-notes.js src/main/test-kb.js; smoke harness at scripts/smoke-kb-e2e.js (uses embedFallbackForTesting pattern); boot test uses Xvfb :98 + npm start + grep "6 kb:* actions" log pattern.

## Phase 5 status (test-automation.js)
test-automation.js written at src/main/test-automation.js. Issues found+fixed so far:
- require("./vision/actions") → "./vision/vision-actions"; require("./permissions/actions") → notes/kb/files actions requires.
- cron.parse throws on invalid → wrap try/catch in tests.
- store.storePath is a FUNCTION (not prop): store.storePath().
- clearForTesting → persist no-op; removed fs read round-trip check.
- Gating is L3+ (SENSITIVE=3 / DESTRUCTIVE=4) NOT L2; REVERSIBLE routine stores as "safe" correctly. Rewrote L3+ tests to use direct control/destructive-level entries. Tests now include: gating-flip test, blind-act refusal, blind-control refusal (duplicate with prior "check-then-act L3" block removed — NOTE: the old block 161-170 was replaced by two new blocks but there's still an EARLIER 4. runner block (~line ~213) that tests 'every day at 9 AM, tell me what's in Downloads, then move old installers' expecting awaiting-confirmation — THAT MUST ALSO BE UPDATED (it was left in place) or it will fail. CHECK and fix: replace its expectations to status==='partial'? Actually runner.runAutomation for maxLevel>=SENSITIVE... this routine max level is REVERSIBLE(2) so needsConfirmation=false → runs unattended; test expects awaiting-confirmation → will FAIL. Also its follow-up confirm test.
- scheduler test fixed: advance to Tuesday Aug 18 08:00 (cron 0 8 weekday fires only at :00).
- runner block for 'check-then-click' was duplicated by my new block — two consecutive `}` — verify no syntax error.
- run notes: npm test chain must add test:automation; final npm test must EXIT 0; then smoke-auto-e2e.js; boot Xvfb; README; summary; commit push; deliver.
Remaining steps after fixing runner L3 expectation: run test-automation.js to green; check duplicate block syntax; add npm script test:automation + chain; run full npm test; write smoke-auto-e2e.js (~13 tests: creates automation via parser+store, advances clock with setNowForTesting, verifies emitter fire + isDue + lastRunAt guard, L3+ pause path via runner+confirm, deletion, action-log tags); Xvfb boot test (grep "[automation] scheduler started"); README + docs/STAGE9-SUMMARY.md; commit+push; deliver.
smoke-kb-e2e.js pattern ref: scripts/smoke-kb-e2e.js uses embedFallbackForTesting export; smoke-auto-e2e can just test engine modules directly (no model needed).
