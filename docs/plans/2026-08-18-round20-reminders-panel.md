# Round 20: Reminders side-panel controls (snooze + cancel from the tab)

## Context
Round 19 added snooze chips to the fired-reminder banner (toast). That
banner is transient (90 s). The Reminders tab in the side panel currently
only offers a cancel button for *pending* reminders — a fired reminder has
no in-panel control at all. Round 20 closes that gap: the Reminders tab
becomes a full reminder management surface.

## Requirements
1. **Fired-reminder row in the Reminders tab**: fired reminders appear in
   the list (grouped under a "fired" marker) with the same snooze chips
   (5m/10m/30m/1h) reused from Round 19's snooze-ui.js.
2. **Same gate**: every chip click invokes nova:snooze-reminder { id,
   seconds, fromUi: true } — identical L1 action, Action Log entry.
3. **Pending reminders keep cancel** (existing flow, unchanged) — the
   Cancel button routes through notes:cancel-reminder via the voice-free
   notes-run path already used for delete/task-toggle.
4. **Live updates**: the Reminders list refreshes after snooze/cancel
   (re-arm moves the reminder back to pending → fires again later;
   snoozed items show their new due time).
5. **Fired-row lifecycle**: a fired reminder shows "fired N min ago" and
   its snooze chips until it either re-fires or gets snoozed; once
   snoozed, it moves back to pending automatically (store.rearmReminder
   clears .fired).
6. Zero new permissions surface — the renderer already calls notes-run
   for cancel/delete; Round 20 adds only the snooze IPC which already
   exists (Round 19).

## Implementation map
- renderer/js/app.js: renderRemindersList() extended — fired items first
  (top group, cyan "fired 3 min ago" label + snooze bar via
  NovaSnoozeUI.buildBanner), pending items after with cancel. Click
  handler for snooze chips wired to window.nova.snoozeReminder + spoken
  confirmation; refreshNotesList after.
- hud.css: small reminders-specific classes (reuse .nova-snooze-bar /
  .nova-snooze-chip from Round 19 — no new rules needed except a fired
  marker style).
- Main process: nothing new — reuse reminders.snoozeFired queue only if
  chips come from the banner; the tab chips call the IPC directly (the
  action's fromUi path re-arms regardless of the queue — rearmReminder
  always works while the reminder exists and .fired=true).
- Tests: extend test-snooze-ui-renderer.js? Better: new harness
  test-reminders-panel.js covering renderer Reminders list logic headless
  (fired-group ordering, chips render, snooze click flow) + verify main
  action re-arm works on fired reminder via the existing action suite
  (already covered by R19). Add ~15 tests.

## Voice parity note
Voice paths unchanged. Panel is purely additive UX on the existing
permissions framework.

## Acceptance
- Harnesses PASS; full npm test EXIT 0.
- README: feature-table row + "## Reminder snooze UI in panel (Round 20)"
  section above Round 19 section.
