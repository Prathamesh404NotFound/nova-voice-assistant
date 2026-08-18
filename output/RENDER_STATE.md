# Round 4 render state (as of latest run)

All 5 scenes now render successfully at low quality (480p15, 15 fps).

| Scene | Media dir | Duration | Target |
|---|---|---|---|
| Scene1Hook | /tmp/manim_r3 | 10.53s | 10.1s |
| Scene2Pipeline | /tmp/manim_r4 | 14.67s | 17.3s (close enough, fine) |
| Scene3KnowledgeBase | /tmp/manim_r4 | 14.27s | 14.3s |
| Scene4Privacy | /tmp/manim_r5 | 15.87s | 16.9s |
| Scene5Outro | /tmp/manim_r5 | 15.13s | 16.2s |

Narration WAVs at /home/ubuntu/nova/output/scene{1..5}*.wav: 9.08 / 16.24 / 13.28 / 15.92 / 15.16 s.

Fixes applied so far: FlashAround->Circumscribe, updater lambda signature, removed wave.start_animation(), badge emoji removed (manim can't render), final brand layout recentered, fill opacities on nodes, wait() beats tuned.

Verified good: Scene2 final frame layout (pipeline + risk ladder), Scene4 layout (shield/block/tagline), Scene1 orb layout.

Final step remaining for Round 4:
1. Run finalize script: bash /home/ubuntu/skills/manim-animator/scripts/finalize_video.sh /home/ubuntu/nova/output/video.py /home/ubuntu/nova/output/ /home/ubuntu/nova/output/final.mp4 (or manually: render HQ + concat + mux audio per-scene WAVs + ffmpeg).
   NOTE: script finalizes by concatenating scene videos in order; audio muxing per-scene may need manual ffmpeg: concat video list then overlay each audio segment at the right offset. Simplest manual approach: per scene, ffmpeg -i scene.mp4 -i scene.wav -c:v copy -c:a aac -map 0:v -map 1:a -shortest; then concat with concat demuxer.
2. Commit: git add -A, commit "Round 4: Nova demo video (Manim explainer)", git push.
3. Report Round 4 complete, start Round 5 (Event-triggered automations in src/main/automation/).

Repo: /home/ubuntu/nova, branch master, tests: cd /home/ubuntu/nova && npm test (must exit 0).
