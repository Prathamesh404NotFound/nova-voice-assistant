# Stage 9 — Lightweight Automation Engine (Design)

**Repository:** Prathamesh404NotFound/nova-voice-assistant
**Date:** 2026-08-17

## Goal

Recurring, user-defined routines built entirely from tools implemented in Prompts 3 (vision), 4 (control), 6 (files), and 7 (notes/KB). No new capabilities — just scheduling and chaining of existing ones.

## Requirements mapping

| # | Requirement | Design decision |
|---|---|---|
| 1 | Creation by voice/panel; schedule + ordered steps | `src/main/automation/planner.js` parses voice to steps; steps are stored as `{kind, text}` pairs run via the existing dispatchers. JSON store in `userData/automations.json` |
| 2 | Original risk levels respected; L3+ pauses for in-app confirmation | Runner computes `maxStepLevel` across steps; L0–2 run unattended; L3+ → OS notification + pending-confirmation state; user confirms in-app |
| 3 | Management UI: list, toggle, next-run, run-now; delete = L1 | Side panel "Automations" section; IPC `nova:auto-*`; deletion removes schedule only |
| 4 | Run history in Action Log, tagged by automation name | New `automation-run` action registration; outcome success/partial/failed/awaiting-confirmation |
| 5 | Limits: ≤10 steps; refuse automation whose ONLY steps are L3+ with no L0–2 first | Planner-level validation + store-level enforcement |
| Test | 1-min schedule fires, logs, speaks | E2E smoke with frozen clock; Xvfb boot test |

## Architecture

```
src/main/automation/
  parser.js      — NL → {name, schedule, steps} (cron-like expressions, local TZ)
  store.js       — persisted store (userData/automations.json); limits enforcement
  cron.js        — lightweight cron expression evaluator (min/hr/dom/mon/dow)
  scheduler.js   — setInterval(10s) scan; computes next-run; emits fires
  runner.js      — executes step list through existing dispatchers, risk-gated
  types.js       — STEP_KINDS registry (which dispatcher handles which kind)
```

### Step kinds (no new capabilities)

| kind | dispatcher used | level source |
|---|---|---|
| `vision` | `vision/dispatch.js` runVisionQuery | READ (0) |
| `control` | `control` planner+executor | varies per step (plan provides levels) |
| `files` | `files/dispatch.js` runFileAction | READ (0) … DESTRUCTIVE (4) |
| `notes` | `notes/dispatch.js` runNoteAction | SAFE (1) / REVERSIBLE (2) |
| `kb` | `kb/dispatch.js` runKbAction | SAFE (1) / REVERSIBLE (2) |

Step level resolution: for vision/notes/kb steps the level is fixed (READ/SAFE/REVERSIBLE); for files/control steps, the planner of that stage returns a level per action — the runner asks the stage's plan module. For control sequences, the automation step is treated as SENSITIVE (3) to stay conservative (user said control sequences are highest-risk).

### Risk gating

- Automation runner computes per-step levels BEFORE running.
- If ANY step is L3+ → the automation is created as **paused-by-default**: it requires per-run confirmation notification (OS Notification + pending state in panel). Panel shows "Awaiting confirmation" and a Confirm button that runs the full sequence once.
- If all steps ≤ L2 → automation runs unattended on schedule.
- "only L3+ steps with no L0–2 first" → planner refuses with friendly message.

### Scheduler

- `cron.js`: 5-field cron (min hr dom mon dow), `*` and ranges/lists, local timezone via `Intl` resolved offsets (no tz dependency).
- `scheduler.js`: 10-second poll; tracks `lastRunAt`; `nextRun = first time t > now matching cron && t > lastRunAt`.
- Fires an event; renderer shows nothing intrusive; result posted to chat history via progress channel + Action Log.

### Naming & parsing examples

- "every weekday at 8 AM, tell me my tasks for today and check for new files in Downloads"
  → `{name: "Morning briefing", cron: "0 8 * * 1-5", steps: [{kind:"notes", text:"what's on my task list"}, {kind:"files", text:"find PDFs I edited this week"}]}` (finder example; actual parse yields list-files step)
- "every day at 9 AM, tell me what's in my Downloads folder"
  → `{name: "Downloads check", cron: "0 9 * * *", steps: [{kind:"files", text:"list my Downloads folder"}]}`

### Data model

```js
{
  id, name, enabled, cron, tz: "local",
  steps: [{kind, text, level}],
  level: max over steps,     // "safe" | "needs-confirmation"
  createdAt, lastRunAt, lastRunStatus, nextRunAt (computed)
}
```

### IPC surface

- `nova:auto-list` / `nova:auto-add` / `nova:auto-toggle` / `nova:auto-delete` /
  `nova:auto-run-now` / `nova:auto-confirm` (for pending L3+ runs)

### Renderer

- New side-panel section "Automations" (after KB): list with toggle switch, next-run, status chip, Run now, Delete.
- Pending-confirmation card when an automation's last run is awaiting.

### Tests

- `src/main/test-automation.js`: parser (cron expressions, NL patterns), cron evaluator, store limits, scheduler next-run math (frozen Date), runner gating (mock dispatchers), refusal rules — ~60 tests.
- `scripts/smoke-auto-e2e.js`: boot harness — create automation, freeze clock, verify fire within 1 min, Action Log entry, speak result; plus L3+ pause path with injected high-level step.
- `npm test` chain must stay EXIT 0.

## Constraints / open issues

- Control steps inside automations: kept conservative at SENSITIVE → any automation containing a control step requires confirmation. Documented limitation.
- No model dependency: all parsing is rule-based → works in Private Mode.
- Electron Notification used (same as reminders stage).
