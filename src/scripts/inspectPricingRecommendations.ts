import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { listPricingRecommendations } from "../db/repositories/pricingRecommendationsRepository";
import type { PricingRecommendationRecord } from "../services/generatePricingRecommendations";

export interface PricingRecommendationsInspection {
  totalRecommendations: number;
  countByConfidence: Record<string, number>;
  earliestStayDate: string | null;
  latestStayDate: string | null;
  sampleRows: PricingRecommendationRecord[];
}

export function inspectPricingRecommendations(db: LocalDatabase): PricingRecommendationsInspection {
  executeMigration(db);
  const rows = listPricingRecommendations(db, {
    sourceMarket: process.env.PRICING_SOURCE_MARKET ?? "jalan",
    ...(process.env.PRICING_FROM === undefined ? {} : { from: process.env.PRICING_FROM }),
    ...(process.env.PRICING_TO === undefined ? {} : { to: process.env.PRICING_TO })
  });
  return {
    totalRecommendations: rows.length,
    countByConfidence: countBy(rows, (row) => row.confidence),
    earliestStayDate: rows[0]?.stayDate ?? null,
    latestStayDate: rows[rows.length - 1]?.stayDate ?? null,
    sampleRows: rows.slice(0, 10)
  };
}

export function formatPricingRecommendationsInspection(inspection: PricingRecommendationsInspection): string {
  return [
    `total_recommendations=${inspection.totalRecommendations}`,
    `count_by_confidence=${JSON.stringify(inspection.countByConfidence)}`,
    `earliest_stay_date=${inspection.earliestStayDate ?? "null"}`,
    `latest_stay_date=${inspection.latestStayDate ?? "null"}`,
    "sample_rows:",
    ...formatRows(inspection.sampleRows)
  ].join("\n");
}

function formatRows(rows: PricingRecommendationRecord[]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.targetId} ${row.stayDate} priority=${row.targetPriority ?? "null"} raw_market_median=${row.rawMarketMedianJpy ?? "null"} adjusted_market_median=${row.qualityAdjustedMarketMedianJpy ?? "null"} baseline_adr=${row.baselineAdrJpy} recommended_price=${row.recommendedPriceJpy} confidence=${row.confidence} reason=${row.recommendationReason}`
  );
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

if (process.argv[1]?.endsWith("inspectPricingRecommendations.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatPricingRecommendationsInspection(inspectPricingRecommendations(db)));
  } finally {
    closeDatabase(db);
  }
}
