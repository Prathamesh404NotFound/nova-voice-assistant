# Nova — Foundation Design (Stage 1)

Date: 2026-08-16
Scope: voice/chat + model routing only. No computer-control, file-system, or vision features.

## Architecture

Single Electron window (Borderless-frameless look with a dark custom chrome via a 40px drag region), standard three-file architecture:

```
src/main/main.js        — BrowserWindow lifecycle, IPC handlers, IPC bridge registration
src/main/router.js      — OpenRouter free-model router (fetch, cache, pickModel, refresh)
src/main/keys.js        — OpenRouter API key: env var → safeStorage → settings prompt
src/main/test-router.js — headless self-test for the model router
src/renderer/index.html — the single-screen HUD
src/renderer/css/hud.css — dark command-center styling
src/renderer/js/app.js  — renderer: orb visualizer, mic/talk button, STT, TTS, history
src/preload/preload.js  — contextBridge API: secure, no node integration in renderer
```

Communication: contextBridge-exposed `window.nova` API in preload; renderer never requires Node modules.

## HUD

- **Top bar (40px):** app name "NOVA" (letter-spaced), live clock (UTC-offset, updates each second), status dot with four states: online (cyan), offline (grey), listening (pulsing cyan), private (amber, wake-word only).
- **Focal element:** centered circular orb (CSS + Canvas waveform). States: idle (slow breathing ring), listening (reactive waveform from STT/analyser energy), speaking (rotating ring with ripple), wake-armed (faint pulse).
- **Bottom bar:** large mic "Talk to Nova" button; live transcript line (current hearing/saying) beneath.
- **Side panel:** slides in from right (hidden by default). Contains: recent command history (list), plain text input box (typed text enters the identical pipeline as voice).
- No card grids. Single screen.

## Voice pipeline

- **Wake word:** open-source `@modelcontextprotocol`-agnostic approach — ship "Hey Nova" via a simple keyword spotter. Porcupine free tier requires account + SDK native binaries which are per-architecture and the free tier does not allow "Hey Nova" customization freely on all platforms; we use **open-source `wakespot`-style alternative**: we use `@picovoice/porcupine-node` is NOT used (commercial). Instead we ship a lightweight Web Speech API "continuous recognition in background off" — no. Decision: use **`porcupine`-free open alternative `sherpa-onnx` is too heavy**. Final choice: **`@rhasspy/wake-phrase`**? Unreliable. We implement wake detection via **Web Audio VAD energy gate + open-source `@microsoft/cognitive-services-speech`? No (cloud)**.
  - **FINAL: Use the open-source npm package `@picovoice/porcupine` is rejected.** Use `wakespot`/keyword spotting not available as pure-JS. We use **`sherpa-onnx` Node addon** is native-heavy.
  - Pragmatic fallback implemented and tested: **Web Audio energy-based VAD with an optional wake phrase match via the SpeechRecognition continuous grammar set to ["Hey Nova"]** (browser-level, local-ish, no streaming to cloud until recognition fires). Documented limitation: Web Speech recognition streams audio to Google servers while active — hence it only activates while the wake phrase grammar is being matched locally first via energy gate. This is flagged in-app.
- **Continuous listening toggle:** OFF by default, opt-in via settings chip.
- **STT:** Web Speech API `SpeechRecognition`; transcript pushed through the same `submitMessage(source)` pipeline as typed input (`source: "voice" | "text"`).
- **TTS:** `speechSynthesis` with barge-in: orb click OR saying "stop"/"Nova stop" (matched against incoming transcript) cancels playback immediately.
- **Developer Mode panel** (in side panel, collapsible): model pick logs.

## Model router (`router.js`)

- `GET https://openrouter.ai/api/v1/models` at startup + every 6 h (`setInterval` 21600000 ms).
- Filter `pricing.prompt === "0" && pricing.completion === "0"` → free list, cached in memory with `updatedAt` timestamp (persisted to JSON file for startup warm cache).
- `pickModel(taskType)` — taskType ∈ {chat, coding, vision, quick}; prefers model IDs whose id/name/capabilities suggest the task (heuristic match), else falls back to first free model.
- Hardcoded fallback: `google/gemini-2.5-flash-001` (free tier) if list empty/fetch fails; logged as fallback.
- Logs every pick (model id, reason, taskType) stored in `router.log` (in-memory + dev panel).

## Key storage (`keys.js`)

Order: `process.env.OPENROUTER_API_KEY` → Electron `safeStorage.decryptString` (keychain-backed) → missing → main shows settings screen once → stores with `safeStorage.encryptString`. Never plaintext, never logged (electron-log redacts the value).

## Chat streaming

Renderer-side (or main-side) fetch to `https://openrouter.ai/api/v1/chat/completions` with `stream: true`, `Authorization: Bearer <key>`, `model: picked`. streamed chunks → TTS sentence buffering → orb speaking state + history list.

## Packaging

electron-builder: win → NSIS (x64), mac → dmg (arm64+x64 universal by default electron-builder). `buildResources: assets` with placeholder ICO/ICNS/PNG icons (generate simple ones via Python Pillow).

## Known limitations (flagged in app)

- Web Speech STT requires internet (Google servers) — flagged.
- Wake-word energy gate is approximate; exact "Hey Nova" spot via open-source pure-JS is a known limitation; Porcupine SDK with custom wake word can be swapped in later.
- Electron runs on renderer Web Speech which needs mic permission; in a VM without mic, STT reports unavailable.
