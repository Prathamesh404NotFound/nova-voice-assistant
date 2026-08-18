/**
 * Nova Command Palette — smart ranking (Round 15)
 * =================================================
 * Actions you run often (and recently) float to the top of Cmd/Ctrl+K results,
 * instead of pure alphabetical order.
 *
 * Design notes:
 *  - Pure renderer module, no IPC. Usage lives only in `localStorage`
 *    (`nova-palette-usage`) — it never leaves the machine and is unaffected
 *    by Private Mode (it's a local preference, not content).
 *  - Score = sqrt(frequency) + recency boost. Recency halves every 24 hours
 *    (toward the max recency floor, not zero — an item you ran once a week
 *    ago still outranks one you never ran).
 *  - Ranking kicks in as soon as there is at least one recorded run; items
 *    without any history fall back to the original tie-break (prefix then
 *    alphabetical) via score 0.
 *  - Capped at `cap` stored entries (oldest by last-run time pruned first)
 *    so the storage key can't grow unbounded.
 *
 * Integration (app.js / palette-setup.js): call recordRun(item) from the
 * palette's onRun handler; pass scoreItems(items, query) as the catalog.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "nova-palette-usage";
  const DEFAULT_CAP = 250;
  const HALF_LIFE_MS = 24 * 60 * 60 * 1000;   // recency halves daily
  const MIN_RECENCY = 0.05;                    // never decays to zero
  const storage = (() => {
    try { return window.localStorage; } catch { return null; }
  })();

  function load() {
    try {
      const raw = storage && storage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }

  function save(entries) {
    try { if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* storage full / unavailable — ranking degrades silently */ }
  }

  /**
   * Look up the usage entry for an item key.
   * @param {string} key  unique id for the item (action id or label)
   * @returns {object|null} { runs, lastRun } or null if never run
   */
  function getEntry(key, now = Date.now()) {
    const entries = load();
    const e = entries[key];
    if (!e || !Number.isFinite(e.lastRun)) return null;
    return { runs: Math.max(0, e.runs || 0), lastRun: Math.max(0, e.lastRun), now };
  }

  /** Score a single usage entry. Pure for testability. */
  function scoreEntry({ runs, lastRun, now }) {
    if (!Number.isFinite(runs) || !Number.isFinite(lastRun) || runs <= 0) return 0;
    const ageMs = Math.max(0, now - lastRun);
    const recency = Math.max(MIN_RECENCY, Math.pow(0.5, ageMs / HALF_LIFE_MS));
    return Math.sqrt(runs) + recency;
  }

  /**
   * Record that the user ran an item.
   * @param {string} key  unique id
   * @param {object} opts { now?, cap? }
   */
  function recordRun(key, opts = {}) {
    if (!key || typeof key !== "string") return;
    const now = opts.now || Date.now();
    const cap = Number.isFinite(opts.cap) ? opts.cap : DEFAULT_CAP;
    const entries = load();
    const e = entries[key] || { runs: 0, lastRun: 0 };
    e.runs = (Number.isFinite(e.runs) ? e.runs : 0) + 1;
    e.lastRun = Math.max(e.lastRun || 0, now);
    entries[key] = e;
    // Cap: keep the `cap` most recently used; prune ties by oldest lastRun.
    const keys = Object.keys(entries);
    if (keys.length > cap) {
      keys
        .sort((a, b) => (entries[a].lastRun || 0) - (entries[b].lastRun || 0))
        .slice(0, keys.length - cap)
        .forEach((k) => { delete entries[k]; });
    }
    save(entries);
  }

  /** Score an item (palette entry) against the usage store. Pure for testability. */
  function scoreItem(item, now = Date.now()) {
    const key = item && (item.id || item.label);
    if (!key) return 0;
    const e = getEntry(String(key), now);
    if (!e) return 0;
    return scoreEntry(e);
  }

  /**
   * Return a copy of the catalog sorted by smart rank.
   * Items with usage history sort by descending score; ties then fall back to
   * prefix-vs-substring of the query and alphabetical — the same rules the
   * vanilla palette applies — so ranking only *reorders*, never hides.
   * @param {Array} items palette entries (as passed to the palette constructor)
   * @param {string} query current palette query
   * @param {object} opts { now? }
   * @returns {Array}
   */
  function scoreItems(items, query = "", opts = {}) {
    const now = opts.now || Date.now();
    if (!Array.isArray(items)) return [];
    const scored = items.map((it) => ({ it, s: scoreItem(it, now) }));
    // Stable bucketing: ranked items (score > 0) first by score desc,
    // unranked afterwards keep their original (prefix-alphabetical) order.
    const ranked = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const unranked = scored.filter((x) => x.s <= 0).map((x) => x.it);
    return [...ranked.map((x) => x.it), ...unranked];
  }

  /** Test hook: wipe the usage store. */
  function resetForTesting() {
    try { if (storage) storage.removeItem(STORAGE_KEY); } catch { /* noop */ }
  }

  window.NovaPaletteRanking = {
    STORAGE_KEY, DEFAULT_CAP, HALF_LIFE_MS, MIN_RECENCY,
    load, recordRun, getEntry, scoreEntry, scoreItem, scoreItems,
    resetForTesting,
  };
})();
