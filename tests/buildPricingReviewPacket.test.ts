import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertPricingRecommendationApproval } from "../src/db/repositories/pricingRecommendationApprovalsRepository";
import { upsertPricingRecommendation } from "../src/db/repositories/pricingRecommendationsRepository";
import { buildPricingReviewPacket } from "../src/services/buildPricingReviewPacket";
import type { PricingRecommendationRecord } from "../src/services/generatePricingRecommendations";

describe("buildPricingReviewPacket", () => {
  it("assembles recommendation, audit, approval, market, and target date data", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    seedTargetDate(db);
    seedMarketSignal(db);
    const recommendation = recommendationRow();
    upsertPricingRecommendation(db, recommendation);
    upsertPricingRecommendationApproval(db, {
      id: "approval",
      recommendationId: recommendation.id,
      targetId: recommendation.targetId,
      stayDate: recommendation.stayDate,
      sourceMarket: recommendation.sourceMarket,
      approvalStatus: "needs_review",
      reasons: ["low_confidence_requires_review"],
      auditFlags: ["low_confidence_recommendation"],
      createdAt: "2026-05-29",
      updatedAt: "2026-05-29"
    });

    const packet = buildPricingReviewPacket(db, { generatedAt: "2026-05-29T00:00:00.000Z" });

    expect(packet.recommendationCount).toBe(1);
    expect(packet.countByApprovalStatus.needs_review).toBe(1);
    expect(packet.rows[0]).toMatchObject({
      targetId: "target",
      stayDate: "2026-07-18",
      priority: "S",
      approvalStatus: "needs_review",
      recommendedPriceJpy: 12000,
      reviewDecision: "pending",
      reviewerNote: ""
    });
    expect(packet.rows[0]?.auditFlags).toContain("low_confidence_recommendation");
    expect(packet.rows[0]?.approvalReasons).toContain("low_confidence_requires_review");
    db.close();
  });
});

export function seedTargetDate(db: LocalDatabase): void {
  db.prepare(
    "INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td', '2026-07-18', 'S', 'test', 1)"
  ).run();
}

export function seedMarketSignal(db: LocalDatabase): void {
  db.prepare(
    `INSERT INTO market_daily_signals (
       id, stay_date, source, postal_code, median_price_jpy, min_price_jpy, max_price_jpy,
       quality_adjusted_median_price_jpy, quality_adjusted_min_price_jpy, quality_adjusted_max_price_jpy,
       quality_adjusted_sample_size, excluded_quality_flag_count, excluded_high_severity_count,
       quality_adjustment_reason, available_count, sold_out_count, not_listed_count, failed_count,
       sample_size, confidence, generated_at, created_at, updated_at
     )
     VALUES (
       'signal', '2026-07-18', 'jalan', '990-2301', 9500, 3000, 26000,
       10000, 4000, 26000, 9, 2, 2, 'excluded_high_severity_quality_flags',
       11, 0, 0, 2, 11, 'A', '2026-05-29', '2026-05-29', '2026-05-29'
     )`
  ).run();
}

export function recommendationRow(overrides: Partial<PricingRecommendationRecord> = {}): PricingRecommendationRecord {
  return {
    id: "rec",
    targetId: "target",
    stayDate: "2026-07-18",
    sourceMarket: "jalan",
    targetPriority: "S",
    rawMarketMedianJpy: 9500,
    qualityAdjustedMarketMedianJpy: 10000,
    baselineAdrJpy: 12000,
    recommendedPriceJpy: 12000,
    minPriceJpy: 8000,
    maxPriceJpy: 35000,
    confidence: "C",
    recommendationReason: "quality_adjusted_market_median_used:S_priority_multiplier",
    marketSignalId: "signal",
    createdAt: "2026-05-29",
    updatedAt: "2026-05-29",
    ...overrides
  };
}
