/**
 * Round 11: orb theme picker.
 *
 * Four color themes, each a full re-skin of the Nova accent family:
 *   cyan (default, cool) / purple (royal) / green (matrix) / amber (warm).
 *
 * The bulk of the HUD is already token-based (`var(--cyan)`,
 * `var(--cyan-dim)`, `var(--cyan-glow)`, `var(--line)` / `--line-strong`),
 * so switching is a single CSS-variable repaint. The remaining hardcoded
 * rgba() literals (orb gradient, talk-button glows, hover states) are
 * rewritten in live stylesheets when switching FROM a theme, so the whole
 * page re-skins instantly without a reload.
 *
 * Persistence: localStorage key `nova-theme` (renderer-only, no IPC,
 * decoration only — no personal data, unaffected by Private Mode).
 */
(function () {
  "use strict";

  function fromHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbaCSS(hex, a) {
    const [r, g, b] = fromHex(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  // Each theme defines the accent family + derived hues used in the HUD.
  const THEMES = {
    cyan: {
      label: "Nova Cyan",
      base: "#39d2ff",
      light: "#7be4ff",   // orb highlight / active talk button
      deep: "#0d6e8a",    // orb depth shadow
      lightest: "#eaffff", // orb inner highlight
      darkText: "#0a1520", // active talk button text
    },
    purple: {
      label: "Orchid Purple",
      base: "#b48cff",
      light: "#d5b8ff",
      deep: "#5a3d8a",
      lightest: "#f6efff",
      darkText: "#151020",
    },
    green: {
      label: "Matrix Green",
      base: "#39ffa1",
      light: "#8affc8",
      deep: "#0d8a4e",
      lightest: "#eafff4",
      darkText: "#0a2015",
    },
    amber: {
      label: "Ember Amber",
      base: "#ffb347",
      light: "#ffd28f",
      deep: "#8a5d0d",
      lightest: "#fff4e6",
      darkText: "#20170a",
    },
  };

  // Theme token map — the var() family the HUD uses.
  function tokensFor(theme) {
    const t = THEMES[theme];
    return {
      "--cyan": t.base,
      "--cyan-dim": rgbaCSS(t.base, 0.55),
      "--cyan-glow": rgbaCSS(t.base, 0.35),
      "--line": rgbaCSS(t.base, 0.10),
      "--line-strong": rgbaCSS(t.base, 0.28),
    };
  }

  const THEME_STORAGE_KEY = "nova-theme";
  const DEFAULT_THEME = "cyan";

  function currentTheme() {
    try {
      const raw = localStorage.getItem(THEME_STORAGE_KEY);
      return raw && THEMES[raw] ? raw : DEFAULT_THEME;
    } catch { return DEFAULT_THEME; }
  }

  /** Apply `themeId` immediately: tokens + hardcoded rgba accents. */
  function applyTheme(themeId) {
    if (!THEMES[themeId]) themeId = DEFAULT_THEME;
    const prev = currentTheme();
    if (prev === themeId) return themeId;

    const t = THEMES[themeId];
    const prevT = THEMES[prev];
    const root = document.documentElement;
    Object.entries(tokensFor(themeId)).forEach(([k, v]) => root.style.setProperty(k, v));

    // Rewrite hardcoded rgba() literals that do not use tokens (orb gradient,
    // talk button glows, hover states, rings). Only the previous theme's RGB
    // values are replaced, so user CSS edits / unknown sheets are untouched.
    const [pr, pg, pb] = fromHex(prevT.base);
    const prevRGB = `${pr}, ${pg}, ${pb}`;
    const [nr, ng, nb] = fromHex(t.base);
    const newRGB = `${nr}, ${ng}, ${nb}`;
    const [lr, lg, lb] = fromHex(prevT.light);
    const prevLightRGB = `${lr}, ${lg}, ${lb}`;
    const [n2r, n2g, n2b] = fromHex(t.light);
    const newLightRGB = `${n2r}, ${n2g}, ${n2b}`;
    const [dr, dg, db] = fromHex(prevT.deep);
    const prevDeepRGB = `${dr}, ${dg}, ${db}`;
    const [n3r, n3g, n3b] = fromHex(t.deep);
    const newDeepRGB = `${n3r}, ${n3g}, ${n3b}`;
    const [l1r, l1g, l1b] = fromHex(prevT.lightest);
    const prevLightestRGB = `${l1r}, ${l1g}, ${l1b}`;
    const [n4r, n4g, n4b] = fromHex(t.lightest);
    const newLightestRGB = `${n4r}, ${n4g}, ${n4b}`;
    const prevDarkHex = prevT.darkText;

    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule.type !== CSSRule.STYLE_RULE) continue;
        const css = rule.cssText;
        if (css.indexOf(prevRGB) === -1 && css.indexOf(prevLightRGB) === -1 &&
            css.indexOf(prevDeepRGB) === -1 && css.indexOf(prevLightestRGB) === -1 &&
            css.indexOf(prevDarkHex) === -1) continue;
        let newCss = css;
        for (const [prevVal, newVal] of [
          [prevRGB, newRGB],
          [prevLightRGB, newLightRGB],
          [prevDeepRGB, newDeepRGB],
          [prevLightestRGB, newLightestRGB],
        ]) {
          // cssText stores rgba() values like "rgba(57, 210, 255, 0.35)". The
          // regex matches the literal `rgba(` followed by the old 3-channel
          // triplet, then replaces the whole triplet with the new one — the
          // trailing `, <alpha>` stays untouched.
          newCss = newCss.replace(
            new RegExp(`rgba\\(\\s*${prevVal.replace(/,\s/g, "\\s*,\\s*")}\\s*,`, "g"),
            `rgba(${newVal},`,
          );
        }
        newCss = newCss.split(prevDarkHex).join(t.darkText);
        try {
          const idx = Array.from(rules).indexOf(rule);
          sheet.deleteRule(idx);
          sheet.insertRule(newCss, idx);
        } catch { /* cross-origin sheet — skip */ }
      }
    }

    try { localStorage.setItem(THEME_STORAGE_KEY, themeId); } catch { /* quota / privacy mode */ }
    document.dispatchEvent(new CustomEvent("nova:theme-changed", { detail: { theme: themeId } }));
    return themeId;
  }

  // Boot: apply the stored theme as early as possible.
  applyTheme(currentTheme());

  if (typeof window !== "undefined") {
    window.NovaThemes = { applyTheme, currentTheme, THEMES, fromHex, THEME_STORAGE_KEY, DEFAULT_THEME };
  }
})();
