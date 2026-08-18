# Nova Improvement Loop — Master State Notes (Stage 10+)

## Task context
- User wants the **VoltSetu-style continuous improvement loop** applied to Nova.
- VoltSetu loop = numbered "Rounds", each: implement → build → commit → push → verify → report round number → move to next. User said "go" and "keep looping until I say stop".
- User also asked to use skills: top-design, github-gem-seeker, video-generator, seo-competitor-analysis, internet-skill-finder, manim-animator, content-gap-analysis — "add as much creativity as you have".
- Repo: /home/ubuntu/nova (GitHub: Prathamesh404NotFound/nova-voice-assistant)
- All 9 stages committed + pushed. Full npm test chain green (455+ tests).

## Current Nova state (from README)
- Electron + Node.js, no bundler, Node 22.13.0, test pattern = Module._resolveFilename shim → shim-electron.js.
- Features: HUD, voice pipeline, VAD, model router, chat streaming, key storage, packaging, agent loop, undo, dev mode, retries, onboarding, indicators, screen vision, mouse/keyboard control, file management, notes/reminders/tasks, KB (local embeddings), safety framework, automation engine.
- Known limitations (from README):
  1. Web Speech STT requires internet (OS service)
  2. No pure-JS offline wake word — energy-gate VAD used
  3. In-app settings overlay; native dialog fallback
  4. safeStorage on Linux may fall back in-memory
  5. desktopCapturer needs real display
  6. Free-tier model rotation, rate limits, retryOnce
  7. Ambiguous-intent quick classification fallback
  8. Undo only L2 with reverse fn, 5 min
  9. macOS control needs Accessibility grant
  10. Vision reasoning needs API key; Private Mode OCR-only

## KB known limitations
- MiniLM ~80MB first-run download; fallback hasher; .docx/.pdf text only (no tables/images)
- Caps: 5 folders / 2000 files / depth 8

## Automation known limitations
- Only fires while Nova running; NL parser covers tested phrasings only

## Test counts (last green run)
- permissions 27/27, vision 27/27, control 72/72, agent 38/38, files 82/82, notes 83/83, kb 88/88, automation 62/62 + smoke-auto-e2e 16/16, verify-plan-regexes 25/25
- npm test chain = permissions + vision + control + agent + files + notes + kb + automation (EXIT 0)

## Key architectural facts
- src/main/permissions/: risk-levels.js, action-registry.js, gate.js, action-log.js
- src/main/router.js pickModel(taskType) for chat/coding/vision/quick; fallback google/gemini-2.5-flash-001
- src/main/agent/: classifier.js (INTENTS, rule-based + pickModel("quick") for ambiguous), dispatcher.js (run(opts))
- src/main/vision/, control/, files/, notes/, kb/, automation/
- src/preload/preload.js contextBridge (nova:* IPC)
- src/renderer/: index.html, css/hud.css, js/app.js — single-screen HUD, Orb visualizer, side panel
- HUD uses Orbitron + Space Grotesk fonts, dark command-center theme
- IPC pattern: main.js ipcMain.handle("nova:X") → preload expose → renderer uses window.nova.X
- Test harness: check()/ok()/FAIL runner, electron shim (shim-electron.js)
- Boot test: Xvfb :98, npm start, verify actions register
- Commit + push pattern: git add -A && git commit -m "..." && git push

## Improvement ideas pool (for the loop)
1. **UI/UX polish (top-design):** HUD redesign — dramatic typography scale contrast, custom easing, staggered reveals, signature moments in orb visualization, branded selection colors, micro-interactions
2. **github-gem-seeker:** find battle-tested open-source wake word (e.g., picovoice/porcupine-free alternatives, snowboy, or picokitt) to fix limitation #2
3. **video-generator / manim-animator:** create a Nova demo/promo video (30-60s) showing the HUD, orb, voice pipeline — for the README/landing
4. **seo-competitor-analysis:** analyze competitors of "voice-first desktop AI assistant" (Copilot, Rabbit R1, Rewind, etc.) to identify feature gaps
5. **content-gap-analysis:** analyze Nova's README/docs as a product site vs competitors to find feature/content gaps
6. **internet-skill-finder:** find Agent Skills for electron-app improvements
7. Feature: offline wake word integration
8. Feature: smart reminders with natural language durations
9. Feature: file preview/quick-look integration
10. Feature: multiple KB folders with tags
11. Feature: automation trigger on events (file change, screen text match) not just time
12. Feature: TTS voice selection/customization
13. Feature: conversation memory (context window across sessions)
14. Feature: onboarding wizard walkthrough
15. Feature: dark/light theme toggle in settings
16. Feature: keyboard shortcuts cheat sheet overlay
17. Feature: notification sound customization
18. Feature: export/import settings + knowledge base
19. Feature: spell check / autocorrect in typed input
20. Feature: command history search (Ctrl+R style)
21. Bug fixes from known limitations

## Loop protocol
- Each round: implement → npm test (full chain, EXIT 0) → commit + push → report round number → next round
- Ask user major questions periodically (every ~2-3 rounds)
- Don't stop until user says "stop"

## Round 1 — Competitive Gap Analysis Findings

### Competitors analyzed (from web research)

| Competitor | Key Features | What Nova Already Has | What Nova Lacks |
|---|---|---|---|
| **Microsoft Copilot Voice (Win 11)** | "Hey Copilot" wake word, 40+ languages, calendar/task management, file control, accessibility-focused, built-in | Voice pipeline, task management, file mgmt | **True wake word**, calendar integration, accessibility focus |
| **Open Interpreter Desktop** | Document editing (Word/Excel/PDF), form filling, data dashboards, expense reports, transcript-to-slides, batch rename, any-model support, offline local models | File mgmt, doc extraction (.txt/.md/.pdf/.docx), model router | **Document editing**, **data analytics/dashboards**, **spreadsheet support**, **offline local LLM (Ollama)** |
| **Rewind AI** (shut down Dec 2025) | 24/7 screen recording, timeline playback, AI search over screen history, media playback memory | Screen vision (screenshot-on-demand), KB | **Continuous screen recording + searchable history**, **audio capture + transcription** |
| **Screenpipe (Rewind alternative)** | 24/7 local screen+audio capture, text extraction, AI search over captured history, OCR, local-first | OCR, screenshot capture | **Continuous background recording**, **searchable screen history** |
| **Rabbit R1** | Large Action Model, 360° camera, visual search, translation, transcription, app interaction | Vision pipeline, control planner | **Dedicated hardware**, **real-time video understanding** |

### Identified Feature Gaps (Prioritized by Impact + Feasibility)

**High Impact, High Feasibility (build these):**
1. **True offline wake word** — "Hey Nova" keyword detection without mic tap (competitors all have this)
2. **Offline local LLM via Ollama** — run local models when API key unavailable (Open Interpreter does this)
3. **TTS voice selection/customization** — Copilot supports 40+ languages, voice options
4. **Event-triggered automations** — screenpipe does file/screen events; Nova only has time-based

**High Impact, Medium Feasibility:**
5. **Conversation memory** — persistent cross-session context (Copilot has this)
6. **Onboarding wizard** — guided first-run experience (Copilot has this)
7. **Keyboard shortcuts overlay** — power-user feature
8. **Dark/light theme** — standard expectation

**High Impact, Lower Feasibility (note as future):**
9. **Continuous screen recording + searchable history** — like screenpipe/Rewind (heavy resource)
10. **Document editing** — Word/Excel manipulation (like Open Interpreter)
11. **Calendar/email integration** — requires OAuth, cloud APIs

**UI/UX Gaps (from top-design rubric):**
12. **Typography scale contrast** — current HUD uses fixed-size fonts, no dramatic scale hierarchy
13. **Custom easing/motion** — current CSS likely uses default transitions
14. **Staggered reveals** — page-load choreography
15. **Micro-interactions** — hover states, magnetic buttons, branded selection colors
16. **Performance visualizer** — 60fps orbital animation with purposeful motion

### Action Plan from Gap Analysis
The gap analysis confirms and prioritizes the improvement rounds already planned in the approved plan. Proceed with Round 2 (wake word) as the highest-impact, highest-feasibility item, followed by Round 3 (UI redesign).

=== ROUND 3: HUD REDESIGN (top-design skill) ===

Key principles from top-design skill:
- Typography as architecture: dramatic scale contrast (10:1+ display:body ratio)
- Custom easing mandatory: cubic-bezier(0.16, 1, 0.3, 1) (expo out) — never linear/default
- Custom cursor, magnetic buttons, branded selection colors for details
- Monochromatic tension: 95% dominant color, 5% accent that pops
- Never pure black/white — warm variants (#0a0a0a, #fafaf9)
- Motion choreography: background (0-200ms), hero words staggered (200-600ms, 80ms stagger), subtitle (400-800ms)
- 60fps non-negotiable
- Color hierarchy: text-primary, text-secondary (60% opacity), text-tertiary (40% opacity), surface, border (10% opacity)
- Elements overlap, bleed, extend with intention — asymmetric balance

Current Nova HUD elements to enhance:
- Orb (300x300 canvas + radial gradient core) — already has pulse animation
- Live transcript line (17px, 620px max-width)
- Talk button (pill shape with ring pulse)
- Status dot + model chip (top bar)
- History panel (side, 360px)
- Type input (bottom)

Redesign approach:
1. Add glassmorphism layers with backdrop-filter blur on overlays
2. Dramatic typography scale contrast on status text
3. Custom easing on all transitions (already has --ease-out defined)
4. Magnetic hover on talk button
5. Ambient particle/aurora background animation
6. Smooth staggered reveal on app load
7. Branded ::selection color
8. Custom scrollbar styling
9. Subtle noise/grain texture overlay for depth
10. Enhanced orb: add ring layers, more dynamic breathing

