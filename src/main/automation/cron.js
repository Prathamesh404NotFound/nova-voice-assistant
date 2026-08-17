// Nova — automation/cron.js (Stage 9)
//
// Lightweight 5-field cron expression evaluator, resolved in the local
// timezone via Intl (no external tz dependency).
//
// Fields: minute hour day-of-month month day-of-week
// Supports `*`, comma-separated lists, ranges (e.g. 9-17), and step
// notation `*/15` (minute lists). Day-of-month and day-of-week are
// intersected only when BOTH are restricted (standard cron behaviour).

function parseField(raw, min, max) {
  const values = new Set();
  const parts = String(raw).split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`empty field part: "${raw}"`);
    const stepMatch = trimmed.match(/^(.+)?\/(\d+)$/);
    let base = trimmed;
    let step = null;
    if (stepMatch) {
      base = stepMatch[1] || "*";
      step = parseInt(stepMatch[2], 10);
      if (!step || step < 1) throw new Error(`bad step in "${raw}"`);
    }
    if (base === "*") {
      for (let v = min; v <= max; v++) values.add(v);
    } else if (/^\d+-\d+$/.test(base)) {
      const [a, b] = base.split("-").map((n) => parseInt(n, 10));
      if (a < min || b > max || a > b) throw new Error(`range out of bounds in "${raw}"`);
      for (let v = a; v <= b; v++) values.add(v);
    } else if (/^\d+$/.test(base)) {
      const v = parseInt(base, 10);
      if (v < min || v > max) throw new Error(`value out of bounds in "${raw}"`);
      values.add(v);
    } else {
      throw new Error(`unparseable cron field: "${raw}"`);
    }
    if (step !== null) {
      const stepped = new Set();
      const sorted = [...values].sort((x, y) => x - y);
      for (let i = 0; i < sorted.length; i += step) stepped.add(sorted[i]);
      values.clear();
      for (const v of stepped) values.add(v);
    }
  }
  return values;
}

/**
 * Parse a 5-field cron expression into a matcher.
 * @param {string} expr e.g. "0 9 * * *" or "0 8 * * 1-5"
 * @returns {{ test: (date) => boolean, expr: string }}
 */
function parse(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression needs 5 fields (got "${expr || ""}")`);
  }
  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const doms = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const dows = parseField(parts[4], 0, 6);
  const domRestricted = !coversAll(parts[2], 1, 31);
  const dowRestricted = !coversAll(parts[4], 0, 6);

  function test(date) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return false;
    if (!minutes.has(d.getMinutes())) return false;
    if (!hours.has(d.getHours())) return false;
    if (!doms.has(d.getDate())) return false;
    if (!months.has(d.getMonth() + 1)) return false;
    const dow = d.getDay(); // 0 = Sunday, matches cron convention
    if (domRestricted && dowRestricted) {
      // Both restricted: union semantics (standard cron)
      if (!doms.has(d.getDate()) && !dows.has(dow)) return false;
    } else {
      if (domRestricted && !doms.has(d.getDate())) return false;
      if (dowRestricted && !dows.has(dow)) return false;
    }
    return true;
  }
  return { test, expr: String(expr).trim() };
}

function coversAll(field, min, max) {
  const p = String(field).trim();
  return p === "*" || new RegExp(`^\\d+-${max}$`).test(p) || p === "1-31" || p === "0-6";
}

/**
 * Find the next Date >= `after` matching the expression, searching forward
 * minute by minute (bounded). Returns null if nothing matches within 366 days.
 */
function nextMatch(matcher, after, maxSearchDays = 366) {
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1); // next distinct minute
  const limit = after.getTime() + maxSearchDays * 86_400_000;
  while (cursor.getTime() <= limit) {
    if (matcher.test(cursor)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

module.exports = { parse, nextMatch };
