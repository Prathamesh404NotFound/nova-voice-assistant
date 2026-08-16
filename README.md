# Nova — Voice-First Desktop AI Assistant

Nova is the foundation stage of a cross-platform (Windows + macOS) desktop AI assistant built with **Electron + Node.js**. This stage covers **voice/chat interaction, model routing, the permission & safety framework, and screen vision** — the safety scaffolding exists BEFORE any feature that can touch the user's mouse, keyboard, or files. Nova can now *see* the screen (screenshot + local OCR + optional vision-model reasoning), which is the first real tool and it is wired through the permission framework as a Level 0 (read-only) action. No file-system, mouse, or keyboard tools are implemented yet.

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
| Indicators | Small model chip in top bar (click = refresh list / open side panel) + Developer Mode panel in side panel |
| Screen vision | Saying or typing "what's on my screen", "what am I looking at", "what does this error say", "describe my screen" captures the screen via `desktopCapturer`, runs fully offline tesseract.js OCR (works in Private Mode), detects button-like / input-like UI regions from OCR bounding boxes, and — when not in Private Mode and a free vision model is available — sends the screenshot + question to a vision-capable model via the router; otherwise answers from OCR text alone; every capture is logged to the Action Log as Level 0 with a note (never the image bytes) |
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
│   └── vision/ Screenshot capture, offline OCR, UI detection, vision-query pipeline
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
6. **Vision-model reasoning needs an API key and internet** — in Private Mode or when no free vision model is available, Nova answers from OCR text alone, so vision never leaks screen content off-device in that mode.

## Packaging notes

- `assets/icon.ico` and `assets/icon.png` are included; electron-builder derives `.icns` from the PNG when building on non-macOS hosts (or generate properly with `iconutil` on a Mac).
- NSIS installer allows directory choice and creates a desktop shortcut.
- The DMG is unsigned (`sign: false`) for local distribution; notarization is required for wider macOS distribution.
