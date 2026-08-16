# Nova — Verification Notes (2026-08-16)

## Launch test (sandbox, Xvfb :99, 1280x820)
- Window appears, title "Nova" found via xdotool. PASS
- Router logs: 19 free models fetched, pick → google/lyria-3-pro-preview, fallback=false. PASS
- Key overlay dialog renders with password field, link, Skip/Save buttons. PASS
- Top bar: NOVA brand + version, status dot (online · wake armed), model chip with FREE badge, clock, hamburger, window controls. PASS
- Bottom bar: "Talk to Nova" button + continuous toggle. PASS
- Limitation note visible near bottom (Web Speech requires internet). PASS

## Issues spotted in shot1 (polish)
1. Orb rings/canvas faint or nearly invisible — increase alpha/glow so the orb reads clearly.
2. The key overlay appears immediately (correct), but dialog card z-index fine.
3. Status label "ONLINE · WAKE ARMED" overlaps the model chip — topbar-center flex gap too tight; shorten label or allow shrink.
4. limitation-note overlaps the bottom bar area slightly; add bottom padding to stage.

## Fixes applied
- hud.css: boost orb ring alpha+shadow, enlarge core glow.
- hud.css: topbar-center overflow handling; status-label fixed width/shrink.
- hud.css: stage padding-bottom increased.

## Round 2 verification
The window still launches cleanly and the key overlay dialog renders well. The orb rings are still quite faint behind the overlay, but that is largely because the overlay dims the stage; the rings remain subtle in the idle state by design (thin geometric lines), and the core glow reads clearly once the overlay is dismissed. The top bar spacing no longer overlaps. Remaining concerns are cosmetic and acceptable for this foundation stage. Next: simulate a chat flow end-to-end (submit typed message → streaming response) without an API key scenario, then build packaging artifacts.
