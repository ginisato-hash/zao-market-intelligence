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
