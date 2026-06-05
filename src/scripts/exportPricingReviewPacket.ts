import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import {
  buildPricingReviewPacket,
  type PricingReviewPacket,
  type PricingReviewPacketRow
} from "../services/buildPricingReviewPacket";

const DEFAULT_EXPORT_DIR = ".data/exports/pricing-review";
const CSV_HEADERS = [
  "target_id",
  "stay_date",
  "priority",
  "approval_status",
  "recommended_price_jpy",
  "confidence",
  "raw_market_median_jpy",
  "quality_adjusted_market_median_jpy",
  "baseline_adr_jpy",
  "audit_flags",
  "approval_reasons",
  "recommendation_reason",
  "review_decision",
  "reviewer_note"
] as const;

export interface PricingReviewExportResult {
  markdownPath: string;
  csvPath: string;
  totalRows: number;
  countByApprovalStatus: Record<string, number>;
  countByConfidence: Record<string, number>;
  autoApprovedCount: number;
  needsReviewCount: number;
  rejectedCount: number;
}

export function exportPricingReviewPacket(
  db: LocalDatabase,
  input: { exportDir?: string; timestamp?: Date } = {}
): PricingReviewExportResult {
  executeMigration(db);
  const timestamp = input.timestamp ?? new Date();
  const filenameStamp = formatTimestampForFilename(timestamp);
  const exportDir = input.exportDir ?? DEFAULT_EXPORT_DIR;
  mkdirSync(exportDir, { recursive: true });

  const packet = buildPricingReviewPacket(db, {
    generatedAt: timestamp.toISOString()
  });
  const markdownPath = join(exportDir, `pricing_review_packet_${filenameStamp}.md`);
  const csvPath = join(exportDir, `pricing_review_packet_${filenameStamp}.csv`);

  writeFileSync(markdownPath, renderPricingReviewMarkdown(packet));
  writeFileSync(csvPath, renderPricingReviewCsv(packet.rows));

  return {
    markdownPath,
    csvPath,
    totalRows: packet.rows.length,
    countByApprovalStatus: packet.countByApprovalStatus,
    countByConfidence: packet.countByConfidence,
    autoApprovedCount: packet.countByApprovalStatus.auto_approved ?? 0,
    needsReviewCount: packet.countByApprovalStatus.needs_review ?? 0,
    rejectedCount: packet.countByApprovalStatus.rejected ?? 0
  };
}

export function formatPricingReviewExportResult(result: PricingReviewExportResult): string {
  return [
    `markdown_path=${result.markdownPath}`,
    `csv_path=${result.csvPath}`,
    `total_rows=${result.totalRows}`,
    `count_by_approval_status=${JSON.stringify(result.countByApprovalStatus)}`,
    `count_by_confidence=${JSON.stringify(result.countByConfidence)}`,
    `auto_approved_count=${result.autoApprovedCount}`,
    `needs_review_count=${result.needsReviewCount}`,
    `rejected_count=${result.rejectedCount}`
  ].join("\n");
}

export function renderPricingReviewMarkdown(packet: PricingReviewPacket): string {
  return [
    "# Pricing Recommendation Review Packet",
    "",
    `Generated: ${packet.generatedAt}`,
    `Source market: ${packet.sourceMarket}`,
    `Target count: ${packet.targetCount}`,
    `Recommendation count: ${packet.recommendationCount}`,
    `Count by approval status: ${JSON.stringify(packet.countByApprovalStatus)}`,
    `Count by confidence: ${JSON.stringify(packet.countByConfidence)}`,
    "",
    "## Summary Table",
    "",
    "| stay_date | priority | approval_status | recommended_price | confidence | raw_median | adjusted_median | audit_flags | approval_reasons |",
    "| --- | --- | --- | ---: | --- | ---: | ---: | --- | --- |",
    ...packet.rows.map(markdownSummaryRow),
    "",
    "## Auto-Approved Rows",
    "",
    ...markdownRowsForStatus(packet.rows, "auto_approved"),
    "",
    "## Needs-Review Rows",
    "",
    ...markdownRowsForStatus(packet.rows, "needs_review"),
    "",
    "## Rejected Rows",
    "",
    ...markdownRowsForStatus(packet.rows, "rejected"),
    "",
    "## Review Checklist",
    "",
    "- Confirm suspicious dates.",
    "- Confirm clamped recommendations.",
    "- Confirm fallback recommendations.",
    "- Confirm no direct upload should happen from this packet.",
    ""
  ].join("\n");
}

export function renderPricingReviewCsv(rows: PricingReviewPacketRow[]): string {
  return [
    CSV_HEADERS.join(","),
    ...rows.map((row) =>
      [
        row.targetId,
        row.stayDate,
        row.priority ?? "",
        row.approvalStatus,
        row.recommendedPriceJpy ?? "",
        row.confidence,
        row.rawMarketMedianJpy ?? "",
        row.qualityAdjustedMarketMedianJpy ?? "",
        row.baselineAdrJpy,
        row.auditFlags.join(";"),
        row.approvalReasons.join(";"),
        row.recommendationReason,
        row.reviewDecision,
        row.reviewerNote
      ]
        .map(csvEscape)
        .join(",")
    )
  ].join("\n");
}

function markdownSummaryRow(row: PricingReviewPacketRow): string {
  return `| ${row.stayDate} | ${row.priority ?? ""} | ${row.approvalStatus} | ${row.recommendedPriceJpy ?? ""} | ${row.confidence} | ${row.rawMarketMedianJpy ?? ""} | ${row.qualityAdjustedMarketMedianJpy ?? ""} | ${row.auditFlags.join(";") || "none"} | ${row.approvalReasons.join(";") || "none"} |`;
}

function markdownRowsForStatus(rows: PricingReviewPacketRow[], status: PricingReviewPacketRow["approvalStatus"]): string[] {
  const matching = rows.filter((row) => row.approvalStatus === status);
  if (matching.length === 0) return ["No rows."];
  return matching.map(
    (row) =>
      `- ${row.targetId} ${row.stayDate}: recommended=${row.recommendedPriceJpy ?? "null"}, confidence=${row.confidence}, reasons=${row.approvalReasons.join(";") || "none"}`
  );
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

if (process.argv[1]?.endsWith("exportPricingReviewPacket.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatPricingReviewExportResult(exportPricingReviewPacket(db)));
  } finally {
    closeDatabase(db);
  }
}
