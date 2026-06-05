// Phase M02X — Local history schema design (monthly shard plan).
//
// Designs and prototypes the local history schema that will eventually store
// daily cross-source market signals in monthly shard CSV files
// (.data/history/zao_signals_YYYY_MM.csv). DESIGN / PROTOTYPE ONLY.
//
// NO DB writes. NO GitHub Actions. NO GitOps. No actual .data/history append.
// No base × 1.1. No PMS/Beds24/AirHost columns.

import { createHash } from "node:crypto";
import { type UnifiedMarketSignalRow } from "./crossSourceMarketSignalNormalization";

export const HISTORY_SCHEMA_VERSION = "zao_local_history_v1";

export type HistorySource = "jalan" | "rakuten" | "booking";

const ALLOWED_SOURCES: ReadonlySet<string> = new Set(["jalan", "rakuten", "booking"]);
const ALLOWED_BASIS_CONFIDENCE: ReadonlySet<string> = new Set(["A", "B", "C", "none", "insufficient"]);

// Columns that must never appear in the local history schema.
export const FORBIDDEN_COLUMNS: readonly string[] = [
  "roomid",
  "inventory",
  "minstay",
  "maxstay",
  "multiplier",
  "price1",
  "price2",
  "price3",
  "price4",
  "price5",
  "tax_multiplier",
  "tax_included_price",
  "tax_normalization_rule",
  "beds24",
  "airhost",
  "pms"
];

export interface HistoryRow {
  rowId: string;
  rowHash: string;
  shardMonth: string;
  collectedDateJst: string;
  collectedAtJst: string;
  normalizedAtJst: string;
  source: string;
  sourcePhase: string;
  collectorStage: string;
  canonicalPropertyName: string;
  sourcePropertyName: string;
  propertyIdentityMatch: boolean;
  sourcePropertyId: string;
  sourceSlugOrCode: string;
  checkin: string;
  checkout: string;
  stayNights: number;
  groupAdults: number;
  noRooms: number;
  groupChildren: number;
  currency: string;
  language: string;
  stayScope: string;
  availabilityStatus: string;
  soldOutStatus: string;
  normalizedTotalPrice: number | null;
  normalizedTotalPriceSource: string | null;
  normalizedTotalPriceBasis: string;
  normalizedTotalPriceConfidence: string;
  basisConfidence: string;
  basisNote: string;
  sourcePrimaryPrice: number | null;
  sourceSecondaryPriceOrAdder: number | null;
  sourceComputedTotal: number | null;
  sourceTaxOrFeeClassification: string;
  sourceClassification: string;
  isPriceUsableForDpDirect: boolean;
  isPriceUsableForDpDirectional: boolean;
  isPriceExcludedFromDp: boolean;
  dpExclusionReason: string | null;
  warningFlags: string;
  sourceReportPath: string;
  sourceCsvPath: string;
  debugArtifactPath: string;
  schemaVersion: string;
}

// Stable column order for monthly shard CSV files.
export const HISTORY_CSV_HEADERS = [
  "row_id",
  "row_hash",
  "shard_month",
  "collected_date_jst",
  "collected_at_jst",
  "normalized_at_jst",
  "source",
  "source_phase",
  "collector_stage",
  "canonical_property_name",
  "source_property_name",
  "property_identity_match",
  "source_property_id",
  "source_slug_or_code",
  "checkin",
  "checkout",
  "stay_nights",
  "group_adults",
  "no_rooms",
  "group_children",
  "currency",
  "language",
  "stay_scope",
  "availability_status",
  "sold_out_status",
  "normalized_total_price",
  "normalized_total_price_source",
  "normalized_total_price_basis",
  "normalized_total_price_confidence",
  "basis_confidence",
  "basis_note",
  "source_primary_price",
  "source_secondary_price_or_adder",
  "source_computed_total",
  "source_tax_or_fee_classification",
  "source_classification",
  "is_price_usable_for_dp_direct",
  "is_price_usable_for_dp_directional",
  "is_price_excluded_from_dp",
  "dp_exclusion_reason",
  "warning_flags",
  "source_report_path",
  "source_csv_path",
  "debug_artifact_path",
  "schema_version"
] as const;

// ---------------------------------------------------------------------------
// Shard month
// ---------------------------------------------------------------------------

export function shardMonthFromCheckin(checkin: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/u.exec(checkin.trim());
  if (!match) return "unknown";
  return `${match[1]}_${match[2]}`;
}

export function futureShardPath(shardMonth: string): string {
  return `.data/history/zao_signals_${shardMonth}.csv`;
}

// ---------------------------------------------------------------------------
// Row identity & hash
// ---------------------------------------------------------------------------

export function buildRowId(parts: {
  collectedDateJst: string;
  source: string;
  canonicalPropertyName: string;
  sourceSlugOrCode: string;
  sourcePropertyId: string;
  checkin: string;
  checkout: string;
  stayScope: string;
}): string {
  const identityToken =
    parts.sourceSlugOrCode.trim() || parts.sourcePropertyId.trim() || "market_aggregate";
  return [
    parts.collectedDateJst,
    parts.source,
    parts.canonicalPropertyName,
    identityToken,
    parts.checkin,
    parts.checkout,
    parts.stayScope
  ].join("|");
}

// Hash stable identity + market value fields. Excludes debug/artifact paths so
// that re-running normalization (which rotates timestamped debug paths) does
// not change the hash when the underlying market values are unchanged.
export function buildRowHash(row: {
  source: string;
  sourcePhase: string;
  collectorStage: string;
  canonicalPropertyName: string;
  sourceSlugOrCode: string;
  sourcePropertyId: string;
  checkin: string;
  checkout: string;
  stayScope: string;
  collectedDateJst: string;
  availabilityStatus: string;
  soldOutStatus: string;
  normalizedTotalPrice: number | null;
  basisConfidence: string;
  sourceClassification: string;
  isPriceUsableForDpDirect: boolean;
  isPriceUsableForDpDirectional: boolean;
  isPriceExcludedFromDp: boolean;
}): string {
  const identityToken = row.sourceSlugOrCode.trim() || row.sourcePropertyId.trim() || "market_aggregate";
  const stable = [
    row.source,
    row.sourcePhase,
    row.collectorStage,
    row.canonicalPropertyName,
    identityToken,
    row.checkin,
    row.checkout,
    row.stayScope,
    row.collectedDateJst,
    row.availabilityStatus,
    row.soldOutStatus,
    row.normalizedTotalPrice === null ? "null" : String(row.normalizedTotalPrice),
    row.basisConfidence,
    row.sourceClassification,
    String(row.isPriceUsableForDpDirect),
    String(row.isPriceUsableForDpDirectional),
    String(row.isPriceExcludedFromDp)
  ].join("|");
  return createHash("sha256").update(stable).digest("hex");
}

// ---------------------------------------------------------------------------
// Mapping M01X unified row → history row
// ---------------------------------------------------------------------------

export function mapUnifiedRowToHistoryRow(unified: UnifiedMarketSignalRow): HistoryRow {
  // The unified row carries a single normalization timestamp; in this prototype
  // it is the best available collection-day marker for dedupe keying.
  const collectedAtJst = unified.normalizedAtJst;
  const collectedDateJst = collectedAtJst.slice(0, 10);
  const shardMonth = shardMonthFromCheckin(unified.checkin);

  const rowId = buildRowId({
    collectedDateJst,
    source: unified.source,
    canonicalPropertyName: unified.canonicalPropertyName,
    sourceSlugOrCode: unified.sourceSlugOrCode,
    sourcePropertyId: unified.sourcePropertyId,
    checkin: unified.checkin,
    checkout: unified.checkout,
    stayScope: unified.stayScope
  });

  const rowHash = buildRowHash({
    source: unified.source,
    sourcePhase: unified.sourcePhase,
    collectorStage: unified.collectorStage,
    canonicalPropertyName: unified.canonicalPropertyName,
    sourceSlugOrCode: unified.sourceSlugOrCode,
    sourcePropertyId: unified.sourcePropertyId,
    checkin: unified.checkin,
    checkout: unified.checkout,
    stayScope: unified.stayScope,
    collectedDateJst,
    availabilityStatus: unified.availabilityStatus,
    soldOutStatus: unified.soldOutStatus,
    normalizedTotalPrice: unified.normalizedTotalPrice,
    basisConfidence: unified.basisConfidence,
    sourceClassification: unified.sourceClassification,
    isPriceUsableForDpDirect: unified.isPriceUsableForDpDirect,
    isPriceUsableForDpDirectional: unified.isPriceUsableForDpDirectional,
    isPriceExcludedFromDp: unified.isPriceExcludedFromDp
  });

  return {
    rowId,
    rowHash,
    shardMonth,
    collectedDateJst,
    collectedAtJst,
    normalizedAtJst: unified.normalizedAtJst,
    source: unified.source,
    sourcePhase: unified.sourcePhase,
    collectorStage: unified.collectorStage,
    canonicalPropertyName: unified.canonicalPropertyName,
    sourcePropertyName: unified.sourcePropertyName,
    propertyIdentityMatch: unified.propertyIdentityMatch,
    sourcePropertyId: unified.sourcePropertyId,
    sourceSlugOrCode: unified.sourceSlugOrCode,
    checkin: unified.checkin,
    checkout: unified.checkout,
    stayNights: unified.stayNights,
    groupAdults: unified.groupAdults,
    noRooms: unified.noRooms,
    groupChildren: unified.groupChildren,
    currency: unified.currency,
    language: unified.language,
    stayScope: unified.stayScope,
    availabilityStatus: unified.availabilityStatus,
    soldOutStatus: unified.soldOutStatus,
    normalizedTotalPrice: unified.normalizedTotalPrice,
    normalizedTotalPriceSource: unified.normalizedTotalPriceSource,
    normalizedTotalPriceBasis: unified.normalizedTotalPriceBasis,
    normalizedTotalPriceConfidence: unified.normalizedTotalPriceConfidence,
    basisConfidence: unified.basisConfidence,
    basisNote: unified.basisNote,
    sourcePrimaryPrice: unified.sourcePrimaryPrice,
    sourceSecondaryPriceOrAdder: unified.sourceSecondaryPriceOrAdder,
    sourceComputedTotal: unified.sourceComputedTotal,
    sourceTaxOrFeeClassification: unified.sourceTaxOrFeeClassification,
    sourceClassification: unified.sourceClassification,
    isPriceUsableForDpDirect: unified.isPriceUsableForDpDirect,
    isPriceUsableForDpDirectional: unified.isPriceUsableForDpDirectional,
    isPriceExcludedFromDp: unified.isPriceExcludedFromDp,
    dpExclusionReason: unified.dpExclusionReason,
    warningFlags: unified.warningFlags,
    sourceReportPath: unified.sourceReportPath,
    sourceCsvPath: unified.sourceCsvPath,
    debugArtifactPath: unified.debugArtifactPath,
    schemaVersion: HISTORY_SCHEMA_VERSION
  };
}

export function mapUnifiedRowsToHistoryRows(rows: UnifiedMarketSignalRow[]): HistoryRow[] {
  return rows.map(mapUnifiedRowToHistoryRow);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateHistorySchemaColumns(columns: string[]): string[] {
  const errors: string[] = [];
  const lower = columns.map((c) => c.toLowerCase());
  for (const forbidden of FORBIDDEN_COLUMNS) {
    if (lower.some((c) => c === forbidden || c.includes(forbidden))) {
      errors.push(`forbidden_column:${forbidden}`);
    }
  }
  for (const required of HISTORY_CSV_HEADERS) {
    if (!columns.includes(required)) errors.push(`missing_column:${required}`);
  }
  return errors;
}

export function validateHistoryRow(row: HistoryRow): string[] {
  const errors: string[] = [];
  if (!row.rowId || row.rowId.trim() === "") errors.push("row_id_empty");
  if (!row.rowHash || row.rowHash.trim() === "") errors.push("row_hash_empty");
  if (!ALLOWED_SOURCES.has(row.source)) errors.push(`invalid_source:${row.source}`);

  if (row.checkin.trim() !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(row.checkin)) {
      errors.push(`invalid_checkin:${row.checkin}`);
    } else if (row.shardMonth !== shardMonthFromCheckin(row.checkin)) {
      errors.push(`shard_month_mismatch:${row.shardMonth}!=${shardMonthFromCheckin(row.checkin)}`);
    }
  } else if (row.shardMonth !== "unknown") {
    errors.push(`shard_month_should_be_unknown:${row.shardMonth}`);
  }

  if (row.isPriceUsableForDpDirect && row.isPriceExcludedFromDp) {
    errors.push("direct_and_excluded");
  }
  if (row.isPriceUsableForDpDirectional && row.isPriceExcludedFromDp) {
    errors.push("directional_and_excluded");
  }

  const price: unknown = row.normalizedTotalPrice;
  if (!(price === null || (typeof price === "number" && Number.isFinite(price)))) {
    errors.push(`normalized_total_price_not_numeric:${String(price)}`);
  }

  if (!ALLOWED_BASIS_CONFIDENCE.has(row.basisConfidence)) {
    errors.push(`invalid_basis_confidence:${row.basisConfidence}`);
  }

  if (row.source === "booking") {
    const tax = row.sourceTaxOrFeeClassification.toLowerCase();
    if (/tax_multiplier|tax_included_price|tax_normalization_rule/u.test(tax)) {
      errors.push("booking_deprecated_tax_field");
    }
  }

  return errors;
}

export interface ValidationSummary {
  rowCount: number;
  validRowCount: number;
  invalidRowCount: number;
  errorCounts: Record<string, number>;
  invalidRows: { rowId: string; errors: string[] }[];
}

export function validateHistoryRows(rows: HistoryRow[]): ValidationSummary {
  const errorCounts: Record<string, number> = {};
  const invalidRows: { rowId: string; errors: string[] }[] = [];
  for (const row of rows) {
    const errors = validateHistoryRow(row);
    if (errors.length > 0) {
      invalidRows.push({ rowId: row.rowId, errors });
      for (const e of errors) {
        const key = e.split(":")[0] ?? e;
        errorCounts[key] = (errorCounts[key] ?? 0) + 1;
      }
    }
  }
  return {
    rowCount: rows.length,
    validRowCount: rows.length - invalidRows.length,
    invalidRowCount: invalidRows.length,
    errorCounts,
    invalidRows
  };
}

// ---------------------------------------------------------------------------
// Dedupe & shard grouping
// ---------------------------------------------------------------------------

export interface DuplicateRowId {
  rowId: string;
  count: number;
  rowHashes: string[];
}

export function findDuplicateRowIds(rows: HistoryRow[]): DuplicateRowId[] {
  const byId = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const bucket = byId.get(row.rowId) ?? [];
    bucket.push(row);
    byId.set(row.rowId, bucket);
  }
  const out: DuplicateRowId[] = [];
  for (const [rowId, bucket] of byId) {
    if (bucket.length > 1) {
      out.push({ rowId, count: bucket.length, rowHashes: [...new Set(bucket.map((r) => r.rowHash))] });
    }
  }
  return out.sort((a, b) => a.rowId.localeCompare(b.rowId));
}

export interface ShardGroup {
  shardMonth: string;
  futureShardPath: string;
  rowCount: number;
  sourceCounts: Record<string, number>;
}

export function groupRowsByShardMonth(rows: HistoryRow[]): ShardGroup[] {
  const byShard = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const bucket = byShard.get(row.shardMonth) ?? [];
    bucket.push(row);
    byShard.set(row.shardMonth, bucket);
  }
  const out: ShardGroup[] = [];
  for (const [shardMonth, bucket] of byShard) {
    out.push({
      shardMonth,
      futureShardPath: futureShardPath(shardMonth),
      rowCount: bucket.length,
      sourceCounts: countBy(bucket.map((r) => r.source))
    });
  }
  return out.sort((a, b) => a.shardMonth.localeCompare(b.shardMonth));
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type M02XDecision =
  | "local_history_schema_design_ready"
  | "local_history_schema_design_basis_caution"
  | "local_history_schema_design_not_ready";

export function decideM02X(input: {
  rowCount: number;
  validation: ValidationSummary;
  duplicates: DuplicateRowId[];
  forbiddenColumnErrors: string[];
}): M02XDecision {
  if (input.rowCount === 0 || input.forbiddenColumnErrors.length > 0) {
    return "local_history_schema_design_not_ready";
  }
  if (input.validation.invalidRowCount > 0) {
    return "local_history_schema_design_not_ready";
  }
  if (input.duplicates.length > 0) {
    return "local_history_schema_design_basis_caution";
  }
  return "local_history_schema_design_ready";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderHistoryCsv(rows: HistoryRow[]): string {
  const body = rows.map((row) =>
    [
      row.rowId,
      row.rowHash,
      row.shardMonth,
      row.collectedDateJst,
      row.collectedAtJst,
      row.normalizedAtJst,
      row.source,
      row.sourcePhase,
      row.collectorStage,
      row.canonicalPropertyName,
      row.sourcePropertyName,
      bool(row.propertyIdentityMatch),
      row.sourcePropertyId,
      row.sourceSlugOrCode,
      row.checkin,
      row.checkout,
      String(row.stayNights),
      String(row.groupAdults),
      String(row.noRooms),
      String(row.groupChildren),
      row.currency,
      row.language,
      row.stayScope,
      row.availabilityStatus,
      row.soldOutStatus,
      numOrEmpty(row.normalizedTotalPrice),
      row.normalizedTotalPriceSource ?? "",
      row.normalizedTotalPriceBasis,
      row.normalizedTotalPriceConfidence,
      row.basisConfidence,
      row.basisNote,
      numOrEmpty(row.sourcePrimaryPrice),
      numOrEmpty(row.sourceSecondaryPriceOrAdder),
      numOrEmpty(row.sourceComputedTotal),
      row.sourceTaxOrFeeClassification,
      row.sourceClassification,
      bool(row.isPriceUsableForDpDirect),
      bool(row.isPriceUsableForDpDirectional),
      bool(row.isPriceExcludedFromDp),
      row.dpExclusionReason ?? "",
      row.warningFlags,
      row.sourceReportPath,
      row.sourceCsvPath,
      row.debugArtifactPath,
      row.schemaVersion
    ]
      .map(csvEscape)
      .join(",")
  );
  return [HISTORY_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderHistorySchemaDesignReport(input: {
  generatedAt: string;
  rows: HistoryRow[];
  decision: M02XDecision;
  validation: ValidationSummary;
  duplicates: DuplicateRowId[];
  shardGroups: ShardGroup[];
  forbiddenColumnErrors: string[];
  dpGate: { direct: number; directional: number; excluded: number };
  sourceArtifact: { reportPath: string; csvPath: string; jsonPath: string };
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}): string {
  const sourceCounts = countBy(input.rows.map((r) => r.source));
  return [
    "# Local History Schema Design (Phase M02X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Policy & safety",
    "",
    "- Design / prototype only: NO DB writes, no collector_runs/rate_snapshots/inventory_snapshots.",
    "- No production cron, no GitHub Actions, no GitOps auto-commit.",
    "- No actual .data/history/zao_signals_YYYY_MM.csv append; prototype CSV lives under reports/.",
    "- No Beds24/AirHost/PMS/OTA columns; no deprecated tax_multiplier/tax_included_price/tax_normalization_rule.",
    "- No base × 1.1; Booking totals stay official base + visible adder.",
    "",
    "## 2. Summary",
    "",
    `- decision=${input.decision}`,
    `- schema_version=${HISTORY_SCHEMA_VERSION}`,
    `- row_count=${input.rows.length}`,
    `- source_counts=${JSON.stringify(sourceCounts)}`,
    `- shard_month_count=${input.shardGroups.length}`,
    `- duplicate_row_id_count=${input.duplicates.length}`,
    `- validation_error_count=${input.validation.invalidRowCount}`,
    `- forbidden_column_errors=${input.forbiddenColumnErrors.length}`,
    `- dp_gate=${JSON.stringify(input.dpGate)}`,
    "",
    "## 3. Source M01X artifact used",
    "",
    `- report=${input.sourceArtifact.reportPath}`,
    `- csv=${input.sourceArtifact.csvPath}`,
    `- json=${input.sourceArtifact.jsonPath}`,
    "",
    "## 4. Proposed history schema (stable column order)",
    "",
    ...HISTORY_CSV_HEADERS.map((col, idx) => `${idx + 1}. ${col}`),
    "",
    "## 5. Row identity & hash strategy",
    "",
    "- row_id = `{collected_date_jst}|{source}|{canonical_property_name}|{slug_or_id_or_market_aggregate}|{checkin}|{checkout}|{stay_scope}`.",
    "- row_hash = sha256 over stable identity + market values (availability, sold_out, price, basis_confidence, classification, DP flags).",
    "- Debug/artifact paths are intentionally excluded from row_hash so rotating debug timestamps do not change the hash.",
    "",
    "## 6. Shard month plan",
    "",
    "- shard_month derived from checkin month; missing checkin → `unknown`.",
    "| shard_month | future_path | rows | sources |",
    "|---|---|---|---|",
    ...input.shardGroups.map(
      (g) => `| ${g.shardMonth} | ${g.futureShardPath} | ${g.rowCount} | ${JSON.stringify(g.sourceCounts)} |`
    ),
    "",
    "## 7. Validation summary",
    "",
    `- valid_rows=${input.validation.validRowCount}`,
    `- invalid_rows=${input.validation.invalidRowCount}`,
    `- error_counts=${JSON.stringify(input.validation.errorCounts)}`,
    "",
    "## 8. Duplicate detection",
    "",
    `- duplicate_row_id_count=${input.duplicates.length}`,
    ...(input.duplicates.length > 0
      ? input.duplicates.map((d) => `- ${d.rowId} (count=${d.count})`)
      : ["- none"]),
    "",
    "## 9. Forbidden column check",
    "",
    `- forbidden_column_errors=${input.forbiddenColumnErrors.length}`,
    ...(input.forbiddenColumnErrors.length > 0 ? input.forbiddenColumnErrors.map((e) => `- ${e}`) : ["- none"]),
    "",
    "## 10. Future history path examples",
    "",
    ...input.shardGroups.slice(0, 6).map((g) => `- ${g.futureShardPath}`),
    "",
    "## 11. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 12. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: M02XDecision): string {
  if (decision === "local_history_schema_design_ready") {
    return "- Proceed to Phase M03X local history append dry-run prototype (simulate monthly shard append under a dry-run dir, with dedupe). Keep DB writes / GitHub Actions / real .data/history writes disabled.";
  }
  if (decision === "local_history_schema_design_basis_caution") {
    return "- Duplicates detected in prototype rows; refine the dedupe key before any append work. Do not append.";
  }
  return "- Critical validation/forbidden-column errors; fix schema/validation before any append or GitOps work. Do not continue.";
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function numOrEmpty(value: number | null): string {
  return value === null ? "" : String(value);
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
