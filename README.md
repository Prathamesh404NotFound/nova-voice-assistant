# Nova — Voice-First Desktop AI Assistant

Nova is the foundation stage of a cross-platform (Windows + macOS) desktop AI assistant built with **Electron + Node.js**. This stage covers **voice/chat interaction, model routing, and the permission & safety framework** — the safety scaffolding exists BEFORE any feature that can touch the user's mouse, keyboard, files, or screen. No real computer-control, file-system, or vision tools are implemented yet; dummy test actions verify every confirmation flow.

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
npm run test:permissions   # headless self-test — 26 checks across all gate paths
```

Dev-only verification flag: `electron . --run-demo-action <actionId>` fires a single demo action through the gate after the window shows (useful for visual checks in CI/Xvfb).

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
│   └── test-permissions.js Headless permission-gate self-test (electron shim)
├── preload/preload.js contextBridge API — renderer has no Node access
└── renderer/
    ├── index.html     Single-screen HUD
    ├── css/hud.css    Dark command-center styling (Orbitron + Space Grotesk)
    └── js/app.js      Orb visualizer, mic, STT, TTS barge-in, streaming chat
```

The renderer performs the OpenRouter fetch directly (renderer-side fetch avoids IPC streaming complexity; CSP `connect-src` restricts it to `https://openrouter.ai`).

## Known limitations (flagged in-app and here)

1. **Web Speech STT requires internet** — audio flows to the OS speech service while recognition is active. This is flagged in the HUD footer.
2. **Wake word** — an open-source pure-JS keyword spotter for an exact "Hey Nova" phrase with offline guarantees is not yet available in the JS ecosystem (Porcupine's SDK is commercial and native-per-architecture; sherpa-onnx is a heavy native addon). This stage uses an energy-gate VAD that arms recognition, so audio capture only begins on tap or wake. A native wake-word addon can be dropped in later without touching the pipeline.
3. **In-app settings prompt** uses a renderer overlay dialog; Electron's native `dialog.showInputBox` is used where available.
4. **safeStorage on Linux** may fall back to in-memory storage when libsecret is missing — flagged in logs.

## Packaging notes

- `assets/icon.ico` and `assets/icon.png` are included; electron-builder derives `.icns` from the PNG when building on non-macOS hosts (or generate properly with `iconutil` on a Mac).
- NSIS installer allows directory choice and creates a desktop shortcut.
- The DMG is unsigned (`sign: false`) for local distribution; notarization is required for wider macOS distribution.
