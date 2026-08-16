# Stage 5 — Unified Agent Loop & Distribution Readiness

**Nova · 2026-08-17 · commits: staged with "Add unified agent loop: intent classifier + dispatcher + narration + undo + dev mode + onboarding + packaging"**

Stage 5 ties every previously built capability into a single coherent agent loop and finalizes packaging for distribution.

## 1. Unified agent loop (`src/main/agent/`)

Every voice or text message now flows through `dispatcher.run(text)` in the main process instead of renderer-side regex routing:

| Module | What it does |
|--------|--------------|
| `classifier.js` | Rule-based intent classification (`conversation` / `vision` / `control` / `combined`). Unambiguous messages are classified locally with zero latency — no LLM round-trip, works offline and in Private Mode. Genuinely ambiguous messages (screen-question hints **and** action verbs) go through one cheap `pickModel("quick")` call; if it fails, a safe `combined` fallback is used. |
| `dispatcher.js` | Routes the classified intent: conversation streams through OpenRouter (with step narration), vision runs the capture+OCR(+model) pipeline, control compiles the planner's checklist and enters the review state, combined runs vision first then control. Emits `progress` events (`narration`, `chat-chunk`) that the renderer speaks aloud and prints in chat. Records a full **last-task** record — classification, model, steps with timings, raw errors — for Developer Mode. |
| `retry.js` | `retryOnce(fn, label)` retries any failing model call or pipeline step exactly once, then converts the error via `plainError()` into a user-readable string. Stack traces only surface in Developer Mode. |
| `onboarding.js` | macOS first-run permission onboarding: detects denied Screen Recording and missing Accessibility access, lists pending screens, records per-permission acknowledgement, and `runAccessibilityTest()` performs the keystroke that triggers the real OS Accessibility prompt. Windows/Linux report "not-needed". |
| `undo-bridge.js` | IPC surface (`nova:undo-info` / `nova:undo-last`) powering the renderer Undo button. |

**Narration** — Nova speaks every step out loud (e.g. "Opening Notepad now…"): dispatcher emits `narration` events with the step name; the renderer speaks each one once and shows it as a small chat entry.

## 2. Developer Mode task inspector

- New `developerMode` setting toggle (`settings.js`, persisted in `settings.json`, synced to renderer via `nova:settings-changed`).
- Side panel shows the **last task**: model picked and why (`router.lastPick()`), intent classification and confidence, generated control plan, each tool call with its risk level, per-step `durationMs`, and every raw error with stack trace.
- Data sources: the Action Log (a `taskId` now flows from `dispatcher.run` → `gate.runAction` into every log entry, including control steps via `runner.runSequence({ taskId })`) plus the dispatcher's last-task record.

## 3. Undo support (`src/main/permissions/undo.js`)

- Gate calls `noteReversibleSuccess(taskId, actionId, payload, outcome)` after every L2+ action; only `outcome === "success"` and a registered `reverse` fn qualify.
- Reversible actions stay undoable for **5 minutes** (`getUndoInfo()` returns `secondsAgo < 300`); the renderer's Undo button enables/disables accordingly.
- Irreversible actions (mouse clicks, key presses, anything L3+, anything without a `reverse` fn) never register — Undo stays greyed out, as required.
- Performing undo runs the reverse fn, logs `<actionId>::undo` (Level 2) in the Action Log, and clears the undoable entry.
- Harness demo actions extended: `demo:create-file` (L2, no reverse — proves the disabled path) and `demo:move-file` reverse registered alongside `demo:rename-file`.

## 4. Error handling & retries

Every model call and pipeline step runs through `retryOnce`: one automatic retry, then a plain-language error in chat ("I could not reach the assistant — please try again in a moment"). Raw errors with stack traces live only in the last-task Developer Mode view.

## 5. Packaging & first-run onboarding

- `electron-builder` config finalized: Windows NSIS `.exe` (x64, `oneClick: false`), macOS `.dmg` (universal, `category: public.app-category.productivity`). **Both are unsigned** — see `docs/SIGNING.md` for the exact env vars to add later (`WIN_CSC_LINK` + EV certificate for Windows; `CSC_LINK`/`CSC_KEY_PASSWORD` + `CSC_IDENTITY_AUTO_DISCOVERY` + `notarize: true` for macOS notarization).
- First-run onboarding: renderer overlay with one screen per pending permission, explaining **why** each is needed ("Reading your screen", "Controlling the mouse and keyboard") **before** the OS prompt; an "Allow" button triggers the OS dialog (keystroke for Accessibility, capture for Screen Recording). Windows/Linux skip entirely.
- CI: build matrix scaffolding ready in `.github/workflows/` (Windows build on `windows-latest` with signing env; macOS build on `macos-latest` with notarization env — signing secrets not yet configured, by design).

## Tests

New `npm run test:agent` — **38/38 PASS**: classification rules + quick-model fallback + safe failure default; `retryOnce` transient vs fatal; `plainError` contains no stack trace; dispatcher conversation with mocked SSE stream (retry, chunks, narration events); missing-key placeholder; control planning + review state + narration; last-task inspector (classification, steps, durations, model pick); undo end-to-end (register / irreversible ignored / reversed / logged / cancelled-and-failed rejected); darwin-mocked onboarding (denied → pending → acknowledged).

Full matrix green:

```
test:agent        38/38 PASS
test:permissions  27/27 PASS
test:control      72/72 PASS
test:vision       27/27 PASS
app boot (Xvfb)   clean — kill-switch hotkey registers after app.whenReady()
```

## Known caveats carried forward

- Undo applies only to actions with a registered `reverse` fn, within 5 minutes.
- Ambiguous-intent classification makes one extra model call per ambiguous message.
- Free-tier model rotation and OpenRouter rate limits (see README "Known limitations").
- Distribution builds are unsigned; signing requires EV certificate (Windows) and Apple Developer ID (macOS).
