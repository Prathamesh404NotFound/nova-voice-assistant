# Nova — Voice-First Desktop AI Assistant

Nova is a cross-platform (Windows + macOS) desktop AI assistant built with **Electron + Node.js**, developed stage by stage with the safety scaffolding built BEFORE any feature that can touch the user's mouse, keyboard, files, or screen. Every message now flows through one **unified agent loop**: an intent classifier (conversation / vision / control / files / notes / combined) dispatches each message, and Nova narrates each step out loud ("Opening Notepad now…"). Nova can *see* the screen (screenshot + local OCR + optional vision-model reasoning, Level 0 read-only), *act* on it through a safety-gated, rule-based task planner (Level 0–3, strictly routed through the permission framework), *manage files* by voice (search, duplicate detection, organize-tidy with mandatory dry-run preview, move/copy/rename, OS-Recycle-Bin delete — Level 0/2/4), keep *fully on-device notes, reminders and tasks* with OS notifications and keyword search, *undo* reversible L2 actions for 5 minutes, and *inspect its own behavior* in a Developer Mode panel.

**Distribution-ready:** electron-builder produces an unsigned Windows NSIS installer and macOS `.dmg` (`npm run build:win` / `npm run build:mac`); first-run onboarding screens explain every OS permission before the OS prompt appears (macOS Screen Recording + Accessibility; Windows needs none). See `docs/SIGNING.md` for how to add code signing later.

## Features

| Area | Implementation |
|------|----------------|
| HUD | Single dark command-center screen: slim top bar (brand, clock, status dot, active-model chip), centered animated orb/waveform visualizer, bottom bar with "Talk to Nova" mic button + live transcript line, collapsible side panel (history + typed input) |
| Voice pipeline | Web Speech API STT → single `submitMessage()` pipeline shared with typed input; `speechSynthesis` TTS with instant barge-in (orb click, mic tap, or saying "stop"/"Nova stop") and per-user voice customization (voice picker, speed/pitch sliders, mute) stored only in `localStorage` |
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
| Voice file management | "find my resume", "find duplicate files in Downloads", "clean up my Downloads folder", "move this file to Documents" — hash-based dup detection, mandatory dry-run preview for organize/remove-duplicates (one-shot preview token, only-loose files), cancellable 5 s toast for move/copy/rename, L4 delete to OS Recycle Bin only, vague-delete refusal, all through the gate/Action Log/undo |
| Local notes & reminders | Fully on-device `userData/notes.json` store; "Nova, note that [X]" timestamped notes, timed reminders via 30 s polling scheduler firing the Electron Notification API once-only (spoken aloud when focused), flat task list with "mark done", keyword search, Notes/Tasks side-panel tab, note content never sent to OpenRouter — only an explicit "summarize my notes" (refused in Private Mode) |
| Knowledge base | Point Nova at folders (voice: "add this folder to my knowledge base") — walks the folder with depth/file limits and a progress line, extracts `.txt/.md/.pdf/.docx` locally, chunks with overlap, and builds a **fully local** 384-d embeddings index (ONNX MiniLM via transformers.js, cached on disk; deterministic local hasher fallback, no network ever needed for indexing); folders are watched with chokidar and only changed/new files re-index; queries embed locally, retrieve the top chunks, and only then send **just those snippets + the question** to `pickModel("chat")` — never raw documents; answers always name their source files with clickable "view source" links that open the file; Private Mode refuses KB search outright with a plain explanation; removal deletes index data only, never the originals |
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
npm run test:agent && npm run test:kb   # agent loop + knowledge base (Stage 8)
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

## Local notes, reminders & tasks (Stage 7)

Everything in this module is **fully on-device**. The store is a single JSON file at `userData/notes.json` (atomic writes, no cloud account, no external calendar), and note content **never leaves the machine** — the model router is never handed notes text. The only exception is an explicit user request to `"summarize my notes"`: that one action sends only the note texts for that single request through the normal router flow, and it is refused outright in Private Mode.

All notes actions are registered through the same permission gate and Action Log as every other stage:

| Action | Level | Notes |
|--------|-------|-------|
| `notes:add-note`, `notes:add-task`, `notes:add-reminder`, `notes:search-notes`, `notes:list-notes`, `notes:list-tasks`, `notes:list-reminders` | L1 | Safe — create/read, runs immediately |
| `notes:complete-task`, `notes:delete-note`, `notes:delete-task`, `notes:cancel-reminder`, `notes:summarize-notes` | L2 | Reversible — cancellable 5 s toast; each mutating action has a `reverse` fn so Nova's Undo restores within 5 minutes |

**Voice commands supported:** `"Nova, note that [X]"` (timestamped note), `"remind me to [X] at [time]"` / `"in [duration]"` (timed reminder), `"add [X] to my tasks"`, `"mark [X] done"`, `"what did I note about [topic]"` (keyword search — reads matches back aloud). `"summarize my notes"` is the single deliberate network path.

**Timed reminders fire as OS notifications** (`new Notification({ title, body }).show()` — `notifications: false` so the sound policy is yours) via a 30 s polling scheduler in `src/main/notes/reminders.js`; each reminder fires exactly once (persisted `fired` flag). If the app window is focused, the reminder is also emitted to the renderer as `nova:reminder-fired` so Nova can speak it out loud. Reminders only fire while the app is running (documented limitation — no system-level persistence beyond the stored JSON).

**Side panel:** a new Notes/Tasks tab (between Action Log and Type-instead) shows notes, tasks, and pending reminders, each editable by mouse/keyboard — add/edit/mark-done/delete without voice. Mouse-driven actions talk to the dispatcher through the same `nova:notes-run` IPC path as the voice loop, so mouse clicks are logged to the Action Log at the same levels as voice commands.

```bash
npm run test:notes   # headless self-test — 78 checks: local JSON store +
                     # atomic saves, NL planning + intent classification,
                     # all 12 action levels + simulate/describe text,
                     # L1 immediate / L2 gate paths, undo reversals for
                     # completed tasks and deleted notes, mock OS notification
                     # firing (once-only), and the privacy guard (summarize is
                     # the only network path; refused in Private Mode)
node scripts/smoke-notes-e2e.js   # end-to-end: note + timed reminder fires +
                                  # task add/complete + keyword search
```

**Demo:** say or type `"Nova, note that my sister's birthday is June 12"`, `"remind me to take the chicken out at 3pm"`, `"add pick up the dry cleaning to my tasks"`, `"what did I note about birthday"`.

## Personal knowledge base (Stage 8)

Everything in `src/main/kb/` is **fully on-device**. No document content is ever sent to OpenRouter — not for indexing (whole documents never leave the machine), and not at query time (only the small retrieved snippets plus the question are handed to `pickModel("chat")`, see `kb/query.js` compose). Document content is also kept out of the model router's system prompt and conversation stream by design.

| Module | Role |
|--------|------|
| `embeddings.js` | 384-d local embeddings: `@xenova/transformers` ONNX MiniLM (cached in `userData/kb-model/`, downloaded once, fully local) with a **deterministic TF-IDF-style char-ngram fallback hasher** (seeded, identical vectors across runs) used automatically when the model cannot load — so the pipeline works fully offline and in CI with no network at all |
| `extractor.js` | Local text extraction for `.txt` / `.md` / `.pdf` (`pdf-parse` — offline) / `.docx` (`mammoth` — offline); unknown extensions are skipped, never sent anywhere |
| `chunker.js` | Sentence-bucket chunking with overlap for long texts; chunk ids are `folderHash:relPath:seq` (with `:hN` suffixes for hard splits) — deterministic and stable across re-indexes |
| `index.js` | Folder walking with caps (5 folders, 2000 files, depth 8), progress events, manifest + per-folder index persistence in `userData/kb-index/` |
| `watcher.js` | chokidar per-folder watch (debounced 1.5 s) — changed and new files re-index incrementally, never the whole folder |
| `search.js` | Embeds the query locally, cosine-ranks all chunks (top-K 6, at most 3 source files), dedupes by file |
| `query.js` | Composes the answer from snippets only: `compose()` embeds locally → retrieves → sends *snippets + question* to the router; **Private Mode refusal is exact and explicit**: `"Knowledge base search needs Private Mode off — I won't send your documents anywhere while it's on."` — no silent degradation |
| `plan.js` / `dispatch.js` | Natural-language planner + end-to-end dispatcher (same narrate/progress/undo conventions as the notes stage) |
| `actions.js` | `kb:add-folder`, `kb:remove-folder`, `kb:reindex` (L2 reversible toasts — removal deletes index data only, originals untouched), `kb:query`, `kb:list-folders` (L1 immediate), `kb:open-source` (L2 — opens the file via `shell.openPath`) |

**Side panel:** a Knowledge Base section (between Notes/Tasks and the Type-instead input) lists indexed folders with file/chunk counts, an **Add folder** button, a query form, a live indexing-progress line, and per-answer **"view source"** links that open the cited file in the OS. Mouse-driven management (`kbRun` IPC) goes through the same dispatcher and gate as the voice loop, so every add/remove/re-index is logged to the Action Log.

```bash
npm run test:kb      # headless self-test — 85 checks: extraction formats, chunking,
                     # embedding determinism + cosine sanity, incremental indexing
                     # and restoration, watcher events, search ranking, RAG compose
                     # (only snippets reach the model, sources cited), the exact
                     # Private Mode refusal, action levels + undo, and classifier routing
node scripts/smoke-kb-e2e.js   # end-to-end: add a 4-document sample folder, query
                               # sunset questions cite the right files, Private Mode
                               # refusal, remove (index gone, originals intact),
                               # incremental re-index picks up edited files
```

**Demo:** copy a folder of documents somewhere, then say or type `"add this folder to my knowledge base"` (or click Add folder in the side panel), and follow with `"what did I write about [topic]"` / `"find my notes on [topic]"`. Toggle **Private Mode** on and ask the same question to hear the explicit refusal. Edit a file inside an indexed folder and watch chokidar re-index it; `"remove this folder from the index"` drops the index data while the originals stay untouched.

**Known limitations:** the MiniLM model is a first-run network download (~80 MB quantized, from the HuggingFace CDN) — everything else is offline; the fallback hasher guarantees zero-network operation and identical results across runs. `.docx`/`.pdf` text extraction captures text only (no tables/images/captions). Re-indexed folders cap at 5 folders / 2000 files / depth 8.

## Automation engine (Stage 9)

Scheduled, user-defined routines built **entirely from the existing tools** (vision, control, files, notes, kb) — Stage 9 adds scheduling and chaining only. Voice phrases like `"every weekday at 8 AM, tell me my tasks for today and check for new files in Downloads"` parse into a stored cron-like schedule (local timezone) plus an ordered list of existing tool calls.

| Concept | Rule |
|---------|------|
| Levels | Every step keeps its **original risk level and confirmation requirements** from the permission framework — an automation can never bypass them |
| Level 0–2 | Run unattended; their own toasts/dry-run previews already apply inside each stage's dispatcher |
| Level 3+ | Pause the run with an **OS notification + pending-confirmation card** in the side panel; L0–2 "check" steps still run first, then the sequence waits for an in-app Confirm |
| Control steps | Always self-pause for in-app review — a control sequence can never fire headless |
| Limits | Max 10 steps per routine, 25 routines; creation is **refused** when the routine's first/only steps are Level 3+ (nudging toward "check something, then maybe act"); creation and deletion are Level 1 (only the schedule is affected) |
| History | Every run — success / partial / failed / awaiting confirmation — lands in the Action Log, tagged by automation name |

**Side panel:** the Automations section lists active routines with an on/off toggle, next-run time, and a **Run now** test button; pending confirmations surface as Confirm/Cancel cards.

```bash
npm run test:automation   # headless — cron + NL parser + store limits/refusals +
npm run smoke:auto        # gated runner + scheduler clock injection + 1-minute firing + action-log tags
```

**Demo:** say or type `"every day at 9 AM, tell me what's in my Downloads folder"`, watch it appear in the Automations panel with its next-run time, click **Run now**, and find the run in the Action Log. In Private Mode a knowledge-base step inside a routine fails with the standard KB refusal — no silent degradation.

**Known limitations:** routines only fire while Nova is running (same as the notes reminder scheduler); the NL parser covers the tested phrasings (every day/weekday/<weekday> at HH:MM, every morning/evening) — unusual schedules can still be set via a raw cron entry through the store's testing/admin paths.

## Event-triggered automations (Round 5)

Beyond cron schedules, automations can now fire on **events**, sitting alongside the scheduler (`src/main/automation/event-triggers.js`):

| Trigger | Behavior |
|---------|----------|
| `type: "file"` | Watches a folder (chokidar, same engine as the knowledge-base watcher) with depth limit, optional filename match, and debounced firing; `ignoreInitial` avoids boot storms |
| `type: "time-of-day"` | Fires at a fixed HH:MM in the local timezone (no date math needed for "remind me at 8 AM") |
| `type: "event"` | Subscribes to named events on the global app-event bus — any subsystem (vision, control, reminders, scheduler) can `emit("app-event", { name: "startup" })`; "when Nova starts up" automations use this |
| `type: "idle"` | Fires after the OS reports `systemPreferences.getUserIdleTime()` exceeding a threshold (Electron-only) |

Every event trigger keeps the automation engine's safety rules: the 5-minute flood cooldown, original risk levels per step, and the Level 3+ in-app confirmation pause. `npm run test:event-triggers` covers debounce, cooldown, clock injection, and the app-event bus.

## Conversation memory (Round 6)

Every chat exchange is appended to a rolling, fully-local journal (`userData/nova-memory.json`) and pruned to the most recent entries. On subsequent sessions the last exchanges plus a compact history summary are injected into the chat model's context, so follow-up questions like "what about that thing earlier?" work across restarts. **Private Mode blocks the memory context entirely** — only the current message ever leaves the machine, and only when Private Mode is off. `memory:clear` and `memory:stats` are Level 1 actions routed through the permission gate; the chat side panel marks messages that used cross-session memory with a small badge.

## Onboarding wizard & global shortcuts (Round 7)

First-run users now see a **welcome wizard** instead of a single permission screen: a branded intro, a capability tour (vision, control, files, knowledge base, notes, automations) with the privacy model stated up front, an optional OpenRouter key pointer, and then the existing macOS permission screens. Completion is recorded in settings (`onboardingWelcomeCompleted`), so the tour appears once per install — it can be re-shown by clearing that setting. Returning users still get the plain permission screens when any are pending.

Three global shortcuts are registered after `app.whenReady()`:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+Esc` | Hard kill-switch — aborts any running control sequence |
| `Alt+Space` | Show/hide Nova: minimizes when focused; restores, steals focus and centers otherwise |
| `Alt+M` | Toggle the microphone on/off (reuses the talk button's barge-in logic) |

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
│   ├── files/     File search, dup detection, organize previews, move/copy/rename/delete (all gated)
│   ├── notes/     On-device notes, reminders, tasks — keyword search, OS notifications, side-panel tab
│   └── kb/        Personal knowledge base — local embeddings, folder indexing, chokidar watching,
│                  snippet-only RAG query with Private Mode guard, source citation
│   └── automation/ Stage 9 — cron parser + local scheduler, NL routine parser, persistent store,
│                   risk-gated runner chaining the existing dispatchers, end-to-end dispatcher
```
├── preload/preload.js contextBridge API — renderer has no Node access
└── renderer/
    ├── index.html     Single-screen HUD
    ├── css/hud.css    Dark command-center styling (Orbitron + Space Grotesk)
    └── js/app.js      Orb visualizer, mic, STT, TTS barge-in, streaming chat, vision trigger phrases, screen-permission help banner
```

The renderer performs the OpenRouter fetch directly (renderer-side fetch avoids IPC streaming complexity; CSP `connect-src` restricts it to `https://openrouter.ai`).

## Known limitations (flagged in-app and here)

1. **Web Speech STT requires internet** — audio flows to the OS speech service while recognition is active. This is flagged in the HUD footer.
2. **Wake word** — an open-source pure-JS keyword spotter for an exact "Hey Nova" phrase with offline guarantees is not yet available in the JS ecosystem (Porcupine's SDK is commercial and native-per-architecture; sherpa-onnx is a heavy native addon). This stage uses an energy-gate VAD that arms recognition, so audio capture only begins on tap or wake. A native wake-word addon can be dropped in later without touching the pipeline. When the wake-word toggle is on but no Picovoice AccessKey is set, the HUD now says so explicitly instead of falling back silently.
3. **In-app settings prompt** uses a renderer overlay dialog; Electron's native `dialog.showInputBox` is used where available.
4. **safeStorage on Linux** may fall back to in-memory storage when libsecret is missing — the app now shows an explicit note in Settings ("Keychain not available — the key is held encrypted in memory only and won't survive a restart") instead of flagging logs only; the `OPENROUTER_API_KEY` env var remains the persistence path.
5. **Screen vision on headless/CI environments** — `desktopCapturer` needs a real display server (Xvfb works for testing, but captures may be empty windows). macOS always requires the Screen Recording grant; Windows works without extra permissioning.
6. **Free-tier model rotation (OpenRouter)** — the free-model list is fetched at startup and every 6 h and cached locally; models can rotate out without notice, so some task types may temporarily have no free model (the router falls back to a hardcoded `google/gemini-2.5-flash-001` and logs every pick). Free models carry rate limits (roughly 20 requests/minute and 200 requests/hour per account key, per OpenRouter's terms — unauthenticated and authenticated tiers differ), so bursts of voice commands can hit `429 Too Many Requests`; `retryOnce` auto-retries once, then tells the user plainly to wait a moment. Occasional higher latency and lower quality on free tiers are expected.
7. **Ambiguous-intent quick classification** runs one model round-trip per ambiguous message; if it fails (rate limit, network, offline), the classifier safely defaults to the combined path — never silent failure.
8. **Undo limits** — only actions registered with a `reverse` function are reversible, and only within 5 minutes of success; mouse clicks, key presses, and anything L3+ can never be undone and the button stays disabled for them.
9. **Control input simulation on macOS** additionally requires the Accessibility grant — the first-run onboarding screen explains this before the OS prompt; Nova detects a missing grant and gates control sequences until it is granted.
10. **Vision-model reasoning needs an API key and internet** — in Private Mode or when no free vision model is available, Nova answers from OCR text alone, so vision never leaks screen content off-device in that mode. The knowledge-base panel also now states which embedding backend is active: the full local MiniLM model (auto-downloaded once from the HuggingFace CDN on first use) or the deterministic local hasher fallback (always available offline, lower retrieval quality).

## Packaging notes

- `assets/icon.ico` and `assets/icon.png` are included; electron-builder derives `.icns` from the PNG when building on non-macOS hosts (or generate properly with `iconutil` on a Mac).
- NSIS installer allows directory choice and creates a desktop shortcut.
- The DMG is unsigned (`sign: false`) for local distribution; notarization is required for wider macOS distribution.
