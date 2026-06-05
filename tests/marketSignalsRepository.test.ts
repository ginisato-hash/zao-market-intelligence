import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  getMarketDailySignal,
  listMarketDailySignals,
  upsertMarketDailySignal
} from "../src/db/repositories/marketSignalsRepository";
import type { MarketDailySignalRecord } from "../src/services/computeMarketSignals";

describe("marketSignalsRepository", () => {
  it("upserts signals idempotently", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    upsertMarketDailySignal(db, signal({ medianPriceJpy: 10000 }));
    upsertMarketDailySignal(db, signal({ medianPriceJpy: 12000 }));

    const rows = listMarketDailySignals(db);

    expect(rows).toHaveLength(1);
    expect(getMarketDailySignal(db, "2026-07-18", "jalan", "990-2301")?.medianPriceJpy).toBe(12000);
    expect(getMarketDailySignal(db, "2026-07-18", "jalan", "990-2301")?.qualityAdjustedMedianPriceJpy).toBe(10000);
    db.close();
  });
});

function signal(overrides: Partial<MarketDailySignalRecord> = {}): MarketDailySignalRecord {
  return {
    id: "market_signal_test",
    stayDate: "2026-07-18",
    source: "jalan",
    postalCode: "990-2301",
    medianPriceJpy: 10000,
    minPriceJpy: 8000,
    maxPriceJpy: 12000,
    qualityAdjustedMedianPriceJpy: 10000,
    qualityAdjustedMinPriceJpy: 8000,
    qualityAdjustedMaxPriceJpy: 12000,
    qualityAdjustedSampleSize: 3,
    excludedQualityFlagCount: 0,
    excludedHighSeverityCount: 0,
    qualityAdjustmentReason: "no_high_severity_quality_flags",
    availableCount: 3,
    failedCount: 0,
    soldOutCount: 0,
    notListedCount: 0,
    sampleSize: 3,
    confidence: "B",
    generatedAt: "2026-05-29T00:00:00.000Z",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides
  };
}
