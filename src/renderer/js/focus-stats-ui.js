// Round 36: focus-stats side-panel tab — DOM-agnostic builder (no global
// document access except what the caller injects), so it can be exercised
// headlessly by a fake-DOM harness exactly like NovaSnoozeUI.
//
// `NovaFocusStatsUI.buildPanel(stats)` renders:
//   1. a totals row ("Today: X minutes · 7 days: Y minutes") — honest on
//      empty logs ("No focus sessions recorded yet — say \"start focus
//      mode\" whenever you're ready…");
//   2. a 7-day bar chart (pure CSS bars, tallest bar = 100%, today
//      highlighted in --cyan, empty days show a quiet 2px baseline);
//   3. a recent-sessions list (newest first, real-elapsed minutes,
//      cancelled/replaced sessions labeled as such).
//
// stats shape (from nova:get-focus-stats):
//   { todayMin, weekMin, daily: [{day: "2026-08-18", label: "Today", minutes}],
//     recent: [{id, durationMin, startedAt, stoppedAt, status}] }

"use strict";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Real elapsed minutes for one session (same math as store.focusMinutes*). */
function elapsedMinutes(f) {
  const planned = Number(f.durationMin) || 0;
  if (!f.stoppedAt) return planned;
  const started = new Date(f.startedAt).getTime();
  const stopped = new Date(f.stoppedAt).getTime();
  if (isNaN(started) || isNaN(stopped)) return planned;
  return Math.min(planned, (stopped - started) / 60_000);
}

/** Minutes formatter matching dispatch-personal's speak shape. */
function fmtMin(m) {
  m = Math.round(m);
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r > 0 ? h + " h " + r + " min" : h + " h";
}

/** Build the totals row as a detached <div>. */
function buildTotals(stats) {
  const today = Math.round(stats.todayMin || 0);
  const week = Math.round(stats.weekMin || 0);
  const div = document.createElement("div");
  div.className = "focus-totals";
  if (!week && !stats.recent.length) {
    div.textContent = "No focus sessions recorded yet — say “start focus mode” whenever you're ready…";
    return div;
  }
  div.textContent = "Today: " + fmtMin(today) + "  ·  Trailing 7 days: " + fmtMin(week);
  return div;
}

/** Build the 7-day bar chart as a detached <div>. */
function buildChart(daily) {
  const wrap = document.createElement("div");
  wrap.className = "focus-chart";
  const max = Math.max(1, ...daily.map((d) => d.minutes || 0));
  daily.forEach((d) => {
    const col = document.createElement("div");
    col.className = "focus-bar-col" + (d.label === "Today" ? " focus-today" : "");
    const bar = document.createElement("div");
    const pct = max > 0 ? ((d.minutes || 0) / max) * 100 : 0;
    bar.className = "focus-bar";
    bar.style.height = pct >= 2 ? pct.toFixed(1) + "%" : "2px";
    bar.title = (d.label || d.day) + ": " + Math.round(d.minutes || 0) + " minutes";
    const lbl = document.createElement("div");
    lbl.className = "focus-bar-label";
    lbl.textContent = d.label || DAY_LABELS[new Date(d.day).getDay()] || d.day.slice(5);
    const num = document.createElement("div");
    num.className = "focus-bar-min";
    num.textContent = d.minutes ? Math.round(d.minutes) : "";
    col.appendChild(bar);
    col.appendChild(lbl);
    col.appendChild(num);
    wrap.appendChild(col);
  });
  return wrap;
}

/** Build the recent-sessions list as a detached <div>. */
function buildRecent(recent) {
  const div = document.createElement("div");
  div.className = "focus-recent";
  if (!recent || !recent.length) return div;
  const hd = document.createElement("div");
  hd.className = "focus-recent-head";
  hd.textContent = "Recent sessions";
  div.appendChild(hd);
  recent.slice(0, 10).forEach((f) => {
    const mins = Math.round(elapsedMinutes(f));
    const row = document.createElement("div");
    row.className = "focus-recent-row" + (f.status === "cancelled" ? " focus-cancelled" : "");
    const t = document.createElement("span");
    t.className = "focus-recent-text";
    t.textContent = fmtMin(mins) + (f.status === "cancelled" ? " (stopped early)" : "");
    const s = document.createElement("span");
    s.className = "focus-recent-when";
    try {
      s.textContent = new Date(f.startedAt).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      s.textContent = "";
    }
    row.appendChild(t);
    row.appendChild(s);
    div.appendChild(row);
  });
  return div;
}

/** Full focus-tab body — caller appends it to the panel's notes list area. */
function buildPanel(stats) {
  const root = document.createElement("div");
  root.className = "focus-panel";
  root.appendChild(buildTotals(stats));
  root.appendChild(buildChart(stats.daily || []));
  root.appendChild(buildRecent(stats.recent || []));
  return root;
}

const NovaFocusStatsUI = { buildPanel, buildTotals, buildChart, buildRecent, fmtMin, elapsedMinutes };
// eslint-disable-next-line no-undef
if (typeof module !== "undefined") module.exports = NovaFocusStatsUI;
if (typeof window !== "undefined") window.NovaFocusStatsUI = NovaFocusStatsUI;
