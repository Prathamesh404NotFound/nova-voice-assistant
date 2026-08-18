# Round 5 progress — Event-triggered automations

Round 4 is DONE (demo video cef295a pushed, output/final.mp4 delivered).

## Round 5 architecture decisions
- New module: `src/main/automation/event-triggers.js` — DONE. Supports trigger
  types: `file` (chokidar folder watch, depth+debounce+regex match),
  `time` (HH:MM clock poll), `event` (app-event bus global.__novaAppEvents),
  `idle` (electron powerMonitor, injected for testing).
- Cooldown COOLDOWN_MIN_MS=5min per automation prevents floods.
- `store.js` now persists `trigger` field via `validateTriggerObj` (done).
  Legacy cron-only automations unchanged (cron validation skipped when trigger present).
- `dispatch.js`: added `addEventAutomation(name, trigger, steps)` and
  `triggerLabel(auto)`; listAutomations returns `triggerLabel`; addAutomation
  calls eventTriggers.refreshForAutomation() when trigger present; toggle
  refreshes too.
- runner.js unchanged (reuses runAutomation with same gating/confirmation).
- scheduler.js unchanged (cron path coexists).

## Remaining Round 5 steps
1. Wire up main.js: global event bus `global.__novaAppEvents = new EventEmitter()`,
   emit "app-event" with {name:"startup"} on ready; import eventTriggers and
   call eventTriggers.start()/stop() around scheduler start/stop. Also
   eventTriggers.setAppEmitter(appEvents).
2. Renderer (app.js cronLabel ~line 392): make triggerLabel aware — already has
   cronLabel(auto) used in renderAutoPanel; update to prefer auto.triggerLabel.
3. Test file: `src/main/test-event-triggers.js` — coverage of all 4 trigger
   types, cooldown, debounce, invalid triggers, refusal rules via store.
4. Add to npm test script chain in package.json if needed (check: currently
   "npm test" runs node src/main/test-*.js per package.json scripts).
5. Run `npm test` (EXIT 0 required), commit "Round 5: event-triggered automations", push.
6. Report Round 5, start Round 6 (conversation memory).

## Key file paths
- repo: /home/ubuntu/nova (branch master)
- test-automation.js exists for stage 9 harness
- package.json "test": runs all test-*.js files
