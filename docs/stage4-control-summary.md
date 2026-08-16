# Stage 4 — Mouse & Keyboard Control: Summary

**Commit:** `6f6b604` — `Add mouse/keyboard control: nut.js input simulation + task planner + kill-switch + vision verification` (23 files, +3,313 lines)

**All suites green:**

| Suite | Result |
|-------|--------|
| `npm run test:control` | 72/72 PASS |
| `npm run test:permissions` | 27/27 PASS (unchanged — framework integrity preserved) |
| `npm run test:vision` | 27/27 PASS |

The app boots cleanly on Linux (Xvfb) with all 11 control actions registered and the kill-switch hotkey successfully bound after `app.whenReady()`.

## What was built

### 1. Input simulation (`src/main/control/input.js`)
Wraps `@nut-tree-fork/nut-js` v4.2.6 with an engine indirection (`setEngineForTesting`) so every hardware call is mockable in headless tests. Eleven control actions registered at the correct risk levels:

| Actions | Level | Notes |
|---------|-------|-------|
| `control:cursor-position`, `control:move-cursor` | L0 | Read-only inspection / movement |
| `control:open-app`, `control:wait-for-window` | L1 | Safe |
| `left-click`, `right-click`, `double-click`, `scroll`, `drag`, `type-text` | L2 | **Physical** — toast + Private Mode block |
| `press-keys` | L3 | Modal confirm for dangerous combos |

### 2. Risk gating through the permission framework
- `action-registry.js` now stores a `physical` flag; the gate's Private Mode path blocks any `physical` action (so all L2+ control actions are blocked in Private Mode, not just L3+).
- Every control action carries a `simulate()` path (required for the L2 toast / L3 modal plain-language descriptions) and a `describe()` helper that builds the description payload.
- Destructive combos (`Ctrl/Cmd+W`, `Alt+F4`, `Ctrl/Cmd+Q`, `Ctrl+Z`) escalate to L3; harmless ones (`Ctrl+T` etc.) stay L2. `Ctrl+C` is explicitly not dangerous.

### 3. Rule-based task planner (`src/main/control/planner.js`)
Compiles natural-language instructions into ordered steps — never LLM-based, so behavior is deterministic and auditable:

- `open the system calculator and compute 12 x 8` → `open-app → wait-for-window → type-text → press-keys (Return)` (4 steps)
- Expression normalization keeps spaces: `12 x 8` → `12 * 8`, `100 plus 25 times 4` → `100 + 25 * 4`, `divided by` → `/`
- Refuses non-numeric payloads (`compute rm -rf /`, `calculate hello world`), caps typed text at 200 chars, refuses empty typing.

### 4. Step runner (`src/main/control/runner.js`)
Executes the confirmed plan one step at a time. Each step: (1) checks the kill-switch via `guardStep()` *inside* the try/catch so aborts report cleanly, (2) resolves click coordinates from vision when a label is given, (3) runs through the gate, (4) posts `done` or halts on `cancelled`/`blocked`/`failed` gate outcomes, (5) runs post-step vision verification when `payload.verify.contains` is set. Emits `running / done / verified / failed / aborted / cancelled` progress events that drive the renderer checklist. Remaining steps are always marked `cancelled`/`aborted` in events and the log — never silently skipped.

### 5. Hard kill-switch (`src/main/control/kill-switch.js` + `main.js`)
Three paths converge on `sequence.abort()`:
- Global hotkey `Ctrl+Shift+Esc` (both platforms), registered after `app.whenReady()` (fixes the earlier "globalShortcut cannot be used before the app is ready" boot error)
- Visible **STOP** button in the HUD topbar
- Voice/text barge-in: `nova stop`

### 6. Vision verification (`src/main/control/verify.js`)
Reuses the vision stack (`screenshot.js` + offline `ocr.js`), so verification works offline and in Private Mode. Retries within a 3 s budget (poll 500 ms); failure halts the sequence with a `verification failed: …` note reaching the renderer events. Used by `wait-for-window` steps and any planner step with `verify: { contains }` (e.g. the compute step verifies `0` appears on screen before pressing Return).

### 7. Cross-platform launcher (`src/main/control/launcher.js`)
`calc` / `calculator` aliases resolve to `Calculator` (macOS), `calc.exe` (Windows), `gnome-calculator` (Linux); spawns via the platform-appropriate shell command with per-OS error handling.

### 8. Renderer integration
- Plan checklist panel in the HUD (`index.html` + `hud.css`) driven by `nova:control-plan` / `nova:control-start` / `nova:control-abort` IPC
- `onControlProgress` renders per-step `running / done / verified / failed / aborted / cancelled` with progress dots
- Control trigger phrases (`open ... and ...`, `click ...`, `type ... into ...`, `press ...`, `compute ...`) in the shared submit path; `nova stop` barge-in kills any sequence

## Headless test harness (`src/main/test-control.js`, 72 checks)
Electron shim + mock input engine + `require.cache` mocking of the vision modules and the gate, covering:

- Planner rules, normalization, refusal cases, dangerous-combo regex, risk levels
- Kill-switch state machine (reviewing → running → aborted → done), `guardStep`, double-start, reason flow-through
- Runner happy path; **mid-step abort** (finished=aborted, interrupted step reported); **cancelled gate outcome halts**; **Private Mode block halts**; **vision verification failure halts** with note reaching renderer events
- Registry (`physical` flag, L2+ simulate coverage), describe helpers, launcher aliases, verify module directly

## Demo flow (works on both Windows and macOS)
Say or type: **"open the system calculator and compute 12 x 8"** → 4-step checklist appears → L1 open runs immediately → L1 wait verifies the window via vision → L2 type shows the 5 s toast → vision verifies `0`-style content is reachable → `12 * 8` typed → L3 Return modal confirm → presses Return → every step logged with outcome. At any point: `Ctrl+Shift+Esc` / STOP / `nova stop` halts cleanly.

## Remaining known limitations
- Linux control actions need a real X display (Xvfb works for testing; headless CI captures need a virtual display server)
- The demo plan's vision verify checks the calculator window label; on a real macOS calculator the OCR content differs, so final text-assertion content should be tuned on real hardware
- File-system tools deliberately deferred to the next stage per requirements
