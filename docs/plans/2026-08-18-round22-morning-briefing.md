# Round 22: Morning briefing automation

## Idea
The daily briefing (Round 21) currently requires asking for it. This round makes it
**arrive automatically**: user says "every morning at 7, tell me what's on my plate"
(or "set up a morning briefing at 7:30", "start a daily briefing") and Nova creates a
scheduled automation that runs the briefing each day, speaking the result.

## Design
1. **parser.js** (`src/main/automation/parser.js`):
   - `RE_BRIEFING_STEP = /what('s| is)? on my plate today|daily briefing|morning briefing|brief me on today|what do i have due today|my briefing|the briefing/`
   - Add classification branch `STEP_KINDS.NOTES` for briefing clauses (before the
     default FILES branch, after RE_NOTES_TASKS check — NOTES kind so it executes via
     `runNotesStep` → dispatcher → `notes:daily-briefing`).
   - `splitClauses` already strips fuzzy time words like "morning" — "every morning at
     7, what's on my plate" → step text "what's on my plate". But "tell me what's on my
     plate" keeps "tell me". Ensure the step text still routes: RE_BRIEFING_STEP allows
     optional "tell me" prefix.
   - Name maker: briefing automations get a friendly name "Morning briefing".
2. **automation/dispatch.js** (create flow): user phrase "set up a morning briefing at 7:30"
   — parser already parses "every morning at 7:30, tell me what's on my plate". Also add
   an explicit dedicated trigger in `createAutomation`/`addAutomation` text path:
   `/^(?:set up|create|start|schedule|make me|add)\s+(a\s+)?(?:daily|morning)\s+briefing(?:\s+(?:at|for)\s+(.+))?\s*$/i` → cron with fuzzy time (8:00 default, else parseTime).
   Steps: [briefing clause]. Name: "Morning briefing".
3. **runner.js** verb floor: briefing clauses are notes-kind, verbFloor already returns
   SAFE for notes without delete/move verbs. Good.
4. **Renderer**: side-panel automation list already renders all automations (toggle, next
   run, run now) — no new UI needed, but the automation card for the briefing preset gets
   a small 📋 icon and the briefing step shows as "Daily plate briefing".
   Also: after creating via voice, say "Morning briefing set — every day at 7 AM I'll tell
   you what's on your plate."

## Tests (test-morning-briefing.js, ~25)
- parser: "every weekday at 7:30, tell me what's on my plate" → cron + 1 notes step;
  "set up a morning briefing" (default 8:00 daily); "create a daily briefing at 6 AM"
  (explicit cron); "every morning at 9 AM, what do i have due today" (alt phrasing);
  "schedule a morning briefing for tomorrow at 8" (should not crash — creates with given cron).
- parser: "every day at 7 AM, check my downloads and brief me on today" → 2 steps
  (files + notes) — combined automation works (R9 chain + briefing step).
- runner: executing a briefing step with items → ok + plate text; with empty store →
  ok + clear skies text (no network).
- store: persistence of the briefing automation (name, cron, steps) across reloads.
- dispatcher create flow: explicit trigger returns ok, cron 8:00 default, name, single
  briefing step; alt time 7:30 parsed.
- Risk: L1 SAFE (notes kind, verbFloor), action registry lookup resolves
  notes:daily-briefing.

## Remaining
1. Implement parser + dispatch changes.
2. Write harness test-morning-briefing.js; run; fix.
3. Wire test:morning-briefing into package.json chain (python3 scripts/add-test-script.py).
4. npm test → EXIT 0.
5. README row + section "## Morning briefing automation (Round 22)".
6. Commit + push; report; next round.
