// Phase AUTO-RUNNER16X - per-run crawl volume multiplier (pure config helpers).
//
// Keeps the scheduled cadence unchanged but scales the observation volume of a
// single run. No I/O, no browser, no DB, no network. The multiplier expands the
// number of checkin dates per verified property (near-term-dense Saturdays plus
// the peak date) and the per-source page caps proportionally. The verified
// property set is never changed and disabled sources stay disabled.

export const MIN_MULTIPLIER = 1;
export const MAX_MULTIPLIER = 5;

// Base dates collected per property today: two upcoming Saturdays + one peak
// date = 3 (mirrors selectPreviewDates / selectMarketRefreshDates).
export const BASE_DATES_PER_PROPERTY = 3;

// Read and clamp the multiplier. Never throws: an invalid/out-of-range value
// falls back to a safe, bounded number so a scheduled run cannot crash here.
export function resolveCrawlVolumeMultiplier(env: Record<string, string | undefined>): number {
  const raw = Number(env.ZMI_CRAWL_VOLUME_MULTIPLIER ?? "");
  if (!Number.isFinite(raw)) return MIN_MULTIPLIER;
  return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, Math.floor(raw)));
}

// Checkin dates per property at a given multiplier (3 -> 9 at multiplier 3).
export function datesPerProperty(multiplier: number): number {
  return BASE_DATES_PER_PROPERTY * clampMultiplier(multiplier);
}

// Saturdays to request so that `nextSaturdays(count) + peakDate` yields exactly
// datesPerProperty(m) checkin dates (near-term first). 2 Saturdays + peak at m=1.
export function expandedSaturdayCount(multiplier: number): number {
  return datesPerProperty(multiplier) - 1;
}

// Scale a base per-source/per-run page cap by the multiplier.
export function scaleCap(baseCap: number, multiplier: number): number {
  return baseCap * clampMultiplier(multiplier);
}

function clampMultiplier(multiplier: number): number {
  if (!Number.isFinite(multiplier)) return MIN_MULTIPLIER;
  return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, Math.floor(multiplier)));
}

// ---------------------------------------------------------------------------
// Phase AUTO-RUNNER17X — near-term dense coverage + forced spot-check dates.

// Days from the run date that are collected EVERY day (not just weekends/peaks),
// so recent ordinary weekdays (e.g. 6/25) are never missed.
export const DEFAULT_NEAR_TERM_DENSE_DAYS = 30;
export const MIN_NEAR_TERM_DENSE_DAYS = 7;
export const MAX_NEAR_TERM_DENSE_DAYS = 60;

// Read and clamp ZMI_NEAR_TERM_DENSE_DAYS. Never throws: invalid -> default.
export function resolveNearTermDenseDays(env: Record<string, string | undefined>): number {
  const raw = Number(env.ZMI_NEAR_TERM_DENSE_DAYS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_NEAR_TERM_DENSE_DAYS;
  return Math.max(MIN_NEAR_TERM_DENSE_DAYS, Math.min(MAX_NEAR_TERM_DENSE_DAYS, Math.floor(raw)));
}

// True only for a real calendar date in strict YYYY-MM-DD form (rejects e.g.
// 2026-02-30, bad-date, 2026-6-25).
export function isValidYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

// Parse ZMI_FORCE_CHECKIN_DATES (comma-separated). Valid dates are deduped and
// sorted; anything not a real YYYY-MM-DD date is reported as invalid (and the
// caller surfaces it as a warning). Empty input -> empty lists (no-op).
export function resolveForcedCheckinDates(env: Record<string, string | undefined>): { valid: string[]; invalid: string[] } {
  const raw = (env.ZMI_FORCE_CHECKIN_DATES ?? "").trim();
  if (raw === "") return { valid: [], invalid: [] };
  const validSet = new Set<string>();
  const invalid: string[] = [];
  for (const token of raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0)) {
    if (isValidYmd(token)) validSet.add(token);
    else if (!invalid.includes(token)) invalid.push(token);
  }
  return { valid: [...validSet].sort(), invalid };
}
