import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import {
  buildDpSafeMarketSignals,
  type DpSafeSignalRow,
  type DpSignalUseClass
} from "../services/buildDpSafeMarketSignals";

const DEFAULT_REPORT_DIR = ".data/reports/market-update";

// DP-safe CSV is an analyst review artifact only. It MUST NOT contain any
// PMS/OTA upload columns (roomid, inventory, multiplier, price1-4, beds24,
// airhost, upload). The header below is the complete allowed schema.
export const DP_SAFE_CSV_HEADERS = [
  "stay_date",
  "confidence",
  "raw_median_jpy",
  "quality_adjusted_median_jpy",
  "dp_safe_median_jpy",
  "use_class",
  "available_count",
  "failed_count",
  "excluded_quality_rows_count",
  "reason",
  "warning_flags"
] as const;

export interface DpSafeReportResult {
  markdownPath: string;
  csvPath: string;
  totalRows: number;
  countByUseClass: Record<DpSignalUseClass, number>;
  countByConfidence: Record<string, number>;
}

export function buildDpSafeMarketSignalReport(
  db: LocalDatabase,
  input: { reportDir?: string; timestamp?: Date } = {}
): DpSafeReportResult {
  executeMigration(db);
  const timestamp = input.timestamp ?? new Date();
  const filenameStamp = formatTimestampForFilename(timestamp);
  const reportDir = input.reportDir ?? DEFAULT_REPORT_DIR;
  mkdirSync(reportDir, { recursive: true });

  const rows = buildDpSafeMarketSignals(db);
  const markdownPath = join(reportDir, `dp_safe_market_signal_report_${filenameStamp}.md`);
  const csvPath = join(reportDir, `dp_safe_market_signals_${filenameStamp}.csv`);

  writeFileSync(markdownPath, renderDpSafeMarkdown(rows, timestamp.toISOString()));
  writeFileSync(csvPath, renderDpSafeCsv(rows));

  return {
    markdownPath,
    csvPath,
    totalRows: rows.length,
    countByUseClass: countByUseClass(rows),
    countByConfidence: countBy(rows, (row) => row.confidence)
  };
}

export function renderDpSafeCsv(rows: DpSafeSignalRow[]): string {
  return [
    DP_SAFE_CSV_HEADERS.join(","),
    ...rows.map((row) =>
      [
        row.stayDate,
        row.confidence,
        row.rawMedianJpy ?? "",
        row.adjustedMedianJpy ?? "",
        row.dpSafeMedianJpy ?? "",
        row.useClass,
        row.availableCount,
        row.failedCount,
        row.excludedQualityRowsCount,
        row.reason,
        row.warningFlags.join(";")
      ]
        .map(csvEscape)
        .join(",")
    )
  ].join("\n");
}

export function renderDpSafeMarkdown(rows: DpSafeSignalRow[], generatedAt: string): string {
  const useClassCounts = countByUseClass(rows);
  const confidenceCounts = countBy(rows, (row) => row.confidence);

  return [
    "# DP-Safe Market Signal Report",
    "",
    "## 1. Run Identity",
    "",
    `- Generated: ${generatedAt}`,
    "- Source: jalan",
    "- Postal code: 990-2301",
    "- Mode: non-destructive read-only derivation (no snapshots written or deleted)",
    "",
    "## 2. Purpose",
    "",
    "DP-safe gating layer over the market signals. Each stay date is classified",
    "as `use_directly`, `use_directionally`, or `exclude` for dynamic pricing, and",
    "a `dp_safe_median` is computed that drops coupon-as-price / suspicious-basis /",
    "per-person-mismatch rows while keeping legitimate premium outliers in the raw",
    "sample (flagged for mid-tier review).",
    "",
    "## 3. Totals",
    "",
    `- Total dates assessed: ${rows.length}`,
    `- use_directly: ${useClassCounts.use_directly}`,
    `- use_directionally: ${useClassCounts.use_directionally}`,
    `- exclude: ${useClassCounts.exclude}`,
    "",
    "## 4. Confidence Distribution",
    "",
    ...Object.entries(confidenceCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([confidence, count]) => `- ${confidence}: ${count}`),
    "",
    "## 5. Use-Class Distribution",
    "",
    `- use_directly: ${useClassCounts.use_directly}`,
    `- use_directionally: ${useClassCounts.use_directionally}`,
    `- exclude: ${useClassCounts.exclude}`,
    "",
    "## 6. Summary Table",
    "",
    "| stay_date | conf | raw_median | adj_median | dp_safe_median | use_class | avail | failed | excl_quality | warnings |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |",
    ...rows.map(markdownSummaryRow),
    "",
    "## 7. use_directly Dates",
    "",
    ...markdownRowsForClass(rows, "use_directly"),
    "",
    "## 8. use_directionally Dates",
    "",
    ...markdownRowsForClass(rows, "use_directionally"),
    "",
    "## 9. Excluded Dates",
    "",
    ...markdownRowsForClass(rows, "exclude"),
    "",
    "## 10. Quality Exclusion Detail",
    "",
    ...qualityExclusionDetail(rows),
    "",
    "## 11. Classification Rules",
    "",
    "- confidence A + non-null dp_safe_median -> use_directly",
    "- confidence A + all rows excluded by quality -> exclude",
    "- confidence B + non-null dp_safe_median -> use_directionally",
    "- confidence C -> exclude (single-sample, not DP-safe)",
    "- insufficient -> exclude (no usable sample)",
    "- dp_safe_median excludes: coupon-suspected rows, price_basis_suspicious rows,",
    "  per_person_or_basis_mismatch rows. Premium high-market rows are kept but",
    "  carry a warning flag for mid-tier DP review.",
    "",
    "## 12. Non-Goals & Guardrails",
    "",
    "- No Beds24 CSV generated. No AirHost XLSX generated. No prices uploaded or applied.",
    "- This CSV contains NO roomid / inventory / multiplier / price1-4 / beds24 / airhost / upload columns.",
    "- No raw snapshots were modified or deleted. No paid sources used.",
    ""
  ].join("\n");
}

export function formatDpSafeReportResult(result: DpSafeReportResult): string {
  return [
    `markdown_path=${result.markdownPath}`,
    `csv_path=${result.csvPath}`,
    `total_rows=${result.totalRows}`,
    `count_by_use_class=${JSON.stringify(result.countByUseClass)}`,
    `count_by_confidence=${JSON.stringify(result.countByConfidence)}`
  ].join("\n");
}

function markdownSummaryRow(row: DpSafeSignalRow): string {
  return `| ${row.stayDate} | ${row.confidence} | ${row.rawMedianJpy ?? ""} | ${row.adjustedMedianJpy ?? ""} | ${row.dpSafeMedianJpy ?? ""} | ${row.useClass} | ${row.availableCount} | ${row.failedCount} | ${row.excludedQualityRowsCount} | ${row.warningFlags.join(";") || "none"} |`;
}

function markdownRowsForClass(rows: DpSafeSignalRow[], useClass: DpSignalUseClass): string[] {
  const matching = rows.filter((row) => row.useClass === useClass);
  if (matching.length === 0) return ["No rows."];
  return matching.map(
    (row) =>
      `- ${row.stayDate}: dp_safe_median=${row.dpSafeMedianJpy ?? "null"}, confidence=${row.confidence}, reason=${row.reason}`
  );
}

function qualityExclusionDetail(rows: DpSafeSignalRow[]): string[] {
  const withExclusions = rows.filter((row) => row.excludedQualityRowsCount > 0 || row.warningFlags.length > 0);
  if (withExclusions.length === 0) return ["No quality exclusions or warnings."];
  return withExclusions.map(
    (row) =>
      `- ${row.stayDate}: excluded_quality_rows=${row.excludedQualityRowsCount}, warnings=${row.warningFlags.join(";") || "none"}`
  );
}

function countByUseClass(rows: DpSafeSignalRow[]): Record<DpSignalUseClass, number> {
  const counts: Record<DpSignalUseClass, number> = { use_directly: 0, use_directionally: 0, exclude: 0 };
  for (const row of rows) {
    counts[row.useClass] += 1;
  }
  return counts;
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
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

if (process.argv[1]?.endsWith("buildDpSafeMarketSignalReport.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatDpSafeReportResult(buildDpSafeMarketSignalReport(db)));
  } finally {
    closeDatabase(db);
  }
}
