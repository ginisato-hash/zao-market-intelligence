import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { listMarketDailySignals } from "../db/repositories/marketSignalsRepository";
import type { MarketDailySignalRecord } from "../services/computeMarketSignals";

export interface MarketSignalsInspection {
  totalMarketSignals: number;
  countByConfidence: Record<string, number>;
  earliestStayDate: string | null;
  latestStayDate: string | null;
  sampleRows: Array<
    MarketDailySignalRecord & {
      priority?: string | null;
      reason?: string | null;
      suspiciousCount?: number;
      qualityAdjustedWarning?: string | null;
    }
  >;
}

export function inspectMarketSignals(db: LocalDatabase): MarketSignalsInspection {
  executeMigration(db);
  const signals = listMarketDailySignals(db, {
    source: process.env.MARKET_SOURCE ?? "jalan",
    postalCode: process.env.MARKET_POSTAL_CODE ?? "990-2301",
    ...(process.env.MARKET_FROM === undefined ? {} : { from: process.env.MARKET_FROM }),
    ...(process.env.MARKET_TO === undefined ? {} : { to: process.env.MARKET_TO })
  });
  return {
    totalMarketSignals: signals.length,
    countByConfidence: countBy(signals, (signal) => signal.confidence),
    earliestStayDate: signals[0]?.stayDate ?? null,
    latestStayDate: signals[signals.length - 1]?.stayDate ?? null,
    sampleRows: signals.slice(0, 10).map((signal) => ({
      ...signal,
      ...targetDateContext(db, signal.stayDate),
      ...qualityContext(db, signal.stayDate, signal.source)
    }))
  };
}

export function formatMarketSignalsInspection(inspection: MarketSignalsInspection): string {
  return [
    `total_market_signals=${inspection.totalMarketSignals}`,
    `count_by_confidence=${JSON.stringify(inspection.countByConfidence)}`,
    `earliest_stay_date=${inspection.earliestStayDate ?? "null"}`,
    `latest_stay_date=${inspection.latestStayDate ?? "null"}`,
    "sample_rows:",
    ...formatRows(inspection.sampleRows)
  ].join("\n");
}

function targetDateContext(db: LocalDatabase, stayDate: string): { priority: string | null; reason: string | null } {
  const row = db
    .prepare("SELECT priority, reason FROM target_dates WHERE stay_date = ?")
    .get(stayDate) as { priority: string; reason: string } | undefined;
  return {
    priority: row?.priority ?? null,
    reason: row?.reason ?? null
  };
}

function qualityContext(
  db: LocalDatabase,
  stayDate: string,
  source: string
): { suspiciousCount: number; qualityAdjustedWarning: string | null } {
  const tableExists =
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'price_quality_flags'").get() !== undefined;
  if (!tableExists) {
    return { suspiciousCount: 0, qualityAdjustedWarning: null };
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM price_quality_flags
       WHERE stay_date = ? AND source = ? AND severity <> 'none'`
    )
    .get(stayDate, source) as { count: number };
  return {
    suspiciousCount: row.count,
    qualityAdjustedWarning: row.count > 0 ? "quality_flags_present_adjusted_metrics_available" : null
  };
}

function formatRows(rows: MarketSignalsInspection["sampleRows"]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.stayDate} median=${row.medianPriceJpy ?? "null"} adjusted_median=${row.qualityAdjustedMedianPriceJpy ?? "null"} min=${row.minPriceJpy ?? "null"} adjusted_min=${row.qualityAdjustedMinPriceJpy ?? "null"} max=${row.maxPriceJpy ?? "null"} adjusted_max=${row.qualityAdjustedMaxPriceJpy ?? "null"} sample_size=${row.sampleSize} adjusted_sample_size=${row.qualityAdjustedSampleSize} excluded_high=${row.excludedHighSeverityCount} available=${row.availableCount} failed=${row.failedCount} confidence=${row.confidence} quality_adjustment_reason=${row.qualityAdjustmentReason} priority=${row.priority ?? "null"} suspicious_count=${row.suspiciousCount ?? 0} quality_adjusted_warning=${row.qualityAdjustedWarning ?? "null"} reason=${row.reason ?? "null"}`
  );
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

if (process.argv[1]?.endsWith("inspectMarketSignals.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatMarketSignalsInspection(inspectMarketSignals(db)));
  } finally {
    closeDatabase(db);
  }
}
