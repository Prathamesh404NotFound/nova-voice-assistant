# Round 19 — Reminder snooze UI in the side panel

## Motivation
Round 13 added VOICE snooze ("snooze 10 minutes", "pause it" → re-arms the
most recently fired reminder, L1 SAFE). But fired reminders in the HUD have
no mouse path: if the user isn't wearing headphones / isn't watching, the
only way to snooze is to speak back. Round 19 gives fired reminders a
physical snooze affordance.

## Design
- Main process: when a reminder fires (`reminders.start` → fires → sends
  `nova:reminder-fired`), also enqueue a **pending snooze** entry keyed by
  reminder id, valid for 15 minutes. A new IPC invoke `nova:snooze-reminder
  { id, durationMs }` re-arms that reminder unfired at now + durationMs.
  Anything else (already re-fired, unknown id, expired) fails with a plain
  message. This REUSES the existing `notes:snooze-reminder` action id so
  risk level, Action Log, and limits stay identical to voice snooze — no new
  action registration.
- Renderer: the fired-reminder banner in app.js gains a **Snooze** button
  with quick chips: 5 min / 10 min / 30 min / 1 h. Clicks call the IPC;
  success shows a toast "Reminded snoozed 10 min" and re-schedules speak.
  Buttons grey out after the reminder re-fires or expires.
- Limits: only ONE pending snooze per fired reminder; snoozed reminders
  fire exactly once at the new time (same invariant as voice snooze);
  snoozes don't stack — a second snooze replaces the first.

## Test harness (test-snooze-ui.js, ~12 tests)
- action id reuse + L1 level + simulate present
- pending queue: enqueue on fire, expires after 15 min
- snooze invoke: re-arms, once-only, unknown/expired failure paths
- double-snooze replaces first
- renderer JS: chips render, disabled after expiry (pure JS unit tests on
  the new module)

## Done criteria
npm test EXIT 0; README row + Round 19 section; commit + push; report; next.
