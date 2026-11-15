// Network-difficulty history: one D1 row per hourly cron tick, and the maths
// the dashboard shows on top of it (daily medians, measured monthly growth).
//
// Shared by:
//   - worker/price-cron.js            appendDifficulty() on every hourly tick
//   - functions/api/difficulty-history.js   readDailyMedians() + historyPayload()
//
// Schema (created on first write, idempotent — see AUTOMATION.md):
//   CREATE TABLE IF NOT EXISTS prl_difficulty (ts INTEGER NOT NULL, difficulty REAL NOT NULL, source TEXT);
//   CREATE INDEX IF NOT EXISTS idx_prl_difficulty_ts ON prl_difficulty (ts);

export const DAY_MS = 864e5;
export const MONTH_DAYS = 30.44;          // same month length the dashboard's ROI uses
export const MIN_GROWTH_DAYS = 7;         // fewer distinct days than this -> no growth figure
export const RANGES = { "30d": 30, "90d": 90, all: null };

export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS prl_difficulty (ts INTEGER NOT NULL, difficulty REAL NOT NULL, source TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_prl_difficulty_ts ON prl_difficulty (ts)",
];

const errText = (e) => String((e && e.message) || e);
export const isMissingTable = (e) => /no such table/i.test(errText(e));

export async function ensureDifficultyTable(db) {
  for (const sql of SCHEMA) await db.prepare(sql).run();
}

// Append one reading. The table is created the first time an insert finds it
// missing, so a fresh D1 database needs no manual setup. Never throws for a
// missing binding or a bad reading; other D1 errors propagate to the caller.
export async function appendDifficulty(db, { ts, difficulty, source } = {}) {
  if (!db) return { stored: false, reason: "no PRICE_DB binding" };
  if (!(Number.isFinite(ts) && ts > 0 && Number.isFinite(difficulty) && difficulty > 0)) {
    return { stored: false, reason: "invalid reading" };
  }
  const insert = () =>
    db
      .prepare("INSERT INTO prl_difficulty (ts, difficulty, source) VALUES (?1, ?2, ?3)")
      .bind(Math.round(ts), difficulty, source ? String(source).slice(0, 64) : null)
      .run();
  try {
    await insert();
    return { stored: true };
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    await ensureDifficultyTable(db);
    await insert();
    return { stored: true, created: true };
  }
}

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Daily medians straight from D1: SQLite groups the hourly rows per UTC day,
// so the Function only ever handles one row per day, however long the history.
// A missing table reads as "no history yet".
export async function readDailyMedians(db, { since = 0 } = {}) {
  try {
    const { results } = await db
      .prepare(
        `SELECT ts / 86400000 AS day, GROUP_CONCAT(difficulty) AS ds, COUNT(*) AS n
           FROM prl_difficulty
          WHERE ts >= ?1
          GROUP BY day
          ORDER BY day ASC`
      )
      .bind(Math.max(0, Math.floor(since)))
      .all();
    const meta = await db.prepare("SELECT MIN(ts) AS first, COUNT(*) AS n FROM prl_difficulty").first();
    const days = (results || [])
      .map((r) => ({ t: Number(r.day) * DAY_MS, d: median(String(r.ds).split(",").map(Number)), n: Number(r.n) }))
      .filter((p) => Number.isFinite(p.t) && p.d > 0);
    return { days, first: meta && meta.first != null ? Number(meta.first) : null, count: meta ? Number(meta.n) || 0 : 0 };
  } catch (e) {
    if (isMissingTable(e)) return { days: [], first: null, count: 0, missing: true };
    throw e;
  }
}

// Log-linear least squares on daily medians: ln d = a + b·day, so the
// difficulty grows by a constant factor per day; monthly growth = e^(30.44·b) − 1.
// windowDays keeps only the last N calendar days of data. Returns null with
// fewer than MIN_GROWTH_DAYS distinct days.
export function fitGrowth(days, { windowDays = null, minDays = MIN_GROWTH_DAYS } = {}) {
  let pts = (days || []).filter((p) => Number.isFinite(p.t) && p.d > 0).sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  const lastT = pts[pts.length - 1].t;
  if (windowDays) pts = pts.filter((p) => p.t > lastT - windowDays * DAY_MS);
  if (pts.length < Math.max(2, minDays)) return null;
  const t0 = pts[0].t;
  const xs = pts.map((p) => (p.t - t0) / DAY_MS), ys = pts.map((p) => Math.log(p.d));
  const n = pts.length, mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx, a = my - b * mx;
  const span = Math.round((lastT - t0) / DAY_MS) + 1;
  return {
    monthly: Math.expm1(b * MONTH_DAYS),
    daily: Math.expm1(b),
    days: span,
    n,
    r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 1,
    // fitted trend at both ends, for drawing the line
    fromT: t0, toT: lastT, fromD: Math.exp(a), toD: Math.exp(a + b * xs[n - 1]),
  };
}

// The /api/difficulty-history response for a range ("30d" | "90d" | "all").
export function historyPayload({ days, first, count }, range) {
  const span = Object.prototype.hasOwnProperty.call(RANGES, range) ? RANGES[range] : RANGES["90d"];
  return {
    range,
    first: first == null ? null : first,     // oldest reading in the table ("collecting since")
    count: count || 0,                        // readings in the table
    points: (days || []).map((p) => ({ t: p.t, d: p.d, n: p.n })),
    growth: fitGrowth(days, { windowDays: span }),
  };
}
