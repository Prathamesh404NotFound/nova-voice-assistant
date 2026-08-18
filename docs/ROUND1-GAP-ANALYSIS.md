# Round 1 — Competitive Gap Analysis

**Date:** August 18, 2026
**Subject:** Nova voice-first desktop AI assistant — feature gaps vs. competitors

## Competitors Analyzed

| Competitor | Type | Key Features | Status |
|---|---|---|---|
| **Microsoft Copilot Voice** | OS-integrated assistant | "Hey Copilot" wake word, 40+ languages, calendar/task management, file control, accessibility | Active (Windows 11) |
| **Open Interpreter Desktop** | Desktop agent | Document editing (Word/Excel/PDF), form filling, data dashboards, expense reports, any-model support incl. local Ollama | Active |
| **Rewind AI** | Screen recording + memory | 24/7 screen recording, timeline playback, AI search over history, media playback | **Shut down Dec 2025** |
| **Screenpipe** | Local-first screen memory | 24/7 local screen+audio capture, text extraction, AI search, OCR, automations | Active (open source) |
| **Rabbit R1** | Hardware AI device | Large Action Model, 360° camera, visual search, translation, transcription | Active (hardware) |

## Gap Matrix

| Feature | Copilot | Open Interpreter | Screenpipe | **Nova** | Gap? |
|---|---|---|---|---|---|
| Wake word ("Hey X") | Yes | No | No | Energy-gate VAD (tap to arm) | **YES** |
| Voice conversation | Yes | Partial | No | Yes | No |
| Screen vision | Yes | Yes | Yes (recording) | Yes (on-demand) | No |
| Mouse/keyboard control | Limited | Yes | No | Yes (planner) | No |
| File management | Partial | Yes | No | Yes (full) | No |
| Local notes/tasks | No | No | No | Yes | **Nova leads** |
| Knowledge base (RAG) | No | No | Yes (screen data) | Yes (folders) | **Nova leads** |
| Automation (scheduled) | No | Partial | Yes (events) | Yes (time-based) | **Partial gap** |
| Offline local LLM | No (cloud) | Yes (Ollama) | Yes | No (OpenRouter only) | **YES** |
| Continuous screen recording | No | No | Yes | No | YES (heavy) |
| Document editing | No | Yes (Word/Excel) | No | No | **YES** |
| Calendar/email integration | Yes | Partial | No | No | **YES** |
| TTS voice customization | Yes | No | No | No | **YES** |
| Onboarding wizard | Yes | Partial | Yes | Static banners | **Partial gap** |
| Dark/light theme | Yes | Yes | Yes | No (dark only) | **YES** |
| Keyboard shortcuts overlay | No | No | No | No | **YES** |
| Conversation memory | Yes | No | No | No | **YES** |

## Prioritized Recommendations

### Tier 1 — Build Now (high impact, high feasibility)
1. **Offline wake word** — "Hey Nova" keyword detection without mic tap
2. **Offline local LLM via Ollama** — fallback when no API key
3. **TTS voice customization** — voice/rate/pitch selection
4. **Event-triggered automations** — file change, screen text match

### Tier 2 — Build Next (high impact, medium feasibility)
5. **Conversation memory** — persistent cross-session context
6. **Onboarding wizard** — guided first-run experience
7. **Keyboard shortcuts overlay** — power-user productivity
8. **Dark/light theme toggle**

### Tier 3 — Future Roadmap (high impact, higher complexity)
9. **Continuous screen recording + searchable history** (screenpipe-style)
10. **Document editing** (Word/Excel manipulation)
11. **Calendar/email integration** (requires OAuth)

## Conclusion

Nova is already ahead of competitors in several areas (local notes, KB RAG, full file management with risk gating, automation engine). The most impactful improvements are:
- **Wake word** (every competitor has it; Nova's tap-to-arm is the biggest UX gap)
- **Offline LLM** (Open Interpreter leads here; Nova's router is OpenRouter-only)
- **TTS customization** (basic expectation for a voice assistant)
- **UI polish** (top-design standards — typography scale, easing, staggered reveals, micro-interactions)

These directly inform Rounds 2-9 in the improvement loop.
