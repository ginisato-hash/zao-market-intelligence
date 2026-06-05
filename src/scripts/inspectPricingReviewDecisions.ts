import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import {
  listPricingReviewDecisions,
  type PricingReviewDecisionStoredRecord
} from "../db/repositories/pricingReviewDecisionsRepository";

export interface PricingReviewDecisionsInspection {
  totalDecisions: number;
  countByReviewDecision: Record<string, number>;
  sampleRows: PricingReviewDecisionStoredRecord[];
}

export function inspectPricingReviewDecisions(db: LocalDatabase): PricingReviewDecisionsInspection {
  executeMigration(db);
  const rows = listPricingReviewDecisions(db, {
    ...(process.env.PRICING_SOURCE_MARKET === undefined ? {} : { sourceMarket: process.env.PRICING_SOURCE_MARKET }),
    ...(process.env.PRICING_FROM === undefined ? {} : { from: process.env.PRICING_FROM }),
    ...(process.env.PRICING_TO === undefined ? {} : { to: process.env.PRICING_TO })
  });
  return {
    totalDecisions: rows.length,
    countByReviewDecision: countBy(rows, (row) => row.reviewDecision),
    sampleRows: rows.slice(0, 10)
  };
}

export function formatPricingReviewDecisionsInspection(inspection: PricingReviewDecisionsInspection): string {
  return [
    `total_decisions=${inspection.totalDecisions}`,
    `count_by_review_decision=${JSON.stringify(inspection.countByReviewDecision)}`,
    "sample_rows:",
    ...formatRows(inspection.sampleRows)
  ].join("\n");
}

function formatRows(rows: PricingReviewDecisionStoredRecord[]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.targetId} ${row.stayDate} recommended_price=${row.recommendedPriceJpy ?? "null"} approval_status=${row.approvalStatus} review_decision=${row.reviewDecision} reviewer_note=${row.reviewerNote ?? ""}`
  );
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

if (process.argv[1]?.endsWith("inspectPricingReviewDecisions.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatPricingReviewDecisionsInspection(inspectPricingReviewDecisions(db)));
  } finally {
    closeDatabase(db);
  }
}
