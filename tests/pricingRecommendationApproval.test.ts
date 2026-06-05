import { describe, expect, it } from "vitest";
import { auditPricingRecommendationRow } from "../src/services/auditPricingRecommendations";
import { classifyPricingRecommendationApproval } from "../src/services/pricingRecommendationApproval";
import type { PricingRecommendationRecord } from "../src/services/generatePricingRecommendations";

describe("pricingRecommendationApproval", () => {
  it("auto-approves clean A and B recommendations", () => {
    expect(classify(rec({ confidence: "A" })).approvalStatus).toBe("auto_approved");
    expect(classify(rec({ confidence: "B" })).approvalStatus).toBe("auto_approved");
  });

  it("sends C confidence and fallback recommendations to review", () => {
    expect(classify(rec({ confidence: "C" })).reasons).toContain("low_confidence_requires_review");
    expect(classify(rec({ confidence: "fallback" })).reasons).toContain("fallback_requires_review");
  });

  it("sends clamped, large-gap, adjusted-missing, and raw fallback quality-excluded recommendations to review", () => {
    expect(classify(rec({ recommendationReason: "quality_adjusted_market_median_used:S_priority_multiplier;clamped_to_min_price" })).reasons).toContain("clamped_requires_review");
    expect(classify(rec({ recommendedPriceJpy: 20000, qualityAdjustedMarketMedianJpy: 10000 })).reasons).toContain("large_gap_requires_review");
    expect(classify(rec({ qualityAdjustedMarketMedianJpy: null })).reasons).toContain("adjusted_median_unavailable_requires_review");
    expect(classify(rec({ qualityAdjustedMarketMedianJpy: null })).reasons).toContain("raw_fallback_quality_excluded_requires_review");
  });

  it("rejects structurally invalid recommendations", () => {
    const nullPrice = rec({ recommendedPriceJpy: null as unknown as number });
    const badBounds = rec({ minPriceJpy: 20000, maxPriceJpy: 10000 });

    expect(classify(nullPrice).approvalStatus).toBe("rejected");
    expect(classify(badBounds).reasons).toContain("invalid_recommendation_rejected");
  });
});

function classify(record: PricingRecommendationRecord) {
  return classifyPricingRecommendationApproval({
    recommendation: record,
    audit: auditPricingRecommendationRow(record),
    createdAt: "2026-05-29T00:00:00.000Z"
  });
}

function rec(overrides: Partial<PricingRecommendationRecord> = {}): PricingRecommendationRecord {
  return {
    id: "rec",
    targetId: "target",
    stayDate: "2026-07-18",
    sourceMarket: "jalan",
    targetPriority: "S",
    rawMarketMedianJpy: 10000,
    qualityAdjustedMarketMedianJpy: 10000,
    baselineAdrJpy: 12000,
    recommendedPriceJpy: 11000,
    minPriceJpy: 8000,
    maxPriceJpy: 35000,
    confidence: "A",
    recommendationReason: "quality_adjusted_market_median_used:S_priority_multiplier",
    marketSignalId: "signal",
    createdAt: "2026-05-29",
    updatedAt: "2026-05-29",
    ...overrides
  };
}
