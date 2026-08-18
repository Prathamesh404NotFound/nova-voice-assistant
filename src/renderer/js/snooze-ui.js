// Nova — renderer/js/snooze-ui.js
//
// Round 19: snooze chips on the fired-reminder banner.
// Pure renderer logic, no Electron APIs — the IPC bridge is injected via
// `init({ ipc })` so unit tests can pass a fake bridge, and the real app
// wires it to window.nova.snoozeReminder (preload).
//
//   - Chips: 5 min / 10 min / 30 min / 1 h (L1 action — local re-arm).
//   - Clicking a chip invokes nova:snooze-reminder { id, seconds } and
//     speaks a one-line confirmation in the live transcript.
//   - Chips disable immediately after one click (no double snooze) and a
//     `markDismissed()` call (fired again / banner removed) disables them
//     without speaking anything.

(function () {
  "use strict";

  const QUICK = [
    { label: "5 min", seconds: 300 },
    { label: "10 min", seconds: 600 },
    { label: "30 min", seconds: 1800 },
    { label: "1 h", seconds: 3600 },
  ];

  let __current = null; // { id, text, spokenAt } of the banner this helper owns
  let __ipc = null;     // (id, seconds) => Promise<{ ok, message }>
  let __speak = null;   // optional (text) → void
  let __disabled = false;

  function init({ ipc, speak } = {}) {
    __ipc = ipc || null;
    __speak = typeof speak === "function" ? speak : null;
  }

  /**
   * Build the chip bar for a fired reminder banner.
   * @param {{ id: string, text: string }} reminder
   * @returns {HTMLElement}
   */
  function buildBanner(reminder) {
    __current = { id: reminder.id, text: reminder.text, spokenAt: Date.now() };
    __disabled = false;

    const bar = document.createElement("div");
    bar.className = "nova-snooze-bar";
    bar.setAttribute("data-reminder-id", reminder.id);

    const label = document.createElement("span");
    label.className = "nova-snooze-bar-label";
    label.textContent = "Snooze:";
    bar.appendChild(label);

    QUICK.forEach((q) => {
      const btn = document.createElement("button");
      btn.className = "nova-snooze-chip";
      btn.type = "button";
      btn.textContent = q.label;
      btn.setAttribute("data-seconds", String(q.seconds));
      btn.addEventListener("click", () => snoozeFor(q.seconds, btn, bar));
      bar.appendChild(btn);
    });

    return bar;
  }

  async function snoozeFor(seconds, btn, bar) {
    if (__disabled || !__current) return;
    __disabled = true;
    disableAll(bar);

    if (!__ipc) {
      if (__speak) __speak(`Could not snooze "${__current.text}" — the bridge is not available.`);
      return;
    }
    try {
      const res = await __ipc(__current.id, seconds);
      if (res && res.ok) {
        const words = Math.round(seconds / 60);
        const msg = `Reminder snoozed ${words} minute${words === 1 ? "" : "s"} — I'll nudge you again at ${new Date(res.dueAt).toLocaleTimeString()}.`;
        if (__speak) __speak(msg);
      } else {
        const msg = (res && res.message) || `Could not snooze "${__current.text}" — it may have fired again.`;
        if (__speak) __speak(msg);
      }
    } catch (err) {
      if (__speak) __speak(`Something went wrong snoozing that reminder.`);
    }
  }

  function disableAll(bar) {
    bar.querySelectorAll("button.nova-snooze-chip").forEach((b) => {
      b.disabled = true;
      b.classList.add("disabled");
    });
  }

  /**
   * The banner is going away (reminder re-fired or dismissed) — kill chips
   * silently so no stale clicks can fire.
   */
  function markDismissed() {
    __current = null;
    __disabled = true;
  }

  // ------------------------------------------------------------------
  // Round 20: per-row snooze chips for the Reminders side-panel tab.
  // The banner helper above is single-owner (one fired reminder at a
  // time); the panel can show several fired rows, so row chips keep
  // their own small scope keyed by reminder id.
  // ------------------------------------------------------------------
  const __rows = new Map(); // reminderId → { ipc, speak, disabled }

  function __rowFor(id) {
    if (!__rows.has(id)) __rows.set(id, { ipc: __ipc, speak: __speak, disabled: false });
    return __rows.get(id);
  }

  /**
   * Build chip buttons for one fired reminder row in the side panel.
   * Multiple rows coexist; each row disables itself independently after
   * one click.
   * @param {{ id: string, text: string }} reminder
   * @returns {HTMLElement}
   */
  function buildReminderRowChips(reminder) {
    __rowFor(reminder.id).disabled = false;
    const bar = document.createElement("div");
    bar.className = "nova-snooze-bar";
    bar.setAttribute("data-reminder-id", reminder.id);

    QUICK.forEach((q) => {
      const btn = document.createElement("button");
      btn.className = "nova-snooze-chip";
      btn.type = "button";
      btn.textContent = q.label;
      btn.setAttribute("data-seconds", String(q.seconds));
      btn.addEventListener("click", () => snoozeReminderRow(reminder.id, q.seconds, reminder.text, bar));
      bar.appendChild(btn);
    });

    return bar;
  }

  async function snoozeReminderRow(id, seconds, text, bar) {
    const row = __rows.get(id);
    if (!row || row.disabled) return;
    row.disabled = true;
    bar.querySelectorAll("button.nova-snooze-chip").forEach((b) => {
      b.disabled = true;
      b.classList.add("disabled");
    });
    const ipc = row.ipc || __ipc;
    const speak = row.speak || __speak;
    if (!ipc) {
      if (speak) speak(`Could not snooze "${text}" — the bridge is not available.`);
      return;
    }
    try {
      const res = await ipc(id, seconds);
      if (res && res.ok) {
        const words = Math.round(seconds / 60);
        if (speak) speak(`Reminder snoozed ${words} minute${words === 1 ? "" : "s"} — I'll nudge you again at ${new Date(res.dueAt).toLocaleTimeString()}.`);
      } else {
        const msg = (res && res.message) || `Could not snooze "${text}" — it may have fired again.`;
        if (speak) speak(msg);
      }
    } catch {
      if (speak) speak("Something went wrong snoozing that reminder.");
    }
  }

  /** Reset state — used between tests. */
  function resetForTesting() {
    __current = null;
    __disabled = false;
    __ipc = null;
    __speak = null;
    __rows.clear();
  }

  const api = { init, buildBanner, snoozeFor, markDismissed, buildReminderRowChips, snoozeReminderRow, resetForTesting, QUICK };
  if (typeof window !== "undefined") window.NovaSnoozeUI = api;
})();
