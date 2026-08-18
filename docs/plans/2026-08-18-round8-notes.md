# Round 8 state — TTS voice customization

## Current TTS (app.js ~L1195)
speak(): rate=1.02 fixed, pitch=1.0 fixed; preferred voice = first en-US female-ish
(Samantha/Zira/Google US English) else first en voice; barge-in via click + talkBtn.
settings mirror exists in renderer (~L1240) synced via nova:settings-changed.
Side-panel settings section exists (~L201 in index.html: privateMode toggle, key,
wake word) — this is where the voice settings UI goes.

## Plan
1. New local TTS settings (renderer-side localStorage, since settings.json is
   main-process; keep simple: nova.settings → only in preload. Options:
   localStorage "nova-tts" { voiceURI, rate, pitch, enabled } — persist + apply.
2. Settings UI in side panel "Voice" block:
   - Mute toggle (disable speech entirely — speaks nothing)
   - Rate slider (0.5–2.0, step 0.05, default 1.02)
   - Pitch slider (0.5–2.0, step 0.05, default 1.0)
   - Voice select (populated from speechSynthesis.getVoices(), English-first)
3. speak() reads settings: apply rate/pitch/voice; if muted return early
   (but still update orb? -> keep visual "speaking" OFF when muted, log line
   shows "answer prepared (muted)").
4. onvoiceschanged repopulates the select; selection persists by voiceURI.
5. Update README TTS row? Optional short mention.
6. npm test → EXIT 0; git commit/push.

## After Round 8
Round 9: bug fixes (MiniLM first-run network, wake word fallback UX, etc.)
Keep looping.

## Done so far
- speak() now reads ttsSettings (localStorage "nova-tts-settings"): muted early-returns
  (shows "text (sound muted)" on liveLine, mode idle), rate/pitch clamped 0.5–2,
  voiceURI preferred else female-ish en-US fallback. TTS_KEY/load/save/loadTtsSettings defined ~L1195.
- index.html: side panel Settings section now has Voice (TTS) toggle (ttsMuteToggle),
  ttsVoiceRow (ttsVoiceSelect + ttsPreviewBtn "Preview"), tts-slider-row x2
  (ttsRate + ttsRateVal, ttsPitch + ttsPitchVal) before Wake word block.
- hud.css: .tts-voice-row / .tts-slider-row / range accent-color appended.
- app.js el map: ttsMuteToggle, ttsVoiceSelect, ttsPreviewBtn, ttsRate, ttsRateVal,
  ttsPitch, ttsPitchVal, ttsVoiceRow added.

## Remaining
1. Wire listeners in app.js after ttsSettings load: populate ttsVoiceSelect from
   getVoices() (English-first, grouped), restore selected by voiceURI, re-populate
   on onvoiceschanged (existing handler at ~L1268: speechSynthesis.onvoiceschanged
   already does getVoices(); extend).
2. Listeners: ttsMuteToggle change → muted, save, hide voiceRow when muted
   (ttsVoiceRow.hidden = muted); ttsVoiceSelect change → voiceURI save;
   ttsRate/ttsPitch input → save + update val labels; ttsPreviewBtn →
   speak("Hello! This is Nova speaking with your selected voice.").
3. README: one line about TTS customization (voice/speed/pitch/mute, local).
4. npm test → EXIT 0; commit "Round 8: TTS voice customization..." push.
5. Then Round 9: bug fixes. Known candidates: MiniLM first-run needs network
   (check kb/embeddings.js offline behavior), wake word fallback UX if no access key.
   Check docs/plans notes and README known limitations for exact wording.
Process: read app.js TTS section after edit before changing; then tests; then commit.
