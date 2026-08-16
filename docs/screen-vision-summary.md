# Nova Screen Vision — Implementation Summary

Screen vision is now live in Nova (commit `b86303f`). It is the first real tool built on top of the permission and safety framework from the previous stage, and it deliberately stays read-only: every capture routes through the framework as the **`vision:capture-screen` Level 0 (READ)** action, executes immediately, and is recorded in the Action Log with a plain-language note — never the image bytes.

## How the pipeline works

Saying or typing one of the trigger phrases — *"what's on my screen"*, *"what am I looking at"*, *"what does this error say"*, *"describe my screen"* — starts the pipeline in `src/main/vision/vision-query.js`:

| Step | Module | Detail |
|------|--------|--------|
| 1. Capture | `screenshot.js` | Electron `desktopCapturer.getSources({ types: ['screen'] })`; on macOS checks `systemPreferences.getMediaAccessStatus('screen')` and reports missing permission |
| 2. OCR | `ocr.js` | Fully offline tesseract.js 7 (WASM) with a local `eng.traineddata` copy; parses HOCR output for words, bounding boxes, and per-word confidence; works in Private Mode |
| 3. UI detection | `ui-detector.js` | Baseline line clustering + horizontal phrase grouping; buttons = short, isolated, Title-Case/CAPS phrases; inputs = colon-ended labels with an empty region to the right (no ML) |
| 4. Reasoning | `vision-query.js` | If not in Private Mode **and** the model router has a free vision model (`pickModel("vision")`), the screenshot + question are sent to OpenRouter; otherwise Nova composes a plain-language answer from the OCR text alone |
| 5. Feedback | renderer | Nova speaks the answer back (`speak()`) and adds it to side-panel history |

## Key design decisions

- **Offline-first OCR.** The tesseract worker is lazily initialized, decodes the screenshot through a temp file (reliable across adapter paths), and all output comes from the engine's HOCR — so screen reading works with no network, including in Private Mode.
- **Private Mode safety.** The vision-model API call is skipped entirely when Private Mode is on or the router is in its no-model fallback state, guaranteeing screen content never leaves the device in that mode.
- **Lightweight action log.** Each capture logs a note such as *"captured screen 1920x1080; platform=macOS; permission=granted"* — the pixel data is never serialized.
- **macOS permission UX.** When Screen Recording permission is missing, Nova shows an in-app banner with instructions and a one-click button that opens System Settings > Privacy & Security > Screen Recording. Windows needs no extra permissioning; Linux short-circuits the check to "granted".
- **No over-engineering.** UI element detection is pure geometry over OCR boxes: about 150 lines, no trained models, and it correctly rejects dense body text from being mis-detected as buttons.

## Verification

| Check | Result |
|-------|--------|
| `npm run test:permissions` | 27/27 PASS (unchanged by the vision additions) |
| `npm run test:vision` | All PASS — OCR text/boxes/confidence, UI detection heuristics (buttons, colon-label inputs, body-text rejection, line clustering), macOS permission reporting, pipeline in Private Mode (OCR-only), network-branch error surfacing, router-fallback path, and 4 logged lightweight action-log entries |
| App launch on Xvfb | Clean — `vision:capture-screen` registers at Level 0 alongside the 5 demo actions |

The new headless harness (`src/main/test-vision.js`) uses the same electron-shim pattern as the permissions test and generates test images with PIL, so it runs on CI without any UI server.

## Notes

- `eng.traineddata` (~5 MB) is gitignored; it is downloaded automatically on first run and then used fully offline.
- The OCR engine currently targets English only; additional languages can be added by extending the worker's language string.
- The sandbox GPU process emits a known `viz_main` error on Xvfb — it does not affect the vision code (verified against empty IPC logs and real toast/modal screenshots).
