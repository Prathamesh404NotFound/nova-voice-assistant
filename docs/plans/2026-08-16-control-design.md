# Nova Stage 4 — Mouse & Keyboard Control Design

**Commit context:** `b86303f` (screen vision). New feature must be *conservative*: the highest-risk feature so far, strictly gated through the existing permission framework.

## Library choice

- **`@nut-tree-fork/nut-js` v4.2.6** (Apache-2.0, ~29k weekly downloads, maintained fork after original author took the package private).
- Prebuilt native binaries for Windows/macOS/Linux — no compilation needed; loads fine in the sandbox on Xvfb.
- Verified: `require()` works, `mouse.leftClick()` runs without error on Xvfb :99.
- robotjs was rejected (last publish 2019, no Windows 11+ prebuilds, no scroll-wheel granularity, blocking native build issues).

## Action inventory and risk levels

| Action id | nut.js primitive | Level | Gate behavior |
|---|---|---|---|
| `control:cursor-position` | `screen.mousePosition()` | L0 READ | immediate |
| `control:move-cursor` | `mouse.move()` | L0 READ | immediate |
| `control:left-click` | `mouse.leftClick()` | L2 REVERSIBLE | 5s toast |
| `control:double-click` | `mouse.doubleClick()` | L2 | 5s toast |
| `control:right-click` | `mouse.rightClick()` | L2 | 5s toast |
| `control:scroll` | `mouse.scrollDown/Up()` | L2 | 5s toast |
| `control:drag` | `mouse.drag()` | L2 | 5s toast |
| `control:type-text` | `keyboard.type()` | L2 | 5s toast |
| `control:press-keys` | `keyboard.pressKey()` | L3 SENSITIVE if the combo can trigger irreversible effects (Ctrl/Cmd+W, Ctrl/Cmd+Q, Alt+F4, close/tab-kill combos); otherwise L2. Default policy: a small deny/blocklist of "dangerous" shortcuts maps to L3. | modal Confirm |
| `control:open-app` | OS-specific launcher (start calc / open -a Calculator) | L1 SAFE | immediate |
| `control:wait-for-window` | poll + screenshot/OCR verification (uses vision) | L1 SAFE | immediate |

Private Mode: L2+ control actions are refused outright (Private Mode already blocks L3+; control of the user's machine is network-independent but physically invasive — extend gate for L2 control actions too via a control-specific flag `physical: true`). Decision: control actions get `executeOpts { physical: true }` and `gate.js` refuses any `physical: true` action in Private Mode.

## Task planner (`control/planner.js`)

Simple rule-based plan compiler, no LLM (keep it deterministic and conservative):
- Regex/NLP-lite instruction parser recognizes a small verb vocabulary: `open <app>`, `click <label>`, `double-click <label>`, `type "<text>"`, `type <text> into <label>`, `press <keys>`, `submit / send / enter`, `compute/calculate <expr>`, `wait for <window>`.
- Output: ordered plan = array of `{ id, label, actionId, payload, level }` steps.
- For `compute <expr>`: emit `open-app` → `wait-for-window` → `type` the expression → `press-keys` Return.
- **Review step**: before executing anything above L1, the plan is sent to the renderer; user sees a checklist and must confirm (L3 steps go through the modal anyway; L2 steps keep their toast windows). The sequence ONLY starts after confirmation — matching "show the planned steps before executing anything above Level 1".
- Execution: steps run one at a time; after each, renderer gets progress event and checks off the step.

## Kill-switch (`control/kill-switch.js`)

- Global hotkey `Ctrl+Shift+Escape` registered via `globalShortcut` in main process (both platforms).
- A shared `sequence` controller: `start(plan)`, `abort()`, `isRunning`, progress events. Every step checks `isAborted` before executing; an aborted sequence logs remaining steps as `cancelled`.
- Renderer: while a sequence runs, a visible red STOP button appears in the chat panel; `Nova stop` voice phrase and orb click also call `abort()` (reuse existing barge-in hook).

## Vision verification (`control/verify.js`)

- After click/submit/wait steps, optionally take a screenshot (reuses `vision/screenshot.js` captureScreen) and run OCR (reuses `ocr.js` recognizeText) to assert an expected label/window title appears — e.g. "confirm Calculator window is focused".
- Used by `wait-for-window` step and any step with `verify: { contains: "..." }`.
- Failure → step outcome `failed`, sequence pauses/stops rather than continuing blindly.

## IPC surface

- `nova:control-sequence`: renderer → main, `{ instruction }`. Main compiles plan, sends `nova:control-plan` (plan + levels). Renderer renders checklist; user confirms → `nova:control-start { planId }`.
- Main executes steps with progress events `nova:control-progress { stepId, status: running|done|failed|aborted, note }`.
- `nova:control-abort`: from STOP button or voice.
- `nova:control-cursor`: request-response for L0 cursor read.
- Global shortcut `Ctrl+Shift+Escape` → `sequence.abort()`.

## Testing (headless)

- `test-control.js` with the electron shim (native bindings stubbed: mouse/keyboard methods spied, screen.mousePosition → {x,y}).
- Checks: risk levels correct; L2 toast path via describeActionPlain; L3 blocklist mapping; plan compilation for "open the system calculator and compute 12 x 8" (open calc → wait → type "12*8" → press Return); progress events; abort mid-sequence; verify step with mocked OCR text; Private Mode refusal of control actions; action-log entries.
- Existing test:permissions + test:vision stay green.

## Scope guardrails (conservative)

- No file/mouse-kbd recording, no global key logger, no clipboard exfil: clipboard untouched in this stage.
- No L4 control actions (nothing destructive reachable from voice).
- Planner only accepts recognized verbs; unrecognized instructions → "I can't safely plan that yet" message.
- The demo e2e target "open the system calculator and compute 12 × 8" is used for plan/confirm/log verification; actual app opening is verified where the sandbox permits (Xvfb has no Calculator — calculator check runs plan-level assertions, real execution verified against gnome-calculator if available, else skipped with a documented note).
