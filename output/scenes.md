# Nova — Meet Your Desktop's New Voice

## Overview
- **Topic**: Product demo/explainer for Nova, an open-source voice-first Electron desktop AI assistant
- **Hook**: "What if your desktop could hear you — and act on what you say?"
- **Target Audience**: Developers and power users who want a local-first AI assistant on their desktop
- **Estimated Length**: ~85 seconds (5 scenes)
- **Key Insight**: Nova sees your screen, controls your mouse and keyboard, manages files and knowledge — but every action is safety-gated and everything stays on your machine.

## Narrative Arc
The viewer starts by imagining a desktop that listens. We then reveal the voice pipeline that turns speech into action, show Nova reading your documents through a local knowledge base, reassure them with the privacy model, and close with automations that run on their own. Each scene ends with a beat of resolution before the next.

---

## Scene 1: Hook — The Desktop Listens
**Duration**: 10.1s (scene1_hook.wav measures 9.08s + 1.0s trailing buffer)
**Purpose**: Grab attention; establish the dark HUD visual language and the orb motif.

### Visual Elements
- Dark background (#020306) with a central glowing cyan orb (concentric rotating rings)
- Soundwave emanating outward from the orb
- Title text "NOVA" in Orbitron-style bold, subtitle "Meet your desktop's new voice"
- A spoken command phrase appearing as a live transcript line: "Nova, open my downloads"

### Content
The orb breathes and pulses. A voice waveform sweeps across. The transcript line types out. Text reveal: "See your screen. Control your mouse. Manage your files. All by voice."

### Narration Notes
Warm, intrigued tone; hook question first.
Script: "What if your desktop could hear you — and actually do what you ask? Meet Nova."

### Technical Notes
- Camera-style background + Circle/SurroundedRectangle rings with continuous rotation updater
- Waveform: a group of vertical bars with height updates; keep it simple (10 bars)

---

## Scene 2: The Voice Pipeline
**Duration**: 17.3s (scene2_pipeline.wav measures 16.24s + 1.0s trailing buffer)
**Purpose**: Explain voice → intent → plan → action flow.

### Visual Elements
- Left-to-right flow diagram: microphone icon → "Intent" chip → "Plan" checklist → action icons (folder, mouse cursor, window)
- Arrows animating between stages
- Risk level ladder appearing beside the plan: L0 Read … L4 Destructive

### Content
Voice enters, gets classified, becomes a step-by-step plan, and Nova narrates each step. The 5-level risk ladder shows which actions fire immediately, which need a toast, which need explicit confirm.

### Narration Notes
Confident, explanatory. Script: "Say a command — or just talk. Nova hears you, figures out what you mean, and builds a plan. Every action carries a risk level. Simple moves happen right away. Anything sensitive asks you first."

### Technical Notes
- VGroup with .arrange(RIGHT, buff=0.9)
- Use Arrow objects; Transform a Text into successive forms where possible
- Keep text sizes so widths stay under ~85% of frame width

---

## Scene 3: Local Knowledge Base
**Duration**: 14.3s (scene3_kb.wav measures 13.28s + 1.0s trailing buffer)
**Purpose**: Show RAG pipeline — folders → chunks → local embeddings → cited answer.

### Visual Elements
- Folder icon → splits into chunk cards (animated split)
- "Local embeddings" node (384-d vector bar motif)
- Query arrow in, answer out with source citation "answer.md · design.md"
- Small "100% local" badge

### Content
Point Nova at your folders. Documents get chunked and embedded fully on-device. Ask a question — only the relevant snippets ever leave the machine, and answers always name their sources.

### Narration Notes
Script: "Point Nova at your folders, and it builds a private knowledge base. Everything gets chunked and embedded right on your machine. Ask a question, get an answer — with sources, and no cloud."

### Technical Notes
- Split animation: folder rectangle shrinks/scales down as chunk cards fade in below
- Citation: Text in monospace (JetBrains Mono via MarkupText tt)

---

## Scene 4: The Privacy Shield
**Duration**: 16.9s (scene4_privacy.wav measures 15.92s + 1.0s trailing buffer)
**Purpose**: Reassure — Private Mode, data stays local.

### Visual Elements
- Shield icon built from shapes, glowing green/cyan
- 🔒 PRIVATE badge in top-right corner style
- A network arrow leaving the machine gets blocked by the shield (X mark)
- "On-device. Always." text

### Content
Flip Private Mode and all outbound network is blocked. Notes, screenshots, and documents never leave the device.

### Narration Notes
Calm, firm, reassuring. Script: "And here's the promise: everything runs on your machine. Flip on Private Mode, and nothing leaves your device. Your files, your notes, your screen — yours."

### Technical Notes
- Shield: Polygon/Star approximated from Rectangle + Triangle VGroup or use a big ArcPolygon-like VGroup of arcs
- Block animation: arrow grows toward shield, shield flashes, arrow replaced by a red X

---

## Scene 5: Automations + Outro
**Duration**: 16.2s (scene5_outro.wav measures 15.16s + 1.0s trailing buffer)
**Purpose**: Show scheduled routines; close with CTA.

### Visual Elements
- Clock face with tick marks
- A chain of tool icons (folder scan → notification bell → spoken note) firing one by one
- Final screen: NOVA logo + tagline "Your desktop, finally fluent." + GitHub URL

### Content
"Every weekday at 8 AM, tell me my tasks and check my downloads" — one voice sentence becomes a recurring routine. Close with brand screen.

### Narration Notes
Optimistic, closing. Script: "One sentence is all it takes. 'Every weekday at eight, tell me my tasks.' Nova remembers. And keeps working. Nova — your desktop, finally fluent."

### Technical Notes
- Clock: Circle + NumberPlane-like ticks (small Line segments rotated)
- Chain: icons appear sequentially with lag_ratio
- Final branding uses same orb motif from Scene 1 for bookending

---

## Transitions & Flow
- Recurring motifs: the cyan orb (opens and closes the video), dark HUD background, cyan accent color throughout
- Scene order: Hook → Pipeline → Knowledge Base → Privacy → Automations/CTA
- Each scene uses left-to-right reading flow; titles at top edge

## Color Palette
- Background: #020306 (Nova dark)
- Primary accent: #39D2FF (Nova cyan)
- Secondary: #83C167 / soft green for "local / safe" moments
- Warning: #FF6B6B for risk-level emphasis
- Neutral text: #E8EDF3

## Implementation Order
1. Generate 5 narration WAV clips first (audio ground truth)
2. Measure each clip duration with ffprobe
3. Write video.py with per-scene target-duration comments
4. Render low quality, review, fix, then finalize with audio mux
