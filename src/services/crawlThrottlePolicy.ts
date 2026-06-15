// Phase AUTO-RUNNER16X - polite crawl throttling policy (pure, deterministic).
//
// Because tripling per-run volume increases the live request footprint, the two
// live crawl loops (Booking preview, Jalan refresh) sleep with jitter between
// requests, back off on rate-limit/block signals, and stop a source early after
// repeated blocks. This module is pure and deterministic (randomness/attempt are
// injected); only sleep() performs a side effect. It never bypasses CAPTCHA,
// logs in, injects cookies, or ignores a block — detection only ever delays or
// stops, it never circumvents.

export const DELAY_MIN_MS = 1_500;
export const DELAY_MAX_MS = 3_500;
export const MAX_CONCURRENCY_PER_SOURCE = 1; // strictly sequential per source
export const CONSECUTIVE_BLOCK_EARLY_STOP = 3;
export const BACKOFF_BASE_MS = 4_000;
export const BACKOFF_MAX_MS = 60_000;

export type BlockReason = "rate_limited_429" | "forbidden_403" | "captcha_or_login_wall" | null;

// Uniform polite delay between sequential requests. rand is injectable for tests.
export function jitterDelayMs(rand: () => number = Math.random): number {
  const sample = rand();
  const r = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return Math.round(DELAY_MIN_MS + r * (DELAY_MAX_MS - DELAY_MIN_MS));
}

// Exponential backoff after a block, capped. attempt is 0-based.
export function backoffDelayMs(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** safeAttempt, BACKOFF_MAX_MS);
}

// Classify a block/rate-limit signal from HTTP status and visible text/flags.
// Returns null when nothing block-like is detected.
export function classifyBlock(httpStatus: number | null, text: string): BlockReason {
  if (httpStatus === 429) return "rate_limited_429";
  if (httpStatus === 403) return "forbidden_403";
  if (/captcha|recaptcha|are you human|security check|login|sign in|robot/iu.test(text)) {
    return "captcha_or_login_wall";
  }
  return null;
}

// Stop crawling a source after this many consecutive blocks.
export function shouldEarlyStop(consecutiveBlocks: number): boolean {
  return consecutiveBlocks >= CONSECUTIVE_BLOCK_EARLY_STOP;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
