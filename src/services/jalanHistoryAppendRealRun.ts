// Phase JALAN-AUTO05X — Approved Jalan history append (engine).
//
// Performs the APPROVED append of the JALAN-AUTO04X proposal rows (which were
// derived from the JALAN-AUTO03B improved preview) into .data/history. Gated by
// an explicit standalone approval sentence (enforced by the calling agent) AND
// the runtime env flag JALAN_HISTORY_APPEND=1. Without both, it fails closed
// (decision=jalan_history_append_ready_not_run) and writes nothing.
//
// This module APPENDS HISTORY ONLY. It writes NO DB rows, runs NO DB sync,
// refreshes NO AI context, runs NO live Jalan probe / headless browser, emits NO
// property-management or OTA upload output, performs NO price update, generates
// NO pricing CSV, and applies NO synthetic tax multiplier (totals are carried
// verbatim from AUTO03B = visible tax-included total). The heavy write engine
// (backup / temp / atomic rename / rollback / post-validate) is reused from
// localHistoryRealAppend (M06X).
//
// Jalan stays a supplementary domestic OTA signal — the Booking primary-source
// directional backbone is unchanged. Directional rows are price-pressure
// evidence only (dp_usable=false, never direct). Excluded rows are audit-only.

import {
  HISTORY_SCHEMA_VERSION,
  buildRowHash,
  buildRowId,
  renderHistoryCsv,
  shardMonthFromCheckin,
  type HistoryRow
} from "./localHistorySchemaDesign";
import { type JalanImprovedPreviewRow } from "./jalanBoundedCollectionProbeImproved";
import { type JalanAppendProposalRow } from "./jalanHistoryAppendProposal";

export const AUTO05X_ENV_FLAG = "JALAN_HISTORY_APPEND";
export const AUTO05X_APPROVAL_SENTENCE =
  "Approve Phase JALAN-AUTO05X append approved Jalan AUTO03B rows. You may append the approved Jalan rows to .data/history.";

// History actions in the AUTO04X proposal that authorize an append.
export const APPROVED_HISTORY_ACTIONS: ReadonlySet<string> = new Set([
  "append_directional",
  "append_excluded_audit"
]);

// ---------------------------------------------------------------------------
// Decision labels
// ---------------------------------------------------------------------------

export type JalanRealAppendDecision =
  | "jalan_history_append_ready_not_run"
  | "jalan_history_append_success"
  | "jalan_history_append_failed_preflight"
  | "jalan_history_append_failed_conflicts"
  | "jalan_history_append_failed_validation"
  | "jalan_history_append_failed_write";

// ---------------------------------------------------------------------------
// 1. Approval gate (two-gate: approval sentence + env flag)
// ---------------------------------------------------------------------------

export interface JalanAppendGateInput {
  approvalSentencePresent: boolean;
  envFlag: string | undefined;
}

export interface JalanAppendGateResult {
  allowed: boolean;
  approvalSentencePresent: boolean;
  envFlagPresent: boolean;
  failedConditions: string[];
}

export function evaluateGate(input: JalanAppendGateInput): JalanAppendGateResult {
  const failed: string[] = [];
  if (!input.approvalSentencePresent) failed.push("approval_sentence_absent");
  if (input.envFlag !== "1") failed.push(`${AUTO05X_ENV_FLAG}!=1`);
  return {
    allowed: failed.length === 0,
    approvalSentencePresent: input.approvalSentencePresent,
    envFlagPresent: input.envFlag === "1",
    failedConditions: failed
  };
}

// ---------------------------------------------------------------------------
// 2. Row selection (adapted to the AUTO04X proposal structure)
// ---------------------------------------------------------------------------
//
// AUTO04X proposal rows carry `history_action` directly (there is no separate
// `append_recommendation` field). Select rows whose history_action is an
// approved append action; everything else (skip_identical / block_conflict /
// manual_review) is held back.

export function selectApprovedRowIds(proposalRows: readonly JalanAppendProposalRow[]): {
  approvedRowIds: string[];
  blockedRowIds: string[];
} {
  const approvedRowIds: string[] = [];
  const blockedRowIds: string[] = [];
  for (const r of proposalRows) {
    if (APPROVED_HISTORY_ACTIONS.has(r.history_action)) approvedRowIds.push(r.row_id);
    else blockedRowIds.push(r.row_id);
  }
  return { approvedRowIds, blockedRowIds };
}

// ---------------------------------------------------------------------------
// 3. Reconstruct a full 45-column history row from an AUTO03B preview row
// ---------------------------------------------------------------------------
//
// The hash-relevant fields (source_phase, collector_stage, the three dp-usage
// booleans, collected_date_jst, etc.) are carried verbatim from the AUTO03B
// preview row — exactly what AUTO04X fed into buildRowHash — so the re-derived
// row_hash matches the value carried in the proposal (validated downstream).

export interface ReconstructContext {
  sourceReportPath: string;
  sourceCsvPath: string;
}

function identityMatchToBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "unconfirmed" || v === "false" || v === "no" || v === "unverified") return false;
  return true;
}

export function reconstructHistoryRow(
  row: JalanImprovedPreviewRow,
  ctx: ReconstructContext
): HistoryRow {
  const rowId = buildRowId({
    collectedDateJst: row.collected_date_jst,
    source: row.source,
    canonicalPropertyName: row.canonical_property_name,
    sourceSlugOrCode: row.source_slug_or_code,
    sourcePropertyId: row.source_property_id,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: row.stay_scope
  });
  const rowHash = buildRowHash({
    source: row.source,
    sourcePhase: row.source_phase,
    collectorStage: row.collector_stage,
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
    isPriceUsableForDpDirect: row.is_price_usable_for_dp_direct,
    isPriceUsableForDpDirectional: row.is_price_usable_for_dp_directional,
    isPriceExcludedFromDp: row.is_price_excluded_from_dp
  });
  return {
    rowId,
    rowHash,
    shardMonth: shardMonthFromCheckin(row.checkin),
    collectedDateJst: row.collected_date_jst,
    collectedAtJst: row.collected_at_jst,
    normalizedAtJst: row.normalized_at_jst,
    source: row.source,
    sourcePhase: row.source_phase,
    collectorStage: row.collector_stage,
    canonicalPropertyName: row.canonical_property_name,
    sourcePropertyName: row.source_property_name,
    propertyIdentityMatch: identityMatchToBool(row.property_identity_match),
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
    normalizedTotalPriceSource: row.normalized_total_price_source === "" ? null : row.normalized_total_price_source,
    normalizedTotalPriceBasis: row.normalized_total_price_basis,
    normalizedTotalPriceConfidence: row.normalized_total_price_confidence,
    basisConfidence: row.basis_confidence,
    basisNote: row.basis_note,
    sourcePrimaryPrice: row.source_primary_price,
    sourceSecondaryPriceOrAdder: row.source_secondary_price_or_adder,
    sourceComputedTotal: row.source_computed_total,
    sourceTaxOrFeeClassification: row.source_tax_or_fee_classification,
    sourceClassification: row.source_classification,
    isPriceUsableForDpDirect: row.is_price_usable_for_dp_direct,
    isPriceUsableForDpDirectional: row.is_price_usable_for_dp_directional,
    isPriceExcludedFromDp: row.is_price_excluded_from_dp,
    dpExclusionReason: row.dp_exclusion_reason === "" ? null : row.dp_exclusion_reason,
    warningFlags: row.warning_flags,
    sourceReportPath: ctx.sourceReportPath,
    sourceCsvPath: ctx.sourceCsvPath,
    debugArtifactPath: row.debug_artifact_path,
    schemaVersion: HISTORY_SCHEMA_VERSION
  };
}

// Build the canonical v1 identity (row_id + row_hash) for a reconstructed row.
// Reuses the canonical helpers exactly as AUTO04X did, so the result matches
// the row_id / row_hash carried in the proposal.
export function withCanonicalIdentity(row: HistoryRow): HistoryRow {
  const rowHash = buildRowHash({
    source: row.source,
    sourcePhase: row.sourcePhase,
    collectorStage: row.collectorStage,
    canonicalPropertyName: row.canonicalPropertyName,
    sourceSlugOrCode: row.sourceSlugOrCode,
    sourcePropertyId: row.sourcePropertyId,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: row.stayScope,
    collectedDateJst: row.collectedDateJst,
    availabilityStatus: row.availabilityStatus,
    soldOutStatus: row.soldOutStatus,
    normalizedTotalPrice: row.normalizedTotalPrice,
    basisConfidence: row.basisConfidence,
    sourceClassification: row.sourceClassification,
    isPriceUsableForDpDirect: row.isPriceUsableForDpDirect,
    isPriceUsableForDpDirectional: row.isPriceUsableForDpDirectional,
    isPriceExcludedFromDp: row.isPriceExcludedFromDp
  });
  return { ...row, rowHash };
}

// ---------------------------------------------------------------------------
// 4. Row policy validation
// ---------------------------------------------------------------------------
//
// Validate each reconstructed row + its source proposal/preview against the
// AUTO05X policy. Directional rows must be price-pressure-only (dp_usable=false,
// never direct); excluded rows must be audit-only. The carried row_id/row_hash
// must re-derive from the canonical helpers. No direct rows are ever appended.

export interface ApprovedRowRecord {
  historyRow: HistoryRow;
  proposal: JalanAppendProposalRow;
  preview: JalanImprovedPreviewRow;
}

export interface RowPolicyValidationResult {
  ok: boolean;
  errors: string[];
  directCount: number;
  directionalCount: number;
  excludedCount: number;
}

export function validateApprovedHistoryRows(records: readonly ApprovedRowRecord[]): RowPolicyValidationResult {
  const errors: string[] = [];
  let directCount = 0;
  let directionalCount = 0;
  let excludedCount = 0;

  for (const { historyRow: r, proposal, preview } of records) {
    const tag = `${r.canonicalPropertyName}/${r.checkin}`;

    if (r.source !== "jalan") errors.push(`${tag}:source_not_jalan`);
    if (proposal.source !== "jalan") errors.push(`${tag}:proposal_source_not_jalan`);

    // No direct rows may ever be appended.
    if (r.isPriceUsableForDpDirect) {
      errors.push(`${tag}:dp_direct_true`);
      directCount += 1;
    }

    if (proposal.history_action === "append_directional") {
      directionalCount += 1;
      if (r.basisConfidence !== "B") errors.push(`${tag}:directional_not_B`);
      if (r.normalizedTotalPrice === null) errors.push(`${tag}:directional_total_null`);
      if (!r.isPriceUsableForDpDirectional) errors.push(`${tag}:directional_flag_false`);
      if (r.isPriceUsableForDpDirect) errors.push(`${tag}:directional_direct_true`);
      if (r.isPriceExcludedFromDp) errors.push(`${tag}:directional_excluded_true`);
      if (preview.dp_usage !== "directional") errors.push(`${tag}:directional_dp_usage_mismatch`);
      if (!proposal.price_pressure_usable) errors.push(`${tag}:directional_price_pressure_false`);
      if (proposal.dp_usable !== false) errors.push(`${tag}:directional_dp_usable_true`);
      if (preview.screenshot_path === "") errors.push(`${tag}:directional_missing_screenshot`);
      if (r.sourceSlugOrCode === "" && r.sourcePropertyId === "") errors.push(`${tag}:directional_identity_unclear`);
      if (proposal.hard_exclusion_reason !== "") errors.push(`${tag}:directional_hard_exclusion_present`);
    } else if (proposal.history_action === "append_excluded_audit") {
      excludedCount += 1;
      if (!r.isPriceExcludedFromDp) errors.push(`${tag}:excluded_flag_false`);
      if (r.isPriceUsableForDpDirectional) errors.push(`${tag}:excluded_directional_true`);
      if (r.isPriceUsableForDpDirect) errors.push(`${tag}:excluded_direct_true`);
      if (preview.dp_usage !== "excluded") errors.push(`${tag}:excluded_dp_usage_mismatch`);
      if (proposal.price_pressure_usable) errors.push(`${tag}:excluded_price_pressure_true`);
      if (proposal.dp_usable !== false) errors.push(`${tag}:excluded_dp_usable_true`);
    } else {
      errors.push(`${tag}:unexpected_history_action:${proposal.history_action}`);
    }

    if (r.schemaVersion !== HISTORY_SCHEMA_VERSION) errors.push(`${tag}:schema_version_mismatch`);
    if (r.shardMonth !== shardMonthFromCheckin(r.checkin)) errors.push(`${tag}:shard_month_mismatch`);
    if (r.rowId === "" ) errors.push(`${tag}:row_id_empty`);
    if (r.rowHash === "") errors.push(`${tag}:row_hash_empty`);

    // Carried identity must match the canonical re-derivation and the proposal.
    const canonical = withCanonicalIdentity(r);
    if (canonical.rowHash !== r.rowHash) errors.push(`${tag}:row_hash_mismatch`);
    if (proposal.row_id !== r.rowId) errors.push(`${tag}:proposal_row_id_mismatch`);
    if (proposal.row_hash !== r.rowHash) errors.push(`${tag}:proposal_row_hash_mismatch`);
  }

  return { ok: errors.length === 0, errors, directCount, directionalCount, excludedCount };
}

// ---------------------------------------------------------------------------
// 5. Preflight (append simulation vs existing history)
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
// Decision before write
// ---------------------------------------------------------------------------

export function decideBeforeWrite(input: {
  gateAllowed: boolean;
  validationOk: boolean;
  conflictCount: number;
}): JalanRealAppendDecision {
  if (!input.gateAllowed) return "jalan_history_append_ready_not_run";
  if (!input.validationOk) return "jalan_history_append_failed_validation";
  if (input.conflictCount > 0) return "jalan_history_append_failed_conflicts";
  return "jalan_history_append_success"; // provisional; confirmed after write
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
  "dp_usage",
  "history_action",
  "price_pressure_usable"
] as const;

export interface AppendActionRow {
  row_id: string;
  canonical_property_name: string;
  checkin: string;
  shard_month: string;
  normalized_total_price: number | null;
  basis_confidence: string;
  dp_usage: string;
  history_action: string;
  price_pressure_usable: boolean;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, '""')}"`;
  return value;
}

export function renderAppendActionCsv(rows: readonly AppendActionRow[]): string {
  const body = rows.map((r) =>
    [
      r.row_id,
      r.canonical_property_name,
      r.checkin,
      r.shard_month,
      r.normalized_total_price === null ? "" : String(r.normalized_total_price),
      r.basis_confidence,
      r.dp_usage,
      r.history_action,
      String(r.price_pressure_usable)
    ]
      .map(csvEscape)
      .join(",")
  );
  return [APPEND_ACTION_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function recommendedNextAction(decision: JalanRealAppendDecision): string {
  if (decision === "jalan_history_append_success") {
    return "- Jalan rows appended to .data/history. Next likely phase is JALAN-AUTO05B (DB mirror sync + AI context refresh after the Jalan append). Do not start JALAN-AUTO05B without explicit instruction.";
  }
  if (decision === "jalan_history_append_ready_not_run") {
    return `- Fail-closed: standalone approval sentence and/or ${AUTO05X_ENV_FLAG}=1 missing. Nothing was written. Provide the exact approval sentence and re-run with the env flag to append.`;
  }
  if (decision === "jalan_history_append_failed_conflicts") {
    return "- Aborted: row_id conflict(s) detected (same row_id, different row_hash). Nothing was written. Resolve conflicts before retrying.";
  }
  if (decision === "jalan_history_append_failed_validation") {
    return "- Aborted: row policy validation failed. Nothing was written. Fix the reported row(s) before retrying.";
  }
  if (decision === "jalan_history_append_failed_write") {
    return "- Write failed and was rolled back. .data/history was restored. Investigate the failure before retrying.";
  }
  return "- Preflight failed. Nothing was written.";
}

export interface JalanRealAppendReportInput {
  generatedAtJst: string;
  runId: string;
  decision: JalanRealAppendDecision;
  gate: JalanAppendGateResult;
  sourceAuto04xJsonPath: string;
  sourceAuto03bJsonPath: string;
  selectionSummary: { approved: number; blocked: number; missingSourceRows: string[] };
  preflight: AppendPreflightSummary;
  validation: RowPolicyValidationResult;
  appendActions: readonly AppendActionRow[];
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
  jalanRowsBefore: number;
  jalanRowsAfter: number;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugRootPath: string;
}

export function renderReport(input: JalanRealAppendReportInput): string {
  const p = input.preflight;
  return [
    "# Approved Jalan History Append (Phase JALAN-AUTO05X)",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Executive Summary",
    "",
    `- decision=${input.decision}`,
    `- approved_rows_selected=${input.selectionSummary.approved}`,
    `- blocked_rows=${input.selectionSummary.blocked}`,
    `- history_row_count_before=${input.historyRowCountBefore}`,
    `- history_row_count_after=${input.historyRowCountAfter}`,
    `- jalan_rows_before=${input.jalanRowsBefore}`,
    `- jalan_rows_after=${input.jalanRowsAfter}`,
    "- Jalan stays a supplementary domestic OTA signal; the Booking primary-source directional backbone is unchanged.",
    "",
    "## 2. Approval Gate",
    "",
    `- allowed=${input.gate.allowed}`,
    `- approval_sentence_present=${input.gate.approvalSentencePresent}`,
    `- env_flag_present=${input.gate.envFlagPresent}`,
    `- failed_conditions=${JSON.stringify(input.gate.failedConditions)}`,
    "",
    "## 3. Source AUTO04X Proposal",
    "",
    `- source_auto04x_proposal_json=${input.sourceAuto04xJsonPath}`,
    `- source_auto03b_preview_json=${input.sourceAuto03bJsonPath}`,
    `- approved_row_ids=${input.selectionSummary.approved}`,
    `- blocked_row_ids=${input.selectionSummary.blocked}`,
    `- missing_source_rows=${JSON.stringify(input.selectionSummary.missingSourceRows)}`,
    "",
    "## 4. Selected Rows",
    "",
    "| canonical_property | checkin | shard | total | conf | dp_usage | history_action | price_pressure |",
    "|---|---|---|---|---|---|---|---|",
    ...input.appendActions.map(
      (a) =>
        `| ${a.canonical_property_name} | ${a.checkin} | ${a.shard_month} | ${a.normalized_total_price ?? ""} | ${a.basis_confidence} | ${a.dp_usage} | ${a.history_action} | ${a.price_pressure_usable} |`
    ),
    "",
    "## 5. Row Policy Validation",
    "",
    `- validation_ok=${input.validation.ok}`,
    `- direct_count=${input.validation.directCount}`,
    `- directional_count=${input.validation.directionalCount}`,
    `- excluded_count=${input.validation.excludedCount}`,
    `- errors=${JSON.stringify(input.validation.errors)}`,
    "",
    "## 6. Preflight Summary",
    "",
    `- existing_history_row_count=${p.existing_history_row_count}`,
    `- approved_append_row_count=${p.approved_append_row_count}`,
    `- new_row_count=${p.new_row_count}`,
    `- skip_identical_count=${p.skip_identical_count}`,
    `- conflict_count=${p.conflict_count}`,
    `- touched_shards=${JSON.stringify(p.touched_shards)}`,
    `- expected_total_after_append=${p.expected_total_after_append}`,
    "",
    "## 7. Write Result",
    "",
    `- files_created=${input.filesCreated}`,
    `- files_updated=${input.filesUpdated}`,
    `- rows_written=${input.rowsWritten}`,
    `- rows_skipped_duplicate=${input.rowsSkippedDuplicate}`,
    `- backup_dir=${input.backupDir}`,
    `- backups_created=${input.backupsCreated}`,
    `- rollback_performed=${input.rollbackPerformed}`,
    "",
    "## 8. Post-Write Validation",
    "",
    `- post_write_ok=${input.postWriteOk}`,
    `- history_row_count_after=${input.historyRowCountAfter}`,
    "",
    "## 9. DB / AI Context Staleness Notice",
    "",
    "- AUTO05X appends LOCAL HISTORY ONLY. The SQLite mirror DB and the downstream AI context packs are NOT updated by this phase.",
    `- Post-AUTO05X state: .data/history=${input.historyRowCountAfter} rows, DB mirror=${input.historyRowCountBefore} rows (stale), AI context=${input.historyRowCountBefore}-row basis (stale).`,
    "- This staleness is expected and acceptable; reconciliation is deferred to the separate JALAN-AUTO05B phase.",
    "",
    "## 10. Rollback Result",
    "",
    `- rollback_performed=${input.rollbackPerformed}`,
    "",
    "## 11. Safety Confirmation",
    "",
    `- history_appended=${input.decision === "jalan_history_append_success"}`,
    "- db_writes=false, db_mirror_sync=false, ai_context_refreshed=false",
    "- live_jalan_fetch=false, browser_automation=false, external_fetch=false",
    "- pricing_csv_generated=false, pms_beds24_airhost_output=false, price_update=false",
    "- other_source_collection=false, github_actions_or_cron=false, paid_source_tooling=false",
    "- base_times_1_1_used=false, auto05b_started=false",
    "",
    "## 12. Decision",
    "",
    `- ${input.decision}`,
    "",
    "## 13. Next Phase",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}
