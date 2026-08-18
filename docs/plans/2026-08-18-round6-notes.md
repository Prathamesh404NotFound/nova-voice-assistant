# Round 6 state — conversation memory (bug fix in progress)

## Root cause FOUND (fix NOT yet verified)
`src/main/agent/dispatcher.js` dispatchConversation:
- `const memoryUsed = memoryContext.length > 0;` IS defined INSIDE `attempt()`
  fn (line ~170) but the final `return { text: res.value, model, memoryUsed };`
  is OUTSIDE attempt (line ~220) → ReferenceError: memoryUsed is not defined
  (caught by run()'s outer try → ok:false "Something went wrong with that
  request").
- FIX: move `const memoryUsed = memoryContext.length > 0;` to right after
  `const memoryContext = settings.isPrivateMode() ? [] : memory.recentContext();`
  but BEFORE `const attempt = async () => {` — i.e. at dispatchConversation
  top level. Currently it sits INSIDE the attempt arrow fn.
- diag scripts proving this: /tmp/diag7.js passes only when the outer-catch
  debug isn't added?? No — consistent failure with ReferenceError.

## Debug residue to REMOVE after fix
1. `src/main/agent/retry.js` line 52: appended `console.log("[DEBUG retryOnce
   attempt2 threw]" ...)` — remove the console.log part, keep log.error.
2. `src/main/agent/dispatcher.js` line 376: `console.log("[DEBUG outer]",
   err && err.stack);` in outer catch — remove.

## Round 6 already built (do not redo)
- memory module `src/main/memory/conversation-memory.js` (12 tests pass in
  test-memory.js)
- actions `src/main/memory/actions.js` (memory:stats, memory:clear L1)
- main.js IPC nova:memory-stats/list/clear; preload bridges memoryStats/List/Clear
- dispatcher wires memory context + append; renderer mem-badge + app.js memory param
- hud.css .mem-badge appended; package.json test:memory in chain

## After fix
1. Remove debug lines, npm test EXIT 0
2. git add -A && git commit -m "Round 6: conversation memory across sessions"
   && git push
3. Report, then Round 7: onboarding wizard + global keyboard shortcuts
   (planned: wizard overlay via existing #onboarding in index.html,
   Alt+Space toggle, globalShortcut in main.js after app ready,
   existing Ctrl+Shift+Esc kill-switch at registerKillHotkey ~line 545)

## Reminder of key facts
- Repo /home/ubuntu/nova, branch master, Node 22, tests via npm test (8 harnesses)
- design tokens: --cyan #39d2ff, --bg #020306, fonts Orbitron/Space Grotesk/JetBrains Mono
