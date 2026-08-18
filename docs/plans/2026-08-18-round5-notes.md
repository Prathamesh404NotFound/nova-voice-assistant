# Running improvement-loop state (updated continuously)

## Completed rounds
- R1: docs/ROUND1-GAP-ANALYSIS.md (competitive gaps)
- R2: offline wake word (porcupine-web) — commit 9e21f8e
- R3: HUD redesign (aurora/orb/glassmorphism) — commit 8e5604f
- R4: Manim demo video (output/final.mp4, 69s, 1080p60 + narration) — cef295a
- R5: event-triggered automations (file/time/event/idle triggers, cooldowns,
  22 new tests, npm test chain includes test:event-triggers) — commit 112de22

## Round 6 IN PROGRESS: conversation memory
- New module created: src/main/memory/conversation-memory.js
  - append({intent,input,output,taskId}) → nova-memory.json in userData
  - prune: MAX_ENTRIES=500, MAX_OUTPUT_CHARS=1000, MAX_AGE_DAYS=30
  - recentContext(turns=6, summaryEntries=8) → messages for chat model
  - clear()/stats(); clearForTesting/setPathForTesting/resetForTesting exports
  - Privacy: only included in model calls when Private Mode OFF
- TODO remaining:
  1. dispatcher.js: in dispatchConversation, build messages =
     recentContext() (only if !settings.isPrivateMode()) + [{role:user,content:text}]
  2. dispatcher run(): after each run, append entry with input + output text
  3. action registry entry memory:clear (Level 1, reversible-ish) in a new
     actions file or inline; expose via IPC nova:memory-* or through action gate
  4. Renderer UI: "Clear memory" option in history/settings panel
  5. Test file src/main/test-memory.js + add test:memory to package.json chain
  6. npm test green, commit "Round 6: conversation memory", push, report,
     then Round 7 (onboarding wizard + global shortcuts)

## Key technical facts
- Repo /home/ubuntu/nova, branch master. Tests: npm test must EXIT 0.
- Dispatcher run() at src/main/agent/dispatcher.js line ~302; conversation
  dispatch at ~154 (fetch openrouter stream, messages array at line ~175).
- Settings: require("../settings"); settings.isPrivateMode()
- classifier INTENTS: CONVERSATION, VISION, CONTROL, FILES, KB, NOTES, AUTOMATION + COMBINED
- Action log: actionLog.append({actionId, level(RISK_LEVEL), outcome, detail})
- package.json test chain: permissions vision control agent files notes kb automation event-triggers
- renderer app.js: automation panel ~line 386; cronLabel ~391; agent-loop
  handling around line 1424

## Round 7+ roadmap (from prior context)
- R7: onboarding wizard + global shortcuts overlay
- R8: TTS voice customization (speed/pitch/voice)
- R9: bug fixes (MiniLM first-run network, wake word fallback UX, etc.)
- Then continue creatively: dark/light theme toggle, Ollama local LLM fallback,
  keyboard shortcuts overlay, continuous improvements
