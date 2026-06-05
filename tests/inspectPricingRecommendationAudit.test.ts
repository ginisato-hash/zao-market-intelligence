import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertPricingRecommendation } from "../src/db/repositories/pricingRecommendationsRepository";
import type { PricingRecommendationRecord } from "../src/services/generatePricingRecommendations";
import {
  buildPricingRecommendationAudit,
  formatPricingRecommendationAudit
} from "../src/scripts/inspectPricingRecommendationAudit";

function openTestDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function makeRec(overrides: Partial<PricingRecommendationRecord> = {}): PricingRecommendationRecord {
  return {
    id: "pricing_rec_x",
    targetId: "sample_target",
    stayDate: "2026-08-08",
    sourceMarket: "jalan",
    targetPriority: "S",
    rawMarketMedianJpy: 15000,
    qualityAdjustedMarketMedianJpy: 15000,
    baselineAdrJpy: 12000,
    recommendedPriceJpy: 15000,
    minPriceJpy: 8000,
    maxPriceJpy: 35000,
    confidence: "B",
    recommendationReason: "quality_adjusted_market_median_used:S_priority_multiplier",
    marketSignalId: "market_signal_1",
    createdAt: "2026-05-29T10:00:00.000Z",
    updatedAt: "2026-05-29T10:00:00.000Z",
    ...overrides
  };
}

function seed(db: LocalDatabase): void {
  upsertPricingRecommendation(db, makeRec({ id: "r1", stayDate: "2026-08-08", confidence: "A" }));
  upsertPricingRecommendation(
    db,
    makeRec({
      id: "r2",
      stayDate: "2026-07-19",
      confidence: "C",
      rawMarketMedianJpy: 4000,
      qualityAdjustedMarketMedianJpy: null,
      recommendedPriceJpy: 8000,
      recommendationReason:
        "raw_market_median_used_due_to_no_adjusted_metric:S_priority_multiplier;clamped_to_min_price"
    })
  );
  upsertPricingRecommendation(
    db,
    makeRec({
      id: "r3",
      stayDate: "2026-12-12",
      confidence: "fallback",
      rawMarketMedianJpy: null,
      qualityAdjustedMarketMedianJpy: null,
      marketSignalId: null,
      recommendedPriceJpy: 13000,
      recommendationReason: "baseline_used_due_to_insufficient_market_signal:A_priority_multiplier"
    })
  );
}

describe("inspectPricingRecommendationAudit", () => {
  let db: LocalDatabase;

  beforeEach(() => {
    db = openTestDb();
    seed(db);
  });

  afterEach(() => {
    db.close();
  });

  it("builds an audit summary with expected counts and flags", () => {
    const summary = buildPricingRecommendationAudit(db);
    expect(summary.totalRecommendations).toBe(3);
    expect(summary.countsByConfidence).toEqual({ A: 1, C: 1, fallback: 1 });
    expect(summary.countsByFlag["raw_fallback_quality_excluded"]).toBe(1);
    expect(summary.countsByFlag["adjusted_median_unavailable"]).toBe(1);
    expect(summary.countsByFlag["clamped_recommendation"]).toBe(1);
    expect(summary.countsByFlag["no_market_signal"]).toBe(1);
    expect(summary.flaggedRows.length).toBe(2);
  });

  it("human-readable output includes headline keys", () => {
    const output = formatPricingRecommendationAudit(buildPricingRecommendationAudit(db));
    expect(output).toContain("total_recommendations=3");
    expect(output).toContain("count_by_confidence=");
    expect(output).toContain("count_by_flag=");
    expect(output).toContain("flagged_row_count=2");
  });

  it("AUDIT_OUTPUT=json shape is valid JSON with expected keys", () => {
    const summary = buildPricingRecommendationAudit(db);
    const parsed = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
    expect(parsed["totalRecommendations"]).toBe(3);
    expect(parsed["countsByConfidence"]).toBeDefined();
    expect(parsed["countsByFlag"]).toBeDefined();
    expect(Array.isArray(parsed["flaggedRows"])).toBe(true);
  });

  it("does not mutate row count or updated_at of the recommendations table", () => {
    const before = db
      .prepare("SELECT id, updated_at FROM pricing_recommendations ORDER BY id ASC")
      .all() as Array<{ id: string; updated_at: string }>;

    buildPricingRecommendationAudit(db);
    buildPricingRecommendationAudit(db);

    const after = db
      .prepare("SELECT id, updated_at FROM pricing_recommendations ORDER BY id ASC")
      .all() as Array<{ id: string; updated_at: string }>;

    expect(after).toEqual(before);
  });
});
