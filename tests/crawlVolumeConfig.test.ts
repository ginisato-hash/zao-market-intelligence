import { describe, expect, it } from "vitest";
import {
  BASE_DATES_PER_PROPERTY,
  DEFAULT_NEAR_TERM_DENSE_DAYS,
  MAX_MULTIPLIER,
  MAX_NEAR_TERM_DENSE_DAYS,
  MIN_MULTIPLIER,
  MIN_NEAR_TERM_DENSE_DAYS,
  datesPerProperty,
  expandedSaturdayCount,
  isValidYmd,
  resolveCrawlVolumeMultiplier,
  resolveForcedCheckinDates,
  resolveNearTermDenseDays,
  scaleCap
} from "../src/services/crawlVolumeConfig";

describe("AUTO-RUNNER16X - crawl volume multiplier resolution", () => {
  it("defaults to 1 when unset", () => {
    expect(resolveCrawlVolumeMultiplier({})).toBe(1);
  });

  it("reads a valid configured value", () => {
    expect(resolveCrawlVolumeMultiplier({ ZMI_CRAWL_VOLUME_MULTIPLIER: "3" })).toBe(3);
  });

  it("clamps below the minimum to 1", () => {
    expect(resolveCrawlVolumeMultiplier({ ZMI_CRAWL_VOLUME_MULTIPLIER: "0" })).toBe(MIN_MULTIPLIER);
    expect(resolveCrawlVolumeMultiplier({ ZMI_CRAWL_VOLUME_MULTIPLIER: "-4" })).toBe(MIN_MULTIPLIER);
  });

  it("clamps above the maximum to MAX_MULTIPLIER", () => {
    expect(resolveCrawlVolumeMultiplier({ ZMI_CRAWL_VOLUME_MULTIPLIER: "99" })).toBe(MAX_MULTIPLIER);
  });

  it("falls back to 1 for non-numeric / floors fractional input", () => {
    expect(resolveCrawlVolumeMultiplier({ ZMI_CRAWL_VOLUME_MULTIPLIER: "abc" })).toBe(1);
    expect(resolveCrawlVolumeMultiplier({ ZMI_CRAWL_VOLUME_MULTIPLIER: "3.9" })).toBe(3);
  });
});

describe("AUTO-RUNNER16X - volume scaling helpers", () => {
  it("baseline (m=1) preserves original 3 dates per property", () => {
    expect(BASE_DATES_PER_PROPERTY).toBe(3);
    expect(datesPerProperty(1)).toBe(3);
    expect(expandedSaturdayCount(1)).toBe(2); // 2 Saturdays + 1 peak = 3
  });

  it("tripling expands dates per property to 9 (8 Saturdays + peak)", () => {
    expect(datesPerProperty(3)).toBe(9);
    expect(expandedSaturdayCount(3)).toBe(8);
  });

  it("scaleCap multiplies a base cap and preserves baseline at m=1", () => {
    expect(scaleCap(9, 1)).toBe(9);
    expect(scaleCap(15, 1)).toBe(15);
    expect(scaleCap(9, 3)).toBe(27);
    expect(scaleCap(15, 3)).toBe(45);
    expect(scaleCap(30, 3)).toBe(90);
  });
});

describe("AUTO-RUNNER17X - near-term dense days resolution", () => {
  it("defaults to 30 when unset or invalid", () => {
    expect(resolveNearTermDenseDays({})).toBe(DEFAULT_NEAR_TERM_DENSE_DAYS);
    expect(resolveNearTermDenseDays({ ZMI_NEAR_TERM_DENSE_DAYS: "abc" })).toBe(30);
    expect(resolveNearTermDenseDays({ ZMI_NEAR_TERM_DENSE_DAYS: "0" })).toBe(30);
  });

  it("reads and clamps to [7, 60]", () => {
    expect(resolveNearTermDenseDays({ ZMI_NEAR_TERM_DENSE_DAYS: "14" })).toBe(14);
    expect(resolveNearTermDenseDays({ ZMI_NEAR_TERM_DENSE_DAYS: "3" })).toBe(MIN_NEAR_TERM_DENSE_DAYS);
    expect(resolveNearTermDenseDays({ ZMI_NEAR_TERM_DENSE_DAYS: "999" })).toBe(MAX_NEAR_TERM_DENSE_DAYS);
  });
});

describe("AUTO-RUNNER17X - forced checkin dates (§8.2)", () => {
  it("is a no-op when unset", () => {
    expect(resolveForcedCheckinDates({})).toEqual({ valid: [], invalid: [] });
  });

  it("accepts valid dates, dedupes, rejects bad format, and sorts", () => {
    const r = resolveForcedCheckinDates({ ZMI_FORCE_CHECKIN_DATES: "2026-06-25,2026-06-25,bad-date,2026-06-28" });
    expect(r.valid).toEqual(["2026-06-25", "2026-06-28"]);
    expect(r.invalid).toEqual(["bad-date"]);
  });

  it("rejects impossible calendar dates via isValidYmd", () => {
    expect(isValidYmd("2026-06-25")).toBe(true);
    expect(isValidYmd("2026-02-30")).toBe(false);
    expect(isValidYmd("2026-6-25")).toBe(false);
    expect(isValidYmd("bad-date")).toBe(false);
    const r = resolveForcedCheckinDates({ ZMI_FORCE_CHECKIN_DATES: "2026-02-30,2026-06-25" });
    expect(r.valid).toEqual(["2026-06-25"]);
    expect(r.invalid).toEqual(["2026-02-30"]);
  });
});
