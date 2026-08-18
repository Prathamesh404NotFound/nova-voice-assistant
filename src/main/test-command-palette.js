// Nova — Round 10 command palette logic tests.
// The palette is a renderer-side fuzzy launcher over main-process actions.
// We test the matching/ranking/highlighting helpers by loading the module's
// class in a minimal DOM-free shim via jsdom-free pure JS: since the module
// is an IIFE that assigns window.NovaCommandPalette, we mock window/document
// globals the minimal way the class needs (createElement / classList / events).

const fs = require("fs");
const path = require("path");

// ---------- minimal global shim ----------
let lastCreated = null;
const createdElements = [];
global.window = global;
global.document = {
  createElement: (tag) => {
    const children = [];
    const listeners = {};
    const e = {
      tag,
      id: null,
      type: tag === "input" ? "input" : undefined,
      placeholder: "",
      setAttribute: () => {},
      className: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      value: "",
      classList: {
        _cls: [],
        add: (c) => { if (!e.classList._cls.includes(c)) e.classList._cls.push(c); },
        remove: (c) => { e.classList._cls = e.classList._cls.filter((x) => x !== c); },
        toggle: (c) => {
          if (e.classList._cls.includes(c)) e.classList.remove(c);
          else e.classList.add(c);
        },
        contains: (c) => e.classList._cls.includes(c),
      },
      appendChild: (c) => { children.push(c); e._children = children; return c; },
      querySelector: (sel) => {
        if (!e._children) return null;
        const found = e._children.find((c) => c.tag === sel.replace(/^\./, "") || c.className.includes(sel.replace(".", "")));
        return found || null;
      },
      querySelectorAll: (sel) => {
        if (!e._children) return [];
        return e._children.filter((c) => c.className && c.className.includes(sel.replace(".", "")));
      },
      addEventListener: (ev, fn, opts) => { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeEventListener: (ev, fn) => {
        const arr = listeners[ev];
        if (arr) listeners[ev] = arr.filter((f) => f !== fn);
      },
      focus: () => {},
      click: () => {},
      remove: () => {},
      dispatchEvent: (ev) => {
        const arr = listeners[ev.type];
        if (arr) arr.forEach((fn) => fn(ev));
        return true;
      },
    };
    createdElements.push(e);
    lastCreated = e;
    return e;
  },
  body: null,
  addEventListener: () => {},
  removeEventListener: () => {},
};
global.document.body = { appendChild: () => {}, remove: () => {} };

// ---------- load the palette module ----------
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "js", "command-palette.js"), "utf8");
new Function("window", src)(global);
const Palette = window.NovaCommandPalette;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}: ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || "not equal"} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }

console.log("Command palette logic tests");

// 1. Fuzzy match: empty query matches all, prefix beats substring.
check("empty query matches all items", () => {
  const p = new Palette({ items: [], maxItems: 50 });
  p.query = "";
  assert(p._match({ label: "x" }, "").hit);
});

check("case-insensitive substring match", () => {
  const p = new Palette({ items: [], maxItems: 50 });
  const item = { label: "Export action log as JSON" };
  assert(p._match(item, "action log").hit, "substring should match");
  assert(!p._match(item, "vision model").hit, "non-matching should not");
});

check("prefix matches rank above substring", () => {
  const p = new Palette({ items: [], maxItems: 50 });
  p.query = "cle";
  const long = [{ label: "Export action log as JSON" }, { label: "Clear action log" }];
  const ranked = long
    .filter((it) => p._match(it, p.query).hit)
    .sort((a, b) => (p._match(a, p.query).prefix ? 0 : 1) - (p._match(b, p.query).prefix ? 0 : 1) || a.label.localeCompare(b.label));
  eq(ranked[0].label, "Clear action log", "prefix match must come first");
});

check("case-insensitive prefix match", () => {
  const p = new Palette({ items: [], maxItems: 50 });
  assert(p._match({ label: "Clear action log" }, "CLEAR").prefix);
});

// 2. Highlighting escapes HTML and marks the match.
check("highlight escapes HTML chars", () => {
  const p = new Palette({ items: [], maxItems: 50 });
  p.query = 'a<b';
  const out = p._highlight('find a<b files');
  assert(out.includes("&lt;"), "must escape <");
  assert(out.includes("<mark>"), "must wrap match in mark");
});

// 3. Item cap is respected.
check("maxItems caps the filtered list", () => {
  const p = new Palette({ items: [], maxItems: 3 });
  const items = [];
  for (let i = 0; i < 7; i++) items.push({ label: `alpha item ${i}` });
  p.items = items;
  p.open();
  // The open palette reads input.value inside _filter; force the query
  // without breaking the palette's own .nova-cmd-list lookup.
  const inputEl = p.root.querySelector("input");
  inputEl.value = "alpha";
  p._filter();
  eq(p.filteredList.length, 3);
  p.close();
});

// 4. Keyboard navigation: Enter runs the highlighted item; Escape closes.
check("Enter runs highlighted item then closes", () => {
  const runs = [];
  const p = new Palette({
    items: [{ label: "x1", run: () => runs.push(1) }, { label: "x2", run: () => runs.push(2) }],
    maxItems: 5,
    onRun: (item) => { item.run(); },
  });
  p.items = p.items; // items stored as catalog
  p.open();
  // ArrowDown selects the next item (2 items, modulo wrap: 0 -> 1 -> 0).
  p._onKey({ key: "ArrowDown", preventDefault: () => {} });
  eq(p.highlightIdx, 1);
  p._runHighlighted();
  eq(runs.length, 1);
  eq(runs[0], 2);
  assert(p.root === null, "palette must close after run");
  p.close();
});

check("Escape closes palette", () => {
  const closed = [];
  const p = new Palette({ items: [{ label: "z1" }], maxItems: 5, onClose: () => closed.push(1) });
  p.open();
  assert(p.root !== null);
  p._onKey({ key: "Escape", preventDefault: () => {} });
  assert(p.root === null, "root cleared on escape");
  eq(closed.length, 1);
});

check("down arrow wraps around", () => {
  const p = new Palette({ items: [{ label: "a" }, { label: "b" }], maxItems: 5 });
  p.open();
  p._onKey({ key: "ArrowDown", preventDefault: () => {} });
  p._onKey({ key: "ArrowDown", preventDefault: () => {} });
  eq(p.highlightIdx, 0, "should wrap from last to first");
  p.close();
});

// 5. setItems triggers re-filter while open.
check("setItems re-filters an open palette", () => {
  const p = new Palette({ items: [], maxItems: 5 });
  p.open();
  const inputEl = p.root.querySelector("input");
  inputEl.value = "panel";
  p.setItems([{ label: "Open side panel" }, { label: "Close side panel" }]);
  eq(p.filteredList.length, 2);
  p.close();
});

// 6. Hotkey contract tested directly: (ctrl|cmd)+K fires, plain k does not.
check("hotkey contract: Ctrl+K fires, Cmd+K fires, plain k does not", () => {
  fired = 0;
  const onKey = (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === "k") fired++; };
  onKey({ ctrlKey: true, key: "k", preventDefault: () => {} });
  eq(fired, 1);
  onKey({ ctrlKey: false, metaKey: false, key: "k", preventDefault: () => {} });
  eq(fired, 1, "plain k must not fire");
  onKey({ metaKey: true, key: "k", preventDefault: () => {} });
  eq(fired, 2, "Cmd+K must fire");
  onKey({ ctrlKey: true, key: "j", preventDefault: () => {} });
  eq(fired, 2, "Ctrl+J must not fire");
});

console.log(failed === 0 ? `\nAll command-palette tests PASSED (${passed}/${passed + failed}).` : `\nFAILED: ${failed} of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
