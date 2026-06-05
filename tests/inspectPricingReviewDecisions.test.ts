import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  pricingReviewDecisionId,
  upsertPricingReviewDecision,
  type PricingReviewDecisionStoredRecord
} from "../src/db/repositories/pricingReviewDecisionsRepository";
import {
  formatPricingReviewDecisionsInspection,
  inspectPricingReviewDecisions
} from "../src/scripts/inspectPricingReviewDecisions";

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

describe("inspectPricingReviewDecisions", () => {
  it("counts decisions and lists sample rows", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    upsertPricingReviewDecision(db, record({ targetId: "a", reviewDecision: "approved" }));
    upsertPricingReviewDecision(
      db,
      record({ targetId: "b", reviewDecision: "rejected", recommendedPriceJpy: null })
    );

    const inspection = inspectPricingReviewDecisions(db);
    expect(inspection.totalDecisions).toBe(2);
    expect(inspection.countByReviewDecision).toEqual({ approved: 1, rejected: 1 });

    const output = formatPricingReviewDecisionsInspection(inspection);
    expect(output).toContain("total_decisions=2");
    expect(output).toContain("review_decision=approved");
    expect(output).toContain("review_decision=rejected");
    db.close();
  });

  it("reports no rows when empty", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    const output = formatPricingReviewDecisionsInspection(inspectPricingReviewDecisions(db));
    expect(output).toContain("total_decisions=0");
    expect(output).toContain("none");
    db.close();
  });
});
