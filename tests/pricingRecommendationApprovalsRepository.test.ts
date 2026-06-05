import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  getPricingRecommendationApproval,
  listPricingRecommendationApprovals,
  upsertPricingRecommendationApproval
} from "../src/db/repositories/pricingRecommendationApprovalsRepository";
import type { PricingRecommendationApprovalRecord } from "../src/services/pricingRecommendationApproval";

describe("pricingRecommendationApprovalsRepository", () => {
  it("upserts approvals idempotently", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    upsertPricingRecommendationApproval(db, approval({ approvalStatus: "needs_review" }));
    upsertPricingRecommendationApproval(db, approval({ approvalStatus: "auto_approved", reasons: ["high_confidence_clean_recommendation"] }));

    expect(listPricingRecommendationApprovals(db)).toHaveLength(1);
    expect(getPricingRecommendationApproval(db, "rec")?.approvalStatus).toBe("auto_approved");
    db.close();
  });
});

function approval(overrides: Partial<PricingRecommendationApprovalRecord> = {}): PricingRecommendationApprovalRecord {
  return {
    id: "approval",
    recommendationId: "rec",
    targetId: "target",
    stayDate: "2026-07-18",
    sourceMarket: "jalan",
    approvalStatus: "needs_review",
    reasons: ["low_confidence_requires_review"],
    auditFlags: ["low_confidence_recommendation"],
    createdAt: "2026-05-29",
    updatedAt: "2026-05-29",
    ...overrides
  };
}
