import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { approvePricingRecommendations, formatPricingApprovalSummary } from "../src/scripts/approvePricingRecommendations";

describe("approvePricingRecommendations", () => {
  it("computes approval rows without mutating pricing recommendations", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    insertRecommendation(db, { id: "clean", confidence: "A", recommendedPriceJpy: 11000 });
    insertRecommendation(db, {
      id: "review",
      stayDate: "2026-07-19",
      confidence: "C",
      recommendedPriceJpy: 8000,
      qualityAdjustedMarketMedianJpy: null,
      recommendationReason: "raw_market_median_used_due_to_no_adjusted_metric:S_priority_multiplier;clamped_to_min_price"
    });
    const before = countRecommendations(db);

    const summary = approvePricingRecommendations(db, { createdAt: "2026-05-29T00:00:00.000Z" });
    const output = formatPricingApprovalSummary(summary);

    expect(summary.recommendationsEvaluated).toBe(2);
    expect(summary.countByStatus.auto_approved).toBe(1);
    expect(summary.countByStatus.needs_review).toBe(1);
    expect(output).toContain("approvals_upserted=2");
    expect(countRecommendations(db)).toBe(before);
    db.close();
  });
});

function countRecommendations(db: LocalDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM pricing_recommendations").get() as { count: number }).count;
}

function insertRecommendation(
  db: LocalDatabase,
  input: {
    id: string;
    stayDate?: string;
    confidence: "A" | "B" | "C" | "fallback";
    recommendedPriceJpy: number;
    qualityAdjustedMarketMedianJpy?: number | null;
    recommendationReason?: string;
  }
): void {
  db.prepare(
    `INSERT INTO pricing_recommendations (
       id, target_id, stay_date, source_market, target_priority,
       raw_market_median_jpy, quality_adjusted_market_median_jpy, baseline_adr_jpy,
       recommended_price_jpy, min_price_jpy, max_price_jpy, confidence,
       recommendation_reason, market_signal_id, created_at, updated_at
     )
     VALUES (?, 'target', ?, 'jalan', 'S', 10000, ?, 12000, ?, 8000, 35000, ?, ?, 'signal', '2026-05-29', '2026-05-29')`
  ).run(
    input.id,
    input.stayDate ?? "2026-07-18",
    input.qualityAdjustedMarketMedianJpy === undefined ? 10000 : input.qualityAdjustedMarketMedianJpy,
    input.recommendedPriceJpy,
    input.confidence,
    input.recommendationReason ?? "quality_adjusted_market_median_used:S_priority_multiplier"
  );
}
