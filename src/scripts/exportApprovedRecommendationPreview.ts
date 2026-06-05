import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import {
  buildApprovedRecommendationPreview,
  type ApprovedRecommendationPreview,
  type ApprovedRecommendationPreviewRow
} from "../services/buildApprovedRecommendationPreview";

const DEFAULT_EXPORT_DIR = ".data/exports/approved-preview";

// Preview-only columns. Deliberately excludes roomid / inventory / multiplier / priceN
// and any Beds24 or AirHost columns: this file is for human confirmation, not upload.
export const PREVIEW_CSV_HEADERS = [
  "target_id",
  "stay_date",
  "priority",
  "recommended_price_jpy",
  "approval_status",
  "review_decision",
  "confidence",
  "recommendation_reason",
  "reviewer_note",
  "source_market"
] as const;

export const PREVIEW_ONLY_WARNING =
  "WARNING: preview only. This is NOT an upload format and must NOT be sent to Beds24 or AirHost. No prices are applied by this file.";

export interface ApprovedPreviewExportResult {
  markdownPath: string;
  csvPath: string;
  approvedRowsCount: number;
  skippedNonApprovedCount: number;
  skippedNullPriceCount: number;
  countByPriority: Record<string, number>;
  countByConfidence: Record<string, number>;
}

export function exportApprovedRecommendationPreview(
  db: LocalDatabase,
  input: { exportDir?: string; timestamp?: Date; sourceMarket?: string } = {}
): ApprovedPreviewExportResult {
  executeMigration(db);
  const timestamp = input.timestamp ?? new Date();
  const filenameStamp = formatTimestampForFilename(timestamp);
  const exportDir = input.exportDir ?? DEFAULT_EXPORT_DIR;
  mkdirSync(exportDir, { recursive: true });

  const preview = buildApprovedRecommendationPreview(db, {
    generatedAt: timestamp.toISOString(),
    ...(input.sourceMarket === undefined ? {} : { sourceMarket: input.sourceMarket })
  });

  const markdownPath = join(exportDir, `approved_recommendation_preview_${filenameStamp}.md`);
  const csvPath = join(exportDir, `approved_recommendation_preview_${filenameStamp}.csv`);

  writeFileSync(markdownPath, renderApprovedPreviewMarkdown(preview));
  writeFileSync(csvPath, renderApprovedPreviewCsv(preview.rows));

  return {
    markdownPath,
    csvPath,
    approvedRowsCount: preview.approvedRowsCount,
    skippedNonApprovedCount: preview.skippedNonApprovedCount,
    skippedNullPriceCount: preview.skippedNullPriceCount,
    countByPriority: preview.countByPriority,
    countByConfidence: preview.countByConfidence
  };
}

export function formatApprovedPreviewExportResult(result: ApprovedPreviewExportResult): string {
  return [
    `markdown_path=${result.markdownPath}`,
    `csv_path=${result.csvPath}`,
    `approved_rows_count=${result.approvedRowsCount}`,
    `skipped_non_approved_count=${result.skippedNonApprovedCount}`,
    `skipped_null_price_count=${result.skippedNullPriceCount}`,
    `count_by_priority=${JSON.stringify(result.countByPriority)}`,
    `count_by_confidence=${JSON.stringify(result.countByConfidence)}`
  ].join("\n");
}

export function renderApprovedPreviewMarkdown(preview: ApprovedRecommendationPreview): string {
  return [
    "# Approved Recommendation Export Preview",
    "",
    `Generated: ${preview.generatedAt}`,
    `Source market: ${preview.sourceMarket}`,
    `Total approved rows: ${preview.approvedRowsCount}`,
    `Count by priority: ${JSON.stringify(preview.countByPriority)}`,
    `Count by confidence: ${JSON.stringify(preview.countByConfidence)}`,
    "",
    `> ${PREVIEW_ONLY_WARNING}`,
    "",
    "## Approved Rows",
    "",
    "| target_id | stay_date | priority | recommended_price_jpy | approval_status | confidence | recommendation_reason | reviewer_note | source_market |",
    "| --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
    ...(preview.rows.length === 0 ? ["| (no approved rows) |  |  |  |  |  |  |  |  |"] : preview.rows.map(markdownRow)),
    "",
    "## Confirmation Checklist",
    "",
    "- [ ] Confirm prices manually.",
    "- [ ] Confirm date range.",
    "- [ ] Confirm no pending / needs_change rows are included.",
    "- [ ] Confirm this is NOT a Beds24 / AirHost upload file.",
    ""
  ].join("\n");
}

export function renderApprovedPreviewCsv(rows: ApprovedRecommendationPreviewRow[]): string {
  return [
    PREVIEW_CSV_HEADERS.join(","),
    ...rows.map((row) =>
      [
        row.targetId,
        row.stayDate,
        row.priority ?? "",
        row.recommendedPriceJpy,
        row.approvalStatus,
        row.reviewDecision,
        row.confidence,
        row.recommendationReason,
        row.reviewerNote,
        row.sourceMarket
      ]
        .map(csvEscape)
        .join(",")
    )
  ].join("\n");
}

function markdownRow(row: ApprovedRecommendationPreviewRow): string {
  return `| ${row.targetId} | ${row.stayDate} | ${row.priority ?? ""} | ${row.recommendedPriceJpy} | ${row.approvalStatus} | ${row.confidence} | ${row.recommendationReason} | ${row.reviewerNote} | ${row.sourceMarket} |`;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatTimestampForFilename(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

if (process.argv[1]?.endsWith("exportApprovedRecommendationPreview.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatApprovedPreviewExportResult(exportApprovedRecommendationPreview(db)));
  } finally {
    closeDatabase(db);
  }
}
