// Phase BOOKING-B07X — Approved Booking normalized history append (engine).
//
// Performs the APPROVED append of the B06X Booking.com proposal rows into
// .data/history. Gated by an explicit standalone approval sentence (enforced by
// the calling agent) AND the runtime env flag BOOKING_HISTORY_APPEND=1. Without
// both, it fails closed (decision=booking_history_append_ready_not_run) and
// writes nothing.
//
// This module APPENDS HISTORY ONLY. It writes NO DB rows, runs NO DB sync,
// refreshes NO AI context, runs NO live Booking probe / headless browser, emits
// NO property-management or OTA upload output, performs NO price update, and uses
// NO Booking base × 1.1 (totals are carried verbatim from B05X = official base +
// visible adder). The heavy write engine (backup / temp / atomic rename /
// rollback / post-validate) is reused from localHistoryRealAppend (M06X).

import {
  HISTORY_SCHEMA_VERSION,
  buildRowHash,
  renderHistoryCsv,
  shardMonthFromCheckin,
  type HistoryRow
} from "./localHistorySchemaDesign";

export const B07X_SOURCE_PHASE = "B05X";
export const B07X_COLLECTOR_STAGE = "prototype_read_only_b05x_broader_normalized";
export const B07X_STAY_SCOPE = "2_adults_1_room_1_night";
export const B07X_ENV_FLAG = "BOOKING_HISTORY_APPEND";
export const B07X_APPROVAL_SENTENCE =
  "Approve Phase BOOKING-B07X normalized history append. You may append the approved Booking.com B06X rows to .data/history.";

// ---------------------------------------------------------------------------
// Decision labels
// ---------------------------------------------------------------------------

export type B07XDecision =
  | "booking_history_append_ready_not_run"
  | "booking_history_append_success"
  | "booking_history_append_failed_preflight"
  | "booking_history_append_failed_conflicts"
  | "booking_history_append_failed_validation"
  | "booking_history_append_failed_write";

// ---------------------------------------------------------------------------
// 1. Approval gate
// ---------------------------------------------------------------------------

export interface BookingAppendGateInput {
  approvalSentencePresent: boolean;
  envFlag: string | undefined;
}

export interface BookingAppendGateResult {
  allowed: boolean;
  failedConditions: string[];
}

export function evaluateBookingAppendGate(input: BookingAppendGateInput): BookingAppendGateResult {
  const failed: string[] = [];
  if (!input.approvalSentencePresent) failed.push("approval_sentence_absent");
  if (input.envFlag !== "1") failed.push(`${B07X_ENV_FLAG}!=1`);
  return { allowed: failed.length === 0, failedConditions: failed };
}

// ---------------------------------------------------------------------------
// B06X proposal row (lite) + B05X full row (source of history fields)
// ---------------------------------------------------------------------------

export interface ProposalRowLite {
  row_id: string;
  history_action: string;
  append_recommendation: string;
}

const APPROVED_RECOMMENDATIONS: ReadonlySet<string> = new Set([
  "append_directional",
  "append_excluded_audit"
]);

// Select only rows the B06X proposal marked as new + approved. Anything with a
// block_conflict / do_not_append / block_until_review recommendation is held back.
export function selectApprovedRowIds(proposalRows: ProposalRowLite[]): {
  approvedRowIds: string[];
  blockedRowIds: string[];
} {
  const approvedRowIds: string[] = [];
  const blockedRowIds: string[] = [];
  for (const r of proposalRows) {
    if (r.history_action === "append_new" && APPROVED_RECOMMENDATIONS.has(r.append_recommendation)) {
      approvedRowIds.push(r.row_id);
    } else {
      blockedRowIds.push(r.row_id);
    }
  }
  return { approvedRowIds, blockedRowIds };
}

// The B05X normalized-row preview shape (a subset of the fields in the B05X JSON
// `rows[]`) — carries every field needed to reconstruct a full HistoryRow.
export interface B05XFullRow {
  row_id: string;
  row_hash: string;
  shard_month: string;
  collected_date_jst: string;
  collected_at_jst: string;
  normalized_at_jst: string;
  canonical_property_name: string;
  source_property_name: string;
  property_identity_match: boolean;
  source_property_id: string;
  source_slug_or_code: string;
  source_url: string;
  checkin_date: string;
  checkout_date: string;
  stay_nights: number;
  group_adults: number;
  no_rooms: number;
  group_children: number;
  currency: string;
  language: string;
  stay_scope: string;
  availability_status: string;
  sold_out_status: string;
  normalized_total_jpy: number | null;
  price_basis: string;
  basis_confidence: string;
  source_primary_price: number | null;
  source_official_tax_fee_adder: number | null;
  source_computed_total_with_tax_fee: number | null;
  source_tax_basis_classification: string;
  classification: string;
  dp_usage: string;
  exclusion_reason: string;
  basis_note: string;
  debug_artifact_path: string;
}

export interface ReconstructContext {
  sourceReportPath: string;
  sourceCsvPath: string;
}

// Reconstruct the full 45-column history row from a B05X normalized row. The
// dp-usage booleans mirror exactly what B05X fed into buildRowHash, so the
// re-derived row_hash will match the carried value (validated downstream).
export function reconstructHistoryRow(row: B05XFullRow, ctx: ReconstructContext): HistoryRow {
  const isDirectional = row.dp_usage === "directional";
  const isExcluded = row.dp_usage === "excluded";
  const hasTotal = row.normalized_total_jpy !== null;
  return {
    rowId: row.row_id,
    rowHash: row.row_hash,
    shardMonth: row.shard_month,
    collectedDateJst: row.collected_date_jst,
    collectedAtJst: row.collected_at_jst,
    normalizedAtJst: row.normalized_at_jst,
    source: "booking",
    sourcePhase: B07X_SOURCE_PHASE,
    collectorStage: B07X_COLLECTOR_STAGE,
    canonicalPropertyName: row.canonical_property_name,
    sourcePropertyName: row.source_property_name,
    propertyIdentityMatch: row.property_identity_match,
    sourcePropertyId: row.source_property_id,
    sourceSlugOrCode: row.source_slug_or_code,
    checkin: row.checkin_date,
    checkout: row.checkout_date,
    stayNights: row.stay_nights,
    groupAdults: row.group_adults,
    noRooms: row.no_rooms,
    groupChildren: row.group_children,
    currency: row.currency,
    language: row.language,
    stayScope: row.stay_scope,
    availabilityStatus: row.availability_status,
    soldOutStatus: row.sold_out_status,
    normalizedTotalPrice: row.normalized_total_jpy,
    normalizedTotalPriceSource: hasTotal ? "booking_official_base_plus_visible_tax_fee_adder" : null,
    normalizedTotalPriceBasis: row.price_basis,
    normalizedTotalPriceConfidence: row.basis_confidence,
    basisConfidence: row.basis_confidence,
    basisNote: row.basis_note,
    sourcePrimaryPrice: row.source_primary_price,
    sourceSecondaryPriceOrAdder: row.source_official_tax_fee_adder,
    sourceComputedTotal: row.source_computed_total_with_tax_fee,
    sourceTaxOrFeeClassification: row.source_tax_basis_classification,
    sourceClassification: row.classification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: isDirectional,
    isPriceExcludedFromDp: isExcluded,
    dpExclusionReason: row.exclusion_reason,
    warningFlags: "",
    sourceReportPath: ctx.sourceReportPath,
    sourceCsvPath: ctx.sourceCsvPath,
    debugArtifactPath: row.debug_artifact_path,
    schemaVersion: HISTORY_SCHEMA_VERSION
  };
}

// ---------------------------------------------------------------------------
// 6. Row policy validation
// ---------------------------------------------------------------------------

export interface RowPolicyValidationResult {
  ok: boolean;
  errors: string[];
  directCount: number;
  directionalCount: number;
  excludedCount: number;
}

// Validate every reconstructed history row against the Booking B07X policy:
// source=booking, direct=0, B→directional priced, C→excluded audit, row_hash
// re-derives, schema_version + shard_month consistent.
export function validateApprovedHistoryRows(rows: HistoryRow[]): RowPolicyValidationResult {
  const errors: string[] = [];
  let directCount = 0;
  let directionalCount = 0;
  let excludedCount = 0;

  for (const r of rows) {
    const tag = `${r.canonicalPropertyName}/${r.checkin}`;
    if (r.source !== "booking") errors.push(`${tag}:source_not_booking`);
    if (r.isPriceUsableForDpDirect) {
      errors.push(`${tag}:dp_direct_true`);
      directCount += 1;
    }

    if (r.basisConfidence === "B") {
      directionalCount += 1;
      if (!r.isPriceUsableForDpDirectional) errors.push(`${tag}:B_not_directional`);
      if (r.isPriceExcludedFromDp) errors.push(`${tag}:B_excluded`);
      if (r.normalizedTotalPrice === null) errors.push(`${tag}:B_total_null`);
    } else if (r.basisConfidence === "C") {
      excludedCount += 1;
      if (!r.isPriceExcludedFromDp) errors.push(`${tag}:C_not_excluded`);
      if (r.isPriceUsableForDpDirectional) errors.push(`${tag}:C_directional`);
      if (r.dpExclusionReason !== "missing_official_tax_fee_adder") {
        errors.push(`${tag}:C_wrong_exclusion_reason`);
      }
    } else {
      errors.push(`${tag}:unexpected_basis_confidence:${r.basisConfidence}`);
    }

    if (r.schemaVersion !== HISTORY_SCHEMA_VERSION) errors.push(`${tag}:schema_version_mismatch`);
    if (r.shardMonth !== shardMonthFromCheckin(r.checkin)) errors.push(`${tag}:shard_month_mismatch`);

    const reHash = buildRowHash({
      source: r.source,
      sourcePhase: r.sourcePhase,
      collectorStage: r.collectorStage,
      canonicalPropertyName: r.canonicalPropertyName,
      sourceSlugOrCode: r.sourceSlugOrCode,
      sourcePropertyId: r.sourcePropertyId,
      checkin: r.checkin,
      checkout: r.checkout,
      stayScope: r.stayScope,
      collectedDateJst: r.collectedDateJst,
      availabilityStatus: r.availabilityStatus,
      soldOutStatus: r.soldOutStatus,
      normalizedTotalPrice: r.normalizedTotalPrice,
      basisConfidence: r.basisConfidence,
      sourceClassification: r.sourceClassification,
      isPriceUsableForDpDirect: r.isPriceUsableForDpDirect,
      isPriceUsableForDpDirectional: r.isPriceUsableForDpDirectional,
      isPriceExcludedFromDp: r.isPriceExcludedFromDp
    });
    if (reHash !== r.rowHash) errors.push(`${tag}:row_hash_mismatch`);
  }

  return { ok: errors.length === 0, errors, directCount, directionalCount, excludedCount };
}

// ---------------------------------------------------------------------------
// 7. Preflight (append simulation vs existing history)
// ---------------------------------------------------------------------------

export interface ExistingHistoryKey {
  row_id: string;
  row_hash: string;
  shard_month: string;
}

export interface AppendPreflightSummary {
  existing_history_row_count: number;
  approved_append_row_count: number;
  new_row_count: number;
  skip_identical_count: number;
  conflict_count: number;
  touched_shards: string[];
  expected_total_after_append: number;
}

export function computeAppendPreflight(
  rows: HistoryRow[],
  existingKeys: ExistingHistoryKey[],
  existingHistoryRowCount: number
): AppendPreflightSummary {
  const existingByKey = new Map<string, string>();
  for (const k of existingKeys) existingByKey.set(`${k.shard_month}::${k.row_id}`, k.row_hash);

  let newCount = 0;
  let skipIdentical = 0;
  let conflict = 0;
  const touched = new Set<string>();

  for (const r of rows) {
    const existingHash = existingByKey.get(`${r.shardMonth}::${r.rowId}`);
    if (existingHash === undefined) {
      newCount += 1;
      touched.add(r.shardMonth);
    } else if (existingHash === r.rowHash) {
      skipIdentical += 1;
    } else {
      conflict += 1;
    }
  }

  return {
    existing_history_row_count: existingHistoryRowCount,
    approved_append_row_count: rows.length,
    new_row_count: newCount,
    skip_identical_count: skipIdentical,
    conflict_count: conflict,
    touched_shards: Array.from(touched).sort(),
    expected_total_after_append: existingHistoryRowCount + newCount
  };
}

// ---------------------------------------------------------------------------
// Group approved rows into per-shard source CSVs for the write engine
// ---------------------------------------------------------------------------

export function groupRowsToSourceShards(rows: HistoryRow[]): { shardMonth: string; csv: string }[] {
  const byShard = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    const bucket = byShard.get(r.shardMonth) ?? [];
    bucket.push(r);
    byShard.set(r.shardMonth, bucket);
  }
  return Array.from(byShard.keys())
    .sort()
    .map((shardMonth) => ({ shardMonth, csv: renderHistoryCsv(byShard.get(shardMonth)!) }));
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideB07XBeforeWrite(input: {
  gateAllowed: boolean;
  validationOk: boolean;
  conflictCount: number;
}): B07XDecision {
  if (!input.gateAllowed) return "booking_history_append_ready_not_run";
  if (!input.validationOk) return "booking_history_append_failed_validation";
  if (input.conflictCount > 0) return "booking_history_append_failed_conflicts";
  return "booking_history_append_success"; // provisional; confirmed after write
}

// ---------------------------------------------------------------------------
// CSV / report rendering
// ---------------------------------------------------------------------------

export const APPEND_ACTION_CSV_HEADERS = [
  "row_id",
  "canonical_property_name",
  "checkin",
  "shard_month",
  "normalized_total_price",
  "basis_confidence",
  "history_action",
  "append_recommendation"
] as const;

export interface AppendActionRow {
  row_id: string;
  canonical_property_name: string;
  checkin: string;
  shard_month: string;
  normalized_total_price: number | null;
  basis_confidence: string;
  history_action: string;
  append_recommendation: string;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

export function renderAppendActionCsv(rows: AppendActionRow[]): string {
  const body = rows.map((r) =>
    [
      r.row_id,
      r.canonical_property_name,
      r.checkin,
      r.shard_month,
      r.normalized_total_price === null ? "" : String(r.normalized_total_price),
      r.basis_confidence,
      r.history_action,
      r.append_recommendation
    ]
      .map(csvEscape)
      .join(",")
  );
  return [APPEND_ACTION_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export interface B07XReportInput {
  generatedAtJst: string;
  runId: string;
  decision: B07XDecision;
  gate: BookingAppendGateResult;
  sourceB06XJsonPath: string;
  sourceB05XJsonPath: string;
  preflight: AppendPreflightSummary;
  validation: RowPolicyValidationResult;
  appendActions: AppendActionRow[];
  backupDir: string;
  backupsCreated: number;
  filesUpdated: number;
  filesCreated: number;
  rowsWritten: number;
  rowsSkippedDuplicate: number;
  rollbackPerformed: boolean;
  postWriteOk: boolean;
  historyRowCountBefore: number;
  historyRowCountAfter: number;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugRootPath: string;
}

export function recommendedNextActionForB07X(decision: B07XDecision): string {
  if (decision === "booking_history_append_success") {
    return "- Booking rows appended to .data/history. Next likely phase is BOOKING-B07B (DB mirror sync + AI context refresh after Booking history append). Do NOT start B07B without explicit instruction.";
  }
  if (decision === "booking_history_append_ready_not_run") {
    return "- Fail-closed: standalone approval sentence and/or BOOKING_HISTORY_APPEND=1 missing. Nothing was written. Provide the exact approval sentence and re-run with the env flag to append.";
  }
  if (decision === "booking_history_append_failed_conflicts") {
    return "- Aborted: row_id conflict(s) detected (same row_id, different row_hash). Nothing was written. Resolve conflicts before retrying.";
  }
  if (decision === "booking_history_append_failed_validation") {
    return "- Aborted: row policy validation failed. Nothing was written. Fix the reported row(s) before retrying.";
  }
  if (decision === "booking_history_append_failed_write") {
    return "- Write failed and was rolled back. .data/history was restored. Investigate the failure before retrying.";
  }
  return "- Preflight failed. Nothing was written.";
}

export function renderB07XReport(input: B07XReportInput): string {
  const p = input.preflight;
  return [
    "# Approved Booking Normalized History Append (Phase BOOKING-B07X)",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Policy & safety",
    "",
    "- B07X appends history ONLY, gated by the explicit standalone approval sentence + BOOKING_HISTORY_APPEND=1.",
    "- No DB writes, no DB sync, no AI context refresh, no live Booking probe, no headless browser.",
    "- No PMS/OTA upload output, no price update, no GitHub Actions/cron, no paid sources.",
    "- Totals carried verbatim from B05X (official base + visible adder). No Booking base × 1.1.",
    "- Backup → temp write → validate → atomic rename → post-validate; rollback on failure.",
    "",
    "## 2. Decision",
    "",
    `- decision=${input.decision}`,
    "",
    "## 3. Approval gate",
    "",
    `- allowed=${input.gate.allowed}`,
    `- failed_conditions=${JSON.stringify(input.gate.failedConditions)}`,
    "",
    "## 4. Source artifacts",
    "",
    `- source_b06x_proposal_json=${input.sourceB06XJsonPath}`,
    `- source_b05x_json=${input.sourceB05XJsonPath}`,
    "",
    "## 5. Preflight summary",
    "",
    `- existing_history_row_count=${p.existing_history_row_count}`,
    `- approved_append_row_count=${p.approved_append_row_count}`,
    `- new_row_count=${p.new_row_count}`,
    `- skip_identical_count=${p.skip_identical_count}`,
    `- conflict_count=${p.conflict_count}`,
    `- touched_shards=${JSON.stringify(p.touched_shards)}`,
    `- expected_total_after_append=${p.expected_total_after_append}`,
    "",
    "## 6. Row policy validation",
    "",
    `- validation_ok=${input.validation.ok}`,
    `- direct_count=${input.validation.directCount}`,
    `- directional_count=${input.validation.directionalCount}`,
    `- excluded_count=${input.validation.excludedCount}`,
    `- errors=${JSON.stringify(input.validation.errors)}`,
    "",
    "## 7. Append actions",
    "",
    "| canonical_property | checkin | shard | total | conf | history_action | recommendation |",
    "|---|---|---|---|---|---|---|",
    ...input.appendActions.map(
      (a) =>
        `| ${a.canonical_property_name} | ${a.checkin} | ${a.shard_month} | ${a.normalized_total_price ?? ""} | ${a.basis_confidence} | ${a.history_action} | ${a.append_recommendation} |`
    ),
    "",
    "## 8. Files written / backups",
    "",
    `- history_row_count_before=${input.historyRowCountBefore}`,
    `- history_row_count_after=${input.historyRowCountAfter}`,
    `- files_created=${input.filesCreated}`,
    `- files_updated=${input.filesUpdated}`,
    `- rows_written=${input.rowsWritten}`,
    `- rows_skipped_duplicate=${input.rowsSkippedDuplicate}`,
    `- backup_dir=${input.backupDir}`,
    `- backups_created=${input.backupsCreated}`,
    `- rollback_performed=${input.rollbackPerformed}`,
    `- post_write_ok=${input.postWriteOk}`,
    "",
    "## 9. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 10. Recommended next action",
    "",
    recommendedNextActionForB07X(input.decision),
    ""
  ].join("\n");
}
