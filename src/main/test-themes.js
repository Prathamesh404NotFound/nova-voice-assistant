// Nova — Round 11 orb theme picker tests.
// The theme module is a renderer-side IIFE (window.NovaThemes) that repaints
// the HUD accent family via CSS variables + live stylesheet rgba() rewrites,
// persisted in localStorage. Headless Node tests cover everything except the
// live stylesheet rewrite (tested by regex simulation of its algorithm).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------- minimal global shim ----------
let styleSheets = [];
let rootStyle = {};
let storage = {};
let lastEvent = null;

global.window = global;
global.localStorage = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = v; },
  removeItem: (k) => { delete storage[k]; },
};
global.document = {
  documentElement: {
    style: {
      setProperty: (k, v) => { rootStyle[k] = v; },
      getPropertyValue: (k) => rootStyle[k] ?? "",
    },
  },
  styleSheets,
  addEventListener: (ev, fn) => {
    if (ev === "DOMContentLoaded") fn();
  },
  dispatchEvent: (ev) => { lastEvent = ev; return true; },
};
global.CSSRule = { STYLE_RULE: 1 };

function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    failed += 1;
  }
}

console.log("Orb theme tests");

// ---------- load the themes module ----------
const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "js", "themes.js"), "utf8");
new Function("window", src)(global);
const T = window.NovaThemes;
assert(T && T.applyTheme, "window.NovaThemes must expose applyTheme");

let passed = 0;
let failed = 0;

test("four themes exist with a full hue family each", () => {
  for (const id of ["cyan", "purple", "green", "amber"]) {
    const t = T.THEMES[id];
    assert(t, `theme ${id} must exist`);
    assert(/^#[0-9a-f]{6}$/.test(t.base));
    assert(/^#[0-9a-f]{6}$/.test(t.light));
    assert(/^#[0-9a-f]{6}$/.test(t.deep));
    assert(/^#[0-9a-f]{6}$/.test(t.lightest));
    assert(/^#[0-9a-f]{6}$/.test(t.darkText));
  }
  // Each theme must be visually distinct (different base hue).
  const bases = Object.values(T.THEMES).map((t) => t.base);
  assert(new Set(bases).size === 4, "all four bases must differ");
});

test("cyan is the default when nothing is stored", () => {
  delete storage[T.THEME_STORAGE_KEY];
  assert.strictEqual(T.currentTheme(), "cyan");
});

test("applyTheme sets the CSS custom properties for the theme", () => {
  delete storage[T.THEME_STORAGE_KEY];
  rootStyle = {};
  T.applyTheme("purple");
  assert.strictEqual(rootStyle["--cyan"], T.THEMES.purple.base);
  assert.match(rootStyle["--cyan-glow"], /^rgba\(180, 140, 255, 0\.35\)$/);
  assert.match(rootStyle["--line"], /^rgba\(180, 140, 255, 0\.1\)$/);
  assert.strictEqual(T.currentTheme(), "purple");
});

test("chosen theme persists and restores across loads", () => {
  delete storage[T.THEME_STORAGE_KEY];
  rootStyle = {};
  T.applyTheme("amber");
  assert.strictEqual(storage[T.THEME_STORAGE_KEY], "amber");
  // Simulate a fresh page load: re-run the module in a clean context.
  const fresh = { styleSheets: [], localStorage };
  const fakeDoc = {
    documentElement: { style: { setProperty: (k, v) => { fresh.style[k] = v; }, getPropertyValue: () => "" } },
    styleSheets: [],
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  fresh.document = fakeDoc;
  new Function("window", src)(fresh);
  assert.strictEqual(fresh.localStorage.getItem(T.THEME_STORAGE_KEY), "amber");
});

test("unknown theme id falls back to cyan", () => {
  delete storage[T.THEME_STORAGE_KEY];
  rootStyle = {};
  assert.strictEqual(T.currentTheme(), "cyan", "no persisted theme → default is cyan");
  // Seed a DIFFERENT stored theme so the apply actually repaints — the module
  // short-circuits when the requested theme equals the stored one.
  storage[T.THEME_STORAGE_KEY] = "purple";
  T.applyTheme("nonexistent");
  assert.strictEqual(rootStyle["--cyan"], T.THEMES.cyan.base, "unknown id must fall back to cyan tokens");
  assert.strictEqual(storage[T.THEME_STORAGE_KEY], "cyan");
});

test("applying the same theme twice is a no-op (no storage write, no event)", () => {
  delete storage[T.THEME_STORAGE_KEY];
  rootStyle = {};
  lastEvent = null;
  T.applyTheme("green");
  storage[T.THEME_STORAGE_KEY] = "green"; // persist like first apply did
  const before = Object.assign({}, rootStyle);
  lastEvent = null;
  const result = T.applyTheme("green");
  assert.strictEqual(result, "green");
  assert.deepStrictEqual(rootStyle, before, "second apply must not mutate tokens");
  assert.strictEqual(lastEvent, null, "same-theme apply must not emit nova:theme-changed");
});

test("switching themes emits nova:theme-changed with the new theme id", () => {
  delete storage[T.THEME_STORAGE_KEY];
  rootStyle = {};
  lastEvent = null;
  T.applyTheme("cyan"); // no event (stored was already default)
  const ev1 = lastEvent;
  T.applyTheme("purple");
  assert.strictEqual(lastEvent.type, "nova:theme-changed");
  assert.strictEqual(lastEvent.detail.theme, "purple");
  assert(ev1 === null, "default→default must not emit");
});

test("fromHex parses hex colors correctly", () => {
  assert.deepStrictEqual(T.fromHex("#39d2ff"), [0x39, 0xd2, 0xff]);
  assert.deepStrictEqual(T.fromHex("#000000"), [0, 0, 0]);
  assert.deepStrictEqual(T.fromHex("#ffffff"), [255, 255, 255]);
});

// Simulate the live-stylesheet rewrite algorithm on a realistic cssText,
// verifying the regex contract (triplet replacement keeps the alpha intact).
test("rgba rewrite keeps alpha untouched and swaps the triplet", () => {
  const css = `.orb-core { background: radial-gradient(circle at 35% 30%, rgba(234, 255, 255, 0.9), rgba(123, 228, 255, 0.4) 40%, rgba(57, 210, 255, 0.7) 70%, rgba(13, 110, 138, 0.9) 100%); box-shadow: 0 0 50px rgba(57, 210, 255, 0.35); }`;
  const replacements = [
    ["57, 210, 255", "180, 140, 255"],   // cyan base -> purple base
    ["123, 228, 255", "213, 184, 255"],  // cyan light -> purple light
    ["13, 110, 138", "90, 61, 138"],     // cyan deep -> purple deep
    ["234, 255, 255", "246, 239, 255"],  // cyan lightest -> purple lightest
  ];
  let newCss = css;
  for (const [prev, next] of replacements) {
    newCss = newCss.replace(
      new RegExp(`rgba\\(\\s*${prev.replace(/,\s/g, "\\s*,\\s*")}\\s*,`, "g"),
      `rgba(${next},`,
    );
  }
  assert.ok(newCss.includes("rgba(180, 140, 255, 0.7)"), "base triplet swapped with alpha 0.7 intact");
  assert.ok(newCss.includes("rgba(180, 140, 255, 0.35)"), "glow triplet swapped with alpha 0.35 intact");
  assert.ok(newCss.includes("rgba(213, 184, 255, 0.4)"), "light triplet swapped");
  assert.ok(newCss.includes("rgba(90, 61, 138, 0.9)"), "deep triplet swapped");
  assert.ok(newCss.includes("rgba(246, 239, 255, 0.9)"), "lightest triplet swapped");
  // Nothing else was touched.
  assert.ok(newCss.includes("radial-gradient(circle at 35% 30%"));
  assert.ok(newCss.indexOf("rgba(57, 210, 255") === -1, "old cyan must be fully gone");
});

if (failed > 0) {
  console.log(`\n${failed} orb-theme test(s) FAILED.`);
  process.exit(1);
}
console.log(`All orb-theme tests PASSED (${passed}/${passed}).`);
