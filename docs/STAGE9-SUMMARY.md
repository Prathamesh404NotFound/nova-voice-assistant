# Stage 9 — Automation Engine

Nova can now run **recurring, user-defined routines** built entirely from the tools
implemented in Stages 3–8 (screen vision, mouse/keyboard control, file management,
notes & reminders, and the local knowledge base). Stage 9 adds no new capabilities —
only **scheduling and chaining** of existing ones.

## What was built

Ten new modules under `src/main/automation/` (~1,400 lines) plus classifier/dispatcher
routing, IPC bridges, and a new Automations side-panel section.

| Module | Role |
| --- | --- |
| `types.js` | Step-kind registry (vision / control / files / notes / kb) and the Level→status map |
| `cron.js` | Local-timezone cron expression parser, matcher, and next-run calculator |
| `parser.js` | Rule-based NL parser: "every weekday at 8 AM, tell me my tasks and check Downloads" → schedule + ordered steps |
| `store.js` | Persisted store (`userData/automations.json`) with the 25-automation and 10-step caps and creation-refusal rules |
| `scheduler.js` | 1-second poll loop, fires `automation-firing`; injectable clock + minute-key guard prevent double-fires |
| `runner.js` | Executes steps through the existing dispatchers with per-step risk resolution |
| `dispatch.js` | End-to-end dispatcher: create / list / toggle / delete / run now / confirm, all through the permission gate |

The **intent classifier** routes explicit automation phrasing ("every … at …", "set up a
routine: …") to the new `AUTOMATION` intent, which dispatches through the existing
`nova:agent-run` agent loop.

## Risk model (the core requirement)

Every step keeps its **original risk level and confirmation requirements** from
Stages 2/6/7 — an automation can never be used to bypass them.

- **Level 0–2 steps run unattended.** Their own safety nets already apply inside each
  stage's dispatcher (toasts, 5-second cancel windows, dry-run previews for
  organize/move operations).
- **Level 3+ steps pause the run.** The automation fires its L0–2 "check" steps first,
  then stops with status `awaiting-confirmation`, emits an OS notification via the
  existing reminders notifier, and shows a pending-confirmation card in the side panel.
  Clicking **Confirm** re-runs the sequence once.
- **Control steps self-pause in every context** — a control sequence can never fire
  fully headless; it always lands as a pending confirmation for in-app review.
- **Level resolution is conservative.** Each step's level is resolved from the target
  stage's real action registry; wording with destructive/reversible verbs is never
  downgraded to read-only even when the planner can't disambiguate.

## Safety limits (the "sensible limits" requirement)

| Limit | Rule |
| --- | --- |
| Max automations | 25 |
| Max steps per automation | 10 |
| L3+-only refusal | An automation whose first (or only) steps are Level 3+ is refused at creation with the guidance: *"I won't create a routine that only does sensitive or destructive things. Start it with a read-only or safe step — like 'check my Downloads folder, then …'."* |
| Creation & deletion | Both Level 1 — creating only schedules; deleting removes only the schedule, never past effects |

## Side-panel management UI

A new **Automations** section sits between the Knowledge Base and the type-instead
box. Each automation shows its name, cron schedule, next-run time, and an on/off
toggle; a **"Run now"** button tests it immediately, and a pending-confirmation card
(with Confirm/Cancel) appears when a scheduled run requires approval. Run history is
written into the existing Action Log, tagged with `actionId: automation:run` /
`automation:add` / `automation:toggle` / `automation:delete` and the automation's name.

## Voice commands supported

- "every weekday at 8 AM, tell me my tasks for today and check for new files in Downloads"
- "every day at 9 AM, tell me what's in my Downloads folder" *(the real example)*
- "every morning at 7:30, take a screenshot of my screen"
- "every Monday at 9 AM, clean up my Downloads folder"
- "set up a routine: every day at 9, check my Downloads"
- On/off via the panel; "run it now" via the panel button (the engine also accepts
  "run my automation now" phrasing through the agent loop)

## Testing

All green, full chain `npm test` **EXIT 0**:

| Suite | Tests |
| --- | --- |
| `test-automation.js` (new, headless) | **62/62** — cron match/next-run/local-timezone, NL parsing, store caps & refusals, level resolution, L0–2 unattended runs, L3+ pause + confirm flow, run history, scheduler clock injection & minute guard, classifier + dispatcher routing |
| `scripts/smoke-auto-e2e.js` (new) | **16/16** — dispatcher end-to-end, action-log tagging, **the 1-minute schedule firing test** (deterministic injected clock: fires once at the eligible minute, no double-fire, fires again next minute), SENSITIVE pause path, destructive refusal |
| Stage 1–8 suites | permissions 27/27, vision 27/27, control 72/72, agent 38/38, files 82/82, notes 83/83, kb 88/88 |

Boot test on Xvfb: clean launch, `scheduler started`, `0 automation(s) loaded`,
kill-switch and reminders schedulers intact, window renders.

## Known limitations

- **Fires only while Nova is running** (documented, same as the Stage 7 reminder
  scheduler). The next-run time is recomputed each tick so a missed window is caught
  on the following eligible minute.
- The NL parser is rule-based and covers the tested phrasings; unusually structured
  schedules (e.g. "twice a day") fall back to the side panel's raw cron entry.
- Private Mode does not block automation execution — routines only use local tools
  and the same model-router privacy rules apply per step (L0–2 steps never send
  document content; a kb/query step only sends retrieved snippets and is blocked by
  Private Mode with the standard refusal, which surfaces as a step failure in the
  run history rather than silent degradation).
- Vision steps need the stage's vision model availability; they degrade to OCR-only
  exactly as a direct vision query would.
