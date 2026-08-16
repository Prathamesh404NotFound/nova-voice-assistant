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
  };

  // ------------------------------------------------------------------ dom
  const $ = (id) => document.getElementById(id);
  const el = {
    statusDot: $("statusDot"), statusLabel: $("statusLabel"),
    clock: $("clock"), modelName: $("modelName"), modelBadge: $("modelBadge"),
    modelChip: $("modelChip"), refreshBtn: $("refreshBtn"),
    orbCanvas: $("orbCanvas"), orbCore: $("orbCore"), orbLabel: $("orbLabel"),
    orbWrap: $("orbWrap"), liveLine: $("liveLine"), liveHear: $("liveHear"),
    talkBtn: $("talkBtn"), continuousCheck: $("continuousCheck"),
    sidePanel: $("sidePanel"), sideToggle: $("sideToggle"), sideClose: $("sideClose"),
    history: $("history"), typeForm: $("typeForm"), typeInput: $("typeInput"),
    devModel: $("devModel"), devCount: $("devCount"), devUpdated: $("devUpdated"),
    devFallback: $("devFallback"), devLog: $("devLog"),
    setKeyBtn: $("setKeyBtn"), keyStatus: $("keyStatus"),
    keyOverlay: $("keyOverlay"), keyInput: $("keyInput"),
    keySaveBtn: $("keySaveBtn"), keyCancelBtn: $("keyCancelBtn"),
    privateBadge: $("privateBadge"), privateToggle: $("privateToggle"),
    permToast: $("permToast"), permToastLevel: $("permToastLevel"),
    permToastMsg: $("permToastMsg"), permToastCancel: $("permToastCancel"),
    permLog: $("permLog"), permExportBtn: $("permExportBtn"), permClearBtn: $("permClearBtn"),
  };

  // ------------------------------------------------------------------ clock
  function tickClock() {
    const now = new Date();
    el.clock.textContent = now.toLocaleTimeString("en-GB");
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
        // Barge-in trigger phrases
        if (/^(nova\s+)?(stop|hush|be quiet|quiet)\b/i.test(text) && state.ttsActive) {
          stopSpeaking();
          el.liveLine.textContent = "Playback stopped.";
          return;
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
  function speak(text) {
    if (!window.speechSynthesis) return;
    stopSpeaking();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.02;
    utter.pitch = 1.0;
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find((v) => /en[-_]US/i.test(v.lang) && /female|samantha|zira|google us english/i.test(v.name))
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

  // Load voice list asynchronously
  if (window.speechSynthesis) {
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
    speechSynthesis.getVoices();
  }

  // ======================================================================
  // MESSAGE PIPELINE — voice and typed text share one entry point
  // ======================================================================
  let historyItems = [];
  const MAX_HISTORY = 40;

  function addHistoryEntry({ role, text, src }) {
    historyItems.push({ role, text, src });
    if (historyItems.length > MAX_HISTORY) historyItems = historyItems.slice(-MAX_HISTORY);
    renderHistory();
  }

  function renderHistory() {
    if (historyItems.length === 0) {
      el.history.innerHTML = `<p class="history-empty">Nothing yet — say something to Nova.</p>`;
      return;
    }
    el.history.innerHTML = historyItems
      .map((m) => `<div class="msg ${m.role}"><span class="src">${m.src}</span>${escapeHtml(m.text)}</div>`)
      .join("");
    el.history.scrollTop = el.history.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function submitMessage(text, source) {
    if (!text?.trim()) return;
    addHistoryEntry({ role: "user", text: text.trim(), src: source });
    el.liveLine.textContent = "";

    if (!apiKey) {
      speak("I need your OpenRouter API key before I can answer. Open the side panel settings to set it.");
      return;
    }

    try {
      const full = await streamChat(text.trim(), onChunk);
      addHistoryEntry({ role: "nova", text: full, src: source });
      if (full.trim()) speak(full);
    } catch (err) {
      const msg = "Sorry — I could not reach the assistant. " + (err?.message || err);
      addHistoryEntry({ role: "nova", text: msg, src: source });
      speak(msg);
      console.error("Chat error:", err);
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
})();
