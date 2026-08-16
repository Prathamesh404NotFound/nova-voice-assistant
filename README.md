# Nova — Voice-First Desktop AI Assistant

Nova is a cross-platform (Windows + macOS) desktop AI assistant built with **Electron + Node.js**, developed stage by stage with the safety scaffolding built BEFORE any feature that can touch the user's mouse, keyboard, files, or screen. Every message now flows through one **unified agent loop**: an intent classifier (conversation / vision / control / combined) dispatches each message, and Nova narrates each step out loud ("Opening Notepad now…"). Nova can *see* the screen (screenshot + local OCR + optional vision-model reasoning, Level 0 read-only), *act* on it through a safety-gated, rule-based task planner (Level 0–3, strictly routed through the permission framework), *undo* reversible L2 file/text actions for 5 minutes, and *inspect its own behavior* in a Developer Mode panel. No file-system tools are implemented yet.

**Distribution-ready:** electron-builder produces an unsigned Windows NSIS installer and macOS `.dmg` (`npm run build:win` / `npm run build:mac`); first-run onboarding screens explain every OS permission before the OS prompt appears (macOS Screen Recording + Accessibility; Windows needs none). See `docs/SIGNING.md` for how to add code signing later.

## Features

| Area | Implementation |
|------|----------------|
| HUD | Single dark command-center screen: slim top bar (brand, clock, status dot, active-model chip), centered animated orb/waveform visualizer, bottom bar with "Talk to Nova" mic button + live transcript line, collapsible side panel (history + typed input) |
| Voice pipeline | Web Speech API STT → single `submitMessage()` pipeline shared with typed input; `speechSynthesis` TTS with instant barge-in (orb click, mic tap, or saying "stop"/"Nova stop") |
| Wake/arm | Energy-gated VAD; app stays "wake-armed" when idle; continuous-listening toggle **off by default** (opt-in); mic activates only on tap or armed wake |
| Model router | Fetches `GET https://openrouter.ai/api/v1/models` at startup + every 6 h, filters `pricing.prompt == "0" && pricing.completion == "0"`, caches locally with timestamp, `pickModel(taskType)` for `chat/coding/vision/quick` with hardcoded fallback `google/gemini-2.5-flash-001`; every pick logged and visible in Developer Mode |
| Chat | Streams `https://openrouter.ai/api/v1/chat/completions` (picked free model) into orb speech output + side-panel history, sentence-by-sentence for natural barge-in timing |
| Key storage | `OPENROUTER_API_KEY` env var → Electron `safeStorage` (OS keychain) → one-time settings prompt. Never plaintext, never logged |
| Packaging | electron-builder: Windows NSIS `.exe` installer (x64), macOS `.dmg` (universal) |
| Agent loop | Unified dispatcher in `src/main/agent/`: rule-based intent classifier (offline, Private-Mode-safe; ambiguous messages go through `pickModel("quick")` with a safe fallback) → conversation / vision / control / combined pipelines; every step narrated aloud and printed in chat |
| Undo | Reversible L2 file/text actions (registered with a `reverse` fn) are undoable for 5 minutes via the Undo button; irreversible actions (clicks, key presses, L3+) keep it disabled; undo itself is logged (`::undo`) |
| Developer Mode | Settings toggle; side panel shows the last task — model used and why, intent classification, generated plan, per-step risk level + timing, and raw errors with stack traces (data source: Action Log + last-task record) |
| Retries | Every model call and pipeline step retries once automatically (`retryOnce`), then surfaces a plain-language error in chat; stack traces live only in Developer Mode |
| Onboarding | macOS first-run: explains Screen Recording (vision) and Accessibility (mouse/keyboard) before the OS prompts, with per-permission acknowledgement; Windows/Linux need no OS permissions |
| Indicators | Small model chip in top bar (click = refresh list / open side panel) + Developer Mode panel in side panel |
| Screen vision | Saying or typing "what's on my screen", "what am I looking at", "what does this error say", "describe my screen" captures the screen via `desktopCapturer`, runs fully offline tesseract.js OCR (works in Private Mode), detects button-like / input-like UI regions from OCR bounding boxes, and — when not in Private Mode and a free vision model is available — sends the screenshot + question to a vision-capable model via the router; otherwise answers from OCR text alone; every capture is logged to the Action Log as Level 0 with a note (never the image bytes) |
| Mouse/keyboard control | Rule-based task planner compiles instructions like "open the system calculator and compute 12 x 8" into a checklist shown before execution; `@nut-tree-fork/nut-js` simulation (move/click/right-click/double-click/scroll/drag/type/press-keys) at L0–L3 with `physical` flag (L2+ blocked in Private Mode); hard kill-switch: `Ctrl+Shift+Esc` global hotkey + STOP button + "nova stop" barge-in; mid-sequence vision verification (screenshot + OCR confirms expected text before continuing); every step logged with outcome |
| Safety framework | 5 risk levels (L0 Read → L4 Destructive), per-action permission gate (L0–1 immediate / L2 cancellable 5s toast / L3–4 explicit Confirm modal in plain language), persistent action log (JSON, newest first, exportable), dry-run `simulate()` paths for L2+, global Private Mode (blocks all outbound network except OpenRouter, persistent 🔒 PRIVATE badge) |

## Run

```bash
npm install
# key via env var:
OPENROUTER_API_KEY=sk-or-... npm start
# or set it in the in-app Settings overlay (stored with OS keychain)
npm run dev        # runs with --dev flag
```

## Build installers

```bash
npm run build:win   # Windows NSIS .exe — cross-builds from Linux/macOS (wine required on Linux)
npm run build:mac   # macOS .dmg — must be built on macOS (dmg-license's native module is darwin-only)
npm run build:all   # all platforms (only works on macOS + wine)
```

Cross-platform build note: the Windows target builds fine from Linux with `wine64` installed (`sudo apt-get install wine64`). The macOS DMG target depends on `dmg-license`/`iconv-corefoundation`, whose native binary is darwin-only — on Linux the mac build falls back gracefully only if you build on a Mac or CI runner (GitHub Actions `macos-latest` works out of the box).

## Permission & safety framework

Every future tool plugs into `src/main/permissions/`:

| Module | Role |
|--------|------|
| `risk-levels.js` | Shared `RISK_LEVEL` enum (READ 0 → DESTRUCTIVE 4) and `riskLabel()` |
| `action-registry.js` | `registerAction({ id, level, description, execute, simulate })` — every tool declares its level |
| `gate.js` | `runAction(id, payload, { dryRun })` — routes by level: L0–1 immediate, L2 toast (5 s cancel window), L3–4 native Confirm/Cancel modal with a plain-language description built from `simulate({ __describe: true })`; Private Mode blocks L3+ |
| `action-log.js` | Persistent log at `userData/actions.log.json` — action id, level, timestamp, outcome (`success`/`failed`/`cancelled`/`dry-run`); newest first, capped at 500 entries |
| `settings.js` | `setPrivateMode(on)` persisted to `userData/settings.json`, notifies renderer |
| `test-actions.js` | Dummy harness actions (`demo:read-files` L0, `demo:open-app` L1, `demo:rename-file` L2, `demo:send-message` L3, `demo:delete-files` L4) — wired behind side-panel demo buttons for manual verification |

In-app: the side panel hosts a **Private Mode toggle** (🔒 PRIVATE badge appears in the top bar while on), an **Action Log** section (newest first, Export JSON, Clear), and **demo-action buttons** to exercise each gate path. Dry runs are available for anything Level 2+.

```bash
npm run test:permissions   # headless self-test — 27 checks across all gate paths
```

Dev-only verification flag: `electron . --run-demo-action <actionId>` fires a single demo action through the gate after the window shows (useful for visual checks in CI/Xvfb).

## Screen vision (Level 0, read-only)

Screen reading lives in `src/main/vision/` and is the first feature built on top of the safety framework. All vision actions route through `runAction("vision:capture-screen", ...)` (Level 0 — executed immediately, but still logged):

| Module | Role |
|--------|------|
| `screenshot.js` | `desktopCapturer.getSources({ types: ['screen'] })` capture; on macOS detects missing Screen Recording permission (`systemPreferences.getMediaAccessStatus`) and offers setup instructions + a button that opens the correct System Settings pane |
| `ocr.js` | Offline tesseract.js (WASM) OCR — lazy worker init, temp-file decoding, HOCR parsing for words + bounding boxes + per-word confidence; works fully offline and in Private Mode |
| `ui-detector.js` | Baseline line clustering + horizontal phrase grouping; buttons = short isolated Title-Case/CAPS phrases, inputs = colon-ended labels with an empty region to the right (no ML) |
| `vision-query.js` | Full pipeline: capture → OCR → UI detection → vision-model call (`pickModel("vision")`, skipped in Private Mode or when the router is in fallback/no-vision-model state) → plain-language answer; OCR-only fallback path |

Voice trigger phrases (in the shared `submitMessage` path, typed and voice both): `what's on my screen`, `what is on my screen`, `what am I looking at`, `describe my screen`, `read the screen`, `what does this error/message say`, and more.

```bash
npm run test:vision    # headless self-test — OCR, UI detection, permission paths, pipeline fallbacks, action-log entries
```

The OCR engine downloads `eng.traineddata` on first run (auto-stored at the repo root; gitignored) — after that, all OCR is local. macOS users must grant Screen Recording access before vision commands work; Nova shows an in-app banner with a one-click button to open System Settings > Privacy & Security > Screen Recording when permission is missing.

## Mouse & keyboard control (L0–L3, safety-gated)

The highest-risk feature so far — every control action routes through the same permission gate, action log, and Private Mode as everything else. Simulation runs on `@nut-tree-fork/nut-js` v4.2.6 (prebuilt binaries, cross-platform) wrapped in `src/main/control/input.js`:

| Action | Level | Notes |
|--------|-------|-------|
| `control:cursor-position`, `control:move-cursor` | L0 | Read-only cursor inspection / movement |
| `control:open-app`, `control:wait-for-window` | L1 | Cross-platform launcher (`control/launcher.js` — resolves `calc` → `Calculator` / `calc.exe` / `gnome-calculator` by OS) |
| `control:left-click`, `right-click`, `double-click`, `scroll`, `drag`, `type-text` | L2 | **Physical** — cancellable 5 s toast; **blocked entirely in Private Mode** |
| `control:press-keys` | L3 | Combos; destructive ones (`Ctrl/Cmd+W`, `Alt+F4`, `Ctrl/Cmd+Q`, `Ctrl+Z`) escalate to the Confirm modal; harmless ones (`Ctrl+T` etc.) stay L2 |

A **rule-based task planner** (`control/planner.js` — deliberately not LLM-based) compiles instructions like `"open the system calculator and compute 12 x 8"` into an ordered step list (`open-app → wait-for-window → type-text → press-keys Return`) with expression normalization (`12 x 8` → `12 * 8`, `divided by` → `/`), refusal of non-numeric compute payloads, typing-length caps, and a risk level per step. The plan renders as a checklist in the renderer *before* anything above Level 1 executes, and `control/runner.js` executes steps one at a time, emitting progress events (`running / done / verified / failed / aborted / cancelled`) that drive the visible checklist.

**Kill-switch — three paths converging on `sequence.abort()`:** the global hotkey `Ctrl+Shift+Esc` (registered after `app.whenReady()`), the visible STOP button in the HUD topbar, and the barge-in phrase `nova stop`. The runner checks the kill-switch via `guardStep()` before *every* step, so a mid-step abort reports cleanly (`finished: "aborted"` with the interrupted step id) instead of crashing. A cancelled gate outcome (or a Private Mode block) halts the sequence with `finished: "failed"` and marks remaining steps `cancelled` in events and the action log — never silently skipped.

**Vision verification mid-sequence:** steps with `verify: { contains }` (set by the planner for `wait-for-window` and compute steps) screenshot the screen and OCR it — reusing `vision/screenshot.js` + `vision/ocr.js`, so verification works offline and in Private Mode — retrying within a 3 s budget before failing the step and halting the sequence with a `verification failed: …` note that reaches the renderer events.

```bash
npm run test:control   # headless self-test — planner rules, kill-switch states, gate flow,
                       # abort/cancel/block halting, vision verification, registry + launcher
```

**Demo:** say or type `"open the system calculator and compute 12 x 8"` — Nova shows the 4-step checklist, executes with toast/modal confirmations per level, verifies the calculator window on screen before typing, types `12 * 8`, presses Return, and logs every step. `Ctrl+Shift+Esc`, the STOP button, or `nova stop` halt it at any point.

## Unified agent loop (Stage 5)

All voice and text input now flows through `src/main/agent/` — one loop with an intent classifier at the front and a dispatcher behind it. Every handled message returns a spoken narration (`dispatcher.on("progress", e => e.type === "narration")`) that the renderer speaks aloud with TTS and also prints in chat:

| Module | Role |
|--------|------|
| `classifier.js` | Rule-based intent classification (conversation / vision / control / combined) — no LLM round-trip for unambiguous messages, works offline and in Private Mode; genuinely ambiguous messages (both screen-question hints and action verbs) go through `pickModel("quick")` and fall back to a safe combined path if the call fails |
| `dispatcher.js` | `run(text, { getKey, runVisionQuery })` — classifies, dispatches to the conversation stream / vision pipeline / control planner / combined path, records a **last-task** object (classification, model used, steps with per-step timings, raw errors) for the Developer Mode inspector |
| `retry.js` | `retryOnce(fn, label)` — one automatic retry on any failure, then `plainError(err, "the assistant")` returns a user-readable string with the raw error available only in Developer Mode |
| `onboarding.js` | macOS first-run: detects denied Screen Recording (`systemPreferences.getMediaAccessStatus("screen")`) and missing Accessibility access (AppleScript probe), exposes `pendingScreens()` / `acknowledge(id)` / `runAccessibilityTest()` (the keystroke that triggers the real OS prompt). Windows/Linux need no OS permissions. |
| `undo-bridge.js` | IPC surface (`nova:undo-info`, `nova:undo-last`) for the renderer Undo button |

**Undo (L2 reversibility):** `permissions/undo.js` watches successful `noteReversibleSuccess(...)` calls from the gate. Actions registered with a `reverse` fn (e.g. `demo:rename-file`, `demo:move-file`; file/text actions in future stages) are undoable for 5 minutes; irreversible actions (clicks, key presses, L3+) never register, so the **Undo** button stays disabled for them. Undo is itself logged (`<actionId>::undo`) in the Action Log.

**Developer Mode:** the Settings toggle persists `developerMode` in `settings.json`; when on, the side panel shows the last task — model picked and why (`router.lastPick()`), the intent classification, the control plan, per-step risk levels and timings, and every raw error with stack trace. The source is the Action Log (`taskId` now flows through `gate.runAction` into every entry) plus the dispatcher's last-task record.

**Retry policy:** every model call and pipeline step goes through `retryOnce` — exactly one automatic retry, then a plain-language error in chat. Stack traces never reach the user outside Developer Mode.

```bash
npm run test:agent   # headless self-test — 38 checks: classification rules, quick-model
                     # fallback, retry + plain errors, dispatcher paths + narration +
                     # streaming, last-task inspector, undo end-to-end, darwin onboarding
```

```bash
npm run test         # everything: agent + permissions + control + vision + files
```

## Voice-driven file management (Stage 6)

All file operations live in `src/main/files/` and — by design — go through the exact same permission gate, Action Log, and undo framework as vision and control. Nothing in this stage ever deletes permanently: even Level 4 deletes go to the **OS Recycle Bin / Trash** (`toolbox.moveToTrash` — PowerShell `VB.FileSystem::DeleteFile` on Windows, `osascript` Finder delete on macOS, `gio trash` on Linux), so the OS-level undo still works outside Nova's own Undo button.

| Action | Level | Notes |
|--------|-------|-------|
| `files:search`, `files:detect-duplicates`, `files:folder-stats` | L0 | Read-only, runs immediately; search defaults to Documents / Downloads / Desktop ("search everywhere" widens it); dup-detect is SHA-256 hash-based, not name-based |
| `files:organize`, `files:remove-duplicates`, `files:move-files`, `files:copy-files`, `files:rename-file` | L2 | Reversible — cancellable 5 s toast; each has a `reverse` fn so Nova's Undo restores within 5 minutes |
| `files:delete-files` | L4 | Confirm modal with the exact file list; **never** a bare "delete junk files" — vague requests are refused at the planning layer with a pointer to the dry-run preview flow |

**Organize/tidy is preview-first, always.** `"clean up my Downloads folder"` never moves a file immediately: `files:organize` is required to dry-run first (the gate path with `{dryRun: true}` calls `simulate()`, and the action's `execute()` refuses to run without a preview token). The dispatcher stores the dry-run report in a short-lived `pendingPreviews` map keyed by a one-shot token and emits a `file-preview` event; the renderer shows a preview card (e.g. `Documents/ (12 files)  Images/ (23 files)  Installers/ (4 files)`) with Confirm / Cancel. Only `nova:files-execute` with the exact token performs the real moves. Organize is also **only-loose** — files already inside subfolders are left alone.

**"This file" file context:** search / dup-detect results are remembered by the dispatcher, so follow-ups like `"move this file to Documents"` or `"delete this file"` resolve against the last result without repeating the search. Named files from a previous search (`"get rid of setup.exe"`) also resolve when they appear in context.

```bash
npm run test:files   # headless self-test — 80+ checks: registration + risk levels +
                     # reverse fns, toolbox primitives, NL planning + intent
                     # classification, L0/L2/L4 gate paths, organize dry-run accept
                     # AND reject, one-shot preview tokens, bulk-undo via the stored
                     # execute result, mock OS-trash delete, refusal cases
```

**Demo:** say or type `"find my resume"`, `"how much space is Downloads taking up"`, `"clean up my Downloads folder"`, `"move this file to Documents"`. The last one shows the 5 s cancellable toast before moving; the organize flow shows the preview card first and moves nothing until you confirm it.

**Design note on the undo bridge:** bulk reversals (organize/move/copy) need the actual moved/copied list, which only exists after `execute()`. `gate.js` now stores the execute result on the registry entry (`action.lastResult`), and `undo.js` merges it into the reverse payload — single-file reversals (rename) keep using the original payload.

## Test the model router headlessly

```bash
npm run test:router
```

Fetches the live free-model list, prints counts, per-task picks, and pick logs.

## Architecture

```
src/
├── main/
│   ├── main.js        Electron lifecycle, IPC handlers, window chrome
│   ├── router.js      OpenRouter free-model router (fetch, cache, pickModel)
│   ├── keys.js        API key: env → safeStorage → one-time prompt
│   ├── settings.js    Settings persistence (Private Mode)
│   ├── permissions/   Safety framework (risk levels, registry, gate, action log, demo actions)
│   ├── test-router.js Headless router self-test (electron shim)
│   ├── test-permissions.js Headless permission-gate self-test (electron shim)
│   ├── test-vision.js Headless screen-vision self-test (electron shim, PIL-generated test images)
│   ├── test-control.js Headless mouse/keyboard-control self-test (electron shim, mock input engine)
│   ├── vision/ Screenshot capture, offline OCR, UI detection, vision-query pipeline
│   └── control/ nut-js input wrapper, cross-platform launcher, rule-based planner, kill-switch,
│                 vision verification, step runner
├── preload/preload.js contextBridge API — renderer has no Node access
└── renderer/
    ├── index.html     Single-screen HUD
    ├── css/hud.css    Dark command-center styling (Orbitron + Space Grotesk)
    └── js/app.js      Orb visualizer, mic, STT, TTS barge-in, streaming chat, vision trigger phrases, screen-permission help banner
```

The renderer performs the OpenRouter fetch directly (renderer-side fetch avoids IPC streaming complexity; CSP `connect-src` restricts it to `https://openrouter.ai`).

## Known limitations (flagged in-app and here)

1. **Web Speech STT requires internet** — audio flows to the OS speech service while recognition is active. This is flagged in the HUD footer.
2. **Wake word** — an open-source pure-JS keyword spotter for an exact "Hey Nova" phrase with offline guarantees is not yet available in the JS ecosystem (Porcupine's SDK is commercial and native-per-architecture; sherpa-onnx is a heavy native addon). This stage uses an energy-gate VAD that arms recognition, so audio capture only begins on tap or wake. A native wake-word addon can be dropped in later without touching the pipeline.
3. **In-app settings prompt** uses a renderer overlay dialog; Electron's native `dialog.showInputBox` is used where available.
4. **safeStorage on Linux** may fall back to in-memory storage when libsecret is missing — flagged in logs.
5. **Screen vision on headless/CI environments** — `desktopCapturer` needs a real display server (Xvfb works for testing, but captures may be empty windows). macOS always requires the Screen Recording grant; Windows works without extra permissioning.
6. **Free-tier model rotation (OpenRouter)** — the free-model list is fetched at startup and every 6 h and cached locally; models can rotate out without notice, so some task types may temporarily have no free model (the router falls back to a hardcoded `google/gemini-2.5-flash-001` and logs every pick). Free models carry rate limits (roughly 20 requests/minute and 200 requests/hour per account key, per OpenRouter's terms — unauthenticated and authenticated tiers differ), so bursts of voice commands can hit `429 Too Many Requests`; `retryOnce` auto-retries once, then tells the user plainly to wait a moment. Occasional higher latency and lower quality on free tiers are expected.
7. **Ambiguous-intent quick classification** runs one model round-trip per ambiguous message; if it fails (rate limit, network, offline), the classifier safely defaults to the combined path — never silent failure.
8. **Undo limits** — only actions registered with a `reverse` function are reversible, and only within 5 minutes of success; mouse clicks, key presses, and anything L3+ can never be undone and the button stays disabled for them.
9. **Control input simulation on macOS** additionally requires the Accessibility grant — the first-run onboarding screen explains this before the OS prompt; Nova detects a missing grant and gates control sequences until it is granted.
10. **Vision-model reasoning needs an API key and internet** — in Private Mode or when no free vision model is available, Nova answers from OCR text alone, so vision never leaks screen content off-device in that mode.

## Packaging notes

- `assets/icon.ico` and `assets/icon.png` are included; electron-builder derives `.icns` from the PNG when building on non-macOS hosts (or generate properly with `iconutil` on a Mac).
- NSIS installer allows directory choice and creates a desktop shortcut.
- The DMG is unsigned (`sign: false`) for local distribution; notarization is required for wider macOS distribution.
