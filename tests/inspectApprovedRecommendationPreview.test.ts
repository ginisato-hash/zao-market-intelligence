import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  pricingReviewDecisionId,
  upsertPricingReviewDecision,
  type PricingReviewDecisionStoredRecord
} from "../src/db/repositories/pricingReviewDecisionsRepository";
import {
  formatApprovedPreviewInspection,
  inspectApprovedRecommendationPreview
} from "../src/scripts/inspectApprovedRecommendationPreview";

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedApprovedRow(db: LocalDatabase, targetId: string, stayDate: string, confidence: string): void {
  db.prepare(
    `INSERT INTO pricing_recommendations (
       id, target_id, stay_date, source_market, baseline_adr_jpy, recommended_price_jpy,
       min_price_jpy, max_price_jpy, confidence, recommendation_reason, created_at, updated_at
     )
     VALUES (@id, @targetId, @stayDate, 'jalan', 16000, 18000, 8000, 35000, @confidence, 'reason', '2026-05-29', '2026-05-29')`
  ).run({ id: `rec_${targetId}_${stayDate}`, targetId, stayDate, confidence });
  const row: PricingReviewDecisionStoredRecord = {
    id: pricingReviewDecisionId(targetId, stayDate, "jalan"),
    targetId,
    stayDate,
    sourceMarket: "jalan",
    recommendedPriceJpy: 18000,
    approvalStatus: "auto_approved",
    reviewDecision: "approved",
    reviewerNote: null,
    importedFromPath: "/tmp/review.csv",
    createdAt: "2026-05-29",
    updatedAt: "2026-05-29"
  };
  upsertPricingReviewDecision(db, row);
}

describe("inspectApprovedRecommendationPreview", () => {
  it("prints approved counts and sample rows", () => {
    const db = openDb();
    seedApprovedRow(db, "a", "2026-08-01", "A");
    seedApprovedRow(db, "b", "2026-08-02", "B");

    const output = formatApprovedPreviewInspection(inspectApprovedRecommendationPreview(db));

    expect(output).toContain("approved_rows_count=2");
    expect(output).toContain("count_by_confidence=");
    expect(output).toContain("a 2026-08-01");
    expect(output).toContain("recommended_price=18000");
    db.close();
  });

  it("reports none when there are no approved rows", () => {
    const db = openDb();
    const output = formatApprovedPreviewInspection(inspectApprovedRecommendationPreview(db));
    expect(output).toContain("approved_rows_count=0");
    expect(output).toContain("none");
    db.close();
  });
});
