import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { listPricingRecommendationApprovals } from "../db/repositories/pricingRecommendationApprovalsRepository";
import type { PricingRecommendationApprovalRecord } from "../services/pricingRecommendationApproval";

interface ApprovalInspectionRow extends PricingRecommendationApprovalRecord {
  recommendedPriceJpy: number | null;
  confidence: string | null;
}

export interface PricingApprovalInspection {
  totalApprovals: number;
  countByStatus: Record<string, number>;
  countByReason: Record<string, number>;
  sampleRows: ApprovalInspectionRow[];
}

export function inspectPricingRecommendationApprovals(db: LocalDatabase): PricingApprovalInspection {
  executeMigration(db);
  const approvals = listPricingRecommendationApprovals(db, {
    sourceMarket: process.env.PRICING_SOURCE_MARKET ?? "jalan",
    ...(process.env.PRICING_FROM === undefined ? {} : { from: process.env.PRICING_FROM }),
    ...(process.env.PRICING_TO === undefined ? {} : { to: process.env.PRICING_TO })
  });
  const rows = approvals.slice(0, 10).map((approval) => ({
    ...approval,
    ...recommendationContext(db, approval.recommendationId)
  }));
  return {
    totalApprovals: approvals.length,
    countByStatus: countBy(approvals, (approval) => approval.approvalStatus),
    countByReason: countReasons(approvals),
    sampleRows: rows
  };
}

export function formatPricingApprovalInspection(inspection: PricingApprovalInspection): string {
  return [
    `total_approvals=${inspection.totalApprovals}`,
    `count_by_status=${JSON.stringify(inspection.countByStatus)}`,
    `count_by_reason=${JSON.stringify(inspection.countByReason)}`,
    "sample_rows:",
    ...formatRows(inspection.sampleRows)
  ].join("\n");
}

function recommendationContext(
  db: LocalDatabase,
  recommendationId: string
): { recommendedPriceJpy: number | null; confidence: string | null } {
  const row = db
    .prepare("SELECT recommended_price_jpy, confidence FROM pricing_recommendations WHERE id = ?")
    .get(recommendationId) as { recommended_price_jpy: number | null; confidence: string } | undefined;
  return {
    recommendedPriceJpy: row?.recommended_price_jpy ?? null,
    confidence: row?.confidence ?? null
  };
}

function formatRows(rows: ApprovalInspectionRow[]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.targetId} ${row.stayDate} recommended=${row.recommendedPriceJpy ?? "null"} confidence=${row.confidence ?? "null"} status=${row.approvalStatus} reasons=${row.reasons.join(",")} audit_flags=${row.auditFlags.join(",") || "none"}`
  );
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function countReasons(rows: PricingRecommendationApprovalRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const reason of row.reasons) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts;
}

if (process.argv[1]?.endsWith("inspectPricingRecommendationApprovals.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatPricingApprovalInspection(inspectPricingRecommendationApprovals(db)));
  } finally {
    closeDatabase(db);
  }
}
