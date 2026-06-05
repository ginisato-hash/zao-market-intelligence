import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  getPricingRecommendation,
  listPricingRecommendations,
  upsertPricingRecommendation
} from "../src/db/repositories/pricingRecommendationsRepository";
import type { PricingRecommendationRecord } from "../src/services/generatePricingRecommendations";

describe("pricingRecommendationsRepository", () => {
  it("upserts recommendations idempotently", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    upsertPricingRecommendation(db, recommendation({ recommendedPriceJpy: 10000 }));
    upsertPricingRecommendation(db, recommendation({ recommendedPriceJpy: 12000 }));

    expect(listPricingRecommendations(db)).toHaveLength(1);
    expect(getPricingRecommendation(db, "target", "2026-07-18", "jalan")?.recommendedPriceJpy).toBe(12000);
    db.close();
  });
});

function recommendation(overrides: Partial<PricingRecommendationRecord> = {}): PricingRecommendationRecord {
  return {
    id: "rec",
    targetId: "target",
    stayDate: "2026-07-18",
    sourceMarket: "jalan",
    targetPriority: "S",
    rawMarketMedianJpy: 9000,
    qualityAdjustedMarketMedianJpy: 10000,
    baselineAdrJpy: 12000,
    recommendedPriceJpy: 10000,
    minPriceJpy: 8000,
    maxPriceJpy: 35000,
    confidence: "A",
    recommendationReason: "test",
    marketSignalId: "signal",
    createdAt: "2026-05-29",
    updatedAt: "2026-05-29",
    ...overrides
  };
}
