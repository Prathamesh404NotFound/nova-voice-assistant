// Nova — renderer app
// Single-screen HUD logic: orb visualizer, mic/talk button, Web Speech STT,
// speechSynthesis TTS with instant barge-in, side-panel history + typed input,
// OpenRouter streaming chat, model router indicators.

(() => {
  "use strict";

  // ------------------------------------------------------------------ state
  const state = {
    mode: "idle",            // idle | listening | speaking
    continuous: false,       // opt-in continuous listening
    micStream: null,
    analyser: null,
    rec: null,               // SpeechRecognition instance
    ttsActive: false,
    wakeArmed: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    wakeDetector: null,      // NovaWakeWordDetector (Stage 10 Round 2 — Porcupine)
    wakeEnabled: false,
    wakeApiKey: null,
  };

  // ------------------------------------------------------------------ dom
  const $ = (id) => document.getElementById(id);
  const el = {
    statusDot: $("statusDot"), statusLabel: $("statusLabel"),
    clock: $("clock"), modelName: $("modelName"), modelBadge: $("modelBadge"),
    focusChip: $("focusChip"), focusChipLabel: $("focusChipLabel"),
    modelChip: $("modelChip"), refreshBtn: $("refreshBtn"),
    orbCanvas: $("orbCanvas"), orbCore: $("orbCore"), orbLabel: $("orbLabel"),
    orbWrap: $("orbWrap"), liveLine: $("liveLine"), liveHear: $("liveHear"),
    talkBtn: $("talkBtn"), continuousCheck: $("continuousCheck"),
    sidePanel: $("sidePanel"), sideToggle: $("sideToggle"), sideClose: $("sideClose"), paletteHint: $("paletteHint"),
    history: $("history"), typeForm: $("typeForm"), typeInput: $("typeInput"),
    devModel: $("devModel"), devCount: $("devCount"), devUpdated: $("devUpdated"),
    devTask: $("devTask"), devTaskBody: $("devTaskBody"), devToggle: $("devToggle"),
    undoBtn: $("undoBtn"), onboarding: $("onboarding"), onboardingTitle: $("onboardingTitle"),
    onboardingWhy: $("onboardingWhy"), onboardingAck: $("onboardingAck"), onboardingBtn: $("onboardingBtn"),
    wizardSteps: $("wizardSteps"), wizardStepLabel: $("wizardStepLabel"), wizardStepFill: $("wizardStepFill"),
    wizardIntro: $("wizardIntro"), wizardIntroLine: $("wizardIntroLine"),
    onboardingFeatures: $("onboardingFeatures"), wizardDots: $("wizardDots"), wizardSkip: $("wizardSkip"),
    devFallback: $("devFallback"), devLog: $("devLog"),
    setKeyBtn: $("setKeyBtn"), keyStatus: $("keyStatus"),
    keyOverlay: $("keyOverlay"), keyInput: $("keyInput"),
    keySaveBtn: $("keySaveBtn"), keyCancelBtn: $("keyCancelBtn"),
    privateBadge: $("privateBadge"), privateToggle: $("privateToggle"),
    permToast: $("permToast"), permToastLevel: $("permToastLevel"),
    permToastMsg: $("permToastMsg"), permToastCancel: $("permToastCancel"),
    permLog: $("permLog"), permExportBtn: $("permExportBtn"), permClearBtn: $("permClearBtn"),
    screenPermHelp: $("screenPermHelp"), openScreenSettingsBtn: $("openScreenSettingsBtn"),
    ctrlStopBtn: $("ctrlStopBtn"),
    notesTabs: $("notesTabs"), notesList: $("notesList"), notesAdd: $("notesAdd"),
    notesRefreshBtn: $("notesRefreshBtn"),
    // Round 24: identity layer elements (may be null in stripped builds).
    identityNameInput: $("identityNameInput"), identityNameSave: $("identityNameSave"),
    identityUserNameInput: $("identityUserNameInput"), identityUserNameSave: $("identityUserNameSave"),
    identityPersonalityRadios: $("identityPersonalityRadios"),
    identityFacts: $("identityFacts"),
    kbFolders: $("kbFolders"), kbAdd: $("kbAdd"), kbRefreshBtn: $("kbRefreshBtn"),
    kbProgressLine: $("kbProgressLine"), kbQueryForm: $("kbQueryForm"),
    kbQueryInput: $("kbQueryInput"), kbAnswer: $("kbAnswer"),
    autoList: $("autoList"), autoAdd: $("autoAdd"), autoRefreshBtn: $("autoRefreshBtn"),
    autoPendingCard: $("autoPendingCard"),
    wakeWordToggle: $("wakeWordToggle"), wakeWordStatus: $("wakeWordStatus"),
    setAccessKeyBtn: $("setAccessKeyBtn"),
    ttsMuteToggle: $("ttsMuteToggle"), ttsVoiceSelect: $("ttsVoiceSelect"),
    ttsPreviewBtn: $("ttsPreviewBtn"), ttsRate: $("ttsRate"), ttsRateVal: $("ttsRateVal"),
    ttsPitch: $("ttsPitch"), ttsPitchVal: $("ttsPitchVal"), ttsVoiceRow: $("ttsVoiceRow"),
  };

  // ------------------------------------------------------------------ clock
  // Round 29: the focus chip ticks inside the same 1 s interval as the
  // clock — one cheap timer, not two; renderFocusChip() guards its own
  // existence until a focus session actually starts.
  let __focusChipVisible = null; // caches the last chip DOM state to avoid work
  function renderFocusChip() {
    if (!el.focusChip) return;
    const s = state.focusSession;
    if (!s) {
      if (!el.focusChip.hidden) el.focusChip.hidden = true;
      return;
    }
    el.focusChip.hidden = false;
    const remain = Math.max(0, Math.round((s.endsAt - Date.now()) / 60_000));
    const elapsed = Math.round((Date.now() - s.startedAt) / 60_000);
    const label = remain > 0 ? `${remain}m left` : `done (${elapsed}m)`;
    if (__focusChipVisible !== label) {
      __focusChipVisible = label;
      el.focusChipLabel.textContent = label;
      el.focusChip.classList.toggle("focus-chip-done", remain <= 0);
    }
    // Ring once when the target hits zero: the main process follows with
    // the real stop — the user may still run past the target.
    if (remain <= 0 && !state.focusBell) {
      state.focusBell = true;
      showNotesToast("Focus session target reached — say “stop focus” to wrap up.");
      if (document.hasFocus()) speak("Your focus session target is up. Say “stop focus” whenever you're done.");
    }
  }
  function tickClock() {
    const now = new Date();
    el.clock.textContent = now.toLocaleTimeString("en-GB");
    renderFocusChip();
  }
  setInterval(tickClock, 1000);
  tickClock();

  // ------------------------------------------------------------------ window chrome
  $("minBtn").addEventListener("click", () => window.nova.minimize());
  $("maxBtn").addEventListener("click", () => window.nova.maximize());
  $("closeBtn").addEventListener("click", () => window.nova.close());

  // ------------------------------------------------------------------ side panel
  function setSidePanel(open) {
    el.sidePanel.classList.toggle("open", open);
    if (open) refreshDevPanel();
  }
  el.sideToggle.addEventListener("click", () => setSidePanel(!el.sidePanel.classList.contains("open")));
  el.sideClose.addEventListener("click", () => setSidePanel(false));

  // ======================================================================
  // NOTES / REMINDERS / TASKS SIDE PANEL (Stage 7 — fully local store)
  // ======================================================================

  const NOTES_STATE = { tab: "notes" };

  /** Tab switching (notes | tasks | reminders). */
  function setNotesTab(tab) {
    NOTES_STATE.tab = tab;
    document.querySelectorAll("[data-notes-tab]").forEach((b) => b.classList.toggle("active", b.dataset.notesTab === tab));
    refreshNotesList();
  }

  function whenHuman(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso;
    }
  }

  // Round 17: due-date badge for pending tasks. Day-granular math — due dates
  // are stored at end-of-day, so "due today" holds until midnight.
  function dueBadge(task) {
    if (task.done || !task.dueDate) return "";
    let d;
    try {
      d = new Date(task.dueDate);
    } catch {
      return "";
    }
    if (isNaN(d.getTime())) return "";
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(d);
    due.setHours(0, 0, 0, 0);
    const days = Math.round((due - today) / 86_400_000);
    if (days === 0) return "due today";
    if (days < 0) return Math.abs(days) + "d overdue";
    return "in " + days + "d";
  }

  /** Render the active tab from the local store (no network — reads userData). */
  async function refreshNotesList() {
    const res = await window.nova.getNotesStore().catch(() => null);
    const store = res?.store;
    const tab = NOTES_STATE.tab;
    const emptyMsg = {
      notes: "No notes yet. Voice: “Nova, note that …” — or type below.",
      tasks: "No tasks yet. Voice: “add X to my tasks” — or type below.",
      reminders: "No reminders yet. Voice: “remind me to X at 3pm” — or type below.",
    }[tab];
    if (!store || !Array.isArray(store[tab + "s"])) {
      el.notesList.innerHTML = `<p class="history-empty">${emptyMsg}</p>`;
      return;
    }
    const items = store[tab + "s"] || [];
    if (!items.length) {
      el.notesList.innerHTML = `<p class="history-empty">${emptyMsg}</p>`;
      return;
    }
    if (tab === "tasks") {
      // Round 17: pending tasks with a due date float to the top (soonest first);
      // a small badge reads "due today" / "in 2d" / "3d overdue".
      const sorted = items.slice().sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        if (!a.done && a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
        return 0;
      });
      el.notesList.innerHTML = sorted
        .map((t) => {
          const badge = dueBadge(t);
          const dueCls = badge.endsWith(" overdue") ? " due-overdue" : badge ? " due-soon" : "";
          return `
        <div class="notes-item${t.done ? " done" : ""}">
          <label class="notes-check"><input type="checkbox" ${t.done ? "checked" : ""} data-notes-action="task-toggle" data-notes-id="${escapeAttr(t.id)}" /></label>
          <span class="notes-text">${escapeHtml(String(t.text || ""))}</span>
          <span class="notes-sub${dueCls}">${t.done ? "done" : badge}</span>
          <button class="notes-del" data-notes-action="delete" data-notes-id="${escapeAttr(t.id)}" title="Delete">&times;</button>
        </div>`;
        }).join("");
      return;
    }
    // Round 19 fired-reminder banner (transient toast) and Round 20's
    // Reminders-tab rows both route snoozes through the same helper —
    // panel rows use per-row chips so several fired reminders coexist.
    const snooze = (typeof window !== "undefined" && window.NovaSnoozeUI) ? window.NovaSnoozeUI : null;
    if (tab === "reminders") {
      // fired reminders first (still snoozable), pending after, oldest-first
      const sorted = items.slice().sort((a, b) => {
        if (a.fired !== b.fired) return a.fired ? -1 : 1;
        return new Date(a.dueAt) - new Date(b.dueAt);
      });
      el.notesList.innerHTML = "";
      sorted.forEach((r) => {
        const div = document.createElement("div");
        div.className = "notes-item" + (r.fired ? " fired" : "");
        div.innerHTML =
          `<span class="notes-check"></span>` +
          `<span class="notes-text">${escapeHtml(String(r.text || ""))}</span>` +
          `<span class="notes-sub notes-sub-fired">${r.fired ? "fired " : ""}${whenHuman(r.dueAt)}</span>` +
          `<button class="notes-del" data-notes-action="cancel" data-notes-id="${escapeAttr(r.id)}" title="Cancel">&times;</button>`;
        if (r.fired && snooze) div.appendChild(snooze.buildReminderRowChips(r));
        el.notesList.appendChild(div);
      });
      return;
    }
    el.notesList.innerHTML = items
      .map((n) => `
      <div class="notes-item">
        <span class="notes-text">${escapeHtml(String(n.text || ""))}</span>
        <span class="notes-sub">${whenHuman(n.at)}</span>
        <button class="notes-del" data-notes-action="delete" data-notes-id="${escapeAttr(n.id)}" title="Delete">&times;</button>
      </div>`).join("");
  }

  function renderNotesAddForm() {
    const tab = NOTES_STATE.tab;
    if (tab === "notes") {
      el.notesAdd.innerHTML = `
      <form id="notesForm" autocomplete="off">
        <input id="notesInput" type="text" placeholder="Note that …" maxlength="2000" />
        <button type="submit" class="send-btn">&#10148;</button>
      </form>`;
      $("notesForm").addEventListener("submit", (ev) => {
        ev.preventDefault();
        const v = $("notesInput").value.trim();
        if (!v) return;
        $("notesInput").value = "";
        runNotesCommand(`note that ${v}`);
      });
      return;
    }
    if (tab === "tasks") {
      el.notesAdd.innerHTML = `
      <form id="notesForm" autocomplete="off">
        <input id="notesInput" type="text" placeholder="Add to my tasks …" maxlength="2000" />
        <button type="submit" class="send-btn">&#10148;</button>
      </form>`;
      $("notesForm").addEventListener("submit", (ev) => {
        ev.preventDefault();
        const v = $("notesInput").value.trim();
        if (!v) return;
        $("notesInput").value = "";
        runNotesCommand(`add ${v} to my tasks`);
      });
      return;
    }
    el.notesAdd.innerHTML = `
    <form id="notesForm" autocomplete="off">
      <input id="notesInput" type="text" placeholder="Remind me to … (e.g. call mom at 5pm)" maxlength="2000" />
      <button type="submit" class="send-btn">&#10148;</button>
    </form>`;
    $("notesForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const v = $("notesInput").value.trim();
      if (!v) return;
      $("notesInput").value = "";
      runNotesCommand(`remind me to ${v}`);
    });
  }

  /**
   * Run a notes command through the same permission-gated path as voice.
   * Used by the side panel (mouse/keyboard) so mouse and voice share the
   * exact same actions, levels and Action Log entries.
   */
  async function runNotesCommand(text) {
    try {
      const res = await window.nova.notesRun(text);
      if (!res?.ok) {
        showNotesToast(res?.text || "That request could not be completed.");
        return;
      }
      // Round 21: the daily briefing gets a structured card instead of a
      // plain toast — due-today (cyan), overdue (amber), and today's
      // reminders rendered as scrollable groups next to the spoken line.
      if (res.detail?.kind === "daily-briefing") {
        showNotesToast(res.narration || res.text || "Here's today's plate…", (div) => {
          const b = res.detail.briefing || {};
          div.classList.add("nova-briefing-toast");
          div.dataset.briefing = "1";
          const groups = [
            { label: "DUE TODAY", items: b.dueToday || [], cls: "brief-due-today" },
            { label: "OVERDUE", items: b.overdue || [], cls: "brief-overdue" },
            { label: "REMINDERS TODAY", items: b.remindersToday || [], cls: "brief-reminders" },
          ].filter((g) => g.items.length);
          if (!groups.length) return; // empty plate — the line is enough
          const wrap = document.createElement("div");
          wrap.className = "nova-briefing-groups";
          for (const g of groups) {
            const block = document.createElement("div");
            block.className = `nova-briefing-group ${g.cls}`;
            block.innerHTML = `<div class="nova-briefing-label">${g.label}</div>`;
            for (const item of g.items) {
              const row = document.createElement("div");
              row.className = "nova-briefing-item";
              row.textContent = item.text;
              block.appendChild(row);
            }
            wrap.appendChild(block);
          }
          div.appendChild(wrap);
        });
        return;
      }
      // Round 24: a personalized greeting gets a small identity card — the
      // greeting line plus who Nova is right now (name/personality/user name),
      // with a quick link into the Identity section of the panel.
      if (res.detail?.kind === "greet") {
        showNotesToast(res.narration || res.text || "Hi!", (div) => {
          const id = res.detail.identity || {};
          div.classList.add("nova-briefing-toast");
          div.dataset.greeting = "1";
          const wrap = document.createElement("div");
          wrap.className = "nova-briefing-groups";
          const block = document.createElement("div");
          block.className = "nova-briefing-group brief-reminders";
          block.innerHTML = `<div class="nova-briefing-label">${id.name || "Nova"}</div>`;
          const who = (id.userName ? `for "${id.userName}"` : "no one yet — tell me your name") + ` · ${id.personality || "warm"} voice`;
          const row = document.createElement("div");
          row.className = "nova-briefing-item";
          row.textContent = who;
          block.appendChild(row);
          const note = document.createElement("div");
          note.className = "nova-briefing-item";
          note.textContent = "Adjust any of this in the Identity section below.";
          block.appendChild(note);
          wrap.appendChild(block);
          div.appendChild(wrap);
        });
        return;
      }
      // Round 23: the weekly digest gets the same structured-card treatment
      // as the daily briefing — completed (cyan-dim), overdue (amber), and
      // next week's dues / upcoming reminders as labeled groups.
      if (res.detail?.kind === "weekly-digest") {
        showNotesToast(res.narration || res.text || "Here's your week in review…", (div) => {
          const d = res.detail.digest || {};
          div.classList.add("nova-briefing-toast");
          div.dataset.digest = "1";
          const groups = [
            { label: "COMPLETED THIS WEEK", items: d.completedThisWeek || [], cls: "brief-due-today" },
            { label: "PENDING", items: d.pending || [], cls: "brief-reminders" },
            { label: "OVERDUE", items: d.overdue || [], cls: "brief-overdue" },
            { label: "DUE NEXT WEEK", items: d.dueNextWeek || [], cls: "brief-due-today" },
            { label: "REMINDERS UPCOMING", items: d.remindersUpcoming || [], cls: "brief-reminders" },
          ].filter((g) => g.items.length);
          if (!groups.length) return; // quiet week — the line is enough
          const wrap = document.createElement("div");
          wrap.className = "nova-briefing-groups";
          for (const g of groups) {
            const block = document.createElement("div");
            block.className = `nova-briefing-group ${g.cls}`;
            block.innerHTML = `<div class="nova-briefing-label">${g.label}</div>`;
            for (const item of g.items) {
              const row = document.createElement("div");
              row.className = "nova-briefing-item";
              row.textContent = item.text;
              block.appendChild(row);
            }
            wrap.appendChild(block);
          }
          div.appendChild(wrap);
        });
        return;
      }
      showNotesToast(res.narration || res.text || "Done.");
      refreshNotesList();
    } catch (err) {
      showNotesToast("Something went wrong — see Developer Mode.");
    }
  }

  function showNotesToast(text, augment) {
    const existing = document.getElementById("notesToast");
    if (existing) existing.remove();
    const div = document.createElement("div");
    div.id = "notesToast";
    div.className = "notes-toast";
    div.textContent = text;
    if (typeof augment === "function") augment(div);
    document.body.appendChild(div);
    setTimeout(() => div.classList.add("show"), 10);
    // Round 19: if the banner carries snooze chips, keep the toast up for 90 s
    // so the chips remain clickable (the fired reminder itself is re-armed
    // with a fresh 10-minute window, so the chips stay meaningful).
    const sticky = !!div.querySelector(".nova-snooze-chip");
    setTimeout(() => {
      div.classList.remove("show");
      setTimeout(() => div.remove(), 300);
    }, sticky ? 90_000 : 3500);
  }

  async function refreshNotesPanel() {
    refreshNotesList();
    renderNotesAddForm();
  }

  // Round 24: identity panel — name / voice / user name / facts. Every field
  // writes through the local identity module; a forget button on each fact
  // routes through the same L2 notes:forget-fact action as voice.
  function renderIdentityPanel(identity, facts) {
    if (!el.identityNameInput || !el.identityPersonalityRadios) return;
    el.identityNameInput.value = identity.name || "";
    el.identityUserNameInput.value = identity.userName || "";
    if (!el.identityPersonalityRadios.hasChildNodes()) {
      for (const p of ["warm", "professional", "concise", "playful"]) {
        const label = document.createElement("label");
        label.className = "identity-radio";
        label.innerHTML = `<input type="radio" name="identityPersonality" value="${p}" /> ${p}`;
        el.identityPersonalityRadios.appendChild(label);
      }
    }
    el.identityPersonalityRadios.querySelectorAll("input").forEach((r) => {
      r.checked = r.value === (identity.personality || "warm");
      r.onchange = async () => {
        await window.nova.setIdentity({ personality: r.value });
        showNotesToast(`Voice set to "${r.value}" — say "good morning" to hear the difference.`);
      };
    });
    el.identityNameSave.onclick = async () => {
      const name = el.identityNameInput.value.trim().slice(0, 24);
      if (!name) { showNotesToast("Names can't be empty — I'll stay Nova for now."); return; }
      const res = await window.nova.setIdentity({ name });
      showNotesToast(res?.ok ? `Her name is now "${name}".` : "Could not save the name.");
    };
    el.identityUserNameSave.onclick = async () => {
      const userName = el.identityUserNameInput.value.trim().slice(0, 40);
      const res = await window.nova.setIdentity({ userName });
      showNotesToast(res?.ok ? (userName ? `She'll call you "${userName}" now.` : "No user name set — she'll greet you without one.") : "Could not save your name.");
    };
    // Facts list (newest on top, like the Action Log).
    if (el.identityFacts) {
      el.identityFacts.innerHTML = "";
      if (!facts.length) {
        const empty = document.createElement("div");
        empty.className = "identity-facts-empty";
        empty.textContent = "Nothing yet — say \"remember that I …\".";
        el.identityFacts.appendChild(empty);
        return;
      }
      for (const f of [...facts].reverse()) {
        const row = document.createElement("div");
        row.className = "identity-fact-row";
        row.innerHTML = `<span class="identity-fact-text">${escapeHtml(String(f.fact || ""))}</span>`;
        const btn = document.createElement("button");
        btn.className = "flat-btn small identity-fact-forget";
        btn.title = "Forget this fact";
        btn.textContent = "×";
        btn.addEventListener("click", async () => {
          const res = await window.nova.forgetUserFact(f.fact);
          if (res?.ok) {
            showNotesToast("Forgotten.");
            renderIdentityPanel(await window.nova.getIdentity(), await window.nova.getUserFacts().then((x) => x.facts || []));
          } else showNotesToast("Could not forget that fact.");
        });
        row.appendChild(btn);
        el.identityFacts.appendChild(row);
      }
    }
  }

  async function refreshIdentityPanel() {
    try {
      const [identity, factsRes] = await Promise.all([window.nova.getIdentity(), window.nova.getUserFacts()]);
      renderIdentityPanel(identity || {}, factsRes?.facts || []);
    } catch { /* renderer-side error only — identity is non-critical */ }
  }

  function initNotesPanel() {
    document.querySelectorAll("[data-notes-tab]").forEach((b) => {
      b.addEventListener("click", () => setNotesTab(b.dataset.notesTab));
    });
    el.notesRefreshBtn.addEventListener("click", () => refreshNotesList());
    el.notesList.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-notes-action]");
      if (!btn) return;
      const action = btn.dataset.notesAction;
      const id = btn.dataset.notesId;
      if (action === "delete") await runNotesCommand(`delete note ${id}`);
      else if (action === "cancel") await runNotesCommand(`cancel reminder ${id}`);
      else if (action === "task-toggle") await runNotesCommand(`mark task ${id} done`);
    });
    refreshNotesPanel();
    refreshIdentityPanel();
    // Round 24: keep the identity panel in sync when it changes anywhere
    // (voice path, this panel, or a second window).
    window.nova.onIdentityChanged(() => refreshIdentityPanel());
    // OS notifications fire in the main process; the renderer speaks them
    // aloud when Nova is focused and shows a small banner either way.
    // Round 19: snooze chips on the fired-reminder banner — every chip
    // routes through the same L1 notes:snooze-reminder action as the voice
    // path, so the Action Log and risk model stay identical.
    // Round 20: panel snooze refreshes the Reminders tab afterwards — a
    // snoozed reminder is re-armed back to pending, so the fired row
    // should disappear on the next render.
    window.NovaSnoozeUI.init({
      ipc: async (id, seconds) => {
        const res = await window.nova.snoozeReminder(id, seconds);
        if (res && res.ok) refreshNotesList();
        return res;
      },
      speak,
    });
    // Round 20: when a reminder fires, the side-panel Reminders tab gains a
    // snoozable row — refresh it so the fired row appears immediately.
    window.nova.onReminderFired((data) => {
      if (!data) return;
      const msg = `Reminder: ${data.text}`;
      showNotesToast(msg, (container) => {
        const bar = window.NovaSnoozeUI.buildBanner({ id: data.id, text: data.text });
        if (bar && container) container.appendChild(bar);
      });
      refreshNotesList();
      // Speak only when the window is focused (the main process already
      // emitted to both; the spoken version is renderer-side so barge-in
      // works and Private Mode stays irrelevant — TTS is fully local).
      if (document.hasFocus()) speak(msg);
    });
    // Round 18: one-per-session overdue-task boot nudge — toast + spoken
    // once at startup when pending overdue tasks exist (main process reads
    // the store; fully local, no network, Private Mode safe).
    window.nova.onTaskDueNudge((data) => {
      if (!data || !data.text) return;
      showNotesToast(data.text);
      if (document.hasFocus()) speak(data.text);
    });
    // Round 29: focus mode / Pomodoro HUD chip — the main process emitted
    // nova:focus-started on a successful start and nova:focus-stopped on
    // end; the renderer owns the countdown. Clicking the chip ends the
    // session via the same L1 voice path ("stop focus"), so mouse and voice
    // share the exact action, level and Action Log entry.
    window.nova.onFocusStarted((data) => {
      if (!data || !data.durationMin) return;
      state.focusSession = { id: data.id, durationMin: Number(data.durationMin), endsAt: new Date(data.endsAt).getTime(), startedAt: new Date(data.startedAt).getTime() };
      renderFocusChip();
      showNotesToast(`Focus mode on — ${data.durationMin} minutes until ${new Date(data.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. I'll ping you when it's done.`);
    });
    window.nova.onFocusStopped((data) => {
      state.focusSession = null;
      renderFocusChip();
      const ended = data && data.ended;
      if (ended) {
        const mins = Math.max(1, Math.round((new Date(ended.stoppedAt).getTime() - new Date(ended.startedAt).getTime()) / 60_000));
        const label = mins === 1 ? "a minute" : `${mins} minutes`;
        showNotesToast(`Focus ended after ${label}${(data && data.pendingCount > 0) ? " — want me to mark a task done?" : ""}`);
      }
    });
    el.focusChip.addEventListener("click", () => {
      if (state.focusSession) runNotesCommand("stop focus");
    });
  }
  // ======================================================================
  // KNOWLEDGE BASE SIDE PANEL (Stage 8 — fully local indexing + RAG)
  // ======================================================================

  function humanBytes(n) {
    if (!n || n < 1024) return `${n || 0} bytes`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  /** Render indexed folder list + add-folder affordance from the local index. */
  async function renderKbPanel() {
    const res = await window.nova.kbList().catch(() => null);
    const folders = res?.ok ? res.folders || [] : [];
    const st = res?.stats || {};
    if (!folders.length) {
      el.kbFolders.innerHTML = `<p class="history-empty">No folders indexed yet. Say “add this folder to my knowledge base” or click below.</p>`;
    } else {
      el.kbFolders.innerHTML = folders.map((f) => `
        <div class="kb-folder-item" data-kb-id="${escapeAttr(f.id)}">
          <div class="kb-folder-head">
            <span class="kb-folder-name" title="${escapeAttr(f.root)}">${escapeHtml(f.root.split(/[\\/]/).filter(Boolean).pop() || f.root)}</span>
            <span class="kb-folder-count">${f.fileCount} files · ${f.chunkCount} chunks · ${humanBytes(f.bytes || 0)}</span>
          </div>
          <div class="kb-folder-path">${escapeHtml(f.root)}</div>
          <div class="kb-folder-actions">
            <button class="flat-btn small" data-kb-action="reindex">Re-index now</button>
            <button class="flat-btn small kb-danger" data-kb-action="remove">Remove from index</button>
          </div>
        </div>`).join("");
    }
    const addNote = folders.length >= (st.maxFolders || 5)
      ? `Index full (${folders.length}/${st.maxFolders || 5}) — remove a folder first.`
      : `Click to choose a folder — it will be indexed locally (text, markdown, PDF, Word).`;
    el.kbAdd.innerHTML = `<button id="kbPickFolderBtn" class="flat-btn" ${folders.length >= (st.maxFolders || 5) ? "disabled" : ""}>+ Add folder to knowledge base</button><div class="settings-note">${addNote}</div><div id="kbEmbeddingNote" class="kb-embedding-note"></div>`;
    // Round 9: show which embedding backend is active (real MiniLM model vs
    // deterministic local fallback hasher) so the first-run network download
    // expectation is explicit.
    const ebRes = await window.nova.kbEmbeddingStatus?.().catch(() => null);
    const ebNote = el.kbEmbeddingNote;
    if (ebRes?.ok && ebNote) {
      if (ebRes.usingFallback) {
        ebNote.textContent = "Embeddings: lightweight local hasher (no network download needed — quality is lower than the full model; the real model can be downloaded on a networked machine later).";
      } else if (ebRes.status === "loaded") {
        ebNote.textContent = "Embeddings: full local model loaded — all search runs on this machine.";
      } else {
        ebNote.hidden = true;
        ebNote.textContent = "";
      }
      ebNote.hidden = !ebNote.textContent;
    } else if (ebNote) { ebNote.hidden = true; }
    document.getElementById("kbPickFolderBtn")?.addEventListener("click", async () => {
      // The L2 gate (cancellable toast) is handled in the main process via
      // nova:kb-run — "add this folder" triggers the dialog there.
      await runKbCommand("add this folder to my knowledge base", { pickDialog: true });
    });
    el.kbFolders.querySelectorAll("[data-kb-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = btn.closest(".kb-folder-item");
        const name = item.dataset.kbId;
        if (btn.dataset.kbAction === "remove") await runKbCommand(`remove folder ${name} from the index`);
        else if (btn.dataset.kbAction === "reindex") await runKbCommand("re-index my knowledge base now");
      });
    });
  }

  async function refreshKbPanel() { renderKbPanel(); }

  function setKbProgress(text) {
    if (text) {
      el.kbProgressLine.textContent = text;
      el.kbProgressLine.hidden = false;
    } else {
      el.kbProgressLine.hidden = true;
    }
  }

  /** Run a KB request via nova:kb-run (shared voice + mouse path; voice also
   *  goes through the agent loop, which lands here after dispatching). */
  async function runKbCommand(text, opts = {}) {
    try {
      const res = await window.nova.kbRun(text);
      if (res?.ok) {
        addHistoryEntry({ role: "nova", text: res.text, src: "panel", kbSources: res.detail?.sources || null });
        speak(res.narration || res.text);
      } else {
        showKbToast(res?.text || "That request could not be completed.");
      }
      renderKbPanel();
    } catch {
      showKbToast("Something went wrong — see Developer Mode.");
    }
  }

  function showKbToast(text) {
    const existing = document.getElementById("kbToast");
    if (existing) existing.remove();
    const div = document.createElement("div");
    div.id = "kbToast";
    div.className = "notes-toast";
    div.textContent = text;
    document.body.appendChild(div);
    setTimeout(() => div.classList.add("show"), 10);
    setTimeout(() => {
      div.classList.remove("show");
      setTimeout(() => div.remove(), 300);
    }, 3500);
  }

  function initKbPanel() {
    el.kbRefreshBtn.addEventListener("click", () => renderKbPanel());
    el.kbQueryForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const q = el.kbQueryInput.value.trim();
      if (!q) return;
      el.kbQueryInput.value = "";
      setKbProgress("Searching your knowledge base…");
      runKbCommand(`search my kb for ${q}`);
    });
    // Indexing progress from the main process (files scanned, status).
    if (window.nova.onKbProgress) {
      window.nova.onKbProgress((evt) => {
        if (!evt) return;
        if (evt.status === "done") { setKbProgress(null); renderKbPanel(); return; }
        // Resolve the folder's on-disk root for a friendlier label.
        window.nova.kbList().then((res) => {
          const f = (res?.ok ? res.folders || [] : []).find((x) => x.id === evt.folderId);
          const label = f ? f.root.split(/[\\/]/).filter(Boolean).pop() : (evt.folderId || "folder");
          setKbProgress(`Indexing ${escapeHtml(label)}: ${evt.filesDone || 0}/${evt.filesTotal || "?"} files…`);
        }).catch(() => setKbProgress(`Indexing… ${evt.filesDone || 0}/${evt.filesTotal || "?"} files…`));
      });
    }
    renderKbPanel();
  }

  // ======================================================================
  // AUTOMATION ENGINE SIDE PANEL (Stage 9 — local scheduling + chaining)
  // ======================================================================

  /** Short, human-friendly schedule label from a 5-field cron expression. */
  function cronLabel(cron) {
    try {
      const [, hour, , , dow] = cron.split(/\s+/);
      const h = parseInt(hour, 10);
      const ap = h >= 12 && h < 21 ? "PM" : "AM";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const dayPart = dow === "1-5" ? "weekdays" : dow === "0,6" ? "weekends" : dow === "*" ? "day" : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parseInt(dow, 10)];
      return `${dayPart} ${h12}:00 ${ap}`;
    } catch {
      return cron;
    }
  }

  /** Render automation list from the persisted store (local, no network). */
  async function renderAutoPanel() {
    const res = await window.nova.autoList().catch(() => null);
    const autos = res?.ok ? res.automations || [] : [];
    if (!autos.length) {
      el.autoList.innerHTML = `<p class="history-empty">No automations yet. Say “every day at 9 AM, check my Downloads folder” or type below.</p>`;
    } else {
      el.autoList.innerHTML = autos.map((a) => {
        const chip = a.status === "safe"
          ? `<span class="auto-status-chip auto-status-safe">runs unattended</span>`
          : `<span class="auto-status-chip auto-status-confirm">confirms first</span>`;
        const next = a.nextRunAt
          ? new Date(a.nextRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
          : "—";
        const last = a.lastRunAt
          ? `${a.lastRunStatus || "?"} · ${new Date(a.lastRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
          : "never run";
        return `
        <div class="auto-item" data-auto-id="${escapeAttr(a.id)}">
          <div class="auto-item-head">
            <span class="auto-item-name" title="${escapeAttr(a.cron)}">${escapeHtml(a.name)}</span>
            ${chip}
          </div>
          <div class="auto-item-meta">${a.triggerLabel || cronLabel(a.cron)} · next ${escapeHtml(next)} · last: ${last}</div>
          <label class="auto-toggle">
            <input type="checkbox" data-auto-action="toggle" data-auto-id="${escapeAttr(a.id)}" ${a.enabled ? "checked" : ""} />
            enabled
          </label>
          <div class="auto-item-actions">
            <button class="flat-btn small" data-auto-action="run-now">Run now</button>
            <button class="flat-btn small kb-danger" data-auto-action="delete">Delete</button>
          </div>
        </div>`;
      }).join("");
    }
    el.autoAdd.innerHTML = `
    <form id="autoForm" autocomplete="off">
      <input id="autoInput" type="text" placeholder="e.g. every weekday at 8 AM, tell me my tasks" maxlength="500" />
      <button type="submit" class="send-btn">&#10148;</button>
    </form>
    <div class="settings-note">Voice works the same — say “every day at 9 AM, …”.</div>`;
    $("autoForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const v = $("autoInput").value.trim();
      if (!v) return;
      $("autoInput").value = "";
      await runAutoCommand(v);
    });
    el.autoList.querySelectorAll("[data-auto-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.autoId;
        if (btn.dataset.autoAction === "toggle") await window.nova.autoToggle({ id, enabled: btn.checked });
        else if (btn.dataset.autoAction === "run-now") await runAutoNow(id);
        else if (btn.dataset.autoAction === "delete") await runAutoDelete(id);
        renderAutoPanel();
      });
    });
  }

  async function refreshAutoPanel() { renderAutoPanel(); }

  /** Speak a result and log it to the chat history (voice + panel path). */
  function autoResultToHistory(res) {
    if (!res?.text) return;
    addHistoryEntry({ role: "nova", text: res.text, src: "panel" });
    speak(res.text);
  }

  async function runAutoNow(id) {
    try {
      const res = await window.nova.autoRunNow(id);
      if (res?.ok) {
        if (res.status === "awaiting-confirmation") {
          showAutoToast("Some steps need your confirmation — check the pending card.");
        } else {
          autoResultToHistory({ text: res.text });
        }
      } else {
        showAutoToast(res?.text || "That automation could not run.");
      }
    } catch {
      showAutoToast("Something went wrong — see Developer Mode.");
    }
  }

  async function runAutoDelete(id) {
    try {
      const res = await window.nova.autoDelete(id);
      if (res?.ok) showAutoToast("Automation removed from the schedule (nothing past was affected).");
      else showAutoToast(res?.text || "Could not delete that automation.");
    } catch {
      showAutoToast("Something went wrong — see Developer Mode.");
    }
  }

  /** Voice/panel command through the agent loop (same gate as voice). */
  async function runAutoCommand(text) {
    try {
      const res = await window.nova.agentRun(text);
      if (res?.ok && res.intent === "automation" && res.detail?.automationId) {
        autoResultToHistory({ text: res.text });
      } else if (res?.ok && res.intent === "automation") {
        autoResultToHistory({ text: res.text });
      } else {
        showAutoToast(res?.text || "I could not create that automation.");
      }
    } catch {
      showAutoToast("Something went wrong — see Developer Mode.");
    }
    renderAutoPanel();
  }

  function showAutoToast(text) {
    const existing = document.getElementById("autoToast");
    if (existing) existing.remove();
    const div = document.createElement("div");
    div.id = "autoToast";
    div.className = "notes-toast";
    div.textContent = text;
    document.body.appendChild(div);
    setTimeout(() => div.classList.add("show"), 10);
    setTimeout(() => {
      div.classList.remove("show");
      setTimeout(() => div.remove(), 300);
    }, 3500);
  }

  /** Pending-confirmation card for L3+ automated runs that paused. */
  function showAutoPending({ id, name }) {
    el.autoPendingCard.hidden = false;
    el.autoPendingCard.innerHTML = `
      <div class="auto-pending-title">${escapeHtml(name || "Automation")} needs your confirmation</div>
      <div class="auto-pending-body">It wants to run sensitive steps. Confirm below to run it now, or leave it — nothing will run unattended.</div>
      <div class="auto-item-actions">
        <button class="flat-btn small" id="autoConfirmBtn">Confirm &amp; run</button>
        <button class="flat-btn small" id="autoDismissPendingBtn">Dismiss</button>
      </div>`;
    document.getElementById("autoConfirmBtn")?.addEventListener("click", async () => {
      el.autoPendingCard.hidden = true;
      const res = await window.nova.autoConfirm(id).catch(() => null);
      if (res?.ok) autoResultToHistory({ text: res.text });
      else if (res?.text) showAutoToast(res.text);
      renderAutoPanel();
    });
    document.getElementById("autoDismissPendingBtn")?.addEventListener("click", () => {
      el.autoPendingCard.hidden = true;
    });
  }

  // ======================================================================
  // WAKE WORD (Stage 10 Round 2 — Porcupine, offline detection)
  // ======================================================================

  async function initWakeWord() {
    // Load AccessKey from main process (stored in memory, never disk)
    const keyRes = await window.nova.getAccessKeyStatus().catch(() => null);
    state.wakeApiKey = keyRes?.configured ? keyRes.key || null : null;

    if (el.wakeWordToggle) {
      el.wakeWordToggle.checked = state.wakeEnabled;
      updateWakeWordStatus();

      el.wakeWordToggle.addEventListener("change", async (ev) => {
        state.wakeEnabled = ev.target.checked;
        updateWakeWordStatus();
        if (state.wakeEnabled) {
          await startWakeWord();
        } else {
          stopWakeWord();
        }
      });

      if (el.setAccessKeyBtn) {
        el.setAccessKeyBtn.addEventListener("click", () => {
          // Reuse the existing key dialog pattern with a different IPC
          el.keyInput.value = state.wakeApiKey || "";
          el.keyOverlay.hidden = false;
          el.keySaveBtn.onclick = async () => {
            const key = el.keyInput.value.trim();
            if (!key) return;
            const r = await window.nova.submitAccessKey(key);
            if (r.ok) {
              state.wakeApiKey = key;
              el.keyOverlay.hidden = true;
              updateWakeWordStatus();
              if (state.wakeEnabled) {
                await stopWakeWord();
                await startWakeWord();
              }
            }
          };
        });
      }
    }

    // Auto-start if previously enabled (persistence via settings would go here)
    if (state.wakeEnabled && state.wakeApiKey) {
      await startWakeWord();
    }
  }

  function updateWakeWordStatus() {
    if (!el.wakeWordStatus) return;
    if (!state.wakeApiKey) {
      const when = state.wakeEnabled ? " (toggle is on, but a key is required — set it to enable)" : "";
      el.wakeWordStatus.textContent = "Requires a free Picovoice AccessKey from console.picovoice.ai" + when + ". Falls back to tap-to-arm.";
    } else if (state.wakeEnabled) {
      el.wakeWordStatus.textContent = state.wakeDetector?.isActive
        ? "Listening for “Hey Nova”…"
        : "Wake word enabled — starting…";
    } else {
      el.wakeWordStatus.textContent = "Wake word disabled. Tap the orb to speak.";
    }
  }

  async function startWakeWord() {
    if (!state.wakeApiKey || !state.wakeEnabled) return;
    if (!window.NovaWakeWordDetector) {
      console.warn("[WakeWord] Detector not available");
      return;
    }
    // Stop any existing detector
    await stopWakeWord();

    state.wakeDetector = new window.NovaWakeWordDetector({
      enabled: true,
      accessKey: state.wakeApiKey,
      keyword: "NOVA",
      sensitivity: 0.6,
      onDetected: () => {
        console.info("[WakeWord] “Hey Nova” detected — starting STT");
        if (el.wakeWordStatus) el.wakeWordStatus.textContent = "Listening…";
        startListening();
        // Update status after 5s if still listening
        setTimeout(() => {
          if (state.mode === "listening") updateWakeWordStatus();
        }, 5000);
      },
      onError: (err) => {
        console.warn("[WakeWord] Error:", err);
        if (el.wakeWordStatus) {
          el.wakeWordStatus.textContent = "Wake word error — tap to speak.";
        }
      },
    });

    const ready = await state.wakeDetector.init();
    if (!ready) return;

    // Get mic stream for wake word audio processing
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const ok = await state.wakeDetector.start(stream);
      if (ok) {
        state.micStream = stream;
        updateWakeWordStatus();
      } else {
        stream.getTracks().forEach((t) => t.stop());
        console.warn("[WakeWord] Failed to start audio processing");
      }
    } catch (err) {
      console.warn("[WakeWord] Mic access failed:", err);
    }
  }

  async function stopWakeWord() {
    if (state.wakeDetector) {
      state.wakeDetector.stop();
      await state.wakeDetector.destroy();
      state.wakeDetector = null;
    }
    if (state.micStream) {
      state.micStream.getTracks().forEach((t) => t.stop());
      state.micStream = null;
    }
  }

  function initAutoPanel() {
    el.autoRefreshBtn.addEventListener("click", () => renderAutoPanel());
    // Scheduled runs report back with their result (or a confirmation request).
    if (window.nova.onAutoRunResult) {
      window.nova.onAutoRunResult((data) => {
        if (!data) return;
        if (data.status === "awaiting-confirmation") {
          showAutoPending({ id: data.id, name: data.name });
        } else if (data.ok && data.text) {
          autoResultToHistory({ text: data.text });
        }
        renderAutoPanel();
      });
    }
    if (window.nova.onAutoPending) {
      window.nova.onAutoPending((data) => {
        if (!data) return;
        showAutoPending(data);
      });
    }
    renderAutoPanel();
  }

  // ======================================================================
  // CONTROL PLAN REVIEW + PROGRESS CHECKLIST
  // ======================================================================

  /** Level 0–4 → short badge label for the checklist. */
  const LEVEL_BADGES = ["READ", "SAFE", "CANCELLABLE", "CONFIRM", "CONFIRM"];

  function showControlPlan(plan, summary, instruction, source) {
    const maxLevel = Math.max(...plan.map((s) => s.level));
    const needsConfirm = maxLevel >= 2;

    const stepsHtml = plan
      .map(
        (s) => `
      <div class="ctrl-step" id="ctrl-step-${escapeAttr(s.id)}" data-step-id="${escapeAttr(s.id)}">
        <span class="ctrl-step-dot"></span>
        <div class="ctrl-step-body">
          <div class="ctrl-step-label">${escapeHtml(s.label)}</div>
          <div class="ctrl-step-note">${escapeHtml(s.note)} <span class="ctrl-step-level level-${s.level}">${LEVEL_BADGES[s.level]}</span></div>
        </div>
      </div>`
      )
      .join("");

    const warn = maxLevel >= 3
      ? `<div class="ctrl-warn">Some steps may affect other apps (closing windows, submitting forms). Review carefully.</div>`
      : ``;

    addHistoryEntry({
      role: "nova",
      src: source,
      // text field is unused by the plan UI but kept for fallback rendering
      __controlPlan: {
        summary,
        instruction,
        stepsHtml,
        warn,
        needsConfirm,
        stepIds: plan.map((s) => s.id),
      },
    });

    if (!needsConfirm) {
      // Level 0–1 only: execute immediately after showing the plan (the user
      // can still hit the kill-switch / STOP at any moment).
      startControlSequence();
    }
    speak(`Here is my plan: ${summary}. ${needsConfirm ? "Review the checklist below and press Start when ready, or Stop." : "Everything is read-only or safe to run — starting now."}`);
  }

  /** User pressed Start on a reviewed plan. */
  function startControlSequence() {
    const card = el.history.querySelector(".ctrl-plan[data-state=reviewing]");
    if (card) card.dataset.state = "running";
    window.nova.controlStart();
  }

  /** User pressed Stop (visible STOP button / barge-in).
   *  Returns true when a sequence was actually running and aborted. */
  function stopControlSequence() {
    if (!sequenceRunning) return false;
    window.nova.controlAbort();
    return true;
  }

  /** Update the visible checklist from sequence progress events. */
  let sequenceRunning = false;

  function handleControlProgress(ev) {
    if (!ev || !ev.type) return;

    if (ev.type === "state") {
      sequenceRunning = ev.state === "running";
      toggleStopButton(sequenceRunning);
      return;
    }

    if (ev.type === "step" && ev.stepId) {
      const node = document.querySelector(`.ctrl-step[data-step-id="${escapeAttr(ev.stepId)}"]`);
      if (!node) return;
      node.classList.remove("running", "done", "verified", "failed", "cancelled", "aborted");
      node.classList.add(ev.status);
      if (ev.note) {
        const noteEl = node.querySelector(".ctrl-step-note");
        if (noteEl) noteEl.textContent = `${escapeHtml(ev.note)} `;
      }
      return;
    }

    if (ev.type === "finished") {
      sequenceRunning = false;
      toggleStopButton(false);
      const finished = ev.finished || "done";
      let msg = finished === "done" ? "All steps completed." : "The sequence was stopped.";
      addHistoryEntry({ role: "nova", text: msg, src: "control" });
      speak(msg);
      refreshPermPanel(); // the Action Log now contains the control entries
    }
  }

  function toggleStopButton(visible) {
    el.ctrlStopBtn.classList.toggle("active", visible);
    el.ctrlStopBtn.setAttribute("aria-disabled", visible ? "false" : "true");
  }

  window.nova.onControlProgress(handleControlProgress);

  function escapeAttr(s) {
    return String(s || "").replace(/"/g, "&quot;");
  }

  // ======================================================================
  // FILE PREVIEW CARDS (Stage 6 — dry-run confirmation)
  // A dry-run report must be confirmed via filesExecute(token) before the
  // main process will actually move or trash anything.
  // ======================================================================

  /** Render a dry-run preview card and wire up Confirm / Cancel. */
  function showFilePreview(res, source) {
    const report = res.report || {};
    const title = report.title || `${(res.actionId || "").replace(/^files:/, "").replace(/-/, " ")} preview`;
    const body = report.body || "";
    const dirs = Array.isArray(report.summary) ? report.summary : [];
    const files = report.files || [];
    addHistoryEntry({
      role: "nova",
      src: source,
      __filePreview: {
        title,
        body,
        dirs,
        files: files.map((f) => (typeof f === "string" ? f : f.path)).slice(0, 10),
        previewToken: res.previewToken,
        actionId: res.actionId,
      },
    });
    speak(res.narration || "Here is what I would do — confirm or cancel.");
  }

  /** Execute a confirmed file preview (token bound). */
  async function confirmFilePreview(node, token, source) {
    const btns = node.querySelectorAll("button");
    btns.forEach((b) => (b.disabled = true));
    node.dataset.state = "running";
    try {
      const res = await window.nova.filesExecute(token);
      if (res?.ok) {
        node.dataset.state = "done";
        const txt = res.text || "Done — nothing deleted, files were only moved.";
        addHistoryEntry({ role: "nova", text: txt, src: "files" });
        speak(txt);
      } else {
        node.dataset.state = "cancelled";
        const txt = res?.text || "The preview was not applied — nothing changed.";
        addHistoryEntry({ role: "nova", text: txt, src: "files" });
        speak(txt);
      }
    } catch {
      node.dataset.state = "cancelled";
      addHistoryEntry({ role: "nova", text: "The action could not be applied — nothing changed.", src: "files" });
    } finally {
      refreshUndoButton();
      refreshPermPanel();
    }
  }

  /** Cancel a pending preview (nothing moves). */
  function cancelFilePreview(node) {
    node.dataset.state = "cancelled";
    addHistoryEntry({ role: "nova", text: "Cancelled — nothing was changed.", src: "files" });
    speak("Cancelled — nothing was changed.");
  }

  // Render the control plan card with review controls. History entries with
  // a __controlPlan payload get this custom markup instead of plain text.
  const origRenderHistory = renderHistory;
  renderHistory = function renderHistoryWithCards() {
    origRenderHistory();
    let planIdx = 0;
    let prevIdx = 0;
    el.history.querySelectorAll(".msg.nova").forEach((node, i) => {
      const entry = historyItems[i];
      if (!entry || !entry.__controlPlan) return;
      const p = entry.__controlPlan;
      node.innerHTML = `
        <div class="ctrl-plan" data-state="${p.needsConfirm ? "reviewing" : "running"}" data-plan-idx="${planIdx++}">
          <div class="ctrl-plan-title">Plan: ${escapeHtml(p.summary)}</div>
          ${p.warn}
          <div class="ctrl-steps">${p.stepsHtml}</div>
          <div class="ctrl-plan-actions">
            ${p.needsConfirm ? `<button class="flat-btn ctrl-start-btn" ${sequenceRunning ? "disabled" : ""}>Start</button>` : ""}
            <button class="flat-btn ctrl-stop-btn" ${sequenceRunning ? "" : "disabled"}>Stop</button>
          </div>
        </div>`;
      const card = node.querySelector(".ctrl-plan");
      const startBtn = card.querySelector(".ctrl-start-btn");
      const stopBtn = card.querySelector(".ctrl-stop-btn");
      if (startBtn) startBtn.addEventListener("click", () => startControlSequence());
      if (stopBtn) stopBtn.addEventListener("click", () => stopControlSequence());
    });
    el.history.querySelectorAll(".msg.nova").forEach((node, i) => {
      const entry = historyItems[i];
      if (!entry || !entry.__filePreview) return;
      const p = entry.__filePreview;
      const dirsHtml = p.dirs.map((d) => `<span class="fp-dir">${escapeHtml(String(d))}</span>`).join("");
      const filesHtml = p.files.length
        ? `<div class="fp-files">${p.files.map((f) => escapeHtml(String(f).split(/[\\/]/).pop())).join(", ")}</div>`
        : "";
      node.innerHTML = `
        <div class="file-preview" data-state="reviewing">
          <div class="fp-title">Dry-run preview: ${escapeHtml(p.title)}</div>
          ${p.body ? `<div class="fp-body">${escapeHtml(p.body).replace(/\n/g, "<br>")}</div>` : ""}
          <div class="fp-dirs">${dirsHtml}</div>
          ${filesHtml}
          <div class="fp-actions">
            <button class="flat-btn fp-confirm">Confirm</button>
            <button class="flat-btn fp-cancel">Cancel</button>
          </div>
        </div>`;
      const card = node.querySelector(".file-preview");
      card.querySelector(".fp-confirm").addEventListener("click", () => confirmFilePreview(card, p.previewToken, entry.src));
      card.querySelector(".fp-cancel").addEventListener("click", () => cancelFilePreview(card));
    });
    el.history.scrollTop = el.history.scrollHeight;
  };

  // ------------------------------------------------------------------ stop btn
  el.ctrlStopBtn.addEventListener("click", () => stopControlSequence());

  // ======================================================================
  // ORB VISUALIZER  (canvas, ~60fps via rAF)
  // ======================================================================
  const ctx = el.orbCanvas.getContext("2d");
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  let W, H, cx, cy;

  function resizeCanvas() {
    const rect = el.orbWrap.getBoundingClientRect();
    W = rect.width; H = rect.height;
    el.orbCanvas.width = W * DPR;
    el.orbCanvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cx = W / 2; cy = H / 2;
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  // Rings: rotating thin geometric rings, animated per mode.
  const rings = [
    { r: 118, speed: 0.0014, dash: [4, 26], alpha: 0.72, gap: 0 },
    { r: 132, speed: -0.0009, dash: [14, 40], alpha: 0.50, gap: 0.9 },
    { r: 145, speed: 0.0021, dash: [2, 18], alpha: 0.38, gap: 2.1 },
  ];
  let t0 = performance.now();
  let energy = 0;           // 0..1 smoothed audio energy (listening)
  let speakPhase = 0;       // speaking animation phase

  function drawOrb(now) {
    const dt = (now - t0) / 1000;
    t0 = now;
    ctx.clearRect(0, 0, W, H);

    for (const ring of rings) {
      ring.gap = (ring.gap + ring.speed * (state.mode === "speaking" ? 3.2 : 1)) % (Math.PI * 2);
      const amp = state.mode === "listening" ? 1 + energy * 0.22
                    : state.mode === "speaking" ? 1.05 + 0.06 * Math.sin(now / 220)
                    : 1;
      const r = ring.r * amp;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ring.gap);
      ctx.strokeStyle = `rgba(57, 210, 255, ${ring.alpha * (state.mode === "idle" ? 0.9 : 1)})`;
      ctx.lineWidth = state.mode === "listening" ? 1.6 + energy * 2.6 : 1.5;
      ctx.shadowColor = "rgba(57, 210, 255, 0.8)";
      ctx.shadowBlur = state.mode === "idle" ? 10 : 16;
      ctx.setLineDash(ring.dash);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Listening waveform ticks on the outer ring
    if (state.mode === "listening") {
      const ticks = 64;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(now / 9000);
      for (let i = 0; i < ticks; i++) {
        const ang = (i / ticks) * Math.PI * 2;
        const v = (Math.sin(i * 1.7 + now / 140) * 0.5 + 0.5) * energy;
        const len = 4 + v * 22;
        const r0 = 152, r1 = r0 + len;
        ctx.strokeStyle = `rgba(122, 214, 255, ${0.15 + v * 0.7})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
        ctx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
        ctx.stroke();
      }
      ctx.restore();
    }

    requestAnimationFrame(drawOrb);
  }
  requestAnimationFrame(drawOrb);

  // ---------------------------------------------------------------- mode UI
  function setMode(mode, label) {
    state.mode = mode;
    el.orbLabel.textContent = label;
    el.statusDot.className = "status-dot " + {
      idle: state.wakeArmed ? "online" : "offline",
      listening: "listening",
      speaking: "speaking",
    }[mode];
    el.statusLabel.textContent = {
      idle: state.wakeArmed ? "online · wake armed" : "offline",
      listening: "listening",
      speaking: "speaking",
    }[mode];
    el.talkBtn.classList.toggle("active", mode === "listening");
  }
  setMode("idle", "IDLE");

  // ======================================================================
  // AUDIO GATE — energy-based VAD so audio only matters when we listen
  // ======================================================================
  function attachAnalyser(stream) {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      state.micStream = stream;
      state.analyser = analyser;
    } catch (err) {
      console.warn("Analyser unavailable:", err);
    }
  }

  function stopAnalyser() {
    if (state.micStream) {
      state.micStream.getTracks().forEach((t) => t.stop());
      state.micStream = null;
    }
    state.analyser = null;
  }

  // Smooth energy sampling loop while listening.
  (function energyLoop() {
    if (state.analyser && state.mode === "listening") {
      const data = new Uint8Array(state.analyser.frequencyBinCount);
      state.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      energy = energy * 0.82 + Math.min(1, rms * 4) * 0.18;
    } else {
      energy *= 0.88;
    }
    setTimeout(energyLoop, 50);
  })();

  // ======================================================================
  // SPEECH RECOGNITION (Web Speech API)
  // Known limitation: recognition streams audio to the OS/cloud speech
  // service and requires an internet connection.
  // ======================================================================
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  state.sttAvailable = !!SpeechRecognition;

  function newRecognition(interimOnly = false) {
    if (!SpeechRecognition) return null;
    const rec = new SpeechRecognition();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      let interim = "", final = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) final += t;
        else interim += t;
      }
      if (interim) {
        el.liveHear.textContent = "hearing: " + interim;
        el.liveLine.textContent = interim;
      }
      if (final) {
        el.liveHear.textContent = "";
        const text = final.trim();
        if (!text) return;
        // Barge-in trigger phrases:
        // "Nova stop" (or just "stop") while a control sequence runs halts it
        // immediately via the kill-switch path; otherwise stop speech playback.
        if (/^(nova\s+)?(stop|hush|be quiet|quiet)\b/i.test(text)) {
          if (stopControlSequence()) {
            addHistoryEntry({ role: "nova", text: "Sequence stopped.", src: "voice" });
            return;
          }
          if (state.ttsActive) {
            stopSpeaking();
            el.liveLine.textContent = "Playback stopped.";
            return;
          }
          // Neither TTS nor a control sequence running — fall through to chat.
        }
        if (!interimOnly) submitMessage(text, "voice");
      }
    };
    rec.onerror = (ev) => {
      if (["no-speech", "aborted"].includes(ev.error)) return;
      console.warn("STT error:", ev.error);
      if (ev.error === "not-allowed") {
        el.liveLine.textContent = "Microphone access denied — check OS privacy settings.";
      }
    };
    rec.onend = () => {
      // Restart while still in listening mode (continuous toggle / talk held)
      if (state.mode === "listening") {
        try { rec.start(); } catch { /* already running */ }
      } else {
        setMode("idle", "IDLE");
        stopAnalyser();
        el.liveHear.textContent = "";
      }
    };
    return rec;
  }

  function startListening() {
    if (!state.sttAvailable) {
      el.liveLine.textContent = "Speech recognition is not available in this environment.";
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        attachAnalyser(stream);
        state.rec = newRecognition();
        state.rec.start();
        setMode("listening", "LISTENING");
        el.liveLine.textContent = "";
      })
      .catch((err) => {
        console.warn("Mic access failed:", err);
        el.liveLine.textContent = "Could not access the microphone (" + err.name + ").";
      });
  }

  function stopListening() {
    if (state.rec) {
      try { state.rec.stop(); } catch { /* ignore */ }
      state.rec = null;
    }
    stopAnalyser();
    setMode("idle", "IDLE");
    el.liveHear.textContent = "";
  }

  // ---------------------------------------------------------------- talk btn
  el.talkBtn.addEventListener("click", () => {
    if (state.ttsActive) { stopSpeaking(); return; } // barge-in by click
    if (state.mode === "listening") stopListening();
    else startListening();
  });

  el.continuousCheck.addEventListener("change", (ev) => {
    state.continuous = ev.target.checked;
    if (state.continuous) startListening();
    else if (state.mode === "listening") stopListening();
  });

  // ======================================================================
  // TTS (speechSynthesis) with instant barge-in
  // ======================================================================
  // Round 8: TTS customization persisted in localStorage (voiceURI, rate,
  // pitch, muted). Settings apply immediately to the next utterance.
  const TTS_KEY = "nova-tts-settings";
  const ttsDefaults = { voiceURI: null, rate: 1.02, pitch: 1.0, muted: false };
  function loadTtsSettings() {
    try {
      const raw = localStorage.getItem(TTS_KEY);
      const saved = raw ? JSON.parse(raw) : {};
      return { ...ttsDefaults, ...saved };
    } catch { return { ...ttsDefaults }; }
  }
  function saveTtsSettings(s) {
    try { localStorage.setItem(TTS_KEY, JSON.stringify(s)); } catch { /* quota/privacy mode */ }
  }
  let ttsSettings = loadTtsSettings();

  function speak(text) {
    if (!window.speechSynthesis) return;
    stopSpeaking();
    if (ttsSettings.muted) {
      // Muted: nothing is spoken, but the prepared answer still shows.
      setMode("idle", "IDLE");
      el.liveLine.textContent = text + "\u2009(sound muted)";
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = Math.min(2, Math.max(0.5, Number(ttsSettings.rate) || 1.02));
    utter.pitch = Math.min(2, Math.max(0.5, Number(ttsSettings.pitch) || 1.0));
    const voices = speechSynthesis.getVoices();
    const preferred = (ttsSettings.voiceURI ? voices.find((v) => v.voiceURI === ttsSettings.voiceURI) : null)
                   || voices.find((v) => /en[-_]US/i.test(v.lang) && /female|samantha|zira|google us english/i.test(v.name))
                   || voices.find((v) => /en/i.test(v.lang));
    if (preferred) utter.voice = preferred;
    utter.onstart = () => { state.ttsActive = true; setMode("speaking", "SPEAKING"); el.liveLine.textContent = text; };
    utter.onend = () => finishSpeaking();
    utter.onerror = () => finishSpeaking();
    speechSynthesis.speak(utter);
    // Chrome pauses long utterances; keep alive
    const keepalive = setInterval(() => {
      if (!state.ttsActive) { clearInterval(keepalive); return; }
      if (speechSynthesis.paused) speechSynthesis.resume();
    }, 8000);
    utter._keepalive = keepalive;
  }

  function stopSpeaking() {
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    state.ttsActive = false;
    if (state.continuous && state.mode !== "listening") {
      startListening();
    } else if (state.mode !== "listening") {
      setMode("idle", "IDLE");
    }
  }

  function finishSpeaking() {
    state.ttsActive = false;
    setMode(state.continuous ? "listening" : "idle", state.continuous ? "LISTENING" : "IDLE");
    if (state.continuous && state.mode !== "listening") startListening();
  }

  // Barge-in: click the orb
  el.orbWrap.addEventListener("click", () => {
    if (state.ttsActive) stopSpeaking();
  });

  // Round 8: TTS settings UI — voice picker, speed/pitch sliders, mute toggle.
  // All persisted in localStorage only; no outbound traffic.
  function voiceDisplayName(v) {
    return (v.name ? v.name + (v.localService ? "" : " (online)") : v.voiceURI)
         + " — " + (v.lang || "");
  }
  function populateVoiceSelect(keepSelection) {
    const s = el.ttsVoiceSelect;
    if (!s || !window.speechSynthesis) return;
    const current = keepSelection && s.value ? s.value : ttsSettings.voiceURI;
    s.innerHTML = "";
    const voices = speechSynthesis.getVoices();
    const english = voices.filter((v) => /en/i.test(v.lang));
    const others = voices.filter((v) => !/en/i.test(v.lang));
    const addOption = (v) => {
      const o = document.createElement("option");
      o.value = v.voiceURI;
      o.textContent = voiceDisplayName(v);
      s.appendChild(o);
    };
    if (english.length) { english.forEach(addOption); }
    if (others.length) { others.forEach(addOption); }
    if (!s.options.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "No voices available";
      s.appendChild(o);
    } else if (current && Array.from(s.options).some((o) => o.value === current)) {
      s.value = current;
    }
    el.ttsVoiceRow.hidden = false;
  }
  function applyTtsUI() {
    if (el.ttsRate) { el.ttsRate.value = ttsSettings.rate; el.ttsRateVal.textContent = Number(ttsSettings.rate).toFixed(2).replace(/0$/, "") + "x"; }
    if (el.ttsPitch) { el.ttsPitch.value = ttsSettings.pitch; el.ttsPitchVal.textContent = Number(ttsSettings.pitch).toFixed(2); }
    if (el.ttsMuteToggle) {
      el.ttsMuteToggle.checked = !!ttsSettings.muted;
      if (el.ttsVoiceRow) el.ttsVoiceRow.hidden = !!ttsSettings.muted;
    }
  }
  if (el.ttsMuteToggle) {
    el.ttsMuteToggle.addEventListener("change", () => {
      ttsSettings.muted = el.ttsMuteToggle.checked;
      saveTtsSettings(ttsSettings);
      if (el.ttsVoiceRow) el.ttsVoiceRow.hidden = ttsSettings.muted;
    });
  }
  if (el.ttsVoiceSelect) {
    el.ttsVoiceSelect.addEventListener("change", () => {
      ttsSettings.voiceURI = el.ttsVoiceSelect.value || null;
      saveTtsSettings(ttsSettings);
    });
  }
  if (el.ttsRate) {
    el.ttsRate.addEventListener("input", () => {
      ttsSettings.rate = Number(el.ttsRate.value);
      el.ttsRateVal.textContent = ttsSettings.rate.toFixed(2).replace(/0$/, "") + "x";
      saveTtsSettings(ttsSettings);
    });
  }
  if (el.ttsPitch) {
    el.ttsPitch.addEventListener("input", () => {
      ttsSettings.pitch = Number(el.ttsPitch.value);
      el.ttsPitchVal.textContent = ttsSettings.pitch.toFixed(2);
      saveTtsSettings(ttsSettings);
    });
  }
  if (el.ttsPreviewBtn) {
    el.ttsPreviewBtn.addEventListener("click", () => {
      if (ttsSettings.muted) return;
      stopSpeaking();
      const preview = new SpeechSynthesisUtterance("Hello! This is Nova speaking with your selected voice.");
      preview.rate = ttsSettings.rate;
      preview.pitch = ttsSettings.pitch;
      const voices = speechSynthesis.getVoices();
      const v = ttsSettings.voiceURI ? voices.find((x) => x.voiceURI === ttsSettings.voiceURI) : null;
      if (v) preview.voice = v;
      speechSynthesis.speak(preview);
    });
  }
  applyTtsUI();

  // Load voice list asynchronously
  if (window.speechSynthesis) {
    const fillAndRestore = () => populateVoiceSelect(true);
    speechSynthesis.onvoiceschanged = fillAndRestore;
    speechSynthesis.getVoices();
    // Voices may already be loaded before onvoiceschanged ever fires.
    const alreadyLoaded = speechSynthesis.getVoices().length > 0;
    if (alreadyLoaded) populateVoiceSelect(true);
  }

  // ======================================================================
  // MESSAGE PIPELINE — voice and typed text share one entry point
  // ======================================================================
  // Local settings mirror (synced via nova:settings-changed).
  const settings = { developerMode: false, privateMode: false, keyConfigured: false };
  window.nova.getSettings().then((s) => {
    settings.developerMode = !!s.developerMode;
    settings.privateMode = !!s.privateMode;
    settings.keyConfigured = !!s.keyConfigured;
    if (settings.developerMode) refreshDevTask();
  }).catch(() => {});
  window.nova.onSettingsChanged?.((s) => {
    if (s.developerMode != null) settings.developerMode = !!s.developerMode;
    if (s.privateMode != null) settings.privateMode = !!s.privateMode;
    if (s.developerMode != null) refreshDevTask();
  });

let historyItems = [];
  const MAX_HISTORY = 40;

  function addHistoryEntry({ role, text, src, small, kbSources, memory }) {
    historyItems.push({ role, text, src, small: !!small, kbSources: kbSources || null, memory: !!memory });
    if (historyItems.length > MAX_HISTORY) historyItems = historyItems.slice(-MAX_HISTORY);
    renderHistory();
  }

  function renderHistory() {
    if (historyItems.length === 0) {
      el.history.innerHTML = `<p class="history-empty">Nothing yet — say something to Nova.</p>`;
      return;
    }
    el.history.innerHTML = historyItems
      .map((m) => {
        const textHtml = escapeHtml(m.text);
        const sourcesHtml = (m.role === "nova" && Array.isArray(m.kbSources) && m.kbSources.length)
          ? `<div class="kb-msg-sources">${m.kbSources.map((s) => `<a class="kb-source-link" data-kb-file="${escapeAttr(s.file)}" title="Open the source file">${escapeHtml(s.title || s.file.split(/[\\/]/).pop())}</a>`).join(" · ")}</div>`
          : "";
        const memBadge = m.memory ? `<span class="mem-badge" title="Answered with context from earlier conversations (stored locally)">&#128172; recalled</span>` : "";
        return `<div class="msg ${m.role}${m.small ? " small" : ""}"><span class="src">${m.src}</span>${textHtml}${memBadge}${sourcesHtml}</div>`;
      })
      .join("");
    el.history.querySelectorAll(".kb-source-link").forEach((a) => {
      a.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await window.nova.kbOpenSource(a.dataset.kbFile);
      });
    });
    el.history.scrollTop = el.history.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Vision trigger phrases: "what am I looking at", "what's on my screen",
  // "what does this error say", "describe my screen", etc.
  const VISION_PHRASES = /what('s| is)? (on my screen|this screen|this (error|message))|what am i looking at|describe (my |the )?screen|read (my |the )?screen|what does (this|that) (error |message )?say/i;

  // Control trigger phrases: "open the calculator and compute 12 x 8", "click Save",
  // "type hello into the search box", "press Ctrl+T", "wait for Notepad".
  // These are checked AFTER vision (vision phrases are unambiguous), and they
  // never collide with normal chat since chat requires a configured API key —
  // but the control route wins regardless of key state.
  const CONTROL_PHRASES = /^(open|click|double[- ]?click|right[- ]?click|type|press|submit|send|compute|calculate|wait for|drag)/i;

    // ======================================================================
  // UNIFIED AGENT LOOP (Stage 5): every message routes through
  // nova:agent-run on the main process — classify → dispatch → narrate.
  // No routing regexes here anymore; the main process owns the policy.
  // ======================================================================
  async function submitMessage(text, source) {
    if (!text?.trim()) return;
    addHistoryEntry({ role: "user", text: text.trim(), src: source });
    el.liveLine.textContent = "";
    let chatBuf = "";
    const narrationSpoken = new Set();
    const progressUnsub = window.nova.onAgentProgress((event) => {
      if (event.type === "narration") {
        // Nova narrates each step out loud AND transcripts it in chat.
        addHistoryEntry({ role: "nova", text: event.text, src: "narration", small: true });
        const key = event.taskId + ":" + event.step;
        if (!narrationSpoken.has(key)) {
          narrationSpoken.add(key);
          speak(event.text);
        }
      } else if (event.type === "chat-chunk") {
        chatBuf += event.text;
        el.liveLine.textContent = chatBuf;
      }
    });
    try {
      setMode("speaking", "THINKING…");
      el.liveLine.textContent = "Thinking…";
      const res = await window.nova.agentRun(text.trim());
      if (!res?.ok) {
        const msg = res?.text || "Something went wrong — the full details are in Developer Mode.";
        addHistoryEntry({ role: "nova", text: msg, src: source });
        speak(msg);
        return;
      }
      if (res.intent === "conversation") {
        if (!chatBuf.trim() && res.text) {
          addHistoryEntry({ role: "nova", text: res.text, src: source, memory: !!res.memoryUsed });
          speak(res.text);
        }
        el.liveLine.textContent = "";
        return;
      }
      if (res.intent === "vision" || (res.intent === "combined" && res.visionAnswer)) {
        const answer = res.intent === "combined" ? res.visionAnswer : res.text;
        if (answer) {
          addHistoryEntry({ role: "nova", text: answer, src: source });
          speak(answer);
          el.liveLine.textContent = "";
        }
        if (res.intent === "vision") return;
      }
      if (res.intent === "files") {
        if (res.preview) {
          // Dry-run preview card: the user MUST confirm before anything moves.
          showFilePreview(res, source);
        } else if (res.text) {
          addHistoryEntry({ role: "nova", text: res.text, src: source });
          speak(res.text);
        } else if (res.actionId === "files:search") {
          const files = res.detail?.files || [];
          const names = files.slice(0, 8).map((f) => f.split(/[\\/]/).pop());
          const txt = files.length
            ? `Found ${files.length} match${files.length === 1 ? "" : "es"}: ${names.join(", ")}${files.length > 8 ? " and more" : ""}.`
            : "Nothing matched in Documents, Downloads and Desktop. Say \"search everywhere\" and I will look through your whole home folder.";
          addHistoryEntry({ role: "nova", text: txt, src: source });
          speak(txt);
        } else if (res.actionId === "files:detect-duplicates") {
          const groups = res.detail?.groups || [];
          const dupCount = groups.reduce((n, g) => n + Math.max(0, g.files.length - 1), 0);
          const txt = dupCount
            ? `Found ${dupCount} duplicate file${dupCount === 1 ? "" : "s"} across ${groups.length} group${groups.length === 1 ? "" : "s"} — same content, not just the name. Say "remove the duplicates" to send them to the Recycle Bin.`
            : "No duplicates found — every file in that folder has unique content.";
          addHistoryEntry({ role: "nova", text: txt, src: source });
          speak(txt);
        } else if (res.actionId === "files:folder-stats") {
          const s = res.detail || {};
          const label = (s.dir || "").split(/[\\/]/).filter(Boolean).pop() || s.dir;
          const txt = `"${escapeHtml(String(label))}" holds ${s.count || 0} file${s.count === 1 ? "" : "s"}, using ${s.human || "no space"}.`;
          addHistoryEntry({ role: "nova", text: txt, src: source });
          speak(txt);
        } else if (res.actionId === "files:delete-files" || res.actionId === "files:remove-duplicates") {
          const t = res.detail?.trashed ?? 0;
          const f = res.detail?.failed?.length || 0;
          const txt = f
            ? `Moved ${t} file${t === 1 ? "" : "s"} to the Recycle Bin — ${f} could not be removed, see Developer Mode.`
            : `Moved ${t} file${t === 1 ? "" : "s"} to the Recycle Bin — you can still restore them from there if needed.`;
          addHistoryEntry({ role: "nova", text: txt, src: source });
          speak(txt);
        } else if (res.actionId) {
          const txt = res.narration || "Done.";
          addHistoryEntry({ role: "nova", text: txt, src: source });
          speak(txt);
        }
        el.liveLine.textContent = "";
        return;
      }
      if (res.intent === "notes") {
        // Notes/reminders/tasks: always shown in chat AND refresh the local
        // side-panel so the list stays in sync (voice + mouse paths share it).
        const txt = res.narration || res.text;
        if (txt) {
          addHistoryEntry({ role: "nova", text: txt, src: source });
          speak(txt);
        }
        el.liveLine.textContent = "";
        refreshNotesPanel();
        return;
      }
      if (res.intent === "kb") {
        // Knowledge base: show the answer in chat with view-source links
        // for each cited file, and refresh the side-panel folder list.
        const txt = res.text || res.narration || "Done.";
        addHistoryEntry({ role: "nova", text: txt, src: source, kbSources: res.detail?.sources || null });
        speak(res.narration || txt);
        el.liveLine.textContent = "";
        refreshKbPanel();
        return;
      }
      if (res.intent === "automation") {
        // Automations: narrate creation/management results and refresh the
        // side panel so the list stays in sync (voice + mouse share it).
        const txt = res.text || res.narration || "Done.";
        if (txt) {
          addHistoryEntry({ role: "nova", text: txt, src: source });
          speak(txt);
        }
        el.liveLine.textContent = "";
        refreshAutoPanel();
        return;
      }
      if (res.plan) {
        showControlPlan(res.plan, res.summary, text.trim(), source);
      }
    } catch (err) {
      const msg = "Sorry — something went wrong. Details are in Developer Mode.";
      addHistoryEntry({ role: "nova", text: msg, src: source });
      speak(msg);
      console.error("Agent loop failed:", err);
    } finally {
      progressUnsub();
      setMode("idle", "IDLE");
      refreshUndoButton();
      refreshDevTask();
    }
  }

  el.typeForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = el.typeInput.value;
    el.typeInput.value = "";
    if (state.ttsActive) stopSpeaking();
    if (state.mode === "listening") stopListening();
    submitMessage(text, "text");
  });

  // ======================================================================
  // OPENROUTER STREAMING CHAT (renderer-side fetch)
  // ======================================================================
  let apiKey = null;
  let chatModel = null;

  async function streamChat(userText, onChunk) {
    const model = pickTaskModel(userText);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nova.assistant.local",
        "X-Title": "Nova",
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          {
            role: "system",
            content: "You are Nova, a voice-first desktop AI assistant. Reply in short, natural, spoken-friendly sentences (under ~60 words unless asked for more). No markdown formatting, no bullet lists — this will be read aloud. No emojis.",
          },
          ...historyItems.slice(-12).map((m) => ({ role: m.role === "nova" ? "assistant" : "user", content: m.text })),
          { role: "user", content: userText },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let sentenceBuf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const data = line.replace(/^data: /, "").trim();
        if (!data || data === "[DONE]") continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        const delta = json.choices?.[0]?.delta?.content;
        if (!delta) continue;
        full += delta;
        sentenceBuf += delta;
        onChunk(delta);
        // Speak sentence-by-sentence for natural TTS barge-in timing
        const cut = sentenceBuf.search(/[.!?…]\s/);
        if (cut > 8 && state.ttsActive) {
          const seg = sentenceBuf.slice(0, cut + 1).trim();
          sentenceBuf = sentenceBuf.slice(cut + 1);
          speak(seg);
        }
      }
    }
    if (sentenceBuf.trim() && state.ttsActive) speak(sentenceBuf.trim());
    return full;
  }

  function onChunk() { /* liveLine updated by speak(); placeholder for extension */ }

  /**
   * Route to a task-specific model via the main process router,
   * with a local regex shortcut so common intents don't need an IPC hop.
   */
  function pickTaskModel(text) {
    const t = text.toLowerCase();
    if (/(write|code|debug|function|script|program|api|refactor)/i.test(t) && /code|debug|script|function|program/.test(t)) return chatModel || "openai/gpt-oss-120b";
    if (/(image|photo|picture|screenshot|diagram|chart)/i.test(t)) return chatModel || "google/gemini-2.5-flash-001";
    if (/\b(hello|hi|hey|thanks|bye)\b/.test(t) && t.length < 20) return chatModel || "google/gemini-2.5-flash-001";
    return chatModel || "google/gemini-2.5-flash-001";
  }

  // ======================================================================
  // MODEL ROUTER INDICATOR + SETTINGS
  // ======================================================================
  async function loadSettings() {
    try {
      const s = await window.nova.getSettings();
      apiKey = null;
      chatModel = s.model || "google/gemini-2.5-flash-001";
      el.modelName.textContent = s.model || "fallback";
      el.modelBadge.hidden = !s.model;
      el.devModel.textContent = s.model || "—";
      el.devCount.textContent = s.freeModelCount ?? "—";
      el.devUpdated.textContent = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : "—";
      el.devFallback.textContent = s.fallbackInUse ? "yes" : "no";
      el.keyStatus.textContent = s.keyConfigured ? "stored" : "not set";
      el.keyStatus.className = "key-status " + (s.keyConfigured ? "ok" : "miss");
      // Round 9: surface keychain unavailability (e.g. Linux without libsecret)
      // so the session-only key behavior is explicit rather than logged only.
      const storageNote = $("keyStorageNote");
      if (storageNote) {
        if (s.keyStorageInsecure) {
          storageNote.textContent = "Keychain not available on this system — the key is held encrypted in memory only and won't survive a restart. Set the OPENROUTER_API_KEY environment variable for persistence.";
          storageNote.hidden = false;
        } else {
          storageNote.hidden = true;
        }
      }
    } catch (err) {
      console.warn("Settings load failed:", err);
    }
  }

  // Refresh the private-mode UI whenever settings change (e.g. key overlay save).
  window.nova.onSettingsChanged?.(() => loadSettings().then(() => {
    window.nova.getSettings().then((s) => setPrivateMode(!!s.privateMode)).catch(() => {});
  }).catch(() => {}));

  function refreshDevPanel() {
    loadSettings();
    checkScreenPermission();
    window.nova.getRouterLogs().then((logs) => {
      el.devLog.innerHTML = logs.slice(-25).reverse()
        .map((l) => `<div>${l.ts.slice(11, 19)} ${l.taskType} → ${l.model}${l.fallback ? " (fallback)" : ""}</div>`)
        .join("") || "<div>no picks yet</div>";
    }).catch(() => {});
    refreshPermPanel();
  }

  // ======================================================================
  // PERMISSIONS & SAFETY — private mode, action toast, action log
  // ======================================================================
  function setPrivateMode(on) {
    el.privateBadge.hidden = !on;
    if (el.privateToggle.checked !== on) el.privateToggle.checked = on;
    if (on) {
      el.statusDot.className = "status-dot private";
      el.statusLabel.textContent = "private · local only";
    }
  }

  el.privateToggle.addEventListener("change", (ev) => {
    window.nova.setPrivateMode(ev.target.checked)
      .then(() => setPrivateMode(ev.target.checked))
      .catch((err) => {
        el.privateToggle.checked = !ev.target.checked;
        console.warn("Private mode toggle failed:", err);
      });
  });

  // Boot guard: never show the toast unless a real "show" IPC arrives.
  el.permToast.hidden = true;
  // Level-2 permission toast: cancellable within 5 s, then auto-executes.
  let toastTimer = null;
  function setPermToastData(data) {
    if (data && data.toastId) el.permToast.dataset.toastId = data.toastId;
  }
  function showPermToast(data) {
    // Only an explicit "show" with a toast id opens the toast; everything else hides.
    if (!data || data.type !== "show" || !data.toastId) { hidePermToast(); return; }
    const lvl = (typeof data.level === "number" ? `L${data.level}` : "L2").toUpperCase();
    el.permToastLevel.textContent = lvl + " · reversible";
    el.permToastMsg.textContent = data.message || "Nova wants to perform a reversible action.";
    el.permToast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hidePermToast, 5500);
  }
  function hidePermToast() {
    clearTimeout(toastTimer);
    el.permToast.hidden = true;
  }
  el.permToastCancel.addEventListener("click", () => {
    const toastId = el.permToast.dataset.toastId;
    if (toastId) window.nova.cancelToast(toastId);
    hidePermToast();
  });
  window.nova.onPermissionToast((data) => {
    setPermToastData(data);
    showPermToast(data);
  });

  // Action log panel: newest first, exportable as JSON.
  async function refreshPermPanel() {
    try {
      const entries = await window.nova.getActionLog();
      if (!entries.length) {
        el.permLog.innerHTML = `<p class="history-empty">No actions yet — Nova’s actions will appear here, newest first.</p>`;
        return;
      }
      const lvlClass = (l) => `l${Math.min(4, Math.max(0, l))}`;
      el.permLog.innerHTML = entries
        .map((e) => {
          const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : "";
          const detail = (e.detail && Object.keys(e.detail).length)
            ? ` — ${JSON.stringify(e.detail).slice(0, 90)}` : "";
          return `<div class="perm-entry">` +
            `<span class="ts">${ts}</span>` +
            `<span class="lvl ${lvlClass(e.level)}">L${e.level} ${e.levelName || ""}</span>` +
            `<span>${escapeHtml(e.actionId)}${escapeHtml(detail)}</span>` +
            `<span class="outcome ${e.outcome}">${e.outcome}</span>` +
            `</div>`;
        }).join("");
    } catch (err) {
      console.warn("Action log refresh failed:", err);
    }
  }

  el.permExportBtn.addEventListener("click", async () => {
    try {
      const entries = await window.nova.getActionLog();
      const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `nova-action-log-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.warn("Log export failed:", err);
    }
  });

  // Demo actions (test harness): click a demo button to drive the gate paths.
  document.querySelectorAll("[data-demo]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.demo;
      const dry = id.endsWith(":dry");
      const actionId = id.replace(":dry", "");
      try {
        const res = await window.nova.runAction(actionId,
          actionId === "demo:rename-file" ? { from: "report.txt", to: "report-final.txt" } : {},
          { dryRun: dry });
        el.liveLine.textContent = dry
          ? `Dry run: ${JSON.stringify(res.detail || {})}`
          : `${actionId} → ${res.outcome}`;
        refreshPermPanel();
      } catch (err) {
        el.liveLine.textContent = `Action failed: ${err?.message || err}`;
      }
    });
  });

  // ------------------------------------------------------------------ screen
  // permission help (macOS Screen Recording): check once at boot and whenever
  // the side panel opens.
  async function checkScreenPermission() {
    if (window.nova.platform !== "darwin") {
      el.screenPermHelp.hidden = true;
      return;
    }
    try {
      const res = await window.nova.checkScreenPermission();
      const missing = res?.status && res.status !== "granted";
      el.screenPermHelp.hidden = !missing;
    } catch {
      el.screenPermHelp.hidden = true;
    }
  }
  el.openScreenSettingsBtn.addEventListener("click", () => {
    window.nova.openScreenSettings().catch(() => {});
  });
  el.permClearBtn.addEventListener("click", async () => {
    try {
      await window.nova.clearActionLog();
      refreshPermPanel();
    } catch (err) {
      console.warn("Log clear failed:", err);
    }
  });

  el.refreshBtn.addEventListener("click", async () => {
    el.refreshBtn.style.transform = "rotate(180deg)";
    setTimeout(() => (el.refreshBtn.style.transform = ""), 400);
    try {
      const r = await window.nova.refreshModels();
      if (r.ok) {
        chatModel = r.model;
        el.modelName.textContent = r.model;
        el.modelBadge.hidden = !r.model;
        refreshDevPanel();
      }
    } catch (err) {
      console.warn("Model refresh failed:", err);
    }
  });
  el.modelChip.addEventListener("click", () => setSidePanel(true));

  // --- key management ---
  function openKeyDialog() {
    el.keyOverlay.hidden = false;
    el.keyInput.value = "";
    el.keyInput.focus();
  }
  function closeKeyDialog() { el.keyOverlay.hidden = true; }

  el.setKeyBtn.addEventListener("click", openKeyDialog);
  el.keyCancelBtn.addEventListener("click", closeKeyDialog);
  el.keySaveBtn.addEventListener("click", async () => {
    const key = el.keyInput.value.trim();
    if (!key) { el.keyInput.focus(); return; }
    const r = await window.nova.submitKey(key);
    if (r.ok) {
      apiKey = key;
      closeKeyDialog();
      loadSettings();
    } else {
      el.keyInput.value = "";
      el.keyInput.placeholder = r.error || "Try again";
    }
  });

  // ======================================================================
  // BOOT
  // ======================================================================
  loadSettings();
  // If the key was never configured, open the overlay dialog once.
  window.nova.getSettings().then((s) => {
    if (!s.keyConfigured) openKeyDialog();
  }).catch(() => {});

  // Expose for debugging in DevTools only
  window.__novaDebug = { state, history: () => historyItems };

  // ---------------------------------------------------------------------------
  // Stage 5 wiring: undo button, Developer Mode task inspector, onboarding.
  // ---------------------------------------------------------------------------
  async function refreshUndoButton() {
    if (!el.undoBtn) return;
    try {
      const res = await window.nova.getUndoInfo();
      const info = res?.ok && res.info ? res.info : null;
      el.undoBtn.disabled = !info;
      el.undoBtn.title = info
        ? "Undo: " + info.label + " (reversible, within 5 minutes)"
        : "Nothing to undo — mouse clicks and messages can't be reversed.";
    } catch { /* offline window state */ }
  }

  el.undoBtn?.addEventListener("click", async () => {
    try {
      const res = await window.nova.undoLast();
      if (!res?.ok) {
        speak("I could not undo that: " + (res?.error || "unknown error"));
        return;
      }
      addHistoryEntry({ role: "nova", text: "Undid the last reversible action — " + res.label + ".", src: "undo" });
      speak("Undone — " + res.label + ".");
      refreshUndoButton();
    } catch (err) {
      console.error("Undo failed:", err);
    }
  });

  function renderDevTask(task) {
    if (!el.devTaskBody) return;
    if (!task) {
      el.devTaskBody.textContent = "No task yet — send Nova a message and this panel fills with the last run.";
      return;
    }
    const lines = [];
    lines.push("Task " + task.id + " — intent: " + task.intent + " (" + (task.classification?.method ?? "?") + ", confidence " + (task.classification?.confidence ?? "?") + ")");
    if (task.modelPick) lines.push("Model: " + (task.modelPick.model || "?") + (task.modelPick.reason ? " — " + task.modelPick.reason : ""));
    lines.push("Steps:");
    for (const s of task.steps || []) {
      lines.push("  • " + s.label + "  " + (s.level != null ? "(L" + s.level + ")" : "") + "  " + s.durationMs + "ms");
    }
    lines.push("Action log (this task):");
    for (const e of task.logEntries || []) lines.push("  • " + e.actionId + " [L" + e.level + "] " + e.outcome + " at " + (e.ts || e.startedAt || "?"));
    lines.push("Errors (raw — visible only in Developer Mode):");
    for (const e of task.errors || []) {
      const stack = e.stack ? "\n    " + e.stack.split("\n").slice(1).join("\n    ").slice(0, 500) : "";
      lines.push("  • [" + e.context + "] " + e.message + stack);
    }
    el.devTaskBody.textContent = lines.join("\n") || "Nothing recorded.";
  }

  async function refreshDevTask() {
    if (!el.devTask || !el.devToggle) return;
    const devOn = !!window.nova.isDevMode?.();
    el.devTask.hidden = !devOn;
    if (!devOn) return;
    try {
      const res = await window.nova.getLastTask();
      renderDevTask(res?.ok ? res.task : null);
    } catch { /* window gone */ }
  }

  function toggleDevMode() {
    if (!el.devToggle) return;
    window.nova.setDevMode(!settings.developerMode).then((res) => {
      if (res?.ok) {
        settings.developerMode = res.developerMode;
        refreshDevTask();
      }
    }).catch(() => {});
  }

  el.devToggle?.addEventListener("click", toggleDevMode);

  // Round 7: first-run welcome wizard. Steps are renderer-driven:
  //   welcome → api-key → [screen-recording] → [accessibility] → done
  // Only the permission steps touch the main process; the tour is marked
  // complete via nova:complete-wizard so it never shows again.
  const WELCOME_FEATURES = [
    ["See your screen", "\u201CWhat's on my screen?\u201D — offline OCR + optional vision model"],
    ["Move & type for you", "Open apps, click, type — gated by a 5-level safety framework"],
    ["Manage your files", "Search, organize and tidy with dry-run previews first"],
    ["Answer about your docs", "A fully local knowledge base: indexing, embeddings and RAG on this machine"],
    ["Notes, tasks & reminders", "Everything stored on-device, never sent to a cloud service"],
    ["Repeat it automatically", "Scheduled or event-triggered automations of any of the above"],
  ];
  const PRIVACY_NOTE = "Your data stays on this machine. An OpenRouter key is optional (unlocks better answers) — every tool still works locally, and Private Mode blocks all outbound calls.";

  let wizard = null; // { step, steps: [{id, label}], platform }
  let wizardStepIndex = 0;

  function hideWizardChrome() {
    if (el.wizardSteps) el.wizardSteps.hidden = true;
    if (el.wizardIntro) el.wizardIntro.hidden = true;
    if (el.wizardDots) el.wizardDots.hidden = true;
    if (el.onboardingFeatures) el.onboardingFeatures.hidden = true;
    if (el.wizardSkip) el.wizardSkip.hidden = true;
  }

  function renderWizardDots() {
    if (!el.wizardDots || !wizard) return;
    el.wizardDots.hidden = false;
    el.wizardDots.innerHTML = "";
    wizard.steps.forEach((_, i) => {
      const dot = document.createElement("span");
      if (i === wizardStepIndex) dot.className = "active";
      el.wizardDots.appendChild(dot);
    });
  }

  function setWizardProgress() {
    if (!wizard || !el.wizardStepLabel || !el.wizardStepFill) return;
    const n = wizard.steps.length;
    const pct = n > 1 ? Math.round(((wizardStepIndex + 1) / n) * 100) : 100;
    el.wizardStepLabel.textContent = (wizardStepIndex + 1) + " of " + n;
    el.wizardStepFill.style.width = pct + "%";
  }

  function showOnboarding(pending, state, firstRun = false) {
    if (!el.onboarding) return;
    if (firstRun && !wizard) {
      // Build the step list for this run: welcome + api-key are renderer steps;
      // permission screens (macOS) come from the main process.
      const steps = [{ id: "welcome", label: "Welcome" }, { id: "api-key", label: "API key" }];
      for (const s of pending) steps.push(s);
      wizard = { step: steps[0].id, steps, pending, state };
      wizardStepIndex = 0;
    }
    // No wizard (returning user) or wizard exhausted → plain permission screens.
    if (!wizard) {
      const screen = pending[0];
      if (!screen) { el.onboarding.hidden = true; return; }
      el.onboarding.hidden = false;
      hideWizardChrome();
      el.onboardingTitle.textContent = "Nova needs " + (screen.id === "screen-recording" ? "Screen Recording" : "Accessibility") + " access";
      el.onboardingWhy.textContent = screen.why;
      if (el.onboardingAck) el.onboardingAck.textContent = "Allow";
      if (el.wizardSteps) el.wizardSteps.hidden = true;
      return;
    }
    el.onboarding.hidden = false;
    const step = wizard.steps[wizardStepIndex];
    if (step) wizard.step = step.id;
    renderWizardDots();
    setWizardProgress();
    const titles = {
      "welcome": "Welcome to Nova",
      "api-key": "Unlock better answers (optional)",
      "screen-recording": "Nova needs Screen Recording access",
      "accessibility": "Nova needs Accessibility access",
    };
    const whys = {
      "welcome": PRIVACY_NOTE,
      "api-key": "Nova works fully offline, but an OpenRouter API key unlocks smarter answers for questions, vision and your knowledge base. The key is stored with your OS keychain — never logged or sent anywhere else.",
      "screen-recording": "To answer questions like \u201Cwhat's on my screen\u201D, Nova reads your display. macOS asks you to allow this in System Settings \u2192 Privacy & Security \u2192 Screen Recording.",
      "accessibility": "To control the mouse and keyboard for you (typing, clicking), Nova sends system-level input events. macOS asks you to allow this in System Settings \u2192 Privacy & Security \u2192 Accessibility.",
    };
    const acks = {
      "welcome": "Get started",
      "api-key": "Continue",
      "screen-recording": "Allow",
      "accessibility": "Allow",
    };
    el.onboardingTitle.textContent = titles[step.id] || step.why;
    el.onboardingWhy.textContent = whys[step.id] || step.why;
    if (el.onboardingAck) el.onboardingAck.textContent = acks[step.id] || "Continue";
    if (el.wizardIntro) {
      el.wizardIntro.hidden = step.id !== "welcome";
      if (el.wizardIntroLine) el.wizardIntroLine.textContent = "A voice-first assistant for your desktop";
    }
    if (el.onboardingFeatures) {
      const show = step.id === "welcome";
      el.onboardingFeatures.hidden = !show;
      if (show && el.onboardingFeatures.children.length === 0) {
        for (const [name, desc] of WELCOME_FEATURES) {
          const li = document.createElement("li");
          li.innerHTML = "<strong>" + name + "</strong> — " + desc;
          el.onboardingFeatures.appendChild(li);
        }
      }
    }
    if (el.wizardSkip) el.wizardSkip.hidden = step.id === "accessibility"; // last step has no skip
  }

  // Round 7: boot the wizard on first run; fall back to the legacy permission flow.
  async function bootWizard() {
    try {
      if (window.nova.getWizard) {
        const res = await window.nova.getWizard();
        if (res?.ok && res.welcomeDue) {
          showOnboarding(res.pending || [], res.state, true);
          return;
        }
      }
      if (window.nova.getOnboarding) {
        const res = await window.nova.getOnboarding();
        if (res?.ok && res.pending?.length) showOnboarding(res.pending, res.state, false);
      }
    } catch { /* offline */ }
  }
  bootWizard();
  if (window.nova.onOnboarding) window.nova.onOnboarding((data) => showOnboarding(data.pending, data.state));

  // Round 7: Alt+M global hotkey (main process) arrives as nova:toggle-mic.
  // Reuse the talk button's existing toggle behavior so wake-word arm state
  // and barge-in rules stay consistent.
  if (window.nova.onToggleMic && el.talkBtn) {
    window.nova.onToggleMic(() => el.talkBtn.click());
  }
  initNotesPanel();
  initKbPanel();
  initAutoPanel();
  initWakeWord();

  // Round 10: command palette — Cmd/Ctrl+K opens a fuzzy launcher over every
  // registered action (which keep their risk levels and confirmation gates)
  // plus local UI affordances.
  if (window.NovaPaletteSetup && typeof window.NovaPaletteSetup.createPalette === "function") {
    const palette = window.NovaPaletteSetup.createPalette({
      el,
      setSidePanel: (open) => setSidePanel(open),
      runKbCommand,
      submitMessage,
      refreshPermPanel,
      exportLog: () => el.permExportBtn.click(),
      startListening: () => { if (state.mode !== "listening") el.talkBtn.click(); },
      stopSpeaking: () => { if (state.ttsActive) stopSpeaking(); },
      isSpeaking: () => state.ttsActive,
      onActionRun: (text) => { el.liveLine.textContent = text; },
    });
    if (el.paletteHint) {
      el.paletteHint.addEventListener("click", () => palette.open());
    }
    window.NovaPaletteSetup.bindPaletteHotkey(() => palette.open());
  }

  // Round 11: orb theme picker — swatch row in Settings. Pure renderer logic,
  // localStorage-only persistence (decorative, no outbound traffic).
  if (window.NovaThemes && el.themeSwatches && el.themeLabel) {
    const THEMES = window.NovaThemes.THEMES;
    function renderSwatches() {
      const cur = window.NovaThemes.currentTheme();
      el.themeSwatches.innerHTML = Object.entries(THEMES)
        .map(([id, t]) =>
          `<button type="button" class="theme-swatch${id === cur ? " active" : ""}" data-theme="${id}" style="background:${t.base};" role="radio" aria-checked="${id === cur}" aria-label="${t.label}" title="${t.label}"></button>`,
        )
        .join("");
      el.themeLabel.textContent = THEMES[cur]?.label ?? "—";
      el.themeSwatches.querySelectorAll(".theme-swatch").forEach((btn) => {
        btn.addEventListener("click", () => {
          window.NovaThemes.applyTheme(btn.dataset.theme);
          renderSwatches();
        });
      });
    }
    renderSwatches();
    document.addEventListener("nova:theme-changed", renderSwatches);
  }

  // Round 16: history export — Markdown download + save transcript as a note.
  // Read-only by nature (L0); saving as a note routes through the existing
  // notes:add-note gate (L1), so no new IPC surface is introduced.
  if (window.NovaHistoryExport && el.historyExportBtn && el.historySaveNoteBtn) {
    el.historyExportBtn.addEventListener("click", () => {
      try {
        const mdText = window.NovaHistoryExport.renderMarkdown(historyItems, { appName: "Nova" });
        const name = window.NovaHistoryExport.downloadMarkdown(mdText);
        el.liveLine.textContent = `Exported ${historyItems.length} message${historyItems.length === 1 ? "" : "s"} → ${name}`;
      } catch (err) {
        el.liveLine.textContent = "Export failed — the session transcript couldn't be saved.";
      }
    });
    el.historySaveNoteBtn.addEventListener("click", async () => {
      try {
        const res = await window.NovaHistoryExport.saveAsNote(historyItems, { appName: "Nova" });
        if (res.ok) {
          el.liveLine.textContent = "Session transcript saved as a local note — you can search it by voice later.";
          if (typeof refreshNotesPanel === "function") refreshNotesPanel();
        } else {
          el.liveLine.textContent = res.detail?.error || "Couldn't save the transcript as a note.";
        }
      } catch (err) {
        el.liveLine.textContent = "Couldn't save the transcript as a note.";
      }
    });
  }

  el.onboardingAck?.addEventListener("click", async () => {
    try {
      if (wizard) {
        const step = wizard.steps[wizardStepIndex];
        if (step.id === "welcome") {
          wizardStepIndex += 1;
          showOnboarding(wizard.pending, wizard.state);
          return;
        }
        if (step.id === "api-key") {
          // The key lives in the side panel (Settings) — skip without nagging.
          wizardStepIndex += 1;
          showOnboarding(wizard.pending, wizard.state);
          return;
        }
        // Permission steps (screen-recording / accessibility).
        const current = await window.nova.getOnboarding();
        const screen = (current?.ok ? current.pending : wizard.pending)[0];
        if (!screen) {
          await window.nova.completeWizard?.().catch(() => {});
          wizard = null;
          el.onboarding.hidden = true;
          return;
        }
        if (screen.id === "accessibility") {
          const res = await window.nova.runAccessibilityTest();
          if (res?.status === "granted") {
            await window.nova.ackOnboarding(screen.id);
            const next = await window.nova.getOnboarding();
            const remaining = (next?.ok ? next.pending : []).length;
            if (remaining === 0) {
              await window.nova.completeWizard?.().catch(() => {});
              wizard = null;
              el.onboarding.hidden = true;
            } else {
              wizard.pending = next?.ok ? next.pending : wizard.pending;
              wizard.state = res?.state || wizard.state;
              wizardStepIndex += 1;
              showOnboarding(wizard.pending, wizard.state);
            }
            return;
          }
          if (res?.ok) {
            el.onboardingAck.textContent = "I allowed it in the OS dialog";
            el.onboardingAck.dataset.step = "verify";
            return;
          }
          return;
        }
        await window.nova.ackOnboarding(screen.id);
        const next = await window.nova.getOnboarding();
        const remaining = (next?.ok ? next.pending : []).length;
        if (remaining === 0) {
          await window.nova.completeWizard?.().catch(() => {});
          wizard = null;
          el.onboarding.hidden = true;
        } else {
          wizard.pending = next?.ok ? next.pending : wizard.pending;
          wizard.state = next?.state || wizard.state;
          wizardStepIndex += 1;
          showOnboarding(wizard.pending, wizard.state);
        }
        return;
      }
      // Legacy path (returning user, permission screens only).
      const current = await window.nova.getOnboarding();
      if (!current?.ok) return;
      const screen = current.pending[0];
      if (!screen) {
        showOnboarding([], current.state);
        return;
      }
      if (screen.id === "accessibility") {
        const res = await window.nova.runAccessibilityTest();
        if (res?.status === "granted") {
          await window.nova.ackOnboarding(screen.id);
          const next = await window.nova.getOnboarding();
          showOnboarding(next?.ok ? next.pending : [], res?.state);
          return;
        }
        if (res?.ok) {
          el.onboardingAck.textContent = "I allowed it in the OS dialog";
          el.onboardingAck.dataset.step = "verify";
          return;
        }
      } else {
        await window.nova.ackOnboarding(screen.id);
        const next = await window.nova.getOnboarding();
        showOnboarding(next?.ok ? next.pending : [], current.state);
        return;
      }
    } catch { /* offline */ }
  });

  el.wizardSkip?.addEventListener("click", async () => {
    try {
      await window.nova.completeWizard?.();
    } catch { /* offline */ }
    wizard = null;
    el.onboarding.hidden = true;
  });
})();
