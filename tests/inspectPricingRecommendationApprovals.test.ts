import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertPricingRecommendationApproval } from "../src/db/repositories/pricingRecommendationApprovalsRepository";
import { formatPricingApprovalInspection, inspectPricingRecommendationApprovals } from "../src/scripts/inspectPricingRecommendationApprovals";

describe("inspectPricingRecommendationApprovals", () => {
  it("prints approval counts and rows", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    db.prepare(
      `INSERT INTO pricing_recommendations (
         id, target_id, stay_date, source_market, baseline_adr_jpy, recommended_price_jpy,
         min_price_jpy, max_price_jpy, confidence, recommendation_reason, created_at, updated_at
       )
       VALUES ('rec', 'target', '2026-07-18', 'jalan', 12000, 11000, 8000, 35000, 'A', 'test', '2026-05-29', '2026-05-29')`
    ).run();
    upsertPricingRecommendationApproval(db, {
      id: "approval",
      recommendationId: "rec",
      targetId: "target",
      stayDate: "2026-07-18",
      sourceMarket: "jalan",
      approvalStatus: "auto_approved",
      reasons: ["high_confidence_clean_recommendation"],
      auditFlags: [],
      createdAt: "2026-05-29",
      updatedAt: "2026-05-29"
    });

    const output = formatPricingApprovalInspection(inspectPricingRecommendationApprovals(db));

    expect(output).toContain("total_approvals=1");
    expect(output).toContain('count_by_status={"auto_approved":1}');
    expect(output).toContain("recommended=11000");
    db.close();
  });
});
