// Phase BOOKING-B11X — Approved Booking bounded append with identity policy (engine).
//
// Performs the APPROVED append of the B10Z proposal rows into .data/history under
// the ID02X observation-identity policy. Gated by an explicit standalone approval
// sentence (enforced by the calling agent) AND the runtime env flag
// BOOKING_BOUNDED_APPEND_WITH_IDENTITY=1. Without both, it fails closed
// (decision=booking_bounded_append_with_identity_ready_not_run) and writes nothing.
//
// This module APPENDS HISTORY ONLY. It writes NO DB rows, runs NO DB sync,
// refreshes NO AI context, runs NO live Booking request or browser automation,
// emits NO property-management or channel-manager upload output, performs NO price
// update, and applies NO synthetic Booking tax multiplier (totals are carried
// verbatim from B09X = official base + official visible adder). The heavy write
// engine (backup / temp / atomic rename / rollback / post-validate) is reused from
// localHistoryRealAppend (M06X).
//
// Identity policy (ID02X Option C): the 15 brand-new observations keep the plain
// 7-segment legacy v1 row_id. The 10 re-observations whose legacy v1 row_id
// already exists in history (with a changed market value) are appended as NEW
// observations under a DISTINCT, deterministic row_id formed by appending an
// observation qualifier (|obs:<observation_id first 16 hex>). This intentionally
// changes row identity (permitted by the spec) so the re-observations never
// overwrite or block the existing rows, while keeping the v1 CSV column set
// unchanged. row_hash is always (re)derived with the canonical schema buildRowHash
// so the store stays internally consistent and idempotent on replay.

import {
  HISTORY_SCHEMA_VERSION,
  buildRowHash,
  buildRowId,
  renderHistoryCsv,
  shardMonthFromCheckin,
  type HistoryRow
} from "./localHistorySchemaDesign";

export const B11X_SOURCE_PHASE = "B09X";
export const B11X_COLLECTOR_STAGE = "bounded_expanded_normalized_collection";
export const B11X_ENV_FLAG = "BOOKING_BOUNDED_APPEND_WITH_IDENTITY";
export const B11X_APPROVAL_SENTENCE =
  "Approve Phase BOOKING-B11X bounded append with identity policy. You may append the 25 approved Booking.com observation rows to .data/history using the B10Z proposal and ID02X identity policy.";

// History actions the B10Z proposal can carry; only these two are appendable.
export const APPENDABLE_HISTORY_ACTIONS: ReadonlySet<string> = new Set([
  "append_new",
  "append_new_observation_after_identity_fix"
]);

// Append recommendations the B10Z proposal can carry; only these two are approved.
const APPROVED_RECOMMENDATIONS: ReadonlySet<string> = new Set([
  "append_directional",
  "append_excluded_audit"
]);

// ---------------------------------------------------------------------------
// 13. Decision labels (7)
// ---------------------------------------------------------------------------

export type B11XDecision =
  | "booking_bounded_append_with_identity_ready_not_run"
  | "booking_bounded_append_with_identity_success"
  | "booking_bounded_append_with_identity_failed_preflight"
  | "booking_bounded_append_with_identity_failed_conflicts"
  | "booking_bounded_append_with_identity_failed_validation"
  | "booking_bounded_append_with_identity_failed_write"
  | "booking_bounded_append_with_identity_failed_rolled_back";

// ---------------------------------------------------------------------------
// 1. Approval gate (fail-closed)
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
  if (input.envFlag !== "1") failed.push(`${B11X_ENV_FLAG}!=1`);
  return { allowed: failed.length === 0, failedConditions: failed };
}

// ---------------------------------------------------------------------------
// B10Z proposal row (lite) + B09X full row (source of history fields)
// ---------------------------------------------------------------------------

// The subset of a B10Z proposal row needed to select + qualify identity.
export interface B10ZProposalRowLite {
  new_row_id: string;
  history_action: string;
  append_recommendation: string;
  observation_id: string;
}

export interface SelectAppendRowsResult {
  appendRowIds: string[];
  skippedRowIds: string[];
  blockedRowIds: string[];
}

// Select rows the B10Z proposal marked appendable + approved. Benign duplicates
// (skip_benign_duplicate / skip_identical) are skipped; anything blocked or under
// manual review is held back.
export function selectAppendRows(proposalRows: readonly B10ZProposalRowLite[]): SelectAppendRowsResult {
  const appendRowIds: string[] = [];
  const skippedRowIds: string[] = [];
  const blockedRowIds: string[] = [];
  for (const r of proposalRows) {
    if (APPENDABLE_HISTORY_ACTIONS.has(r.history_action) && APPROVED_RECOMMENDATIONS.has(r.append_recommendation)) {
      appendRowIds.push(r.new_row_id);
    } else if (r.history_action === "skip_benign_duplicate" || r.history_action === "skip_identical") {
      skippedRowIds.push(r.new_row_id);
    } else {
      blockedRowIds.push(r.new_row_id);
    }
  }
  return { appendRowIds, skippedRowIds, blockedRowIds };
}

// The B09X normalized-row preview shape (a subset of the fields in the B09X JSON
// `normalized_rows_preview[]`) — carries every field needed to reconstruct a full
// HistoryRow.
export interface B09XFullRow {
  row_id: string;
  shard_month: string;
  collected_date_jst: string;
  collected_at_jst: string;
  normalized_at_jst: string;
  canonical_property_name: string;
  source_property_name: string;
  property_identity_match: boolean;
  source_property_id: string;
  source_slug_or_code: string;
  checkin: string;
  checkout: string;
  stay_nights: number;
  group_adults: number;
  no_rooms: number;
  group_children: number;
  currency: string;
  language: string;
  stay_scope: string;
  availability_status: string;
  sold_out_status: string;
  normalized_total_price: number | null;
  normalized_total_price_source: string | null;
  normalized_total_price_basis: string;
  normalized_total_price_confidence: string;
  basis_confidence: string;
  basis_note: string;
  source_primary_price: number | null;
  source_secondary_price_or_adder: number | null;
  source_computed_total: number | null;
  source_tax_or_fee_classification: string;
  source_classification: string;
  dp_usage: string;
  dp_exclusion_reason: string | null;
  debug_artifact_path: string;
}

export interface ReconstructContext {
  sourceReportPath: string;
  sourceCsvPath: string;
}

// Length (hex chars) of the observation_id slice used in the qualified row_id.
export const OBSERVATION_QUALIFIER_LENGTH = 16;

// Build the row_id for a reconstructed row. append_new rows keep the plain
// 7-segment legacy v1 row_id. Re-observations after the identity fix get a
// DISTINCT, deterministic row_id by appending an observation qualifier so they
// never collide with the existing legacy row in history.
export function buildAppendRowId(input: {
  legacyRowId: string;
  historyAction: string;
  observationId: string;
}): string {
  if (input.historyAction === "append_new_observation_after_identity_fix") {
    return `${input.legacyRowId}|obs:${input.observationId.slice(0, OBSERVATION_QUALIFIER_LENGTH)}`;
  }
  return input.legacyRowId;
}

// Reconstruct the full 45-column history row from a B09X normalized row + its
// B10Z proposal classification. row_hash is (re)derived with the canonical schema
// buildRowHash (NOT carried from B09X, whose hash uses a different algorithm) so
// the row matches the rest of .data/history and replays idempotently.
export function reconstructHistoryRow(
  row: B09XFullRow,
  proposal: B10ZProposalRowLite,
  ctx: ReconstructContext
): HistoryRow {
  const isDirectional = row.dp_usage === "directional";
  const isExcluded = row.dp_usage === "excluded";
  const hasTotal = row.normalized_total_price !== null;

  // Canonical legacy row_id (defensive: derive rather than trust the carried one).
  const legacyRowId = buildRowId({
    collectedDateJst: row.collected_date_jst,
    source: "booking",
    canonicalPropertyName: row.canonical_property_name,
    sourceSlugOrCode: row.source_slug_or_code,
    sourcePropertyId: row.source_property_id,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: row.stay_scope
  });

  const rowId = buildAppendRowId({
    legacyRowId,
    historyAction: proposal.history_action,
    observationId: proposal.observation_id
  });

  const rowHash = buildRowHash({
    source: "booking",
    sourcePhase: B11X_SOURCE_PHASE,
    collectorStage: B11X_COLLECTOR_STAGE,
    canonicalPropertyName: row.canonical_property_name,
    sourceSlugOrCode: row.source_slug_or_code,
    sourcePropertyId: row.source_property_id,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: row.stay_scope,
    collectedDateJst: row.collected_date_jst,
    availabilityStatus: row.availability_status,
    soldOutStatus: row.sold_out_status,
    normalizedTotalPrice: row.normalized_total_price,
    basisConfidence: row.basis_confidence,
    sourceClassification: row.source_classification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: isDirectional,
    isPriceExcludedFromDp: isExcluded
  });

  return {
    rowId,
    rowHash,
    shardMonth: row.shard_month,
    collectedDateJst: row.collected_date_jst,
    collectedAtJst: row.collected_at_jst,
    normalizedAtJst: row.normalized_at_jst,
    source: "booking",
    sourcePhase: B11X_SOURCE_PHASE,
    collectorStage: B11X_COLLECTOR_STAGE,
    canonicalPropertyName: row.canonical_property_name,
    sourcePropertyName: row.source_property_name,
    propertyIdentityMatch: row.property_identity_match,
    sourcePropertyId: row.source_property_id,
    sourceSlugOrCode: row.source_slug_or_code,
    checkin: row.checkin,
    checkout: row.checkout,
    stayNights: row.stay_nights,
    groupAdults: row.group_adults,
    noRooms: row.no_rooms,
    groupChildren: row.group_children,
    currency: row.currency,
    language: row.language,
    stayScope: row.stay_scope,
    availabilityStatus: row.availability_status,
    soldOutStatus: row.sold_out_status,
    normalizedTotalPrice: row.normalized_total_price,
    normalizedTotalPriceSource: hasTotal
      ? row.normalized_total_price_source ?? "booking_official_visible_total"
      : null,
    normalizedTotalPriceBasis: row.normalized_total_price_basis,
    normalizedTotalPriceConfidence: row.normalized_total_price_confidence,
    basisConfidence: row.basis_confidence,
    basisNote: row.basis_note,
    sourcePrimaryPrice: row.source_primary_price,
    sourceSecondaryPriceOrAdder: row.source_secondary_price_or_adder,
    sourceComputedTotal: row.source_computed_total,
    sourceTaxOrFeeClassification: row.source_tax_or_fee_classification,
    sourceClassification: row.source_classification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: isDirectional,
    isPriceExcludedFromDp: isExcluded,
    dpExclusionReason: row.dp_exclusion_reason,
    warningFlags: "",
    sourceReportPath: ctx.sourceReportPath,
    sourceCsvPath: ctx.sourceCsvPath,
    debugArtifactPath: row.debug_artifact_path,
    schemaVersion: HISTORY_SCHEMA_VERSION
  };
}

// ---------------------------------------------------------------------------
// 6/7. Row policy validation
// ---------------------------------------------------------------------------

export interface RowPolicyValidationResult {
  ok: boolean;
  errors: string[];
  directCount: number;
  directionalCount: number;
  excludedCount: number;
  identityFixCount: number;
}

// Validate every reconstructed history row against the Booking B11X policy:
// source=booking, direct=0, B→directional priced, C→excluded audit, row_hash
// re-derives, schema_version + shard_month consistent, and identity-qualified
// row_ids carry exactly one observation qualifier.
export function validateApprovedHistoryRows(
  rows: readonly HistoryRow[],
  identityFixRowIds: ReadonlySet<string>
): RowPolicyValidationResult {
  const errors: string[] = [];
  let directCount = 0;
  let directionalCount = 0;
  let excludedCount = 0;
  let identityFixCount = 0;

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

    const isIdentityFix = identityFixRowIds.has(r.rowId);
    if (isIdentityFix) {
      identityFixCount += 1;
      if (!/\|obs:[0-9a-f]{16}$/u.test(r.rowId)) errors.push(`${tag}:identity_fix_qualifier_malformed`);
    } else if (/\|obs:/u.test(r.rowId)) {
      errors.push(`${tag}:unexpected_observation_qualifier`);
    }

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

  return { ok: errors.length === 0, errors, directCount, directionalCount, excludedCount, identityFixCount };
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
  rows: readonly HistoryRow[],
  existingKeys: readonly ExistingHistoryKey[],
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

export function groupRowsToSourceShards(rows: readonly HistoryRow[]): { shardMonth: string; csv: string }[] {
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
// Decision (pre-write)
// ---------------------------------------------------------------------------

export function decideB11XBeforeWrite(input: {
  gateAllowed: boolean;
  validationOk: boolean;
  conflictCount: number;
}): B11XDecision {
  if (!input.gateAllowed) return "booking_bounded_append_with_identity_ready_not_run";
  if (!input.validationOk) return "booking_bounded_append_with_identity_failed_validation";
  if (input.conflictCount > 0) return "booking_bounded_append_with_identity_failed_conflicts";
  return "booking_bounded_append_with_identity_success"; // provisional; confirmed after write
}

// ---------------------------------------------------------------------------
// Identity metadata (report/debug only)
// ---------------------------------------------------------------------------

export interface IdentityMetadataRow {
  legacy_row_id: string;
  new_row_id: string;
  history_action: string;
  observation_id: string;
  market_identity_key: string;
  market_value_hash: string;
  observation_hash: string;
  identity_changed: boolean;
}

// ---------------------------------------------------------------------------
// CSV / report rendering
// ---------------------------------------------------------------------------

export const APPEND_ACTION_CSV_HEADERS = [
  "new_row_id",
  "legacy_row_id",
  "canonical_property_name",
  "checkin",
  "shard_month",
  "normalized_total_price",
  "basis_confidence",
  "history_action",
  "append_recommendation",
  "identity_changed"
] as const;

export interface AppendActionRow {
  new_row_id: string;
  legacy_row_id: string;
  canonical_property_name: string;
  checkin: string;
  shard_month: string;
  normalized_total_price: number | null;
  basis_confidence: string;
  history_action: string;
  append_recommendation: string;
  identity_changed: boolean;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

export function renderAppendActionCsv(rows: readonly AppendActionRow[]): string {
  const body = rows.map((r) =>
    [
      r.new_row_id,
      r.legacy_row_id,
      r.canonical_property_name,
      r.checkin,
      r.shard_month,
      r.normalized_total_price === null ? "" : String(r.normalized_total_price),
      r.basis_confidence,
      r.history_action,
      r.append_recommendation,
      String(r.identity_changed)
    ]
      .map(csvEscape)
      .join(",")
  );
  return [APPEND_ACTION_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function recommendedNextActionForB11X(decision: B11XDecision): string {
  if (decision === "booking_bounded_append_with_identity_success") {
    return "- Booking bounded observations appended to .data/history under the ID02X identity policy. Next likely phase is BOOKING-B11B (DB mirror sync + AI context refresh). Do NOT start B11B without explicit instruction.";
  }
  if (decision === "booking_bounded_append_with_identity_ready_not_run") {
    return "- Fail-closed: standalone approval sentence and/or BOOKING_BOUNDED_APPEND_WITH_IDENTITY=1 missing. Nothing was written. Provide the exact approval sentence and re-run with the env flag to append.";
  }
  if (decision === "booking_bounded_append_with_identity_failed_conflicts") {
    return "- Aborted: row_id conflict(s) detected (same row_id, different row_hash). Nothing was written. Resolve conflicts before retrying.";
  }
  if (decision === "booking_bounded_append_with_identity_failed_validation") {
    return "- Aborted (or rolled back): row policy / post-write validation failed. .data/history is unchanged. Fix the reported row(s) before retrying.";
  }
  if (decision === "booking_bounded_append_with_identity_failed_rolled_back") {
    return "- Write failed and was rolled back. .data/history was restored. Investigate the failure before retrying.";
  }
  if (decision === "booking_bounded_append_with_identity_failed_write") {
    return "- Write failed and rollback FAILED. MANUAL RECOVERY REQUIRED: inspect .data/history and .data/history/.backup.";
  }
  return "- Preflight failed. Nothing was written.";
}

export interface B11XReportInput {
  generatedAtJst: string;
  runId: string;
  decision: B11XDecision;
  gate: BookingAppendGateResult;
  sourceB10ZJsonPath: string;
  sourceB09XJsonPath: string;
  preflight: AppendPreflightSummary;
  validation: RowPolicyValidationResult;
  appendActions: readonly AppendActionRow[];
  identityMetadata: readonly IdentityMetadataRow[];
  backupDir: string;
  backupsCreated: number;
  filesUpdated: number;
  filesCreated: number;
  rowsWritten: number;
  rowsSkippedDuplicate: number;
  rollbackPerformed: boolean;
  postWriteOk: boolean;
  postWriteDuplicateRowIdCount: number;
  historyRowCountBefore: number;
  historyRowCountAfter: number;
  skippedRowCount: number;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugRootPath: string;
}

export function renderB11XReport(input: B11XReportInput): string {
  const p = input.preflight;
  return [
    "# Approved Booking Bounded Append With Identity Policy (Phase BOOKING-B11X)",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Policy & safety",
    "",
    "- B11X appends history ONLY, gated by the explicit standalone approval sentence + BOOKING_BOUNDED_APPEND_WITH_IDENTITY=1.",
    "- No DB writes, no DB sync, no AI context refresh, no live Booking request, no browser automation.",
    "- No property-management or channel-manager upload output, no price update, no GitHub Actions/cron, no paid sources.",
    "- Totals carried verbatim from B09X (official base + official visible adder). No synthetic Booking tax multiplier.",
    "- Backup -> temp write -> validate -> atomic rename -> post-validate; rollback on failure.",
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
    `- source_b10z_proposal_json=${input.sourceB10ZJsonPath}`,
    `- source_b09x_json=${input.sourceB09XJsonPath}`,
    "",
    "## 5. Identity policy",
    "",
    "- ID02X Option C: append_new rows keep the plain 7-segment legacy v1 row_id.",
    "- Re-observations after the identity fix get a distinct deterministic row_id: `<legacy_row_id>|obs:<observation_id first 16 hex>`.",
    "- row_hash is (re)derived with the canonical schema buildRowHash; existing rows are never overwritten or superseded.",
    `- identity_fix_rows=${input.validation.identityFixCount}`,
    "",
    "## 6. Preflight summary",
    "",
    `- existing_history_row_count=${p.existing_history_row_count}`,
    `- approved_append_row_count=${p.approved_append_row_count}`,
    `- skipped_benign_duplicate_count=${input.skippedRowCount}`,
    `- new_row_count=${p.new_row_count}`,
    `- skip_identical_count=${p.skip_identical_count}`,
    `- conflict_count=${p.conflict_count}`,
    `- touched_shards=${JSON.stringify(p.touched_shards)}`,
    `- expected_total_after_append=${p.expected_total_after_append}`,
    "",
    "## 7. Row policy validation",
    "",
    `- validation_ok=${input.validation.ok}`,
    `- direct_count=${input.validation.directCount}`,
    `- directional_count=${input.validation.directionalCount}`,
    `- excluded_count=${input.validation.excludedCount}`,
    `- identity_fix_count=${input.validation.identityFixCount}`,
    `- errors=${JSON.stringify(input.validation.errors)}`,
    "",
    "## 8. Append actions",
    "",
    "| canonical_property | checkin | shard | total | conf | history_action | identity_changed |",
    "|---|---|---|---|---|---|---|",
    ...input.appendActions.map(
      (a) =>
        `| ${a.canonical_property_name} | ${a.checkin} | ${a.shard_month} | ${a.normalized_total_price ?? ""} | ${a.basis_confidence} | ${a.history_action} | ${a.identity_changed} |`
    ),
    "",
    "## 9. Files written / backups",
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
    `- post_write_duplicate_row_id_count=${input.postWriteDuplicateRowIdCount}`,
    "",
    "## 10. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 11. Recommended next action",
    "",
    recommendedNextActionForB11X(input.decision),
    ""
  ].join("\n");
}
