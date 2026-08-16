# Stage 5 — One Coherent Agent + Distribution

## 1. Single agent loop (dispatcher)

Move routing OUT of the renderer. Today `app.js` decides vision/control/chat
by regex before sending anything to main — renderer-driven. That duplicates
policy in two places and makes narration (TTS per step) hard.

New design: a thin agent loop in the **main process** (`src/main/agent/`).

```
renderer submitMessage ──IPC──▶ nova:agent-run({ text })
                                  │
                                  ├─ intent = classify(text)   // local, offline
                                  ├─ dispatch(intent):
                                  │    conversation ▶ chat stream (renderer streams TTS)
                                  │    vision       ▶ runVisionQuery → answer
                                  │    control      ▶ compilePlan → renderer review → runSequence
                                  │    combined     ▶ vision step then control plan
                                  └─ each step: speakNarration(msg)  (text for chat transcript
                                         + TTS utterance; renderer dedupes)
```

**Intent classifier (`agent/classifier.js`)** — deliberately LOCAL and
rule-based, like the planner. No LLM round-trip for routing decisions:
- vision patterns: existing VISION_PHRASES regex (screen/looking/error)
- control patterns: existing CONTROL_PHRASES regex (open/click/type/press/
  compute/calculate/drag/submit/wait)
- conversation: everything else

`pickModel("quick")` is required by the brief, so the classifier ALSO makes a
cheap model call for AMBIGUOUS cases only (sentence mentions both a screen
question AND an action verb): send a one-shot system prompt to
`pickModel("quick")` with choices [conversation, vision, control, combined].
Failure of the cheap call falls back to heuristic (control-safe default:
conversation). Router logs the pick with taskType "quick" — visible in Dev
Mode.

**Narration:** dispatcher emits per-step narration events to renderer
(`nova:agent-progress`): `{ step, text }`. Renderer appends them to chat
history AND speaks them (first time only — TTS barge-in clears the queue).
Chat answers arrive as normal streaming text.

## 2. Developer Mode task inspector

- Settings toggle `developerMode` in `settings.json` (existing module).
- New panel section `#devTaskPanel` in side panel: shows the LAST task:
  intent, input text, model used + pick reason (from router pickLog — new
  accessor `lastPick(taskType)`), plan steps, per-tool-call risk level +
  timing (gate already tracks durationMs), outcomes, errors.
- Data source = Action Log (`actions.log.json`, already has actionId/level/
  outcome/durationMs/ts). Tag every action-log entry with a `taskId` so the
  inspector can filter to "current task". Task ids minted by dispatcher.
- New IPC: `nova:get-last-task` returns the assembled view.

## 3. Undo (Level 2 file/text, 5 min window)

Stage 2-4 deliberately built NO file-system tools, so "undo last action"
covers the TEXT subset today + the file subset is wired for the future:
- `undo.js` in permissions/: for each logged action, store a `reversal` fn
  at registration time (registry `registerAction({ ..., reverse })`).
  - `demo:rename-file` → swap names back (already in test-actions)
  - `demo:move-file` → move back
  - `control:type-text` → NOT reversible (buttons never fire — greyscale)
  - `demo:read-files`/vision/cursor → N/A (idempotent reads)
- IPC `nova:get-undo-info` returns the latest reversible success from the
  last 5 minutes with the reversal detail; `nova:undo` executes the reversal
  through the SAME gate (L2 toast) — undo itself is logged as `dry-run`? No —
  logged as outcome `undo` with level.
- Renderer: "↶ Undo last action" button in the top bar / history panel;
  disabled+greyed when no reversible action exists within 5 min.

## 4. Error handling + single retry

- Wrapper `retryOnce(fn)` in agent/: any chat fetch / model call / action
  step failure retries ONCE; on second failure returns structured error.
- Renderer NEVER shows stack traces: plain-language messages ("I could not
  reach the assistant — please check your internet connection and try
  again."). Raw error + stack + timing retained in `errors[]` of last-task
  view — Dev Mode only.
- Gate failures (cancelled/blocked) are NOT retried.

## 5. Packaging + onboarding

- electron-builder: unsigned both targets (kept). Add comments in config
  explaining signing: Windows → signtool/cert in `win.certificateFile`;
  macOS → Apple Developer ID in `mac.identity`. Note `dmg.sign: false`
  already.
- First-run onboarding (`agent/onboarding.js` main + renderer overlay):
  - Detect permission state per OS on first launch / on demand:
    macOS: Screen Recording (`systemPreferences.getMediaAccessStatus`) —
    Vision; Accessibility (AppleScript `tell application "System Events"`
    keystroke test via `execSync osascript`) — Control.
  - Windows: no OS permission needed for either (flagged as "none needed").
  - Onboarding explains WHY each permission is needed BEFORE the OS prompt
    appears, one screen per permission, with a button that triggers the OS
    prompt (screenshot capture attempt / accessibility test).
- Update README: API key setup, first-run per-OS, risk levels explainer,
  free-tier caveats (rate limits, rotation gaps).

## Files to create
- `src/main/agent/classifier.js`   — intent classification (rules + quick model)
- `src/main/agent/dispatcher.js`   — nova:agent-run loop, narration, taskId
- `src/main/agent/retry.js`        — retryOnce + plain-language formatter
- `src/main/agent/onboarding.js`   — permission checks + onboarding flow
- `src/main/permissions/undo.js`   — reversal registry + undo gate path
- `src/main/test-agent.js`         — headless harness (~50 checks)
- Renderer: `index.html` dev task panel + undo button + onboarding overlay;
  `app.js` agent wiring; `preload.js` new IPCs; `hud.css` styles.

## Files to modify
- `settings.js` — developerMode getter/setter
- `router.js` — lastPick(taskType)
- `action-log.js` — taskId field in append()
- `action-registry.js` — reverse() support
- `test-actions.js` — reverse fns for demo rename/move
- `main.js` — agent-run handler, undo handlers, onboarding kick-off,
  remove renderer-side regex routing? Keep renderer as PASS-THROUGH (every
  message → nova:agent-run; renderer routing removed) — cleaner.
