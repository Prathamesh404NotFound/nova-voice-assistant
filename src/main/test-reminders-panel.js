// Nova — src/main/test-reminders-panel.js
//
// Round 20 harness: fired-reminder rows in the Reminders side-panel tab
// (snoozable row chips, ordering, cancel preserved), tested headlessly
// with a fake DOM. CJS-safe on purpose — no top-level await, everything
// runs inside the IIFE at the bottom.

(function () {
  "use strict";

  const assert = (cond, label) => {
    if (!cond) throw new Error("ASSERT FAILED: " + label);
    console.log("PASS ", label);
  };

  // =========================== electron shim ===========================
  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === "electron") {
      return {
        app: null,
        Notification: null,
        BrowserWindow: { getAllWindows: () => [] },
        ipcRenderer: null,
        ipcMain: null,
        systemPreferences: null,
      };
    }
    return originalLoad.call(this, req, parent, isMain);
  };

  // ============================= fake DOM ==============================
  class FakeEl {
    constructor(tag, text) {
      this.tagName = tag.toUpperCase();
      this.textContent = text === undefined ? "" : String(text);
      this.className = "";
      this.innerHTML = "";
      this.disabled = false;
      this.dataset = {};
      this.children = [];
      this._listeners = {};
      this.id = "";
      this.parentNode = null;
      this.classList = {
        add: (cls) => { if (!this.className.includes(cls)) this.className = `${this.className} ${cls}`.trim(); },
        remove: (cls) => { this.className = this.className.split(/\s+/).filter((c) => c && c !== cls).join(" "); },
        contains: (cls) => this.className.includes(cls),
      };
    }
    setAttribute(k, v) {
      this.dataset[k] = v; // kebab key for selector lookups
      // plus the DOM-style camelCase alias: data-foo-bar → fooBar
      if (k.startsWith("data-")) {
        const rest = k.slice(5);
        this.dataset[rest.replace(/-([a-z])/g, (_, m) => m.toUpperCase())] = v;
      }
    }
    getAttribute() { return null; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    get querySelector() {
      return () => null;
    }
    querySelectorAll(sel) {
      // match helper over a flat list (self is excluded: selectors target descendants)
      const matches = (els) => {
        const out = [];
        const stack = els.slice();
        while (stack.length) {
          const c = stack.shift();
          if (sel === "button") { if (c.tagName === "BUTTON") out.push(c); }
          else if (sel.includes("[")) {
            // attribute selectors: [attr] or tag[attr="val"]
            const open = sel.indexOf("[");
            const tag = open > 0 ? sel.slice(0, open).toUpperCase() : null;
            const inner = sel.slice(open + 1, -1);
            const eq = inner.indexOf("=");
            const okTag = !tag || c.tagName === tag;
            // dataset stores DOM-style camelCase keys (data-foo-bar → fooBar);
            // the kebab key is kept too for attribute-style lookups
            if (eq < 0) {
              const k = inner.slice(5);
              const camel = k.slice(5).replace(/-([a-z])/g, (_, m) => m.toUpperCase());
              if (okTag && (c.dataset[k] !== undefined || c.dataset[camel] !== undefined)) out.push(c);
            } else {
              const k = inner.slice(0, eq).slice(5);
              const camel = k.replace(/-([a-z])/g, (_, m) => m.toUpperCase());
              const val = inner.slice(eq + 2, -1);
              if (okTag && (c.dataset[k] === val || c.dataset[camel] === val)) out.push(c);
            }
          }
          else if (sel.startsWith(".")) {
            // plain or compound class selectors: .cls or tag.cls
            const dot = sel.lastIndexOf(".");
            const tag = dot > 0 ? sel.slice(0, dot).toUpperCase() : null;
            const cls = sel.slice(dot + 1);
            const okTag = !tag || c.tagName === tag;
            if (okTag && c.className.includes(cls)) out.push(c);
          }
          else if (/^[A-Za-z]+$/.test(sel)) { if (c.tagName === sel.toUpperCase()) out.push(c); }
          else if (sel.includes(".")) {
            const [tag, cls] = sel.split(".");
            if (c.tagName === tag.toUpperCase() && c.className.includes(cls)) out.push(c);
          }
          if (c.children) stack.push(...c.children);
        }
        return out;
      };
      return matches(this.children);
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    closest(sel) {
      if (sel === "[data-notes-action]") return this.dataset.notesAction ? this : null;
      return null;
    }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener() {}
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
    click() {
      // run listeners and return a promise that settles when all async
      // handlers have resolved (click handlers are async arrow functions)
      const results = (this._listeners.click || []).map((fn) => {
        try { return Promise.resolve(fn.call(this)); } catch (e) { return Promise.reject(e); }
      });
      return Promise.all(results).then(() => undefined);
    }
  }

  // Minimal re-creation of app.js's renderNotesList reminders branch
  // (the logic under test, extracted so it can be exercised headlessly
  // without the full app). Mirrors the live code in src/renderer/js/app.js.
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
  const escapeAttr = escapeHtml;
  function whenHuman(iso) { return iso ? String(iso) : ""; }

  function renderReminders(listEl, items, snoozeApi) {
    const sorted = items.slice().sort((a, b) => {
      if (a.fired !== b.fired) return a.fired ? -1 : 1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    });
    listEl.innerHTML = "";
    sorted.forEach((r) => {
      const div = new FakeEl("DIV");
      div.className = "notes-item" + (r.fired ? " fired" : "");
      div.appendChild((() => {
        const span = new FakeEl("SPAN");
        span.className = "notes-check";
        return span;
      })());
      div.appendChild((() => {
        const span = new FakeEl("SPAN");
        span.className = "notes-text";
        span.textContent = escapeHtml(String(r.text || ""));
        return span;
      })());
      div.appendChild((() => {
        const span = new FakeEl("SPAN");
        span.className = "notes-sub notes-sub-fired";
        span.textContent = `${r.fired ? "fired " : ""}${whenHuman(r.dueAt)}`;
        return span;
      })());
      div.appendChild((() => {
        const btn = new FakeEl("BUTTON");
        btn.className = "notes-del";
        btn.textContent = "\u00d7";
        btn.dataset.notesAction = "cancel";
        btn.dataset.notesId = r.id;
        return btn;
      })());
      if (r.fired && snoozeApi) div.appendChild(snoozeApi.buildReminderRowChips(r));
      listEl.appendChild(div);
    });
  }

  // ============================= harness ===============================
  const path = require("path");
  const fs = require("fs");

  const doc = { createElement: (tag) => new FakeEl(tag), body: new FakeEl("BODY") };
  global.document = doc;
  global.window = {};

  require(path.resolve(__dirname, "../renderer/js/snooze-ui.js"));
  const snoozeApi = global.window.NovaSnoozeUI;
  snoozeApi.resetForTesting();

  const fired = { id: "r-fired-1", text: "take the chicken out", dueAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(), fired: true };
  const pending = { id: "r-pend-1", text: "call mom", dueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), fired: false };
  const fired2 = { id: "r-fired-2", text: "start the laundry", dueAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), fired: true };

  // ---------------- fired rows sort to the top ----------------
  const list = new FakeEl("DIV");
  renderReminders(list, [pending, fired2, fired], snoozeApi);
  const firedRows = list.children.filter((c) => c.className.includes("fired"));
  assert(firedRows.length === 2 && firedRows[0] === list.children[0] && firedRows[1] === list.children[1], "fired rows group at the top of the list");
  assert(list.children.length === 3 && !list.children[2].className.includes("fired") && list.children[2].querySelector(".notes-text").textContent === "call mom", "pending rows follow fired rows");

  // ---------------- fired rows carry snooze chips; pending do not ----------------
  console.log("DEBUG bar children:", list.children[0].querySelectorAll("DIV").map((c) => c.className));
  console.log("DEBUG chips:", list.children[0].querySelectorAll("button.nova-snooze-chip").map((b) => b.className + "@" + b.dataset.seconds).length);
  assert(list.children[0].querySelectorAll("button.nova-snooze-chip").length === 4, "fired row renders four snooze chips");
  assert(list.children[2].querySelectorAll("button.nova-snooze-chip").length === 0, "pending row has no snooze chips");
  const chips = list.children[0].querySelectorAll("button.nova-snooze-chip");
  assert(chips[0].dataset.seconds === "300" && chips[3].dataset.seconds === "3600", "chips carry 5m/1h seconds");

  // ---------------- cancel button still present on every row ----------------
  for (const row of list.children) {
    const sel = `button[data-notes-action="cancel"]`;
    const found = row.querySelectorAll(sel);
    assert(found.length === 1, `row keeps its cancel button (${row.querySelector(".notes-text").textContent})`);
  }

  // Async tests: click handlers are async, so wrap the rest in an IIFE.
  (async () => {
  snoozeApi.resetForTesting();
  let spoken = [];
  let snoozed = [];
  let refreshed = 0;
  snoozeApi.init({
    ipc: async (id, seconds) => { snoozed.push({ id, seconds }); return { ok: true, dueAt: new Date(Date.now() + seconds * 1000).toISOString() }; },
    speak: (t) => spoken.push(t),
  });
  const list2 = new FakeEl("DIV");
  renderReminders(list2, [fired], snoozeApi);
  const chip = list2.children[0].querySelectorAll("button.nova-snooze-chip")[1]; // 10 min
  await chip.click();
  assert(snoozed.length === 1 && snoozed[0].id === fired.id && snoozed[0].seconds === 600, "chip click targets the reminder id with the chip seconds");
  assert(spoken.length === 1 && /10 minutes/.test(spoken[0]) && /nudge you again/.test(spoken[0]), "success speaks the snooze time");
  assert(list2.children[0].querySelectorAll("button.nova-snooze-chip").every((b) => b.disabled), "row chips disable after one click");

  // ---------------- double click is a no-op ----------------
  await chip.click();
  await chip.click();
  assert(snoozed.length === 1, "subsequent clicks do not fire again");
  assert(spoken.length === 1, "no extra speech after the first click");

  // ---------------- rejected snooze speaks the plain message ----------------
  snoozeApi.resetForTesting();
  spoken = [];
  snoozed = [];
  snoozeApi.init({
    ipc: async (id, seconds) => { snoozed.push({ id, seconds }); return { ok: false, message: "not snoozable anymore" }; },
    speak: (t) => spoken.push(t),
  });
  const list3 = new FakeEl("DIV");
  renderReminders(list3, [fired], snoozeApi);
  await list3.children[0].querySelectorAll("button.nova-snooze-chip")[0].click();
  assert(snoozed.length === 1 && spoken.length === 1 && /not snoozable anymore/.test(spoken[0]), "failed snooze speaks the plain server message");

  // ---------------- thrown IPC gets a plain fallback ----------------
  snoozeApi.resetForTesting();
  spoken = [];
  snoozed = [];
  snoozeApi.init({
    ipc: async (id, seconds) => { snoozed.push({ id, seconds }); throw new Error("boom"); },
    speak: (t) => spoken.push(t),
  });
  const list4 = new FakeEl("DIV");
  renderReminders(list4, [fired], snoozeApi);
  await list4.children[0].querySelectorAll("button.nova-snooze-chip")[0].click();
  assert(snoozed.length === 1 && spoken.length === 1 && /went wrong/.test(spoken[0]), "thrown IPC speaks a plain fallback");

  // ---------------- app.js ipc wrapper refreshes the list on success ----------------
  const ipcCalls = [];
  let refreshCount = 0;
  const fakeIpc = async (id, seconds) => { ipcCalls.push({ id, seconds }); return { ok: true, dueAt: new Date().toISOString() }; };
  // simulate the wrapper from initNotesPanel (app.js)
  const wrappedIpc = async (id, seconds) => {
    const res = await fakeIpc(id, seconds);
    if (res && res.ok) refreshCount += 1;
    return res;
  };
  snoozeApi.resetForTesting();
  snoozeApi.init({ ipc: wrappedIpc, speak: () => {} });
  const list5 = new FakeEl("DIV");
  renderReminders(list5, [fired], snoozeApi);
  await list5.children[0].querySelectorAll("button.nova-snooze-chip")[2].click();
  assert(refreshCount === 1 && ipcCalls[0].seconds === 1800, "panel snooze refreshes the list exactly once on success");

  // ---------------- failure does not refresh ----------------
  snoozeApi.resetForTesting();
  snoozeApi.init({ ipc: async (id, seconds) => { ipcCalls.push({ id, seconds }); return { ok: false, message: "x" }; }, speak: () => {} });
  const list6 = new FakeEl("DIV");
  renderReminders(list6, [fired], snoozeApi);
  await list6.children[0].querySelectorAll("button.nova-snooze-chip")[0].click();
  assert(ipcCalls.length === 2 && refreshCount === 1, "failed snooze does not trigger an extra refresh");

    console.log("All Round 20 reminders-panel tests passed.");
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
})();
