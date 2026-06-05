import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertPricingRecommendation } from "../src/db/repositories/pricingRecommendationsRepository";
import {
  formatPricingRecommendationsInspection,
  inspectPricingRecommendations
} from "../src/scripts/inspectPricingRecommendations";

describe("inspectPricingRecommendations", () => {
  it("prints recommendation summary and sample rows", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    upsertPricingRecommendation(db, {
      id: "rec",
      targetId: "target",
      stayDate: "2026-07-18",
      sourceMarket: "jalan",
      targetPriority: "S",
      rawMarketMedianJpy: 9000,
      qualityAdjustedMarketMedianJpy: 10000,
      baselineAdrJpy: 12000,
      recommendedPriceJpy: 12000,
      minPriceJpy: 8000,
      maxPriceJpy: 35000,
      confidence: "A",
      recommendationReason: "quality_adjusted_market_median_used:S_priority_multiplier",
      marketSignalId: "signal",
      createdAt: "2026-05-29",
      updatedAt: "2026-05-29"
    });

    const output = formatPricingRecommendationsInspection(inspectPricingRecommendations(db));

    expect(output).toContain("total_recommendations=1");
    expect(output).toContain('count_by_confidence={"A":1}');
    expect(output).toContain("recommended_price=12000");
    db.close();
  });
});
