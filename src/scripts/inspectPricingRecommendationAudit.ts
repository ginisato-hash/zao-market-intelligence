import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { listPricingRecommendations } from "../db/repositories/pricingRecommendationsRepository";
import {
  auditPricingRecommendations,
  type PricingRecommendationAuditRow,
  type PricingRecommendationAuditSummary
} from "../services/auditPricingRecommendations";

/** Reads recommendations from the DB and computes the audit summary. Read-only. */
export function buildPricingRecommendationAudit(db: LocalDatabase): PricingRecommendationAuditSummary {
  executeMigration(db);
  const rows = listPricingRecommendations(db, {
    sourceMarket: process.env.PRICING_SOURCE_MARKET ?? "jalan",
    ...(process.env.PRICING_FROM === undefined ? {} : { from: process.env.PRICING_FROM }),
    ...(process.env.PRICING_TO === undefined ? {} : { to: process.env.PRICING_TO })
  });
  return auditPricingRecommendations(rows);
}

export function formatPricingRecommendationAudit(summary: PricingRecommendationAuditSummary): string {
  return [
    `total_recommendations=${summary.totalRecommendations}`,
    `count_by_confidence=${JSON.stringify(summary.countsByConfidence)}`,
    `count_by_flag=${JSON.stringify(summary.countsByFlag)}`,
    `flagged_row_count=${summary.flaggedRows.length}`,
    "flagged_rows:",
    ...formatFlaggedRows(summary.flaggedRows)
  ].join("\n");
}

function formatFlaggedRows(rows: PricingRecommendationAuditRow[]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.stayDate} ${row.targetId} ${row.sourceMarket} recommended=${row.recommendedPriceJpy} confidence=${row.confidence} market_median=${row.chosenMarketMedianJpy ?? "null"}(${row.chosenMarketMedianKind}) gap_pct=${row.gapFromChosenMarketMedianPct ?? "null"} flags=${row.flags.join(",")} reason=${row.reason}`
  );
}

if (process.argv[1]?.endsWith("inspectPricingRecommendationAudit.ts")) {
  const db = openLocalDatabase();
  try {
    const summary = buildPricingRecommendationAudit(db);
    if (process.env.AUDIT_OUTPUT === "json") {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(formatPricingRecommendationAudit(summary));
    }
  } finally {
    closeDatabase(db);
  }
}
