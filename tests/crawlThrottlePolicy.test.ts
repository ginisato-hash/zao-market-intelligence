import { describe, expect, it } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CONSECUTIVE_BLOCK_EARLY_STOP,
  DELAY_MAX_MS,
  DELAY_MIN_MS,
  MAX_CONCURRENCY_PER_SOURCE,
  backoffDelayMs,
  classifyBlock,
  jitterDelayMs,
  shouldEarlyStop
} from "../src/services/crawlThrottlePolicy";

describe("AUTO-RUNNER16X - jitter delay", () => {
  it("stays within [DELAY_MIN_MS, DELAY_MAX_MS] for any injected rand in [0,1]", () => {
    expect(jitterDelayMs(() => 0)).toBe(DELAY_MIN_MS);
    expect(jitterDelayMs(() => 1)).toBe(DELAY_MAX_MS);
    expect(jitterDelayMs(() => 0.5)).toBe(Math.round((DELAY_MIN_MS + DELAY_MAX_MS) / 2));
  });

  it("clamps out-of-range / non-finite rand", () => {
    expect(jitterDelayMs(() => 5)).toBe(DELAY_MAX_MS);
    expect(jitterDelayMs(() => -1)).toBe(DELAY_MIN_MS);
    expect(jitterDelayMs(() => NaN)).toBe(DELAY_MIN_MS);
  });

  it("is sequential per source by policy", () => {
    expect(MAX_CONCURRENCY_PER_SOURCE).toBe(1);
  });
});

describe("AUTO-RUNNER16X - backoff delay", () => {
  it("grows monotonically and is capped", () => {
    expect(backoffDelayMs(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(1)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(2)).toBe(BACKOFF_BASE_MS * 4);
    expect(backoffDelayMs(99)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(2)).toBeGreaterThan(backoffDelayMs(1));
  });

  it("treats invalid attempt as base", () => {
    expect(backoffDelayMs(-1)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(NaN)).toBe(BACKOFF_BASE_MS);
  });
});

describe("AUTO-RUNNER16X - block classification (detect only, never bypass)", () => {
  it("detects rate-limit / forbidden HTTP status", () => {
    expect(classifyBlock(429, "")).toBe("rate_limited_429");
    expect(classifyBlock(403, "")).toBe("forbidden_403");
  });

  it("detects captcha / login wall in visible text", () => {
    expect(classifyBlock(200, "Please complete the CAPTCHA")).toBe("captcha_or_login_wall");
    expect(classifyBlock(200, "Sign in to continue")).toBe("captcha_or_login_wall");
  });

  it("returns null for a normal page", () => {
    expect(classifyBlock(200, "空室あり 1泊2名 25000円")).toBeNull();
    expect(classifyBlock(null, "")).toBeNull();
  });
});

describe("AUTO-RUNNER16X - early stop", () => {
  it("stops after the configured consecutive blocks", () => {
    expect(shouldEarlyStop(CONSECUTIVE_BLOCK_EARLY_STOP - 1)).toBe(false);
    expect(shouldEarlyStop(CONSECUTIVE_BLOCK_EARLY_STOP)).toBe(true);
    expect(shouldEarlyStop(CONSECUTIVE_BLOCK_EARLY_STOP + 1)).toBe(true);
  });
});
