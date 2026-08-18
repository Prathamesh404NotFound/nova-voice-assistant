# Render review findings (low-quality run 2)

All 5 scenes render without errors. Durations vs narration targets (add ~1s buffer):
- S1: 12.27s vs 10.1s target -> slightly over (+2.2s), acceptable but could trim waveform loop (16 steps x 0.35 = 5.6s too long). Trim loop to ~12 steps and 0.3s each.
- S2: 9.0s vs 17.3s -> WAY under. Need more beats: animate arrow->Act node completion, ladder emphasis beats, and longer waits. Add ~8s of pauses/transitions.
- S3: 8.13s vs 14.3s -> under by ~6s. Add pauses + query emphasis beats.
- S4: 7.67s vs 16.9s -> under by ~9s. Add pauses, arrow travel longer, tagline wait.
- S5: 12.13s vs 16.2s -> under by ~4s. Extend chain fire + final brand waits.

Visual issues seen in frames:
- S1: good; waveform small at bottom, transcript not yet visible at frame 60 (fine, it appears later). OK.
- S2: pipeline nodes good but right half empty at t=200; the "Act" node not yet shown (play order issue: scene too short so final state never reached in time budget). Duration fix covers this.
- S3: at t=200 query text mid-Write ("wha..."); final answer box appears after; duration fix covers. Answer box labels may be tiny — increase font sizes slightly (embed labels were black-on-green fine). Source text "sources: answer.md" font 18 OK.
- S4: PRIVATE badge overlaps title "Your Data Stays Yours" at t=60 — move badge lower or title smaller. Shield shape odd (arc top + lines) but recognizable; fine. Badge: shift down.
- S5: step card text missing at t=200 (FadeIn after) — duration fix; card labels were black on colored cards, may be fine once visible. Final brand screen: title+orb side by side; check final frame.

Fixes to apply:
1. S4: badge moves down (UR buff 0.4 -> to_edge(UP) under title? simplest: badge at corner buff 0.8 / title keep, badge buff 1.1 and shift LEFT) -> instead move badge to right side lower: badge.to_corner(UR, buff=0.5) and reduce title overlap by... title width ~6 units from center? Title at 0.55 up, badge at top-right corner overlaps. Move badge down: badge.next_to(title, RIGHT) won't fit. Simplest: badge at corner but buff=1.4, or shrink title to 44.
2. S1: trim waveform loop to 12 steps of 0.3s.
3. S2–S5: add wait() beats and slightly longer run times so total matches targets:
   - S2 add +8.3s: increase ladder fade-in to 1.4, Indicate stays, add self.wait(2.5) at end, run_time 1.6 on action flash.
   - S3 add +6.2s: add waits, query emphasis wait 1.5, answer wait 1.5, final wait 2.
   - S4 add +9.2s: badge fade 1.0, arrow run 1.6, wait(2) after flash, tag write 1.8, final wait 2.5.
   - S5 add +4.1s: chain fire 0.7 each, waits before final brand 1.5, final waits 1.5.
4. S3: labels inside embed_node are NOVA_BG on NOVA_GREEN fill but RoundedRectangle has fill_opacity=0 by default -> text visible on dark bg. Set fill_opacity 0.25 on embed/answer cards. Also answer_box fill.
5. S2: set fill_opacity 0.15 on stage nodes for contrast.
6. S5 step cards: fill_opacity 0.2.
