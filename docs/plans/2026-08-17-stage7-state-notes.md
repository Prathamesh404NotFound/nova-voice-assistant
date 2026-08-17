# Stage 7 running state notes (Aug 17 ~21:10)

## Task
Add local notes/reminders/tasks module (Stage 7). L1 create/read, L2 edit/delete (+summarize). OS Notification on due reminders + spoken if focused. Side-panel Notes/Tasks tab. Keyword note search. Strict privacy: notes NEVER to OpenRouter except explicit "summarize my notes" (one request, only note text). User test: note + timed reminder (confirm notification fires) + task add/complete + keyword search returns right result.

## Design doc
`docs/plans/2026-08-17-stage7-notes-tasks-design.md` — read it for full design.

## Files DONE (src/main/notes/)
- store.js — local JSON at userData/nova-notes.json (.tmp+rename), setStorePathForTesting, resetForTesting, addNote/addReminder(rearmReminder)/addTask/setTaskDone/deleteNote/deleteTask/cancelReminder/searchNotes/summarizeOf/dueReminders/markFired/all
- plan.js — rule-based: RE_NOTE/RE_REMIND/RE_TASK_ADD/RE_TASKS_LIST/RE_TASK_DONE/RE_SEARCH_NOTES/RE_NOTES_LIST/RE_DELETE/RE_SUMMARIZE; planNoteAction(text, {tasks,notes}); parseTime handles "at 3pm"/"15:30"/"in X minutes"/"in 2 hours 15 minutes"/"tomorrow at 9am"; matchTask(pool, text) case-insensitive substring; errors returned as {error}
- actions.js — all notes:* registered (add-note/add-reminder/add-task/list-notes/list-tasks/list-reminders/search-notes L1=SAFE; complete-task/delete-note/delete-task/cancel-reminder/summarize-notes L2=REVERSIBLE with reverse(p) single-arg, merged lastResult payload — FIXED signatures). Note: registry stores action.lastResult; undo.js merges into reverse payload (single arg).
- reminders.js — start(mainWindow)/stop()/scanOnce(mainWindow); SCAN_MS=15s; sends new Notification(title, body) once; emits mainWindow.webContents.send("nova:reminder-fired",{id,text,dueAt,focused}); setNotifierForTesting(fn)
- summarize.js — buildSummaryUserMessage(noteTexts), sendSummary(key, model, userMessage) w/ retryOnce+plainError; only network file in notes/
- dispatch.js — runNoteAction(text, {taskId, getKey, mainWindow}); summarize branch: getKey→check→gate→store.summarizeOf→router.pickModel("chat")→buildSummaryUserMessage→sendSummary; Private Mode: dispatcher must refuse summarize in private mode (TODO in dispatcher wiring); formatLocalResult action→narrated text.

## Wire status (TODO)
1. classifier.js: add NOTES intent + NOTES_RE using planNoteAction non-null → dispatch branch notes. Existing pattern: requires FILE_RE from files/plan in classifier; copy that.
2. dispatcher.js: dispatchNotes(text) → notes dispatch.runNoteAction(text, {taskId, getKey, mainWindow}) with narrate; import notes/dispatch.js only inside dispatcher (fine; notes store not imported). Private Mode: if settings.isPrivateMode() && planned actionId === notes:summarize-notes → refuse BEFORE any network ("Private Mode blocks note summaries — no outbound calls except OpenRouter are allowed"). NOTE: summarize IS OpenRouter — user said summarize IS allowed; Private Mode blocks ALL outbound except openrouter... Stage 2 said Private Mode blocks everything except openrouter.ai. Summarize calls openrouter.ai → allowed in Private Mode? User spec: "summarize my notes" explicitly allowed to leave machine. So allow even in private mode. BUT other notes actions are local — fine.
3. main.js: require('./notes/actions') at boot; ipcMain.handle('nova:get-notes-store') → store.all(); ipcMain.handle('nova:notes-run', (text)) → runNoteAction; reminders.start(mainWindow) in ready/create-window; also preload filesExecute analog: notesRun, getNotesStore; renderer receives nova:reminder-fired event → show toast + speak if focused (app.hasFocus()).
4. preload.js: expose notesRun(text), getNotesStore(), onReminderFired(cb).
5. renderer app.js: notes tab in side panel (tabs: History/Notes + keep Dev); render notes/tasks/reminders lists; add note/task forms; mark done; refresh after IPC; reminder toast.
6. hud.css: .notes-* styles.

## Test plan (TODO)
- src/main/test-notes.js: mirror test-files.js pattern: electron shim (shim-electron.js at repo root; Module._resolveFilename override), tmp store path via setStorePathForTesting, notifier injection via setNotifierForTesting, modal confirm hook gate.setModalConfirmForTesting. Coverage: store CRUD, plan parsing (all regexes incl. parseTime variants), registry levels, reverse fns (undo), classify intent, dispatch paths, reminder scan fires (dueAt in past), summarize buildMessage + no-leak check (mock fetch), privacy: conversation never imports store.
- scripts/smoke-notes-e2e.js: full voice flow like smoke-files-e2e.js.
- package.json: add test:notes script + include in test chain.

## Key repo facts
- risk levels: READ 0/SAFE 1/REVERSIBLE 2/SENSITIVE 3/DESTRUCTIVE 4 (permissions/risk-levels.js).
- gate.js exports: runAction, cancelToast, toastConfirm, modalConfirm, describeActionPlain, setModalConfirmForTesting.
- settings.js exports: isPrivateMode, setPrivateMode, isDeveloperMode, setDeveloperMode, all, setRaw.
- dispatcher exports: run, getLastTask, on, emitter; dispatcher.js L78 chat stream POST openrouter; settings key via opts.getKey.
- classifier: INTENTS conversation/vision/control/files/combined; planFileAction check; FILE_RE from files/plan.
- renderer: sidePanel id "sidePanel"; history div id "history"; app.js uses nova: IPC via window.nova.*.
- Existing test suites: npm run test:permissions/vision/control/agent/files all green (27/27/27/72/38). npm run test:router separate.
- Stage 6 commit a802ae9 pushed? NO — push failed earlier (no remote). User chose repo ash-vish-event-demo (unrelated) — user hasn't answered where to push yet.
- Design doc for stage 7 written at docs/plans/2026-08-17-stage7-notes-tasks-design.md (uncommitted).

## Progress snapshot 2 (~21:20)
DONE so far (all in src/main/notes/ + wiring):
- store.js, plan.js, actions.js, reminders.js, summarize.js, dispatch.js — DONE (dispatchNotes in notes/dispatch.js: runNoteAction(text,{taskId,getKey,mainWindow}); notes:summarize path uses router.pickModel("chat")+buildSummaryUserMessage+sendSummary)
- classifier.js: NOTES intent added, planNoteAction check before FILES; quick classify includes "notes"
- agent/dispatcher.js: import notes/dispatch as notesDispatch; narrateNotes; dispatchNotes() with taskId:getKey:mainWindow opts; run() branch INTENTS.NOTES before COMBINED
- main.js: require('./notes/actions') + require('./notes/reminders') as reminders; reminders.start(mainWindow) after createWindow; nova:get-notes-store + nova:notes-run IPC handlers; agent-run passes mainWindow
- preload.js: getNotesStore, notesRun, onReminderFired exposed on window.nova
- index.html: Notes/Tasks side panel section inserted after History (id notesTabs/notesList/notesAdd, tab buttons data-notes-tab=notes|tasks|reminders, refresh btn notesRefreshBtn)

REMAINING:
1. renderer js/app.js: notes panel logic — tab switching, render notesList (notes/tasks/reminders with inline delete + task done toggle), notesAdd form per tab (note textarea-like input "note that …" style, task input, reminder text+time input + quick chips 10min/1h/tomorrow 9am), submit handler calling window.nova.notesRun, refresh on submit + notesRefreshBtn; listener window.nova.onReminderFired → speak via TTS (speechSynthesis) + show inline toast banner; add el.notes* refs; call initNotesPanel().
2. hud.css: .notes-tabs/.notes-tab/.notes-list/.notes-item/.notes-add styles (mirror existing flat-btn/history styles).
3. test-notes.js (~40-50 checks) + scripts/smoke-notes-e2e.js; package.json test:notes + test chain; all suites green.
4. Boot on Xvfb :98 (stage 6 pattern: DISPLAY=:98 timeout 25 npm start > /tmp/boot.log 2>&1; grep -c error), README Stage 7 section, commit+push.
Test harness facts: use shim-electron.js at repo root via Module._resolveFilename override (see test-files.js for exact pattern); store.setStorePathForTesting(tmp); reminders.setNotifierForTesting(fn); gate.setModalConfirmForTesting; actions load require('./notes/actions') registers notes:*; classify via classifier.classify; dispatcher.run with getKey.
Key imports: risk levels RISK_LEVEL.SAFE=1/REVERSIBLE=2; gate exports runAction,setModalConfirmForTesting,toastConfirm,modalConfirm,describeActionPlain; undo.noteReversibleSuccess auto via registry; action.lastResult + undo merge.
Plan parser plan.js quirks: RE_REMIND task text group1 = text before time-preposition, time expr group2; parseTime: at 3pm/15:30/in X/in 2h 15m/tomorrow at 9am; matchTask substring longest. Errors as {error} strings.
Privacy: conversation stream (dispatcher.js L~85) only sends user text; notes store never imported in dispatcher; summarize via notes/summarize.js only; main.js nova:notes-run same path.

## Progress snapshot 3 (~21:40)
Renderer DONE: el refs (notesTabs/notesList/notesAdd/notesRefreshBtn); NOTES_STATE tab logic; refreshNotesList reads store.{notes,tasks,reminders} via getNotesStore (plural keys correct); renderNotesAddForm per tab (note that / add X to my tasks / remind me to X); runNotesCommand → window.nova.notesRun + showNotesToast + refresh; initNotesPanel (tabs/refresh/delegated list clicks: delete note/cancel reminder/mark task done) — NOTE: mark done sends "mark task <id> done" — plan.js RE_TASK_DONE must accept "mark task <uuid> done"; CHECK plan regex accepts uuid! delete note <uuid>: check RE_DELETE regex handles "delete note <uuid>" with prefix "note"; cancel reminder <uuid>: plan RE_REMIND_CANCEL? need to verify notes plan has cancel + delete support. handleResult intent===notes branch + refreshNotesPanel. CSS appended (notes-tabs/.notes-item/.notes-toast).
REMAINING:
1. VERIFY notes plan.js regexes cover: "note that X", "remind me to X at/in/tomorrow …", "add X to my tasks", "what's on my task list"/"my tasks", "mark <id> done", "delete note <id>", "cancel reminder <id>", "search my notes for Y", "summarize my notes", "what did I note about Y" (searchNotes). Read src/main/notes/plan.js to confirm.
2. Also verify "remind me to X in 10 minutes" time parsing.
3. Wire initNotesPanel() call in app.js top-level init region (near line ~1193 other listeners).
4. tests: src/main/test-notes.js + scripts/smoke-notes-e2e.js + package.json test:notes + chain; suites; boot Xvfb; README; commit.
Test hooks available: store.setStorePathForTesting(p)/resetForTesting(); reminders.setNotifierForTesting(fn); gate.setModalConfirmForTesting(true); classifier.classify(text); dispatcher.run with {getKey}; notes actions register via require("./notes/actions"); risk levels from permissions/risk-levels.js (SAFE/REVERSIBLE).
Store item shape: notes {id, text, at}; reminders {id, text, dueAt, fired}; tasks {id, text, done}. Plan errors = {error: string}; success = {actionId, payload} (check plan.js returns shape).

## Progress snapshot 4 (~21:50)
DONE now: plan.js fixed — added findById(ctx,id), RE_REMIND_CANCEL ("cancel reminder <id>"), RE_DELETE_ID ("delete note|task|reminder <id>"), RE_TASK_DONE now tries findById before matchTask, RE_DELETE subject also tries findById first. All exported. Renderer commands now match: mark task <uuid> done, delete note <uuid>, cancel reminder <uuid>.
Renderer complete incl CSS. main.js/preload/classifier/dispatcher wiring complete.

NEXT STEPS (in order):
1. Wire initNotesPanel() call in app.js — must call it once app starts (near other listener setup at bottom, after typeForm etc.). ALSO: renderer reads store via getNotesStore which returns {ok, store} — check notesList render uses store[tab+"s"]; reminders render expects items r.dueAt/r.fired — store stripInternal keeps fired? Verify stripInternal in store.js (line ~82 all()). CHECK.
2. Check dispatch.js narration — does runNoteAction result have .narration + .text? grep dispatch.js returns.
3. test-notes.js: create src/main/test-notes.js mirroring test-files.js pattern (electron shim at repo root shim-electron.js; Module._resolveFilename override; tmp path; setStorePathForTesting; notifier injection setNotifierForTesting; modalConfirm test hook gate.setModalConfirmForTesting(true); classifier + dispatcher runs). Coverage: store CRUD/persistence; plan parse all regexes (note/remind times, task add, list, done by text+id, search, delete by text+id, cancel, summarize); registry levels; reverse fns (undo complete/delete/cancel); classify intent; dispatcher runNoteAction end-to-end (add note, reminder fires past due via set notifier + scanOnce, summarize with mocked fetch (use nock or monkeypatch fetch) verifying only note text sent, not other notes); privacy: plan rejects leak phrases? At minimum: verify buildSummaryUserMessage contains only targeted notes.
4. scripts/smoke-notes-e2e.js: voice flow: note, reminder at now, task add, search.
5. package.json: test:notes, include in top-level test.
6. Boot Xvfb :98: DISPLAY=:98 timeout 25 npm start > /tmp/boot7.log 2>&1; grep -ic error; must be 0; grep '"notes:' boot log for registered actions.
7. README Stage 7 section (after Stage 6 section); docs/plans design doc kept.
8. Commit: git add -A && git commit -m "Add local notes, reminders and tasks: voice + side panel, L1/L2 gated, OS notifications, no-cloud privacy". Push? NO remote configured (user-selected repo ash-vish-event-demo is unrelated; previously offered new repo, no answer). Do NOT push — tell user at delivery.
9. Deliver summary doc.

Design doc: docs/plans/2026-08-17-stage7-notes-tasks-design.md. Test hook names confirmed in code: setStorePathForTesting, resetForTesting (store.js), setNotifierForTesting (reminders.js), setModalConfirmForTesting (gate.js).

## Progress snapshot 5 (~22:05) — key API facts (verified)
- Dispatcher dispatchNotes now has Private Mode guard (settings.isPrivateMode()) before runNoteAction; returns ok:false text with "Private Mode".
- dispatcher.run(text, opts) at line 226 — headless callable? run() sets lastTask internally. OK.
- classify() is rules-only for my test phrases (no model call) — safe headless.
- actionLog API: {append, list, clear, logPath} — list(limit) NOT entries().
- undo.undoLast(runActionFn) — async, returns {undone:true, actionId, payload, label}; label includes item text for complete/delete? (undoLabel fn). test-files.js pattern: undo.undoLast(async (id,p)=>gate.runAction(id,p,{})). undo.resetUndoTrackerForTesting exists (may need between sections!).
- notes actions ids+levels confirmed (SAFE: add-note/add-reminder/add-task/list-notes/search-notes/list-tasks/list-reminders; REVERSIBLE: complete-task/delete-note/delete-task/cancel-reminder/summarize-notes). All L2 have reverse.
- gate.setModalConfirmForTesting(true); reminders.setNotifierForTesting(fn); store.setStorePathForTesting(p)/resetForTesting(); reminders.scanOnce(mainWindow); reminders.stop(); notifier payload {id, text, ...}.
- store.addReminder(text, dueAtISO); cancelReminder sets? store.has cancelReminder, rearmReminder; searchNotes case-insensitive; summarizeOf(ids) returns [{id,text,createdAt}].
- shim-electron.js EXISTS at repo root; test-files.js shim has NO Notification class (mine added).
- dispatch.runNoteAction(text, {taskId, getKey, mainWindow}) returns {ok, intent, text, narration, actionId, detail:{kind:...}}; kinds: note/note-deleted/task/task-done/reminder/reminder-cancelled/list/search/summarize.
- classifier INTENTS: CONVERSATION/VISION/CONTROL/FILES/NOTES/COMBINED. INTENTS.CONVERSATION="conversation".
- REMAINING: run test-notes.js; fix failures; smoke harness scripts/smoke-notes-e2e.js; package.json test:notes + npm test chain; boot Xvfb (DISPLAY=:98 npm start); README Stage 7; commit; deliver.

## Progress snapshot 6 (~22:18) — test-notes.js first run diagnostics
test-notes.js written at src/main/test-notes.js (NOT yet passing). First run failures and root causes (verified via debug node run):

1. 'remind me to stand up in 30 minutes' FAIL: fixed — RE_REMIND restructured + RE_REMIND_ONLY fallback; lazy capture was cutting at 'in'. Also added bare 'remind me X' path.
2. 'note that' empty-body FAIL + 'remind me to' FAIL: because parser returned payload {text:'that'}/{text:'to'} — RE_NOTE allowed optional group match. FIXED: RE_NOTE now anchored with optional 'nova, ' prefix; need to verify empty-body still returns error. 'remind me to' now RE_REMIND_ONLY matches with 'to' → text='to'! Need: bare 'remind me' check: if trimmed remainder is a stop word ('to','at','in') or empty → error. ADD this.
3. 'mark task <id> done' FAIL: RE_TASK_DONE group1 = 'task <id>' → findById fails (id has 'task ' prefix), matchTask fails. FIX: in RE_TASK_DONE block, strip leading 'task ' word before lookup: taskText.replace(/^task\s+/i,'').
4. 'delete my note about X' FAIL: RE_DELETE subject = 'about pizza' (strips 'my'). FIX: strip leading about/for/with keyword from subject in RE_DELETE block before lookup.
5. classify 'Nova, note that...' FAIL conversation: classifier calls planNoteActionSafe with {} ctx — planNoteActionSafe presumably wraps planNoteAction; 'Nova,' prefix was not matched by old RE_NOTE (now fixed in 1). Re-check classify after fix.
6. classify 'mark pay rent done' FAIL conversation: because ctx {} → plan error 'task list empty' → noteAction.error → skips notes branch → conversation. FIX in classifier: only skip on error if error implies no-context (e.g. 'empty') — treat 'could not find/empty' as still-notes intent? Simplest: when noteAction.error AND RE_TASK_DONE/RE_DELETE/etc matched (intent determinable from regex alone), still route NOTES. Implement: intentFromRegex helper checking regex test. Better minimal: if error contains 'empty' || error starts with 'I could not find' → still return NOTES with error carried? Then dispatcher runNoteAction will show the error text — correct UX. Apply same for plan error 'Your task list is empty'.
7. dispatcher add-note FAIL: planning-error because of (2) 'Nova,' prefix + 'note that' matched group2 with 'that'?? Actually debug showed planNoteAction('Nova, note that the garage...') = null — RE_NOTE didn't match at all (now fixed #1).
8. dispatcher search-notes FAIL: store.resetForTesting() in section 3 wiped the note added in section 5 setup? No—section 5 runs AFTER section 3 and section 3 resetForTesting is at section 3 top; section 5 adds 'garage' note via dispatcher THEN searches. Debug: search result 0 matches — because store.searchNotes('garage') vs note text 'the garage code changed to 8472' — 'garage' IS in there. Hmm, why 0: dispatch.runNoteAction searches with ctx from storeContext() but execute uses store.searchNotes(p.query). store.resetForTesting in section 7?? Section 7 resetForTesting runs after section 5. OK actually search FAIL might be from section ordering bug: section 5 'search my notes for garage' returned 0. Maybe store.searchNotes uses loaded data that was reset by a later run… check test order: sections run sequentially. Could be: searchNotes query matching logic — case-insensitive substring. Verify searchNotes body. ALSO 'delete my note about the garage code' got planning-error (null actionId) because RE_DELETE subject 'about the garage code' then strip-about → 'the garage code' → matchTask substring vs 'garage code changed' → includes? 'the garage code' not substring of 'the garage code changed to 8472' → YES it is! Wait 'the garage code changed to 8472'.includes('the garage code')=true → matchTask returns it. So after strip-about fix should work.
9. reminders scanOnce FAIL: log says '[notes] reminder fired ... focused=false' but notifier fn not called — fire path may use mainWindow focus check + different notifier signature. Check reminders.js scanOnce/firing code: notifier payload key names vs test fired.find(f=>f.id===r.id). Maybe payload keys are {title,body} not {id,text}. FIX test to match actual payload.

REMAINING steps: fix plan.js #2 bare-word check; classifier #6; strip prefixes in RE_TASK_DONE/RE_DELETE; re-run; fix test assertions per reminders payload; then smoke harness, package.json, boot, README, commit.
Reminder notifier: test expects payload with id+text; reminders.js logs 'reminder fired' but notifier may differ — READ reminders.js firing block after next compaction.
Gate L2 toast headless: gate.setModalConfirmForTesting(true) works (tests pass complete-task/undo). 
Dispatcher search-delete-cancel failures all stem from plan bugs #1/#2/#3/#4/#6 above (planning-error null) — expect all to resolve after plan+classifier fixes.

## Progress snapshot 7 (~22:30) — remaining 4 failures
Status: 74/78 PASS. Remaining:
1. 'write down that the wifi password is blue' FAIL: RE_NOTE matches but plan block body=(m[1]||m[2]||m[3]) — 'write down that' → body 'the wifi password is blue' works in regex (node test shows group3=body). So why FAIL? Because plan.js line: const body = (m[1] || m[2] || "").trim(); — OLD code only uses m[1]||m[2], missing m[3]! FIX plan.js: body = (m[1] || m[2] || m[3] || "").trim().
2. 'note that' FAIL: RE_NOTE: 'note that' → matches alt1 note(?:\s*:\s*|\s+that\s+)(.+)? — no, (.+) requires 1+ → fails alt1; alt2 note\s+(.+) matches with 'that'! body='that' → passes. FIX: in planNoteAction RE_NOTE block, body.trim() === 'that' → return error 'Note what...'. OR reorder alts. Simplest: after body extraction: if (body.toLowerCase() === 'that') return error.
3. undo restores deleted note FAIL + cancel-reminder FAIL: both planning-error null actionId. 'cancel reminder <id>' — plan RE_REMIND_ONLY? No—cancel: RE_REMIND? 'cancel reminder n-...' doesn't match remind. RE_REMIND_CANCEL: /^cancel reminder\s+([\w-]+)$/ — should match. But undo test runs AFTER section 6 where... the cancel test uses `cancel reminder ${rem.id}` where rem.id from addRem (section 5). After section 7? No section 6/7 don't touch reminders. BUT wait — my earlier run had 'cancel reminder cancelled via gate' PASSING at first run (it was the delete-note FAIL instead). Now it's FAIL with planning-error... Actually re-check: the FAIL shows planning-error null — meaning planNoteAction returned {error} with null actionId. 'delete my note about the garage code' (dispatcher) — after about-strip, subject='the garage code'; matchTask substring vs 'the garage code changed to 8472' → should match. Hmm. And cancel: maybe store.all().reminders returns stripInternal without dueAt? cancel payload needs dueAt: findById(pool,id) returns stripped item WITH dueAt (stripInternal keeps dueAt). So cancel should work...
   Hypothesis: plan.js RE_DELETE subject strip: 'about' stripped → 'the garage code' — but matchTask compares ctx (dispatcher's storeContext()) — dispatcher runs after reset... In section 5 test ordering: addNote then search then delete then undo then cancel. cancel uses rem.id from addRem. Should exist. Maybe order issue: my earlier edit to RE_DELETE added strip-about AFTER m extraction — wait I also edited RE_TASK_DONE. The FAIL 'dispatcher cancel-reminder' appears; the planning-error log says 'null → planning-error'. Let me check what text fails: likely 'cancel reminder <id>' fails because RE_REMIND_MATCH? No. RUN DEBUG: planNoteAction('cancel reminder n-xxx') with ctx.reminders=[...] returns?
   DEBUG next: quick node check of planNoteAction cancel + delete with full ctx.
Also note: classifier now routes planning errors to NOTES — test expectations for error cases (empty reminders list) may need adjusting. Test currently: empty-case 'mark X done' with ctx empty → expect error — OK (intent=notes, dispatcher returns error text, dispatch.runNoteAction called with {planningError} returns ok:false). BUT my test section 4: 'mark pay rent done' now expects notes intent! I changed classifier; section 4 expects notes for 'mark pay rent done' — test expects classify→notes; earlier it FAILed as conversation. FIXED by classifier change? It now expects PASS. Good.
BUT test section 5 (dispatcher) 'mark pay rent done' runs runNoteAction directly (not classify) — fine.
The 2 failing dispatcher tests (delete/cancel) run through dispatch.runNoteAction → planNoteAction(text, storeContext()) — with FULL ctx. They should work. DEBUG to find why.

## Progress snapshot 8 (~22:17) — Stage 7 essentially complete
- test-notes.js: 78/78 PASS (src/main/test-notes.js)
- smoke-notes-e2e.js (scripts/): SMOKE OK — note + timed reminder fired (title 'Nova reminder', body has text) + task add/complete + keyword search + delete + classify routing
- All regression suites green: permissions 27, vision 27, control 72, agent 38, files 82, notes 78
- test:notes script added to package.json
- Boot on Xvfb :98: clean; all 12 notes actions registered at boot (L1/L2 as designed); single viz GPU headless cosmetic error only
- README updated: new '## Local notes, reminders & tasks (Stage 7)' section after Stage 6 (lines 166-195)
- REMAINING: also update README intro/features table? Intro mentions intents conversation/vision/control/combined — should add notes + files to classifier summary. Optional minor.
- THEN: git add -A && commit + push (no remote configured yet — user never answered earlier push question; last time user didn't respond. Default: commit locally, inform user, ask about remote).
- Note: user's linked repo ash-vish-event-demo is NOT Nova; local repo has no remote.
