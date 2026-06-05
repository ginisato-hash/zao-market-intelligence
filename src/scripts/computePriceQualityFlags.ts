import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction, type LocalDatabase } from "../db/client";
import {
  computePriceQualityFlags,
  type ComputePriceQualityFlagsSummary,
  type PriceQualityAssessmentRow
} from "../services/computePriceQualityFlags";

export function computeAndPersistPriceQualityFlags(
  db: LocalDatabase,
  input: { source?: "jalan"; postalCode?: "990-2301"; from?: string; to?: string; createdAt?: string } = {}
): ComputePriceQualityFlagsSummary {
  executeMigration(db);
  return runInTransaction(db, () => computePriceQualityFlags(db, input));
}

export function formatPriceQualityComputeSummary(summary: ComputePriceQualityFlagsSummary): string {
  return [
    `assessed_count=${summary.assessedCount}`,
    `flagged_count=${summary.flaggedCount}`,
    `count_by_severity=${JSON.stringify(summary.countBySeverity)}`,
    `count_by_flag=${JSON.stringify(summary.countByFlag)}`,
    "sample_flagged_rows:",
    ...formatFlaggedRows(summary.sampleFlaggedRows)
  ].join("\n");
}

function formatFlaggedRows(rows: PriceQualityAssessmentRow[]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.stayDate} ${row.propertyName} price=${row.priceJpy} median=${row.marketMedianJpy ?? "null"} sample_size=${row.marketSampleSize} flags=${row.assessment.flags.join(",")} severity=${row.assessment.severity} reason=${row.assessment.reason}`
  );
}

if (process.argv[1]?.endsWith("computePriceQualityFlags.ts")) {
  const db = openLocalDatabase();
  try {
    const summary = computeAndPersistPriceQualityFlags(db, {
      source: (process.env.QUALITY_SOURCE as "jalan" | undefined) ?? "jalan",
      postalCode: (process.env.QUALITY_POSTAL_CODE as "990-2301" | undefined) ?? "990-2301",
      ...(process.env.QUALITY_FROM === undefined ? {} : { from: process.env.QUALITY_FROM }),
      ...(process.env.QUALITY_TO === undefined ? {} : { to: process.env.QUALITY_TO })
    });
    console.log(formatPriceQualityComputeSummary(summary));
  } finally {
    closeDatabase(db);
  }
}
