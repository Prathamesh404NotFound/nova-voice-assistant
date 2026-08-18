# Round 18 Design: Task due-date lifecycle management

Round 17 added due dates on creation. Round 18 closes the loop: what happens AFTER
the task exists — editing, boot nudges, and completion nudges.

## Scope (kept tight, YAGNI)

1. **Change/extend a due date by voice.**
   - Planner: `change the due date for finish report to next monday`,
     `make fix bug due by friday`, `finish report is due today`.
   - Regex: detect `(change|move|reschedule|make).*?due (date)? ... to <expr>`
     (with the task identified by fuzzy keyword match against pending tasks),
     OR `<task-ish phrase> due <expr>` / `by <expr>` for a known task.
   - Action: `notes:set-task-due` — **Level 2** (edit of existing item) with
     `simulate()` describing the change ("would move the due date of 'finish
     report' from Friday to Monday"); plain-language confirmation toast.
   - Clearing a date: "remove the due date for X" / "no longer has a due date"
     → payload `{ id, dueDate: null }`.
   - Task matching: pick pending task whose text contains the noun phrase;
     zero matches → honest error listing close candidates; multiple → error.
   - Dispatcher: "Done — finish report is now due Monday."

2. **Overdue boot nudge.** On main-app ready (`app` module), if any pending task
   is overdue, queue ONE spoken nudge via the existing dispatch channel ("You
   have 2 overdue tasks: ..."). Local only, reads existing store — no new risk
   surface. Fires once per session (flag file or module-level flag).

3. **Completion celebration.** In `notes:complete-task`, if the task is due
   today or overdue, append a short congratulations line to the spoken reply.
   "Done! And right on time — you crushed your 3 overdue tasks."

## Files touched
- `src/main/notes/plan.js` — two new planner branches (set-due, clear-due)
- `src/main/notes/actions.js` — `notes:set-task-due` (L2 + simulate), wire
- `src/main/notes/dispatch.js` — spoken text for set-due + celebration lines
- `src/main/notes/store.js` — `setTaskDue(id, dueDate)` with NaN-guard
- `src/main/app.js` (or main entry) — boot nudge after window ready
- `src/main/test-task-due-management.js` — ~20 tests, chained
- README — table row + Round 18 section

## Out of scope (explicit)
- Recurring due dates; priority; subtasks; calendar sync.
