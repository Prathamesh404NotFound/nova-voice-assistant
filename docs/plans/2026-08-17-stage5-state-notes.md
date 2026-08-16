# Stage 5 state notes (2026-08-17)

## Done so far (files created/modified)
- `src/main/agent/classifier.js` — rule-based intent classification (vision/control/conversation/combined); ambiguous → pickModel("quick") one-shot; fallback heuristic = combined (vision+control), else conversation.
- `src/main/agent/retry.js` — retryOnce(fn,label) + plainError(err,ctx)
- `src/main/agent/dispatcher.js` — run(text, opts{getKey, runVisionQuery}); classification + dispatch (conversation streams SSE w/ emitter chat-chunk events; vision retries; control compiles plan + sequence.reviewing(`agent-${taskId}`)); lastTask inspector state; emitter "progress" events (narration, chat-chunk).
- `src/main/agent/onboarding.js` — permissionState() (darwin: screen recording via systemPreferences.getMediaAccessStatus('screen'); accessibility via osascript System Events), pendingScreens(), acknowledge(id), runAccessibilityTest()
- `src/main/agent/undo-bridge.js` — IPCs: nova:get-undo-info, nova:undo, nova:get-last-task, nova:set-dev-mode, nova:get-onboarding, nova:ack-onboarding, nova:run-accessibility-test
- `src/main/permissions/undo.js` — noteReversibleSuccess/getUndoInfo/canUndo/undoLast(runActionFn)/UNDO_WINDOW_MS=5min, resetUndoTrackerForTesting
- `src/main/permissions/action-registry.js` — registerAction accepts `reverse`
- `src/main/permissions/test-actions.js` — reverse fns for demo:rename-file + new demo:move-file (L2)
- `src/main/permissions/gate.js` — opts.taskId flows to action-log append; executeAndLog calls undo.noteReversibleSuccess on success
- `src/main/permissions/action-log.js` — append accepts taskId
- `src/main/control/runner.js` — runSequence({plan, taskId}) threads taskId to runAction
- `src/main/settings.js` — isDeveloperMode/setDeveloperMode/setRaw (exports after load())
- `src/main/router.js` — lastPick(taskType) exported
- `src/main/main.js` — patched via patch-main.py: requires agent/dispatcher + agent/undo-bridge + agent/onboarding; nova:agent-run handler (getKey from keys.js, runVisionQuery wrapper); dispatcher.on("progress") → mainWindow.webContents.send("nova:agent-progress", event); startup emits nova:onboarding after window show when pending screens exist
- `src/preload/preload.js` — patched: agentRun, onAgentProgress, getUndoInfo, undoLast, getLastTask, setDevMode, getOnboarding, ackOnboarding, runAccessibilityTest, onOnboarding
- `src/renderer/js/app.js` — part 1 patched: new el refs (devTask/devTaskBody/devToggle/undoBtn/onboarding/*), submitMessage replaced with agent-run pass-through (progress listener: narration → history entry + speak, chat-chunk → liveLine). STILL NEEDS: refreshUndoButton/refreshDevTask functions, undo click handler, dev-toggle wiring, onOnboarding listener + overlay show. Also addHistoryEntry must support small flag (check usage).

## Remaining renderer patch (part 2)
The patch-renderer.py anchor for submitMessage failed because the file has BOTH comment lines: "// Vision route: ..." AND "// Works offline and in Private Mode — ..." (with em-dash). The part-1 patch DID succeed (preload + el refs + submitMessage replacement) — verify with git diff what actually changed in app.js before part 2. NOTE: "preload patched" printed twice earlier — check preload for duplicates of the added IPCs!

## app.js remaining wiring to add (part 2)
1. refreshUndoButton(): calls getUndoInfo → el.undoBtn.disabled = !info; label = info?.label || "↶ Undo last action"
2. refreshDevTask(): only if settings.developerMode → getLastTask → render into el.devTaskBody (intent, modelPick.model+reason, steps with durationMs, errors raw, logEntries)
3. devToggle click → setDevMode(!current) → refreshDevTask
4. onOnboarding listener → show overlay with title/why per pending screen; onboardingBtn triggers: ack then for accessibility runAccessibilityTest; hide overlay when pending empty.
5. addHistoryEntry small flag: add css class .small for narration entries (already appended with src:"narration").

## Packaging (electron-builder in package.json)
- win: nsis x64; mac: dmg. Currently UNSIGNED. Need comment blocks:
  - Windows signing: `win.certificateFile`/`certificatePassword` (signtool) or cloud autoSign
  - macOS signing: `mac.identity` = Apple Developer ID cert name; notarization needs notarytool + Xcode 13+/App Store Connect.
- dmg.sign:false already; add entitlements not needed (unsigned).
- README update: OPENROUTER_API_KEY setup, first-run per OS (mac: Screen Recording + Accessibility onboarding screens; win: none), risk levels explainer table, free-tier caveats (rate limits ~20 req/min per model, rotation gaps, fallback model).

## Testing plan
- new `src/main/test-agent.js`: ~50 checks w/ electron shim:
  - classifier: pure vision→vision, pure control→control, ambiguous no-key-fallback→combined, conversation default, private-mode/offline fallback
  - dispatcher: conversation retry (mock fetch failing once), vision failure plain error, control compile + reviewing state, undo info after reversible success, undoLast restores detail, dev-mode toggle, onboarding pending detection (darwin mocked), packaging comments verify
- run npm run test:control, test:permissions, test:vision after all changes
- boot on Xvfb :98: DISPLAY=:98 timeout 20 npx electron .

## Prior commits (stage 5 starts at 654c9d9)
6f6b604 control, b86303f vision, 228fa70 permissions, 7c4dda4 foundation. Local repo only (no remote; user's selected repo ash-vish-event-demo is unrelated — do not push).

## Key facts
- Gate runAction signature: (actionId, payload, {dryRun, taskId})
- action-log append keys: actionId, level, outcome, startedAt, detail, reason, taskId
- Settings: isPrivateMode/setPrivateMode/isDeveloperMode/setDeveloperMode/all/setRaw; nova:settings-changed broadcast {privateMode, developerMode}
- Dispatcher lastTask shape: {id, input, startedAt, intent, classification{intent,method,confidence}, steps[{label,level,durationMs,ts}], errors[{context,message,stack,ts}], output, logEntries, modelPick}
- Router: pickModel(taskType), lastPick(taskType), FALLBACK_MODEL_ID
- Renderer: onAgentProgress events {type:"narration",taskId,step,text} and {type:"chat-chunk",taskId,text}; nova:agent-run returns {ok, intent, text/plan/summary/visionAnswer, error}
- Undo: undoLast(runActionFn) — bridge passes (id,payload,o)=>runAction(id,payload,{...o,...opts}); outcome logged "undo" via undo.js itself; lastReversible nullified on success
- Onboarding: pendingScreens reads settings keys onboardingAckScreenRecording / onboardingAckAccessibility + permissionState
- Demo action verify flag in main.js: --run-demo-action <id>


## UPDATE (phase 4 complete)
All renderer wiring DONE and syntax-checked. app.js fully patched: submitMessage → agent-run pass-through w/ narration (narration entries speak once + small class), conversation/vision/control branches; helpers at IIFE end: refreshUndoButton, undoLast handler, renderDevTask (pre text), refreshDevTask (hidden when dev off; uses window.nova.isDevMode()), toggleDevMode, showOnboarding, onboardingAck click (accessibility verify step). addHistoryEntry supports small flag. settings mirror in app.js (developerMode/privateMode/keyConfigured) loaded via getSettings + onSettingsChanged.

preload.js: agentRun, onAgentProgress, getUndoInfo, undoLast, getLastTask, setDevMode, isDevMode (=Boolean(window.__novaDevMode__) — MIRROR variable __novaDevMode__ never set anywhere! FIX: either set it on settings-changed listener in preload, or have isDevMode invoke an ipc). undo-bridge ipc nova:undo returns {ok,undone,label|error}.

index.html: undoBtn (after ctrlStopBtn), devToggle span, devTask/devTaskBody pre, onboarding overlay (title/why/ack button — NOTE: overlay uses onboardingAck; onboardingBtn el ref is unused, harmless). hud.css: onboarding overlay + dev-task + msg.small styles added. SIGNING.md written (Windows EV + cloud notarization, macOS identity+notarization env vars). package.json: nsis oneClick false, mac category.

tests: test:control 72 pass, test:permissions 27, test:vision all pass (after all stage-5 changes).
TODO: fix __novaDevMode__ (preload or main window preload injection), write src/main/test-agent.js (~50 checks: classifier intents, dispatcher run/retry/errors, undo flow end-to-end w/ demo:rename-file via gate mock, dev mode toggle ipc, onboarding pendingScreens darwin-mock), update README stage5 section + SIGNING, commit, boot test Xvfb :98.
test harness pattern: Module._load shim 'electron' (same as test-control.js lines 1-35), installVisionMocks from test-control if needed, DATA_DIR from argv[2].


## UPDATE (phase 5 COMPLETE)
test-agent.js DONE: 38/38 PASS. Covers classifier (vision/control/conversation/ambiguous), quick-model fallback, retryOnce (transient+fatal), plainError no-stack, dispatcher conversation w/ mocked fetch SSE stream (retry 2 attempts, chunks, narration), no-key placeholder, control plan+reviewing+narration, getLastTask inspector (classification/steps/errors/modelPick), undo end-to-end (register/irreversible ignored/undo/reverse logged/cancelled&failed don't register), darwin-mock onboarding (denied screen-rec → pending screen → acknowledge).
npm script test:agent added. All suites green: agent 38, permissions 27, control 72, vision 27. App boots clean on Xvfb :98 (only viz GPU error = headless artifact; hotkey registers).

preload mirror fix: __devModeCache/__privateModeCache declared above contextBridge, seeded by nova:get-settings, updated on nova:settings-changed. isDevMode/isPrivateMode exposed.
undo: undo.js returns {undone,label,...}; undo-bridge returns {ok,undone,label|error}; demo:create-file (L2 no reverse) added to test-actions.js.
test-agent needs settings reset before onboarding test (setRaw ack keys false).

## Phase 6 remaining tasks
1. README.md: add Stage 5 section — OPENROUTER_API_KEY setup (OPENROUTER_API_KEY env or in-app dialog), first-run per OS (mac: Screen Recording + Accessibility onboarding screens; win: none), risk levels table (L0-L4 + control L0/L2/L3), free-tier caveats (rate limits ~20rpm, model rotation gaps, fallback gemini-2.5-flash), undo limits, distribution notes (unsigned, see SIGNING.md)
2. Update feature table in README intro
3. docs/stage5 summary (optional — include as attachment)
4. git add -A && commit "Add unified agent loop: intent classifier + dispatcher + narration + undo + dev mode + onboarding + packaging"
5. Also update task-state notes file with stage5 commit hash

## Stage 5 complete
Commit: b448132 — unified agent loop + undo + dev mode + onboarding + packaging. Tests: agent 38/38, permissions 27/27, control 72/72, vision 27/27. README updated with Stage 5 section + free-tier limitations. SIGNING.md written. Repo remains local-only (no remote configured; ash-vish-event-demo repo is unrelated, not pushed).
