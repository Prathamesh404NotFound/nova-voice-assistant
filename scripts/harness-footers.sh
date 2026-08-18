#!/bin/bash
# Print each harness's summary footer (last lines mentioning pass/fail/tests).
cd /home/ubuntu/nova
for f in test-agent test-automation test-files test-notes test-kb test-history-export test-palette-ranking test-router test-snooze-reminder test-snooze-ui test-task-due-dates test-task-stats test-weekly-digest test-identity test-identity-briefing test-greeting-briefing test-mood-check test-mood-priority test-morning-briefing test-reminders-panel test-screenshot-note; do
  echo "=== $f"
  node src/main/$f.js 2>&1 | grep -iE "passed|failed|PASS|assertions|tests" | tail -2
done
