import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  pricingReviewDecisionId,
  upsertPricingReviewDecision,
  type PricingReviewDecisionStoredRecord
} from "../src/db/repositories/pricingReviewDecisionsRepository";
import { buildApprovedRecommendationPreview } from "../src/services/buildApprovedRecommendationPreview";
import type { PricingReviewDecision } from "../src/services/pricingReviewDecision";

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedRecommendation(
  db: LocalDatabase,
  overrides: { targetId?: string; stayDate?: string; confidence?: string; reason?: string; price?: number } = {}
): void {
  const targetId = overrides.targetId ?? "sample_target";
  const stayDate = overrides.stayDate ?? "2026-08-08";
  const confidence = overrides.confidence ?? "A";
  const reason = overrides.reason ?? "quality_adjusted_market_median_used";
  const price = overrides.price ?? 18000;
  db.prepare(
    `INSERT INTO pricing_recommendations (
       id, target_id, stay_date, source_market, baseline_adr_jpy, recommended_price_jpy,
       min_price_jpy, max_price_jpy, confidence, recommendation_reason, created_at, updated_at
     )
     VALUES (@id, @targetId, @stayDate, 'jalan', 16000, @price, 8000, 35000, @confidence, @reason, '2026-05-29', '2026-05-29')`
  ).run({ id: `rec_${targetId}_${stayDate}`, targetId, stayDate, price, confidence, reason });
}

function decision(overrides: Partial<PricingReviewDecisionStoredRecord> = {}): PricingReviewDecisionStoredRecord {
  const targetId = overrides.targetId ?? "sample_target";
  const stayDate = overrides.stayDate ?? "2026-08-08";
  const sourceMarket = overrides.sourceMarket ?? "jalan";
  const reviewDecision: PricingReviewDecision = overrides.reviewDecision ?? "approved";
  return {
    id: pricingReviewDecisionId(targetId, stayDate, sourceMarket),
    targetId,
    stayDate,
    sourceMarket,
    recommendedPriceJpy: 18000,
    approvalStatus: "auto_approved",
    reviewDecision,
    reviewerNote: null,
    importedFromPath: "/tmp/review.csv",
    createdAt: "2026-05-29",
    updatedAt: "2026-05-29",
    ...overrides
  };
}

describe("buildApprovedRecommendationPreview", () => {
  it("includes only approved decisions and excludes pending/rejected/needs_change", () => {
    const db = openDb();
    seedRecommendation(db, { targetId: "a", stayDate: "2026-08-01", confidence: "A" });
    seedRecommendation(db, { targetId: "b", stayDate: "2026-08-02", confidence: "B" });
    seedRecommendation(db, { targetId: "c", stayDate: "2026-08-03" });
    seedRecommendation(db, { targetId: "d", stayDate: "2026-08-04" });

    upsertPricingReviewDecision(db, decision({ targetId: "a", stayDate: "2026-08-01", reviewDecision: "approved" }));
    upsertPricingReviewDecision(
      db,
      decision({ targetId: "b", stayDate: "2026-08-02", reviewDecision: "pending", recommendedPriceJpy: null })
    );
    upsertPricingReviewDecision(
      db,
      decision({ targetId: "c", stayDate: "2026-08-03", reviewDecision: "rejected", recommendedPriceJpy: null })
    );
    upsertPricingReviewDecision(
      db,
      decision({ targetId: "d", stayDate: "2026-08-04", reviewDecision: "needs_change", reviewerNote: "raise floor" })
    );

    const preview = buildApprovedRecommendationPreview(db);

    expect(preview.approvedRowsCount).toBe(1);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]?.targetId).toBe("a");
    expect(preview.rows[0]?.reviewDecision).toBe("approved");
    expect(preview.rows[0]?.confidence).toBe("A");
    expect(preview.skippedNonApprovedCount).toBe(3);
    db.close();
  });

  it("skips approved rows with a null price and counts them", () => {
    const db = openDb();
    seedRecommendation(db, { targetId: "a", stayDate: "2026-08-01" });
    seedRecommendation(db, { targetId: "b", stayDate: "2026-08-02" });

    upsertPricingReviewDecision(db, decision({ targetId: "a", stayDate: "2026-08-01", reviewDecision: "approved" }));
    upsertPricingReviewDecision(
      db,
      decision({ targetId: "b", stayDate: "2026-08-02", reviewDecision: "approved", recommendedPriceJpy: null })
    );

    const preview = buildApprovedRecommendationPreview(db);

    expect(preview.approvedRowsCount).toBe(1);
    expect(preview.skippedNullPriceCount).toBe(1);
    expect(preview.rows[0]?.targetId).toBe("a");
    db.close();
  });

  it("joins confidence/reason from the recommendation and priority from target_dates", () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO target_dates (target_date_id, stay_date, priority, reason)
       VALUES ('td_2026-08-08', '2026-08-08', 'S', 'peak weekend')`
    ).run();
    seedRecommendation(db, { confidence: "B", reason: "market median anchored" });
    upsertPricingReviewDecision(db, decision({ reviewerNote: "looks good" }));

    const preview = buildApprovedRecommendationPreview(db);
    const row = preview.rows[0];
    expect(row?.priority).toBe("S");
    expect(row?.confidence).toBe("B");
    expect(row?.recommendationReason).toBe("market median anchored");
    expect(row?.reviewerNote).toBe("looks good");
    expect(preview.countByPriority).toEqual({ S: 1 });
    expect(preview.countByConfidence).toEqual({ B: 1 });
    db.close();
  });

  it("uses the reviewer-approved price from the decision", () => {
    const db = openDb();
    seedRecommendation(db, { price: 18000 });
    upsertPricingReviewDecision(db, decision({ recommendedPriceJpy: 21000 }));

    const preview = buildApprovedRecommendationPreview(db);
    expect(preview.rows[0]?.recommendedPriceJpy).toBe(21000);
    db.close();
  });

  it("does not mutate any DB rows", () => {
    const db = openDb();
    seedRecommendation(db);
    upsertPricingReviewDecision(db, decision());

    const before = {
      recommendations: db.prepare("SELECT * FROM pricing_recommendations ORDER BY id").all(),
      decisions: db.prepare("SELECT * FROM pricing_review_decisions ORDER BY id").all()
    };

    buildApprovedRecommendationPreview(db);

    expect(db.prepare("SELECT * FROM pricing_recommendations ORDER BY id").all()).toEqual(before.recommendations);
    expect(db.prepare("SELECT * FROM pricing_review_decisions ORDER BY id").all()).toEqual(before.decisions);
    db.close();
  });
});
