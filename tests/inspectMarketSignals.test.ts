import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertMarketDailySignal } from "../src/db/repositories/marketSignalsRepository";
import { formatMarketSignalsInspection, inspectMarketSignals } from "../src/scripts/inspectMarketSignals";

describe("inspectMarketSignals", () => {
  it("prints count by confidence and sample rows", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    db.prepare(
      `INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active)
       VALUES ('td1', '2026-07-18', 'S', 'major_three_day_weekend', 1)`
    ).run();
    upsertMarketDailySignal(db, {
      id: "market_signal_test",
      stayDate: "2026-07-18",
      source: "jalan",
      postalCode: "990-2301",
      medianPriceJpy: 20000,
      minPriceJpy: 10000,
      maxPriceJpy: 30000,
      qualityAdjustedMedianPriceJpy: 25000,
      qualityAdjustedMinPriceJpy: 20000,
      qualityAdjustedMaxPriceJpy: 30000,
      qualityAdjustedSampleSize: 2,
      excludedQualityFlagCount: 1,
      excludedHighSeverityCount: 1,
      qualityAdjustmentReason: "excluded_high_severity_quality_flags",
      availableCount: 3,
      failedCount: 1,
      soldOutCount: 0,
      notListedCount: 0,
      sampleSize: 3,
      confidence: "B",
      generatedAt: "2026-05-29T00:00:00.000Z",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z"
    });

    const output = formatMarketSignalsInspection(inspectMarketSignals(db));

    expect(output).toContain("total_market_signals=1");
    expect(output).toContain('count_by_confidence={"B":1}');
    expect(output).toContain("2026-07-18 median=20000");
    expect(output).toContain("adjusted_median=25000");
    expect(output).toContain("excluded_high=1");
    expect(output).toContain("priority=S");
    db.close();
  });
});
