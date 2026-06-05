import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import {
  buildApprovedRecommendationPreview,
  type ApprovedRecommendationPreviewRow
} from "../services/buildApprovedRecommendationPreview";

export interface ApprovedPreviewInspection {
  approvedRowsCount: number;
  countByPriority: Record<string, number>;
  countByConfidence: Record<string, number>;
  sampleRows: ApprovedRecommendationPreviewRow[];
}

/** Rebuilds the approved preview in memory (read-only) and summarizes it. No DB writes. */
export function inspectApprovedRecommendationPreview(db: LocalDatabase): ApprovedPreviewInspection {
  executeMigration(db);
  const preview = buildApprovedRecommendationPreview(db, {
    ...(process.env.PRICING_SOURCE_MARKET === undefined ? {} : { sourceMarket: process.env.PRICING_SOURCE_MARKET })
  });
  return {
    approvedRowsCount: preview.approvedRowsCount,
    countByPriority: preview.countByPriority,
    countByConfidence: preview.countByConfidence,
    sampleRows: preview.rows.slice(0, 10)
  };
}

export function formatApprovedPreviewInspection(inspection: ApprovedPreviewInspection): string {
  return [
    `approved_rows_count=${inspection.approvedRowsCount}`,
    `count_by_priority=${JSON.stringify(inspection.countByPriority)}`,
    `count_by_confidence=${JSON.stringify(inspection.countByConfidence)}`,
    "sample_rows:",
    ...formatRows(inspection.sampleRows)
  ].join("\n");
}

function formatRows(rows: ApprovedRecommendationPreviewRow[]): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map(
    (row) =>
      `  ${row.targetId} ${row.stayDate} priority=${row.priority ?? ""} recommended_price=${row.recommendedPriceJpy} approval_status=${row.approvalStatus} confidence=${row.confidence} reviewer_note=${row.reviewerNote}`
  );
}

if (process.argv[1]?.endsWith("inspectApprovedRecommendationPreview.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatApprovedPreviewInspection(inspectApprovedRecommendationPreview(db)));
  } finally {
    closeDatabase(db);
  }
}
