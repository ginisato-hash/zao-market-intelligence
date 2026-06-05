import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertPricingRecommendationApproval } from "../src/db/repositories/pricingRecommendationApprovalsRepository";
import { upsertPricingRecommendation } from "../src/db/repositories/pricingRecommendationsRepository";
import {
  exportPricingReviewPacket,
  renderPricingReviewCsv,
  renderPricingReviewMarkdown
} from "../src/scripts/exportPricingReviewPacket";
import { recommendationRow, seedMarketSignal, seedTargetDate } from "./buildPricingReviewPacket.test";
import { buildPricingReviewPacket } from "../src/services/buildPricingReviewPacket";

describe("exportPricingReviewPacket", () => {
  it("renders Markdown sections and exact CSV headers for manual review", () => {
    const db = fixtureDb();
    const packet = buildPricingReviewPacket(db, { generatedAt: "2026-05-29T00:00:00.000Z" });
    const markdown = renderPricingReviewMarkdown(packet);
    const csv = renderPricingReviewCsv(packet.rows);

    expect(markdown).toContain("# Pricing Recommendation Review Packet");
    expect(markdown).toContain("## Auto-Approved Rows");
    expect(markdown).toContain("## Needs-Review Rows");
    expect(markdown).toContain("## Rejected Rows");
    expect(markdown).toContain("## Review Checklist");
    expect(csv.split("\n")[0]).toBe(
      "target_id,stay_date,priority,approval_status,recommended_price_jpy,confidence,raw_market_median_jpy,quality_adjusted_market_median_jpy,baseline_adr_jpy,audit_flags,approval_reasons,recommendation_reason,review_decision,reviewer_note"
    );
    expect(csv).toContain(",pending,");
    expect(csv).not.toContain("beds24");
    expect(csv).not.toContain("airhost");
    db.close();
  });

  it("writes files to a temp directory without mutating DB", () => {
    const db = fixtureDb();
    const before = countRows(db, "pricing_recommendations");
    const exportDir = mkdtempSync(join(tmpdir(), "pricing-review-"));

    const result = exportPricingReviewPacket(db, {
      exportDir,
      timestamp: new Date("2026-05-29T12:34:56+09:00")
    });

    expect(existsSync(result.markdownPath)).toBe(true);
    expect(existsSync(result.csvPath)).toBe(true);
    expect(result.totalRows).toBe(1);
    expect(countRows(db, "pricing_recommendations")).toBe(before);
    expect(readFileSync(result.csvPath, "utf8")).toContain("reviewer_note");
    db.close();
  });
});

function fixtureDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  seedTargetDate(db);
  seedMarketSignal(db);
  const recommendation = recommendationRow({ confidence: "A" });
  upsertPricingRecommendation(db, recommendation);
  upsertPricingRecommendationApproval(db, {
    id: "approval",
    recommendationId: recommendation.id,
    targetId: recommendation.targetId,
    stayDate: recommendation.stayDate,
    sourceMarket: recommendation.sourceMarket,
    approvalStatus: "auto_approved",
    reasons: ["high_confidence_clean_recommendation"],
    auditFlags: [],
    createdAt: "2026-05-29",
    updatedAt: "2026-05-29"
  });
  return db;
}

function countRows(db: LocalDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
