# Round 9 — bug fixes / known-limitation improvements

Candidates identified (README known limitations + code review):

1. **Wake-word no-key UX**: toggle shows ON but silently falls back; no user-facing
   status. Fix: renderer shows inline note when enabled but no key ("Wake word
   needs a Picovoice AccessKey — set it to enable") + wakeWordStatus text updated
   on toggle; initWakeWord() reports state.
2. **MiniLM first-run network + silent fallback**: fallback hasher is silent —
   user may never know the real model never loaded. Fix: expose kb embedding mode
   via IPC (nova:get-kb-status → { hasModel, usingFallback, modelPath }) and show
   an inline note in KB panel ("Using lightweight local hasher — real embeddings
   need a one-time download").
3. **safeStorage Linux in-memory fallback**: detection exists in logs only. Fix:
   report keyStorageInsecure flag via getSettings + UI note in Settings
   ("Keychain unavailable — key stored encrypted in app data" when fallback).
4. **429 bursts UX**: retryOnce says "wait a moment" — add a rate-limit state to
   model chip: show a small hourglass "slow" badge after a 429 until cooldown
   (local state, 60s).
5. **kb reindex after model download**: if model unavailable at first run, later
   runs with network still use fallback because _fallback=true persists for the
   session only — actually session-only, so it self-heals; but index was built
   with fallback vectors → search quality jump inconsistent. Acceptable; add a
   "rebuild index" button? Keep simple: add note in UI.

Implementation plan:
- keys.js: getSettings additions — keyStorageInsecure (isEncryptionAvailable false)
  → main.js get-settings handler adds it.
- kb/index.js or query.js: add getKbStatus() → main.js ipc handler nova:get-kb-status.
- embeddings.js: expose modelDownloaded boolean (cached model exists OR loaded).
- renderer app.js: kbStatus inline note; keyStatus line note; wake word note;
  429 chip badge after speak/error "Too Many".
- README known limitations: update entries.
- npm test → EXIT 0; commit Round 9; push.

Then loop continues: Round 10+ creative (e.g., command palette, orb theming,
screenshot-to-notes, etc.) until user says stop.

## Done (Round 9)
- keys.js: isKeyStorageInsecure() added (cached check; env var users exempt).
- main.js: get-settings returns keyStorageInsecure; new nova:kb-embedding-status handler
  (embeddings.js: embeddingStatus() loaded/fallback/unknown, exported).
- preload.js: kbEmbeddingStatus bridge.
- app.js: kbEmbeddingNote rendered in KB panel (fallback/loaded/unknown messages);
  wakeWordStatus mentions toggle-on-without-key; keyStorageNote under key row.
- hud.css: .kb-embedding-note style appended.
- README known-limitations 2/4/10 updated.
- npm test EXIT=0, 0 failures.

## Remaining
1. git add -A && commit "Round 9: transparency fixes..." && git push.
2. Then continue loop creatively: candidate Round 10+ ideas — command palette
   (Cmd+K-style fuzzy search of actions), orb themes (user-selectable accent
   colors), screenshot-to-note capture, history export, reminder snooze via
   chat, task stats in side panel, keyboard shortcuts in settings view, devmode
   export JSON. Ask no questions — user said keep looping.
