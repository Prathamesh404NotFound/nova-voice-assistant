# Round 24: Nova Identity & Persona Layer

## Why this (competitor gap evidence)
- Vellum: identity layer + personality = #1 differentiator; 25% scoring weight for
  "memory and personalization" + 20% "capability"; proactive persona is a 2026
  standard in personal-AI rankings.
- Nova answers by voice but has no name/persona/user-model yet → largest gap.

## Scope
1. **Identity module** (`src/main/identity/identity.js`): local JSON in user-data
   (`identity.json`): name (default "Nova"), personality ("concise" |
   "professional" | "warm" | "playful"), user name, preferred time zone note,
   createdAt. `setForTesting` + reset hooks. L1 SAFE (local only, never sent to
   OpenRouter except a single preference-summary request later if user asks).
2. **User model / preferences** (`src/main/identity/user-model.js`): stores
   per-topic preferences keyed by normalized phrase ("when I say good morning",
   "when I add tasks", …) plus a global "knowsAboutUser" list of facts extracted
   from explicit statements ("remember I work from home on Fridays"). Max 100
   entries, dedupe by key. Voice: "remember that [X]", "remember I [X]",
   "forget that [X]", "what do you know about me". Actions:
   `notes:remember-fact` (L1 SAFE), `notes:forget-fact` (L2 reversible, toast).
3. **Planner routing** (`src/main/notes/plan.js`): RE_REMEMBER_FACT +
   RE_FORGET_FACT + RE_USER_MODEL_ASK before RE_NOTES_LIST. Greeting trigger:
   "good morning" / "hello nova" when matched via RE_GREETING → notes:greet.
4. **Personality-driven dispatch** (`src/main/notes/dispatch.js`):
   - `notes:remember-fact` execute saves fact; response "Got it — [fact]." (warm:
     "I'll remember that."). Personalities affect ONLY greeting + acknowledgement
     line prefixes, never fact wording.
   - `notes:forget-fact` L2 toast with simulate ("would forget 'I work from home on Fridays'"),
     reversible restore.
   - `notes:user-model-ask` reads all facts and speaks "You told me: …" (3 facts
     named, then "+N more"); empty: "I don't know you yet — tell me things to remember."
   - `notes:greet` uses name+time: morning/afternoon/evening greeting with user
     name if set, else generic. Personality tone.
5. **Renderer** (`app.js` + `hud.css`): "About me" mini-section in Notes tab side
   panel (settings cog area): shows identity name + personality radio buttons
   (4 options), "facts I know" list with remove buttons; greeting toast card when
   greet action fires (reuses briefing toast card style `.nova-identity-toast`).
   Settings persist to identity.json via IPC `nova:identity-set`.
6. **Greeting automation hook**: morning briefing (R22 preset) greeting line
   personalized with user name when set. Simple: dispatcher looks up identity in
   briefing case — no preset change needed.
7. **Test harness** `src/main/test-identity.js` (~30 tests):
   - identity module: defaults, set/get, persistence, reset hooks
   - user-model: add/dedupe/max-caps/forget/keys normalization
   - planner routing: 6 remember phrases, 2 forget phrases, 2 ask phrases,
     3 greeting phrases, negatives ("remember the milk"?? ambiguous — "remember
     the milk" should NOT match because no fact clause; use "remember milk is in
     fridge" style; negative: "remember" alone)
   - actions: registry L1/L2, simulate on forget
   - dispatch wording: warm vs concise greeting variants, personalized morning
     briefing line when user name set
   - renderer IPC round-trip via fake mainWindow (settings flow)
   Wire test:identity into chain; full npm test EXIT 0; README row + section.

## Files touched
src/main/identity/identity.js (NEW), src/main/identity/user-model.js (NEW),
src/main/notes/plan.js, actions.js, dispatch.js, main.js (IPC), preload.js
(identity callbacks), src/renderer/js/app.js, index.html, hud.css,
README.md, package.json (script), docs/plans/2026-08-18-round24-identity.md (NEW),
src/main/test-identity.js (NEW).
