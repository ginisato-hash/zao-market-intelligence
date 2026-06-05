import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction, type LocalDatabase } from "../db/client";
import { upsertMarketDailySignal } from "../db/repositories/marketSignalsRepository";
import { computeMarketSignalsFromSnapshots, type MarketDailySignalRecord } from "../services/computeMarketSignals";

export interface MarketComputeSummary {
  processedDatesCount: number;
  insertedOrUpdatedCount: number;
  countByConfidence: Record<string, number>;
  sampleRows: MarketDailySignalRecord[];
}

export function computeAndUpsertMarketSignals(
  db: LocalDatabase,
  input: { source?: "jalan"; postalCode?: "990-2301"; from?: string; to?: string; generatedAt?: string } = {}
): MarketComputeSummary {
  executeMigration(db);
  const signals = computeMarketSignalsFromSnapshots(db, input);
  runInTransaction(db, () => {
    for (const signal of signals) {
      upsertMarketDailySignal(db, signal);
    }
  });

  return {
    processedDatesCount: signals.length,
    insertedOrUpdatedCount: signals.length,
    countByConfidence: countBy(signals, (signal) => signal.confidence),
    sampleRows: signals.slice(0, 10)
  };
}

export function formatMarketComputeSummary(summary: MarketComputeSummary): string {
  return [
    `processed_dates_count=${summary.processedDatesCount}`,
    `inserted_or_updated_count=${summary.insertedOrUpdatedCount}`,
    `count_by_confidence=${JSON.stringify(summary.countByConfidence)}`,
    "sample_rows:",
    ...formatSampleRows(summary.sampleRows)
  ].join("\n");
}

function formatSampleRows(rows: MarketDailySignalRecord[]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.stayDate} ${row.source} median=${row.medianPriceJpy ?? "null"} adjusted_median=${row.qualityAdjustedMedianPriceJpy ?? "null"} min=${row.minPriceJpy ?? "null"} adjusted_min=${row.qualityAdjustedMinPriceJpy ?? "null"} max=${row.maxPriceJpy ?? "null"} adjusted_max=${row.qualityAdjustedMaxPriceJpy ?? "null"} sample_size=${row.sampleSize} adjusted_sample_size=${row.qualityAdjustedSampleSize} excluded_high=${row.excludedHighSeverityCount} available=${row.availableCount} failed=${row.failedCount} sold_out=${row.soldOutCount} not_listed=${row.notListedCount} confidence=${row.confidence} quality_adjustment_reason=${row.qualityAdjustmentReason}`
  );
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

if (process.argv[1]?.endsWith("computeMarketSignals.ts")) {
  const db = openLocalDatabase();
  try {
    const summary = computeAndUpsertMarketSignals(db, {
      source: (process.env.MARKET_SOURCE as "jalan" | undefined) ?? "jalan",
      postalCode: (process.env.MARKET_POSTAL_CODE as "990-2301" | undefined) ?? "990-2301",
      ...(process.env.MARKET_FROM === undefined ? {} : { from: process.env.MARKET_FROM }),
      ...(process.env.MARKET_TO === undefined ? {} : { to: process.env.MARKET_TO })
    });
    console.log(formatMarketComputeSummary(summary));
  } finally {
    closeDatabase(db);
  }
}
