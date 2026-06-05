import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  getPricingReviewDecision,
  listPricingReviewDecisions,
  pricingReviewDecisionId,
  upsertPricingReviewDecision,
  type PricingReviewDecisionStoredRecord
} from "../src/db/repositories/pricingReviewDecisionsRepository";

function record(overrides: Partial<PricingReviewDecisionStoredRecord> = {}): PricingReviewDecisionStoredRecord {
  const targetId = overrides.targetId ?? "sample_target";
  const stayDate = overrides.stayDate ?? "2026-08-08";
  const sourceMarket = overrides.sourceMarket ?? "jalan";
  return {
    id: pricingReviewDecisionId(targetId, stayDate, sourceMarket),
    targetId,
    stayDate,
    sourceMarket,
    recommendedPriceJpy: 18000,
    approvalStatus: "auto_approved",
    reviewDecision: "approved",
    reviewerNote: null,
    importedFromPath: "/tmp/review.csv",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides
  };
}

describe("pricingReviewDecisionsRepository", () => {
  it("upserts a decision idempotently, preserving created_at", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);

    upsertPricingReviewDecision(db, record());
    upsertPricingReviewDecision(
      db,
      record({
        reviewDecision: "rejected",
        recommendedPriceJpy: null,
        reviewerNote: "too high",
        updatedAt: "2026-05-30T00:00:00.000Z"
      })
    );

    const all = listPricingReviewDecisions(db);
    expect(all).toHaveLength(1);

    const stored = getPricingReviewDecision(db, "sample_target", "2026-08-08", "jalan");
    expect(stored?.reviewDecision).toBe("rejected");
    expect(stored?.recommendedPriceJpy).toBeNull();
    expect(stored?.reviewerNote).toBe("too high");
    expect(stored?.createdAt).toBe("2026-05-29T00:00:00.000Z");
    expect(stored?.updatedAt).toBe("2026-05-30T00:00:00.000Z");
    db.close();
  });

  it("filters by review_decision, target_id, and stay-date range", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);

    upsertPricingReviewDecision(db, record({ targetId: "a", stayDate: "2026-08-01", reviewDecision: "approved" }));
    upsertPricingReviewDecision(
      db,
      record({ targetId: "b", stayDate: "2026-08-10", reviewDecision: "rejected", recommendedPriceJpy: null })
    );
    upsertPricingReviewDecision(
      db,
      record({ targetId: "b", stayDate: "2026-08-20", reviewDecision: "pending", recommendedPriceJpy: null })
    );

    expect(listPricingReviewDecisions(db, { reviewDecision: "approved" })).toHaveLength(1);
    expect(listPricingReviewDecisions(db, { targetId: "b" })).toHaveLength(2);
    expect(listPricingReviewDecisions(db, { from: "2026-08-05", to: "2026-08-15" })).toHaveLength(1);
    db.close();
  });

  it("returns undefined for a missing decision", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    expect(getPricingReviewDecision(db, "missing", "2026-08-08", "jalan")).toBeUndefined();
    db.close();
  });
});
