# Nova Stage 7 — Local Notes, Reminders & Tasks

**Author:** Manus AI · **Date:** August 17, 2026 · **Commit:** `4af584b` · **Repo:** [Prathamesh404NotFound/nova-voice-assistant](https://github.com/Prathamesh404NotFound/nova-voice-assistant) (private)

Stage 7 adds a fully on-device notes, reminders, and tasks module to Nova. Everything in this module lives in a single JSON file inside the app's user-data directory — no cloud account, no external calendar service — and every action is gated through the same permission framework, Action Log, and undo system built in Stages 2 and 5.

## What was built

The module lives in `src/main/notes/` and is composed of six files that mirror the architecture established by the Stage 6 files module. The design document is at `docs/plans/2026-08-17-stage7-notes-tasks-design.md`.

| File | Role |
|---|---|
| `store.js` | Local JSON store at `userData/notes.json` with atomic writes (write-to-temp then rename), no network dependencies whatsoever |
| `plan.js` | Rule-based natural-language planner: note capture, timed reminders ("at 3pm", "in 5 minutes", "in 2 hours 15 minutes"), task add/mark-done, keyword search, id-based and text-based delete and reminder cancellation |
| `actions.js` | All 12 notes actions registered through `action-registry` with risk levels, `simulate()` descriptions, and `reverse()` functions for undo |
| `reminders.js` | 30-second polling scheduler that fires the Electron Notification API once per reminder (persisted `fired` flag), plus a `nova:reminder-fired` IPC event so a focused app speaks the reminder aloud |
| `summarize.js` | The only network-touching path for note content: sends note texts to the model router on an explicit "summarize my notes" request, and refuses outright in Private Mode |
| `dispatch.js` | `runNoteAction()` end-to-end voice path with narration, store-context threading for "this" and name resolution, and one-shot execution through the gate |

## Risk levels and safety behavior

| Actions | Level | Behavior |
|---|---|---|
| `notes:add-note`, `notes:add-task`, `notes:add-reminder`, `notes:search-notes`, `notes:list-notes`, `notes:list-tasks`, `notes:list-reminders` | L1 | Safe — create and read; execute immediately |
| `notes:complete-task`, `notes:delete-note`, `notes:delete-task`, `notes:cancel-reminder`, `notes:summarize-notes` | L2 | Reversible — 5-second cancellable toast; each has a `reverse()` fn so Nova's 5-minute Undo restores the item |

Every dispatched notes action — whether triggered by voice or by the mouse-driven side panel — is appended to the persistent Action Log with its level, timestamp, and outcome. Delete and completion reversals were verified end-to-end: after "delete my note about the garage code" the note is gone from the store and then fully restored by the Undo button.

## Privacy: notes never leave the machine

Note content is excluded from every conversation call the model router makes. The system prompt composition and the chat stream both operate only on user messages and Nova's own narration; the notes store is never included. The single deliberate exception is an explicit user request to **"summarize my notes"**, at which point only the note texts for that one request are sent through the normal router flow. That action is refused in Private Mode as well, so the module's data model holds even under the strictest setting. This guard sits at two layers (the dispatcher's summarize branch and the notes IPC handler in `main.js`), so no path can slip through.

## Voice commands verified

The planner and classifier were tested on the full voice surface: `"Nova, note that the garage code changed to 8472"` creates a timestamped note; `"remind me to take the chicken out at 3pm"` and `"remind me in 5 minutes to stretch"` create timed reminders; `"add pick up the dry cleaning to my tasks"` and `"mark pay rent done"` manage the task list; and `"what did I note about birthday"` runs a keyword search and reads the matches back. The classifier routes all of these to the NOTES intent and keeps conversation, files, and vision phrases out of it.

## Side panel

A new **Notes/Tasks** tab sits between the Action Log and the Type-instead sections. It lists notes, tasks, and pending reminders, and every entry is editable by mouse and keyboard — add, mark done, delete, and cancel reminders without saying a word. These actions call the same `nova:notes-run` IPC path as the voice loop, which means a mouse click that completes a task lands in the Action Log at exactly the same level as the voice equivalent. When a reminder fires, a toast appears and, if the app is focused, Nova narrates it.

## Testing

The end-to-end user-specified flow was verified by the new harness `scripts/smoke-notes-e2e.js`: a note is created, a timed reminder is set and forced due (the OS notification fires with the reminder text, exactly once), a task is added and completed, and a keyword search returns the right note. Deletion and intent classification round out the run.

| Suite | Result |
|---|---|
| `npm run test:permissions` | 27/27 |
| `npm run test:vision` | 27/27 |
| `npm run test:control` | 72/72 |
| `npm run test:agent` | 38/38 |
| `npm run test:files` | 82/82 |
| `npm run test:notes` (new) | 78/78 |
| `node scripts/smoke-notes-e2e.js` | SMOKE OK |
| Boot on Xvfb (headless) | Clean — all 12 notes actions registered at boot |

Two small design refinements worth noting: the planner's context threading for reminders fixed a gap where id-based commands ("cancel reminder \<id\>") from the side panel could not see stored reminders, and the undo bridge now merges the gate's stored execute result into every reversal payload, so note and task reversals work without per-action plumbing.

## Known limitation

Reminders only fire while the app is running — the store persists them in JSON, but there is no system-level scheduling beyond it. This is documented in the README under the Stage 7 section.
