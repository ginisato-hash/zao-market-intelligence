import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  formatPricingRecommendationGenerationSummary,
  generateAndUpsertPricingRecommendations
} from "../src/scripts/generatePricingRecommendations";

describe("generatePricingRecommendations script helpers", () => {
  it("generates recommendations from fixture DB and config", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    seedMarketSignal(db);
    seedTargetDate(db);
    const configPath = writeTargetConfig();

    const summary = generateAndUpsertPricingRecommendations(db, {
      configPath,
      createdAt: "2026-05-29T00:00:00.000Z"
    });
    const output = formatPricingRecommendationGenerationSummary(summary);

    expect(summary.targetCount).toBe(1);
    expect(summary.recommendationsUpserted).toBe(1);
    expect(output).toContain("recommendations_upserted=1");
    expect((db.prepare("SELECT COUNT(*) AS count FROM pricing_recommendations").get() as { count: number }).count).toBe(1);
    db.close();
  });
});

function writeTargetConfig(): string {
  const path = join(mkdtempSync(join(tmpdir(), "pricing-targets-")), "targets.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        target_id: "target",
        property_name: "Target",
        postal_code: "990-2301",
        source_market: "jalan",
        baseline_adr_jpy: 12000,
        min_price_jpy: 8000,
        max_price_jpy: 35000,
        rounding_unit_jpy: 500,
        strategy: "follow_quality_adjusted_market",
        active: true
      }
    ])
  );
  return path;
}

function seedMarketSignal(db: LocalDatabase): void {
  db.prepare(
    `INSERT INTO market_daily_signals (
       id, stay_date, source, postal_code, median_price_jpy, min_price_jpy, max_price_jpy,
       quality_adjusted_median_price_jpy, quality_adjusted_min_price_jpy, quality_adjusted_max_price_jpy,
       quality_adjusted_sample_size, excluded_quality_flag_count, excluded_high_severity_count,
       quality_adjustment_reason, available_count, sold_out_count, not_listed_count, failed_count,
       sample_size, confidence, generated_at, created_at, updated_at
     )
     VALUES (
       'signal', '2026-07-18', 'jalan', '990-2301', 9000, 3000, 26000,
       10000, 8000, 26000, 5, 1, 1, 'excluded_high_severity_quality_flags',
       6, 0, 0, 0, 6, 'A', '2026-05-29', '2026-05-29', '2026-05-29'
     )`
  ).run();
}

function seedTargetDate(db: LocalDatabase): void {
  db.prepare(
    "INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td', '2026-07-18', 'S', 'test', 1)"
  ).run();
}
