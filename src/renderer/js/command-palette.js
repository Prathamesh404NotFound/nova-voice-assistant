/**
 * Nova Command Palette (Round 10)
 * ================================
 * Cmd/Ctrl+K opens a fuzzy-search launcher over everything Nova can do:
 * registered permission actions (which carry a risk level and confirmation
 * semantics) plus UI affordances (panels, automations, reminders, …).
 *
 * Design notes:
 *  - Pure renderer module; no new IPC surface except the one that already
 *    exists (nova:get-actions + the run-action IPC). Actions keep their
 *    risk levels — a Level 3+ palette action still goes through the
 *    confirmation gates in the main process.
 *  - Fuzzy match: case-insensitive substring + prefix bonus, then highlight.
 *  - ESC / Escape key / blur all close it; Enter runs the highlighted item;
 *    ↑/↓/Tab navigate.
 */

(function () {
  "use strict";

  const PALETTE_CLASS = "nova-cmd-palette";

  class CommandPalette {
    constructor(opts = {}) {
      this.items = opts.items || [];
      this.onRun = opts.onRun || (() => {});
      this.onClose = opts.onClose || (() => {});
      this.maxItems = opts.maxItems || 9;
      this.query = "";
      this.highlightIdx = 0;
      this.filteredList = [];
      this.root = null;
    }

    open(parentDoc = document) {
      if (this.root) this.close();
      this.root = parentDoc.createElement("div");
      this.root.className = PALETTE_CLASS;

      const input = parentDoc.createElement("input");
      input.type = "text";
      input.placeholder = "Type a command… (e.g. clear action log, new note…)";
      input.maxLength = 120;
      input.setAttribute("aria-label", "Command palette");
      this.root.appendChild(input);

      const list = parentDoc.createElement("div");
      list.className = "nova-cmd-list";
      this.root.appendChild(list);

      // Escape overlay: clicking outside closes.
      this._overlay = parentDoc.createElement("div");
      this._overlay.className = "nova-cmd-backdrop";
      this._overlay.addEventListener("click", () => this.close());
      this._overlay.appendChild(this.root);

      this._keydown = (ev) => this._onKey(ev);
      parentDoc.addEventListener("keydown", this._keydown, true);

      parentDoc.body.appendChild(this._overlay);
      input.addEventListener("input", () => this._filter());
      input.addEventListener("focus", () => this._filter());

      input.focus();
      this._filter();
      return this;
    }

    _onKey(ev) {
      if (!this.root) return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.close();
      } else if (ev.key === "ArrowDown" || (ev.key === "Tab" && !ev.shiftKey)) {
        ev.preventDefault();
        this._moveHighlight(1);
      } else if (ev.key === "ArrowUp" || (ev.key === "Tab" && ev.shiftKey)) {
        ev.preventDefault();
        this._moveHighlight(-1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        this._runHighlighted();
      }
    }

    _moveHighlight(delta) {
      if (!this.filteredList.length) return;
      this.highlightIdx = (this.highlightIdx + delta + this.filteredList.length) % this.filteredList.length;
      this._render();
    }

    _runHighlighted() {
      const item = this.filteredList[this.highlightIdx];
      if (!item) return;
      const runRef = item;
      this.close();
      try { this.onRun(runRef); } catch { /* guard: UI stays usable */ }
    }

    close() {
      if (this._overlay) {
        this._overlay.remove();
        this._overlay = null;
      }
      if (this._keydown) {
        document.removeEventListener("keydown", this._keydown, true);
        this._keydown = null;
      }
      this.root = null;
      try { this.onClose(); } catch { /* noop */ }
    }

    /** Substring fuzzy filter with a prefix-match bonus. */
    _match(item, q) {
      const hay = item.label.toLowerCase();
      const needle = q.toLowerCase();
      if (!needle) return { hit: true, prefix: false };
      if (hay === needle) return { hit: true, prefix: true };
      if (hay.startsWith(needle)) return { hit: true, prefix: true };
      return { hit: hay.includes(needle), prefix: false };
    }

    _filter() {
      this.query = this.root.querySelector("input").value;
      this.filteredList = this.items
        .filter((it) => this._match(it, this.query).hit)
        .sort((a, b) => {
          const pa = this._match(a, this.query).prefix ? 0 : 1;
          const pb = this._match(b, this.query).prefix ? 0 : 1;
          if (pa !== pb) return pa - pb;
          return a.label.localeCompare(b.label);
        })
        .slice(0, this.maxItems);
      if (!this.filteredList.length) {
        this.highlightIdx = 0;
      } else {
        this.highlightIdx = Math.min(this.highlightIdx, this.filteredList.length - 1);
      }
      this._render();
    }

    _render() {
      const list = this.root.querySelector(".nova-cmd-list");
      list.innerHTML = "";
      if (!this.filteredList.length) {
        const none = document.createElement("div");
        none.className = "nova-cmd-none";
        none.textContent = this.query.trim() ? "No commands match — try “note”, “task”, “clear”… " + this.query : "Start typing a command…";
        list.appendChild(none);
        return;
      }
      this.filteredList.forEach((item, i) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "nova-cmd-item" + (i === this.highlightIdx ? " nova-cmd-hl" : "");
        const levelChip = item.level != null ? `<span class="nova-cmd-level l${item.level}">L${item.level}</span>` : "";
        row.innerHTML = `<span class="nova-cmd-name">${this._highlight(item.label)}</span>${levelChip}${item.hint ? `<span class="nova-cmd-hint">${this._esc(item.hint)}</span>` : ""}`;
        row.addEventListener("mouseenter", () => {
          this.highlightIdx = i;
          list.querySelectorAll(".nova-cmd-item").forEach((r, j) => r.classList.toggle("nova-cmd-hl", j === i));
        });
        row.addEventListener("click", () => {
          this.highlightIdx = i;
          this._runHighlighted();
        });
        list.appendChild(row);
      });
    }

    _highlight(label) {
      const q = this.query.trim();
      if (!q) return this._esc(label);
      const idx = label.toLowerCase().indexOf(q.toLowerCase());
      if (idx < 0) return this._esc(label);
      return this._esc(label.slice(0, idx))
        + `<mark>${this._esc(label.slice(idx, idx + q.length))}</mark>`
        + this._esc(label.slice(idx + q.length));
    }

    _esc(s) {
      return String(s || "").replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
      ));
    }

    /** Replace the command catalog (used to async-merge main-process actions). */
    setItems(items) {
      this.items = items;
      if (this.root) this._filter();
    }
  }

  // Expose globally for app.js to construct + manage.
  window.NovaCommandPalette = CommandPalette;
})();
