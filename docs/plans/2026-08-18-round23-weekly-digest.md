# Round 23: Weekly digest preset

## Idea
R21/R22 cover "today". This round adds the **week**: a voice-created automation that
delivers a spoken weekly digest every Sunday evening — a summary of what got done this
week, what's still pending, what's overdue, what's coming next week, and what reminders
exist. One voice command sets it up; Nova also gives a fresh on-demand digest ("my week
in review", "weekly digest").

## Design
1. **store.js**: `weeklyDigest(now, weekStart)` — week-granular snapshot:
   - completedThisWeek: tasks completed within [weekStart, now) — needs a done-at
     timestamp; notes store already tracks completions (R14 task-stats week logic uses
     completedAt). Reuse same field via taskStats-like scan.
   - pendingCount: pending tasks not done (excluding done).
   - overdueCount / overdue named (oldest first).
   - dueNextWeek: tasks due in [next Monday 00:00, next Monday+7).
   - remindersUpcoming: reminders due in [now, now+7d) unfired.
   - Keep done-task exclusion rule consistent with R21.
2. **notes plan.js**: RE_WEEKLY = "my week in review" / "weekly digest" / "how did my week
   go" / "what happened this week" → notes:weekly-digest. Check AFTER RE_BRIEFING.
3. **notes actions.js**: register notes:weekly-digest (L1 SAFE), execute {result: store.weeklyDigest()}.
4. **notes dispatch.js**: case notes:weekly-digest — text:
   "This week: {completed} completed out of {total} tasks, {pending} still pending" (+
   overdue mention, next week look-ahead, reminders). narration: "Here's your week in
   review…". empty: "Quiet week — nothing to report."
5. **app.js**: same briefing-card pattern? Simpler: reuse toast with groups (COMPLETED
   THIS WEEK cyan-dim, PENDING, OVERDUE amber, NEXT WEEK, REMINDERS). Or just the toast
   with 4 groups. Implement .nova-digest-toast sharing briefing CSS classes (reuse).
6. **automation parser.js** (mirror R22): RE_DIGEST_PRESET =
   /^(?:set up|create|start|schedule|make me|add)\s+(?:a\s+)?(?:my\s+)?(?:weekly\s+)?digest(?:\s+(?:at|on|for)\s+(.+))?\s*$/i
   → name "Weekly digest", cron with time (default "Sunday 19:00" → `0 19 * * 0`),
   single step "my week in review" (notes kind).
7. **runner.js**: narration passthrough already works (single narrated step → exact text).
   Verify notes step text "my week in review" resolves L1 via registry.

## Tests (test-weekly-digest.js)
- planner routing: 6 trigger phrases + 3 negative (daily phrasings don't route to weekly,
  list survives).
- store weeklyDigest math (week boundary, done-this-week count, overdue, next-week due,
  upcoming reminders, done-exclusion).
- actions register + execute payload.
- dispatcher wording (populated + quiet week).
- parser preset: "set up a weekly digest at 7 PM" (cron 0 19 * * 0), "create a weekly
  digest" (default Sunday 19:00), "schedule a digest for Sunday at 8 PM" — bare digest
  phrase; bad time → plain error; non-digest phrasing not swallowed.
- store add: preset status safe, L1 step resolution.
- runner: preset execution → exact dispatcher digest line (narration passthrough),
  unattended, quiet-week line.

## Pipeline
implement → harness → fix → python3 scripts/add-test-script.py test:weekly-digest
"node src/main/test-weekly-digest.js" → npm test EXIT 0 → README row + section →
commit/push → report → R24.
