import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction, type LocalDatabase } from "../db/client";
import { upsertPricingRecommendationApproval } from "../db/repositories/pricingRecommendationApprovalsRepository";
import { listPricingRecommendations } from "../db/repositories/pricingRecommendationsRepository";
import { auditPricingRecommendationRow } from "../services/auditPricingRecommendations";
import {
  classifyPricingRecommendationApproval,
  type PricingRecommendationApprovalRecord
} from "../services/pricingRecommendationApproval";

export interface PricingApprovalSummary {
  recommendationsEvaluated: number;
  approvalsUpserted: number;
  countByStatus: Record<string, number>;
  countByReason: Record<string, number>;
  sampleRows: PricingRecommendationApprovalRecord[];
}

export function approvePricingRecommendations(
  db: LocalDatabase,
  input: { createdAt?: string } = {}
): PricingApprovalSummary {
  executeMigration(db);
  const recommendations = listPricingRecommendations(db, {
    sourceMarket: process.env.PRICING_SOURCE_MARKET ?? "jalan",
    ...(process.env.PRICING_FROM === undefined ? {} : { from: process.env.PRICING_FROM }),
    ...(process.env.PRICING_TO === undefined ? {} : { to: process.env.PRICING_TO })
  });
  const approvals = recommendations.map((recommendation) =>
    classifyPricingRecommendationApproval({
      recommendation,
      audit: auditPricingRecommendationRow(recommendation),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
    })
  );

  runInTransaction(db, () => {
    for (const approval of approvals) {
      upsertPricingRecommendationApproval(db, approval);
    }
  });

  return {
    recommendationsEvaluated: recommendations.length,
    approvalsUpserted: approvals.length,
    countByStatus: countBy(approvals, (approval) => approval.approvalStatus),
    countByReason: countReasons(approvals),
    sampleRows: approvals.slice(0, 10)
  };
}

export function formatPricingApprovalSummary(summary: PricingApprovalSummary): string {
  return [
    `recommendations_evaluated=${summary.recommendationsEvaluated}`,
    `approvals_upserted=${summary.approvalsUpserted}`,
    `count_by_status=${JSON.stringify(summary.countByStatus)}`,
    `count_by_reason=${JSON.stringify(summary.countByReason)}`,
    "sample_rows:",
    ...formatRows(summary.sampleRows)
  ].join("\n");
}

function formatRows(rows: PricingRecommendationApprovalRecord[]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.targetId} ${row.stayDate} ${row.sourceMarket} status=${row.approvalStatus} reasons=${row.reasons.join(",")} audit_flags=${row.auditFlags.join(",") || "none"}`
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

if (process.argv[1]?.endsWith("approvePricingRecommendations.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatPricingApprovalSummary(approvePricingRecommendations(db)));
  } finally {
    closeDatabase(db);
  }
}
