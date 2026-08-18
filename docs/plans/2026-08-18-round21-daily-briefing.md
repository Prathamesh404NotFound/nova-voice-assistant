# Round 21 — Daily briefing: "what's on my plate today"

## Motivation
Rounds 17/18 gave tasks due dates and stats (due-this-week / overdue). R13/19/20 made
reminders manageable. Nothing yet gives the user ONE spoken sentence covering today's
work at a glance — the "morning standup" moment. The R18 boot nudge only speaks overdue
tasks at startup and only once; a briefing command fills the "ask anytime" gap.

## Voice triggers (planner.js, notes:list-tasks branch family)
- "what's on my plate today" / "brief me on today" / "today's briefing" /
  "what do I have due today" / "morning briefing" / "daily briefing"
- Maps to new action `notes:daily-briefing` (L1 SAFE, read-only, local).

## Data (store.js additions)
- `dailyBriefing(now)`: pending tasks due today, overdue pending tasks (day granularity),
  reminders due today. Reuses existing task list + reminders; NO new storage.
- Honors existing taskStats (keep untouched).

## Dispatcher (dispatch.js)
- Spoken summary pattern: "Here's today's plate: 2 tasks due today — finish report,
  book flight — 1 overdue — pay rent — and 2 reminders scheduled for today."
- Empty plate gets an honest "nothing on the plate today — clear skies."
- Panel result: rich structured object for the renderer (dueToday[], overdue[],
  remindersToday[]) so the chat shows a list, not a blob.

## Renderer (app.js / hud.css)
- Chat result card: "Today's plate" header + three groups (Due today cyan, Overdue amber,
  Reminders default) with item counts.
- Also available via command palette search ("briefing").

## Panel (no side-panel UI changes this round — results live in chat; keep scope tight)

## Test harness (test-daily-briefing.js)
- Planner routing: each trigger phrase → notes:daily-briefing; non-trigger phrases don't.
- Store dailyBriefing math: due-today EOD boundary, overdue day granularity, reminder
  due-today window, done tasks excluded, empty plate.
- Dispatcher wording: due+overdue+reminders, overdue-only, empty plate, done exclusion.
- Mirror existing harness pattern (CJS shim, IIFE, pinned clock).

Scope guard: no new IPC surface beyond the existing notes:run-action (dispatcher result
already flows through runNoteAction). L1 read-only, Private Mode safe, fully local.
