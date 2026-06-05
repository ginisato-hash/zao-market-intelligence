import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { listPriceQualityFlags, type PriceQualityFlagRecord } from "../db/repositories/priceQualityRepository";

export interface PriceQualityInspection {
  totalQualityRows: number;
  flaggedCount: number;
  countBySeverity: Record<string, number>;
  countByFlag: Record<string, number>;
  sampleFlaggedRows: Array<PriceQualityFlagRecord & { propertyName: string | null }>;
}

export function inspectPriceQualityFlags(db: LocalDatabase): PriceQualityInspection {
  executeMigration(db);
  const rows = listPriceQualityFlags(db, {
    source: process.env.QUALITY_SOURCE ?? "jalan",
    ...(process.env.QUALITY_FROM === undefined ? {} : { from: process.env.QUALITY_FROM }),
    ...(process.env.QUALITY_TO === undefined ? {} : { to: process.env.QUALITY_TO })
  });
  const flaggedRows = rows.filter((row) => row.severity !== "none");

  return {
    totalQualityRows: rows.length,
    flaggedCount: flaggedRows.length,
    countBySeverity: countBy(rows, (row) => row.severity),
    countByFlag: countFlags(rows),
    sampleFlaggedRows: flaggedRows.slice(0, 10).map((row) => ({
      ...row,
      propertyName: propertyNameFor(db, row.propertyId)
    }))
  };
}

export function formatPriceQualityInspection(inspection: PriceQualityInspection): string {
  return [
    `total_quality_rows=${inspection.totalQualityRows}`,
    `flagged_count=${inspection.flaggedCount}`,
    `count_by_severity=${JSON.stringify(inspection.countBySeverity)}`,
    `count_by_flag=${JSON.stringify(inspection.countByFlag)}`,
    "sample_flagged_rows:",
    ...formatRows(inspection.sampleFlaggedRows)
  ].join("\n");
}

function propertyNameFor(db: LocalDatabase, propertyId: string | null): string | null {
  if (propertyId === null) return null;
  const row = db.prepare("SELECT name FROM properties WHERE id = ?").get(propertyId) as { name: string } | undefined;
  return row?.name ?? null;
}

function formatRows(rows: PriceQualityInspection["sampleFlaggedRows"]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.stayDate} ${row.propertyName ?? row.propertyId ?? "unknown"} price=${row.priceJpy ?? "null"} flags=${row.flags.join(",")} severity=${row.severity} reason=${row.reason}`
  );
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function countFlags(rows: PriceQualityFlagRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const flag of row.flags) {
      counts[flag] = (counts[flag] ?? 0) + 1;
    }
  }
  return counts;
}

if (process.argv[1]?.endsWith("inspectPriceQualityFlags.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatPriceQualityInspection(inspectPriceQualityFlags(db)));
  } finally {
    closeDatabase(db);
  }
}
