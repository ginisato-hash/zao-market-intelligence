import { describe, expect, it } from "vitest";
import { generatePricingRecommendation } from "../src/services/generatePricingRecommendations";
import type { PricingTargetConfig } from "../src/config/pricingTargetSchema";
import type { MarketDailySignalRecord } from "../src/services/computeMarketSignals";

describe("generatePricingRecommendations", () => {
  it("prefers quality-adjusted median and applies priority multiplier and rounding", () => {
    const row = generatePricingRecommendation({
      target: target(),
      signal: signal({ qualityAdjustedMedianPriceJpy: 10000, medianPriceJpy: 9000, qualityAdjustedSampleSize: 5, confidence: "A" }),
      priority: "S",
      createdAt: "2026-05-29T00:00:00.000Z"
    });

    expect(row?.recommendedPriceJpy).toBe(12000);
    expect(row?.confidence).toBe("A");
    expect(row?.recommendationReason).toContain("quality_adjusted_market_median_used:S_priority_multiplier");
  });

  it("falls back to raw median when adjusted metric is unavailable", () => {
    const row = generatePricingRecommendation({
      target: target(),
      signal: signal({ qualityAdjustedMedianPriceJpy: null, medianPriceJpy: 10000, confidence: "B" }),
      priority: "B"
    });

    expect(row?.recommendedPriceJpy).toBe(10000);
    expect(row?.confidence).toBe("C");
    expect(row?.recommendationReason).toContain("raw_market_median_used_due_to_no_adjusted_metric");
  });

  it("falls back to baseline when market signal is insufficient", () => {
    const row = generatePricingRecommendation({
      target: target(),
      signal: signal({ qualityAdjustedMedianPriceJpy: null, medianPriceJpy: null, confidence: "insufficient" }),
      priority: "A"
    });

    expect(row?.recommendedPriceJpy).toBe(13000);
    expect(row?.confidence).toBe("fallback");
    expect(row?.recommendationReason).toContain("baseline_used_due_to_insufficient_market_signal");
  });

  it("applies min/max clamp and rounding", () => {
    const low = generatePricingRecommendation({
      target: target({ min_price_jpy: 8000 }),
      signal: signal({ qualityAdjustedMedianPriceJpy: 5000 }),
      priority: "C"
    });
    const high = generatePricingRecommendation({
      target: target({ max_price_jpy: 15000 }),
      signal: signal({ qualityAdjustedMedianPriceJpy: 20000 }),
      priority: "S"
    });

    expect(low?.recommendedPriceJpy).toBe(8000);
    expect(low?.recommendationReason).toContain("clamped_to_min_price");
    expect(high?.recommendedPriceJpy).toBe(15000);
    expect(high?.recommendationReason).toContain("clamped_to_max_price");
  });
});

function target(overrides: Partial<PricingTargetConfig> = {}): PricingTargetConfig {
  return {
    target_id: "target",
    property_name: "Target",
    postal_code: "990-2301",
    source_market: "jalan",
    baseline_adr_jpy: 12000,
    min_price_jpy: 8000,
    max_price_jpy: 35000,
    rounding_unit_jpy: 500,
    strategy: "follow_quality_adjusted_market",
    active: true,
    ...overrides
  };
}

function signal(overrides: Partial<MarketDailySignalRecord> = {}): MarketDailySignalRecord {
  return {
    id: "signal",
    stayDate: "2026-07-18",
    source: "jalan",
    postalCode: "990-2301",
    medianPriceJpy: 9000,
    minPriceJpy: 3000,
    maxPriceJpy: 26000,
    qualityAdjustedMedianPriceJpy: 10000,
    qualityAdjustedMinPriceJpy: 8000,
    qualityAdjustedMaxPriceJpy: 26000,
    qualityAdjustedSampleSize: 5,
    excludedQualityFlagCount: 1,
    excludedHighSeverityCount: 1,
    qualityAdjustmentReason: "excluded_high_severity_quality_flags",
    availableCount: 5,
    failedCount: 0,
    soldOutCount: 0,
    notListedCount: 0,
    sampleSize: 6,
    confidence: "A",
    generatedAt: "2026-05-29",
    createdAt: "2026-05-29",
    updatedAt: "2026-05-29",
    ...overrides
  };
}
