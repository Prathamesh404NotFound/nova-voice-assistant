// Nova — Round 19 renderer test: snooze-ui.js logic against a fake DOM.
//
// snooze-ui.js is deliberately DOM-only (no Electron APIs), so the renderer
// logic can be exercised headlessly with a tiny Element mock. CJS-safe:
// electron is shimmed via Module._load, no top-level await anywhere.

// =========================== electron shim ===========================
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return { app: null, Notification: null, BrowserWindow: { getAllWindows: () => [] }, ipcRenderer: null, ipcMain: null, systemPreferences: null };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// =========================== tiny DOM mock ===========================
const assert = (cond, label) => {
  if (!cond) throw new Error("ASSERT FAILED: " + label);
  console.log("PASS ", label);
};
class FakeEl {
  constructor(tag, text) {
    this.tagName = tag.toUpperCase();
    this.textContent = text === undefined ? "" : String(text);
    this.className = "";
    this.disabled = false;
    this.dataset = {};
    this.children = [];
    this._listeners = {};
    this.id = "";
    this.parentNode = null;
    // Minimal classList: mirrors FakeEl.className so snooze-ui's disableAll works
    this.classList = {
      add: (cls) => { if (!this.className.includes(cls)) this.className = `${this.className} ${cls}`.trim(); },
      remove: (cls) => { this.className = this.className.split(/\s+/).filter((c) => c && c !== cls).join(" "); },
      contains: (cls) => this.className.includes(cls),
    };
  }
  setAttribute(k, v) {
    if (k === "data-seconds") this.dataset.seconds = v;
    if (k === "data-reminder-id") this.dataset.reminderId = v;
  }
  getAttribute() { return null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  querySelectorAll(sel) {
    if (sel === "button") return this.children.filter((c) => c.tagName === "BUTTON");
    if (sel.startsWith(".")) return this.children.filter((c) => c.className.includes(sel.slice(1)));
    // Compound "tag.class" selectors: tag must match AND className must include the class
    if (sel.includes(".")) {
      const [tag, cls] = sel.split(".");
      return this.children.filter((c) => c.tagName === tag.toUpperCase() && c.className.includes(cls));
    }
    return [];
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener() {}
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
}
const doc = {
  _bodyChildren: [],
  createElement(tag) { return new FakeEl(tag); },
  body: { appendChild(c) { doc._bodyChildren.push(c); return c; } },
};
global.document = doc;

const noop = () => {};
global.window = {};

// Load the renderer helper with the fake DOM + window in place.
require("../renderer/js/snooze-ui.js");
const UI = global.window.NovaSnoozeUI;

// ---------------- chip set ----------------
const chips = UI.QUICK;
assert(chips.length === 4 && chips[0].seconds === 300 && chips[3].seconds === 3600, "QUICK offers 5m/10m/30m/1h");

// ---------------- buildBanner shape ----------------
UI.init({ ipc: null, speak: noop });
const bar = UI.buildBanner({ id: "r-42", text: "take the chicken out" });
assert(bar.tagName === "DIV" && bar.dataset.reminderId === "r-42", "bar targets the reminder id");
const buttons = bar.querySelectorAll("button");
assert(buttons.length === 4, "bar renders four snooze chips");

// ---------------- click disables every chip (single-use, no stacking) ----------------
const first = buttons[0];
const fn = first._listeners.click[0];
fn();
assert(buttons.every((b) => b.disabled && b.className.includes("disabled")), "all chips disable after one click");

// ---------------- a second click cannot fire (ipc is null, would have spoken an error) ----------------
let spoke = [];
UI.init({ ipc: null, speak: (t) => spoke.push(t) });
const bar2 = UI.buildBanner({ id: "r-7", text: "feed the dog" });
const chips2 = bar2.querySelectorAll("button");
chips2[0]._listeners.click[0]();
assert(chips2.every((b) => b.disabled), "no second shot — chips stay disabled");
assert(spoke.length === 1 && /bridge/.test(spoke[0]), "clicking with no ipc speaks the plain bridge error exactly once");

// ---------------- successful IPC speak ----------------
UI.init({
  ipc: async (id, seconds) => ({ ok: true, dueAt: new Date(Date.now() + seconds * 1000).toISOString() }),
  speak: (t) => spoke.push(t),
});
const bar3 = UI.buildBanner({ id: "r-9", text: "water the plants" });
const chips3 = bar3.querySelectorAll("button");
(async () => {
  await chips3[1]._listeners.click[0]();
  assert(spoke.some((t) => /10 minute/.test(t) && /water the plants/.test(t) === false), "success speaks the snooze time");
  assert(spoke.some((t) => /10 minute/.test(t)), "spoken confirmation mentions the snooze duration");

  // ---------------- failed IPC surfaces a plain message ----------------
  UI.init({ ipc: async () => ({ ok: false, message: "it already fired again" }), speak: (t) => spoke.push(t) });
  const bar4 = UI.buildBanner({ id: "r-3", text: "mop the kitchen" });
  await bar4.querySelectorAll("button")[2]._listeners.click[0]();
  assert(spoke.some((t) => /already fired again/.test(t)), "failed IPC speaks the plain error");

  // ---------------- IPC throw is handled silently ----------------
  UI.init({ ipc: async () => { throw new Error("boom"); }, speak: (t) => spoke.push(t) });
  const bar5 = UI.buildBanner({ id: "r-1", text: "walk the cat" });
  await bar5.querySelectorAll("button")[0]._listeners.click[0]();
  assert(spoke.some((t) => /went wrong/.test(t)), "thrown IPC gets a plain fallback line");

  // ---------------- markDismissed kills chips without speaking ----------------
  UI.init({ ipc: async () => { throw new Error("boom"); }, speak: (t) => spoke.push(t) });
  const bar6 = UI.buildBanner({ id: "r-8", text: "unlatch the gate" });
  UI.markDismissed();
  await bar6.querySelectorAll("button")[0]._listeners.click[0]();
  assert(spoke.filter((t) => /went wrong/.test(t)).length === 1, "dismissed banners cannot fire and stay silent");

  console.log("\nAll Round 19 renderer snooze-UI tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
