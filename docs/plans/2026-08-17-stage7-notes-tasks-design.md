# Stage 7 — Local Notes / Reminders / Tasks

## Requirements (verbatim, from the user)

1. Voice capture: "Nova, note that [X]" → timestamped note. "Nova, remind me to [X] at [time]" / "in [duration]" → local reminder that fires an OS notification (Electron Notification API) + spoken reminder if the app is focused.
2. Simple task list: "add [X] to my tasks", "what's on my task list", "mark [X] done" — flat list, no projects/subtasks.
3. Retrieval by voice: "what did I note about [topic]" → simple keyword search over stored notes, read back.
4. Side-panel view: Notes/Tasks tab in the existing collapsible side panel; editable by mouse/keyboard (no voice required).
5. Data lives entirely on-device. Notes content must NEVER be sent to OpenRouter — except one explicit "summarize my notes" flow where only that note's text is sent for exactly one request.

## Design decisions

### Data model

Single JSON file, `userData/nova-notes.json` (atomic-ish writes: write to `.tmp` then rename). Three flat arrays of objects, all with `{ id (uuid-ish), text, createdAt, updatedAt }`:

- `notes`: `{ id, text, createdAt, updatedAt }`
- `reminders`: `{ id, text, dueAt (ISO), fired: bool, createdAt, updatedAt }`
- `tasks`: `{ id, text, done: bool, createdAt, updatedAt }`

No SQLite — a flat JSON file under ~10k items is fine for a personal assistant, keeps deps zero, trivially inspectable. JSON file + fs.rename write pattern = no bundler, consistent with the rest of the app.

### Privacy guard (requirement 5)

Two hard lines, enforced in code, not just policy:

1. **Conversation guard** — `notes.summarize()` is the ONLY function in the module that touches the network. The dispatcher's OpenRouter POST path gets a helper `notes.buildConvoPrompt(notes)` that returns ONLY the summarize payload when explicitly requested; no other conversation path ever reads the store. We make this structural: the notes store is never imported in `dispatcher.js`; only `notes/privacy.js` exposes `summarizePayload(store, noteIds)` which the dispatcher calls through an explicit IPC (`nova:notes-summarize`) that requires a fresh note list from the store plus an explicit user request.
2. **Model call content** — notes text is never injected into system prompts, history, or chat context. The classifier and planner see only the user's utterance (which is what the user said — if they say a note aloud, that's their choice, same as any mic app).

Implementation: `src/main/notes/store.js` (no network imports, no router import — enforced by keeping the file dep-free of `router.js`); `src/main/notes/notes.js` exposes actions and a `summarizeOf(ids)` fn; `src/main/notes/summarize.js` is the single network-touching bridge imported by dispatcher.

### Risk levels (Stage 1 framework)

| Action | Level | Flow |
|---|---|---|
| `notes:add-note`, `notes:search-notes`, `notes:list-tasks`, `notes:list-reminders` | L1 (SAFE) | Immediate, logged |
| `notes:complete-task`, `notes:delete-note`, `notes:delete-task`, `notes:cancel-reminder`, `notes:summarize-notes` | L2 (REVERSIBLE) | Cancellable 5 s toast; reverse fns where possible (complete-task reverses to undone; delete-note keeps a soft copy in an undo stash for 5 min via registry lastResult pattern; summarize is idempotent — reverse no-op) |

Rationale: editing/deleting existing items is L2 (reversible), matching the user's spec. Summarize is L2 because it fires a network call the user should be able to cancel in the toast window (and it's reversible — cancelling just skips it).

### Reminder scheduler

`src/main/notes/reminders.js`: on boot / after every add, walks reminders with `!fired && dueAt <= now`, fires, marks fired, persists. Plus a cheap 15 s setInterval scan. Fire = `new Notification(...)` (Electron API; we request notification permission once at first fire; Linux: electron Notification falls back; fine). If `mainWindow` is focused (`win.isFocused()`) → also narrate via TTS (dispatcher `narrate()` or direct renderer event → renderer speaks). Also show renderer event so the HUD announces it.

### NLP parsing (`src/main/notes/plan.js`)

Rule-based regexes (same style as `files/plan.js` and `control/planner.js` — no LLM, works offline/Private Mode):

- note: `/(?:note that|note down|write down|remember)[\s:]+(.+)/i`
- remind: `/(?:remind me to|remind me)\s+(?:to\s+)?(.+?)(?:\s+(?:at|in)\s+(.+))?\s*$/i` + time parser (`at 3pm`, `at 15:30`, `in 10 minutes`, `in 1 hour`, `in 2 hours 15 minutes`, `tomorrow at 9am`)
- task add: `/(?:add|create)\s+(.+?)\s+to my tasks|task:?\s+(.+)/i`
- tasks list: `/(?:what('s| is) (on |in ))?my task list|list (my )?tasks|show (my )?tasks/i`
- mark done: `/(?:mark|set)\s+(.+?)\s+(?:as\s+)?done|done[:\s]+(.+)/i` → match task text against stored tasks (fuzzy: case-insensitive substring, prefer longest match)
- search notes: `/(?:what did i note|what have i noted|search (my )?notes|find (in|among) my notes|note(?:s)? about)[\s:]+(.+)/i`
- list notes: `/(?:show|list) (my )?notes|what (are|('s| is)) my notes/i`
- delete note/task: `/(?:delete|remove)\s+(?:my |the )?(note|task)\s+["“]?(.+?)["”]?$/i`
- summarize: `/summarize my notes/i`

Unmatched → `null` (classifier falls through to conversation). Classifier gets a `NOTES_RE` pass (check plan returns non-null) → intent `notes`.

### Dispatcher (`src/main/agent/dispatcher.js`)

New `dispatchNotes(text)` — plan → gate.runAction with `{taskId}` → narrate per step ("Noting that down…", "Reminder set for 3:15 PM", …) → return result. Notes actions are cheap and local, so results come back fully formed (no streaming). Renderer shows the result card; reminders fire later via scheduler events.

### Renderer

Side panel: add a **Notes/Tasks tab row** under the "Session" header (tabs: History | Notes | Dev). Notes tab lists notes, reminders, tasks; each editable inline (contenteditable / input), add-note field + add-task field + set-reminder form (text + relative time quick chips). IPC: `nova:get-notes-store` (read-only mirror), `nova:notes-edit` (edit/delete via gate), `nova:notify-fires` (renderer shows incoming reminder toast + speaks if focused).

### Test plan

`src/main/test-notes.js` (mirrors test-files.js, electron shim): store CRUD, plan parsing (note/remind/relative-time/tomorrow/task add/done mark/search/delete/summarize), registry levels + reverse fns, gate L1/L2 flow, reminder scheduler fires on due (mock clock or dueAt=now), summarize builds payload WITHOUT store-wide leakage (only requested note text), classifier picks `notes` intent, dispatcher paths, store persists across load/save. Smoke harness `scripts/smoke-notes-e2e.js`: full voice flow — note → timed reminder (dueAt in the past fires immediately) → task add → mark done → keyword search → summarize payload check.

### Undo

Registry `lastResult` + reverse fns (per Stage 6 pattern): `complete-task` reverse un-does; `delete-note` reverse re-inserts (stashed content); `cancel-reminder` reverse re-arms; `summarize-notes` reverse is a no-op (idempotent).

### Known limitations

- Keyword search is substring/TF-ish, not semantic (user flagged: semantic arrives in Prompt 8).
- Reminder notification permission on macOS is requested at first fire; Windows works without prompts.
- Reminders only fire while the app is running (local app; acceptable — noted in README).
