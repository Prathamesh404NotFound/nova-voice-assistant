# Round 7 plan — onboarding wizard + global keyboard shortcuts

## Current onboarding (Stage 5, main.js L643+, undo-bridge.js L65+)
- onboarding.pendingScreens() returns ["screen-recording", "accessibility"] (macOS only; Windows "not-needed" → never shows)
- IPCs: nova:get-onboarding / nova:ack-onboarding / nova:run-accessibility-test
- Renderer: #onboarding overlay with title/why + single "Allow" button (app.js L1851+)
- Settings ack keys: onboardingAckScreenRecording / onboardingAckAccessibility (settings.setRaw)

## Round 7 scope
1. **Welcome wizard** — extend onboarding module + renderer into a multi-step
   wizard shown on FIRST RUN ONLY (new setting key `onboardingCompleted`):
   - Step 0 "Welcome to Nova": what Nova is, privacy note (data stays local,
     OpenRouter optional), 4-6 capability bullets, CTA "Get started"
   - Step 1 API key: explain OPENROUTER_API_KEY / side-panel key input
     (renderer already has settings Key input — point at it), can skip
   - Steps 2-3: existing permission screens (macOS only)
   - Step 4 "Knowledge base": invite adding a folder (renderer already has
     kb panel; just an info step, CTA opens kb panel?)
   - Step 5 done
   - Renderer-driven steps with IPC bridge: nova:get-onboarding gains
     `wizard: { firstRun, step, data }`; `nova:ack-onboarding` reused;
     new `nova:skip-wizard-step`? Keep simple: steps tracked in RENDERER
     state; only permission steps need IPC.
   - Onboarding module gains `isFirstRun()` (onboardingCompleted key) and
     `completeWizard()`.
2. **Global shortcuts** (main.js, AFTER registerKillHotkey ~L587):
   - Alt+Space (CommandOrControl+Alt+Space for parity): show/hide/toggle
     Nova window (focus behavior: always-on-top flash + show/center)
   - Alt+M: toggle mute (mic) — renderer has mic toggle; use webContents.send
     "nova:toggle-mic" and renderer listens (app.js already has mic handling)
   - Documented in README; configurable would be extra — keep fixed combos.
3. Tests: test-agent.js has onboarding coverage (first-run darwin denied →
   pending). Extend onboarding tests minimally + verify npm test EXIT 0.

## Kill hotkey note
- existing: CommandOrControl+Shift+Escape → kill agent (main.js L587)

## Deliverable
- commit message: "Round 7: welcome onboarding wizard (first-run tour) + global shortcuts (Alt+Space toggle, Alt+M mute)"

## Round 7 implementation state (as of writing)
DONE:
- onboarding.js: added ACK_KEYS.welcomeCompleted ("onboardingWelcomeCompleted"), isFirstRun(), completeWizard(), wizardState() { firstRun, pending, welcomeDue }
- undo-bridge.js: ipcMain.handle("nova:get-wizard") + ("nova:complete-wizard")
- preload.js: nova.getWizard(), nova.completeWizard() bridges
- main.js: registerNovaHotkeys() — Alt+Space show/hide (minimize when focused; else show+focus steal+center), Alt+M sends "nova:toggle-mic" to renderer; called after registerKillHotkey() at boot. (NOTE: mainWindow may be null when hotkey fires before createWindow — guarded.)
- index.html: onboarding overlay upgraded — wizardSteps bar (wizardStepLabel, wizardStepFill), wizardIntro (onboarding-orb + wizardIntroLine), onboardingFeatures ul, wizardDots, wizardActions (wizardSkip ghost + onboardingAck)
- hud.css: wizard CSS appended (steps bar, intro orb, features grid, dots, ghost button)

REMAINING:
1. app.js: el refs (wizardSteps/wizardStepLabel/wizardStepFill/wizardIntro/wizardIntroLine/onboardingFeatures/wizardDots/wizardActions/wizardSkip) — check el map ~line 36. Then:
   - On boot: call nova.getWizard() (fallback: legacy nova:get-onboarding) → if firstRun, start wizard.
   - Wizard steps: welcome → api-key → [screen-recording] → [accessibility] → done.
   - Welcome step: intro text, features list (vision, control, files, kb, notes, automations), privacy note; button "Get started" (skip wizardSkip shows "Skip tour").
   - API-key step: show key status + point to side panel; button "Set key" opens existing key overlay (el.keyOverlay hidden; key overlay already exists id=keyOverlay; setKeyBtn handler exists); allow skip.
   - Permission steps: reuse existing showOnboarding + ack flow (ack → next).
   - After final step: nova.completeWizard(), hide onboarding.
   - wizardSkip: mark complete + hide (skipping tour keeps permission screens? For first run, skip only skips the tour; permission screens still show when pending — but onboarding overlay IS the wizard... decision: skip tour hides overlay entirely; permission states handled by existing topbar help — macOS screenPermHelp in side panel. Acceptable.)
   - Add listener for ipc nova:toggle-mic: renderer needs to listen to webContents.send("nova:toggle-mic") — BUT renderer has no ipcRenderer; nova bridge lacks onToggleMic. TODO: add preload bridge onToggleMic(cb) using ipcRenderer.on("nova:toggle-mic",...) — wait preload exposes bridge; add "onToggleMic" method to contextBridge before it's too late; then app.js: window.nova.onToggleMic(() => el.talkBtn.click()) — toggle via existing talk button click (state-dependent).
   - OnOnboarding existing flow still sends permission screens; integrate: wizardState pending screens drive same showOnboarding after welcome/api steps.
2. tests: npm test should stay green; optionally a tiny test-agent style check. Run `npm test` → EXIT 0.
3. README: add global shortcuts section (Alt+Space, Alt+M, Ctrl+Shift+Esc) — find existing hotkey docs in README.
4. Commit: "Round 7: welcome onboarding wizard + global shortcuts" — git push.

## Notes
- key overlay: id=keyOverlay, setKeyBtn handler exists in app.js (find "setKeyBtn").
- app.js el map around line 36; onboarding el at lines 1776-1906 (showOnboarding, ack handler).
- After commit: Round 8 = TTS voice customization (speed/pitch/voice selection UI in settings + speechSynthesis options).
