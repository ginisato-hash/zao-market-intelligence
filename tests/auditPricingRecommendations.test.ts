import { describe, it, expect } from "vitest";
import {
  auditPricingRecommendationRow,
  auditPricingRecommendations
} from "../src/services/auditPricingRecommendations";
import type { PricingRecommendationRecord } from "../src/services/generatePricingRecommendations";

function makeRec(overrides: Partial<PricingRecommendationRecord> = {}): PricingRecommendationRecord {
  return {
    id: "pricing_rec_x",
    targetId: "sample_target",
    stayDate: "2026-08-08",
    sourceMarket: "jalan",
    targetPriority: "S",
    rawMarketMedianJpy: 15000,
    qualityAdjustedMarketMedianJpy: 15000,
    baselineAdrJpy: 12000,
    recommendedPriceJpy: 15000,
    minPriceJpy: 8000,
    maxPriceJpy: 35000,
    confidence: "B",
    recommendationReason: "quality_adjusted_market_median_used:S_priority_multiplier",
    marketSignalId: "market_signal_1",
    createdAt: "2026-05-29T10:00:00.000Z",
    updatedAt: "2026-05-29T10:00:00.000Z",
    ...overrides
  };
}

describe("auditPricingRecommendationRow", () => {
  it("flags fallback_recommendation when confidence is fallback", () => {
    const row = auditPricingRecommendationRow(makeRec({ confidence: "fallback" }));
    expect(row.flags).toContain("fallback_recommendation");
  });

  it("flags low_confidence_recommendation when confidence is C", () => {
    const row = auditPricingRecommendationRow(makeRec({ confidence: "C" }));
    expect(row.flags).toContain("low_confidence_recommendation");
  });

  it("flags raw_fallback_quality_excluded and adjusted_median_unavailable when adjusted median is null but raw and signal exist", () => {
    const row = auditPricingRecommendationRow(
      makeRec({
        rawMarketMedianJpy: 4000,
        qualityAdjustedMarketMedianJpy: null,
        marketSignalId: "market_signal_1",
        recommendedPriceJpy: 4000
      })
    );
    expect(row.flags).toContain("raw_fallback_quality_excluded");
    expect(row.flags).toContain("adjusted_median_unavailable");
    expect(row.chosenMarketMedianKind).toBe("raw");
  });

  it("flags clamped_recommendation when reason contains clamped_to_min_price", () => {
    const row = auditPricingRecommendationRow(
      makeRec({
        recommendationReason:
          "raw_market_median_used_due_to_no_adjusted_metric:S_priority_multiplier;clamped_to_min_price"
      })
    );
    expect(row.flags).toContain("clamped_recommendation");
  });

  it("flags clamped_recommendation when reason contains clamped_to_max_price", () => {
    const row = auditPricingRecommendationRow(
      makeRec({
        recommendationReason: "quality_adjusted_market_median_used:S_priority_multiplier;clamped_to_max_price"
      })
    );
    expect(row.flags).toContain("clamped_recommendation");
  });

  it("flags large_gap_from_market_median when gap exceeds 25%", () => {
    const row = auditPricingRecommendationRow(
      makeRec({ qualityAdjustedMarketMedianJpy: 10000, rawMarketMedianJpy: 10000, recommendedPriceJpy: 13000 })
    );
    expect(row.flags).toContain("large_gap_from_market_median");
    expect(row.gapFromChosenMarketMedianPct).toBe(30);
  });

  it("does NOT flag large_gap_from_market_median at exactly 25%", () => {
    const row = auditPricingRecommendationRow(
      makeRec({ qualityAdjustedMarketMedianJpy: 10000, rawMarketMedianJpy: 10000, recommendedPriceJpy: 12500 })
    );
    expect(row.flags).not.toContain("large_gap_from_market_median");
    expect(row.gapFromChosenMarketMedianPct).toBe(25);
  });

  it("flags no_market_signal when marketSignalId is null", () => {
    const row = auditPricingRecommendationRow(
      makeRec({ marketSignalId: null, rawMarketMedianJpy: null, qualityAdjustedMarketMedianJpy: null, confidence: "A" })
    );
    expect(row.flags).toContain("no_market_signal");
    expect(row.chosenMarketMedianKind).toBe("none");
    expect(row.gapFromChosenMarketMedianPct).toBeNull();
  });

  it("produces no flags for a clean, high-confidence, on-market recommendation", () => {
    const row = auditPricingRecommendationRow(
      makeRec({ confidence: "A", qualityAdjustedMarketMedianJpy: 15000, recommendedPriceJpy: 15000 })
    );
    expect(row.flags).toHaveLength(0);
  });

  it("prefers adjusted median over raw when choosing the comparison median", () => {
    const row = auditPricingRecommendationRow(
      makeRec({ qualityAdjustedMarketMedianJpy: 20000, rawMarketMedianJpy: 10000, recommendedPriceJpy: 20000 })
    );
    expect(row.chosenMarketMedianKind).toBe("adjusted");
    expect(row.chosenMarketMedianJpy).toBe(20000);
    expect(row.gapFromChosenMarketMedianPct).toBe(0);
  });

  it("does not compute a gap when chosen median is zero or negative", () => {
    const row = auditPricingRecommendationRow(
      makeRec({ qualityAdjustedMarketMedianJpy: 0, rawMarketMedianJpy: null, recommendedPriceJpy: 12000 })
    );
    expect(row.gapFromChosenMarketMedianPct).toBeNull();
    expect(row.flags).not.toContain("large_gap_from_market_median");
  });
});

describe("auditPricingRecommendations", () => {
  it("aggregates counts and returns only flagged rows", () => {
    const summary = auditPricingRecommendations([
      makeRec({ id: "clean", confidence: "A", recommendedPriceJpy: 15000 }),
      makeRec({ id: "lowconf", confidence: "C", recommendedPriceJpy: 15000 }),
      makeRec({ id: "fb", confidence: "fallback", marketSignalId: null, rawMarketMedianJpy: null, qualityAdjustedMarketMedianJpy: null })
    ]);

    expect(summary.totalRecommendations).toBe(3);
    expect(summary.countsByConfidence).toEqual({ A: 1, C: 1, fallback: 1 });
    expect(summary.countsByFlag["low_confidence_recommendation"]).toBe(1);
    expect(summary.countsByFlag["fallback_recommendation"]).toBe(1);
    expect(summary.countsByFlag["no_market_signal"]).toBe(1);
    expect(summary.flaggedRows).toHaveLength(2);
    expect(summary.flaggedRows.map((row) => row.id).sort()).toEqual(["fb", "lowconf"]);
  });

  it("respects a custom large gap threshold", () => {
    const rec = makeRec({ qualityAdjustedMarketMedianJpy: 10000, rawMarketMedianJpy: 10000, recommendedPriceJpy: 11000 });
    expect(auditPricingRecommendations([rec]).countsByFlag["large_gap_from_market_median"]).toBeUndefined();
    expect(
      auditPricingRecommendations([rec], { largeGapThreshold: 0.05 }).countsByFlag["large_gap_from_market_median"]
    ).toBe(1);
  });
});
