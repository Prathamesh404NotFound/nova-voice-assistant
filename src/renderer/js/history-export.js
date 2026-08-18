/**
 * Nova — chat history export (Round 16)
 * ======================================
 * Save the current session transcript as Markdown (browser download) or
 * store it as a timestamped local note for future voice retrieval.
 *
 * Design notes:
 *  - Pure renderer module: Markdown building and the Blob download never
 *    touch the main process. Saving as a note uses the EXISTING
 *    `notes:add-note` action through `window.nova.runAction` — so it keeps
 *    its Level 1 gate, confirmation semantics, and Action Log entry. No
 *    new IPC surface.
 *  - Export is read-only by nature (L0): it only reads historyItems, never
 *    mutates anything.
 *  - Works in Private Mode: Markdown assembly and Blob download are local;
 *    the note-save path is a local notes action, so nothing extra leaves
 *    the machine.
 *  - History is capped at 40 entries in the app (MAX_HISTORY) — the export
 *    reflects exactly what's visible in the side panel. A note above the
 *    body states this so exported transcripts are self-documenting.
 */

(function () {
  "use strict";

  const md = window.NovaHistoryExportMarkdown = {};

  /** Escape characters that would break Markdown structure. */
  function escLine(text) {
    return String(text || "")
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\|/g, "\\|");
  }

  /**
   * Render historyItems into a self-contained Markdown session transcript.
   * @param {Array} historyItems [{ role, text, src, small, kbSources, memory }]
   * @param {object} opts { now (Date), appName }
   * @returns {string}
   */
  function renderMarkdown(historyItems, opts = {}) {
    const now = opts.now || new Date();
    const appName = opts.appName || "Nova";
    const iso = now.toISOString().replace("T", " ").slice(0, 19);
    const entries = Array.isArray(historyItems) ? historyItems : [];
    const lines = [
      `# ${appName} session transcript`,
      "",
      `Exported on ${iso}. This transcript covers the most recent ${entries.length} message${entries.length === 1 ? "" : "s"} visible in the side panel (the HUD keeps the last 40 entries in memory).`,
      "",
    ];
    entries.forEach((m, i) => {
      const who = m.role === "user" ? "You" : appName;
      const srcLine = m.src ? ` — via ${escLine(String(m.src))}` : "";
      lines.push(`## ${i + 1}. ${who}${srcLine}`);
      lines.push("");
      lines.push(escLine(String(m.text || "")));
      lines.push("");
      if (m.role === "nova" && Array.isArray(m.kbSources) && m.kbSources.length) {
        lines.push("*Sources:* " + m.kbSources.map((s) => `\`${escLine(String(s.file || ""))}\``).join(", "));
        lines.push("");
      }
    });
    if (!entries.length) {
      lines.push("Nothing yet — the session history was empty when this was exported.");
      lines.push("");
    }
    return lines.join("\n");
  }

  /** Default suggested filename, e.g. nova-session-2026-08-18.md */
  function suggestFilename(now = new Date()) {
    const d = now.toISOString().slice(0, 10);
    return `nova-session-${d}.md`;
  }

  /** Trigger a browser download of the Markdown text. Returns the filename used. */
  function downloadMarkdown(mdText, filename) {
    const blob = new Blob([mdText], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || suggestFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return a.download;
  }

  /**
   * Save the transcript as a timestamped local note through the existing
   * notes:add-note action (keeps its L1 gate + Action Log entry).
   * Returns { ok, detail }.
   */
  async function saveAsNote(historyItems, opts = {}) {
    const mdText = renderMarkdown(historyItems, opts);
    const title = `Session transcript ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
    try {
      const res = await window.nova.runAction("notes:add-note", { text: `${title}\n\n${mdText}` }, { dryRun: false });
      return { ok: res?.outcome === "success", detail: res?.detail || null };
    } catch (err) {
      return { ok: false, detail: { error: String(err?.message || err) } };
    }
  }

  window.NovaHistoryExport = { renderMarkdown, suggestFilename, downloadMarkdown, saveAsNote };
})();
