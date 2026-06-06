// Phase AUTO-RUNNER08Z - approved Booking preview history append (real run).
//
// Appends only the 9 AUTO-RUNNER08Y-approved Booking directional preview rows
// into .data/history, gated by BOOKING_PREVIEW_HISTORY_APPEND=1 plus the current
// instruction approval. It writes no DB rows, runs no DB sync, refreshes no AI
// context, runs no live collection, and emits no pricing/PMS output.

import {
  buildRowHash,
  buildRowId,
  renderHistoryCsv,
  shardMonthFromCheckin,
  type HistoryRow
} from "./localHistorySchemaDesign";
import { type BookingPreviewReviewRow } from "./bookingPreviewAppendProposal";

export const BOOKING_PREVIEW_APPEND_ENV_FLAG = "BOOKING_PREVIEW_HISTORY_APPEND";
export const BOOKING_PREVIEW_APPEND_APPROVAL_SENTENCE =
  "I explicitly approve AUTO-RUNNER08Z to append the 9 AUTO-RUNNER08Y Booking preview rows to local history only.";

export type BookingPreviewHistoryAppendDecision =
  | "booking_preview_history_append_ready_not_run"
  | "booking_preview_history_append_success"
  | "booking_preview_history_append_basis_caution"
  | "booking_preview_history_append_not_ready";

export interface GateInput {
  approvalSentencePresent: boolean;
  envFlag: string | undefined;
}

export interface GateResult {
  allowed: boolean;
  approvalSentencePresent: boolean;
  envFlagPresent: boolean;
  failedConditions: string[];
}

export function evaluateGate(input: GateInput): GateResult {
  const failed: string[] = [];
  if (!input.approvalSentencePresent) failed.push("approval_sentence_absent");
  if (input.envFlag !== "1") failed.push(`${BOOKING_PREVIEW_APPEND_ENV_FLAG}!=1`);
  return {
    allowed: failed.length === 0,
    approvalSentencePresent: input.approvalSentencePresent,
    envFlagPresent: input.envFlag === "1",
    failedConditions: failed
  };
}

export interface ExistingHistoryKey {
  row_id: string;
  row_hash: string;
  shard_month: string;
  source?: string;
}

export interface HistoryInventory {
  total_rows: number;
  booking_rows: number;
  jalan_rows: number;
  rakuten_rows: number;
  duplicate_row_id_count: number;
  empty_row_hash_count: number;
  shard_month_mismatch_count: number;
  rows_by_shard: Record<string, number>;
  source_files: string[];
}

export interface ApprovedRowsSelection {
  approved_rows: HistoryRow[];
  rejected_row_ids: string[];
  validation_errors: string[];
  direct_count: number;
  directional_count: number;
  excluded_count: number;
  touched_shards: string[];
}

export function validateCanonicalIdentity(row: HistoryRow): string[] {
  const errors: string[] = [];
  const expectedId = buildRowId({
    collectedDateJst: row.collectedDateJst,
    source: row.source,
    canonicalPropertyName: row.canonicalPropertyName,
    sourceSlugOrCode: row.sourceSlugOrCode,
    sourcePropertyId: row.sourcePropertyId,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: row.stayScope
  });
  const expectedHash = buildRowHash({
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
  if (row.rowId !== expectedId) errors.push("row_id_not_canonical");
  if (row.rowHash !== expectedHash) errors.push("row_hash_not_canonical");
  if (row.shardMonth !== shardMonthFromCheckin(row.checkin)) errors.push("shard_month_mismatch");
  return errors;
}

export function selectApprovedRows(reviewRows: readonly BookingPreviewReviewRow[]): ApprovedRowsSelection {
  const approved: HistoryRow[] = [];
  const rejected: string[] = [];
  const errors: string[] = [];
  let directCount = 0;
  let directionalCount = 0;
  let excludedCount = 0;

  for (const review of reviewRows) {
    const row = review.proposed_history_row;
    const tag = review.row_id;
    if (review.append_action !== "append_directional") {
      rejected.push(tag);
      errors.push(`${tag}:append_action_not_append_directional`);
      continue;
    }
    if (review.source !== "booking" || row.source !== "booking") errors.push(`${tag}:source_not_booking`);
    if (review.dp_usage !== "directional") errors.push(`${tag}:dp_usage_not_directional`);
    if (review.basis_confidence !== "B" || row.basisConfidence !== "B") errors.push(`${tag}:basis_not_B`);
    if (review.direct_pricing_usable !== false || row.isPriceUsableForDpDirect) {
      directCount += 1;
      errors.push(`${tag}:direct_pricing_detected`);
    }
    if (!review.price_pressure_usable || !row.isPriceUsableForDpDirectional) {
      errors.push(`${tag}:directional_price_pressure_false`);
    }
    if (row.normalizedTotalPrice === null || row.sourcePrimaryPrice === null) errors.push(`${tag}:missing_price`);
    if (row.sourceSecondaryPriceOrAdder !== null) errors.push(`${tag}:unexpected_tax_fee_adder`);
    if (row.sourceComputedTotal !== null) errors.push(`${tag}:unexpected_computed_total`);
    if (row.sourcePhase !== "AUTO-RUNNER08X") errors.push(`${tag}:source_phase_not_auto_runner08x`);
    if (review.screenshot_path === "" || row.debugArtifactPath === "") errors.push(`${tag}:missing_evidence`);
    if (row.isPriceExcludedFromDp) {
      excludedCount += 1;
      errors.push(`${tag}:excluded_flag_true`);
    }
    errors.push(...validateCanonicalIdentity(row).map((e) => `${tag}:${e}`));
    approved.push(row);
    directionalCount += 1;
  }

  const touched = [...new Set(approved.map((row) => row.shardMonth))].sort();
  return {
    approved_rows: approved,
    rejected_row_ids: rejected,
    validation_errors: errors,
    direct_count: directCount,
    directional_count: directionalCount,
    excluded_count: excludedCount,
    touched_shards: touched
  };
}

export interface AppendPreflight {
  existing_history_row_count: number;
  approved_append_row_count: number;
  new_row_count: number;
  skip_identical_count: number;
  conflict_count: number;
  touched_shards: string[];
  expected_total_after_append: number;
  conflict_row_ids: string[];
}

export function computeAppendPreflight(
  rows: readonly HistoryRow[],
  existingKeys: readonly ExistingHistoryKey[],
  existingHistoryRowCount: number
): AppendPreflight {
  const existing = new Map<string, string>();
  for (const key of existingKeys) existing.set(`${key.shard_month}::${key.row_id}`, key.row_hash);
  let newCount = 0;
  let skip = 0;
  let conflict = 0;
  const conflictIds: string[] = [];
  const touched = new Set<string>();
  for (const row of rows) {
    const existingHash = existing.get(`${row.shardMonth}::${row.rowId}`);
    if (existingHash === undefined) {
      newCount += 1;
      touched.add(row.shardMonth);
    } else if (existingHash === row.rowHash) {
      skip += 1;
    } else {
      conflict += 1;
      conflictIds.push(row.rowId);
    }
  }
  return {
    existing_history_row_count: existingHistoryRowCount,
    approved_append_row_count: rows.length,
    new_row_count: newCount,
    skip_identical_count: skip,
    conflict_count: conflict,
    touched_shards: [...touched].sort(),
    expected_total_after_append: existingHistoryRowCount + newCount,
    conflict_row_ids: conflictIds
  };
}

export function groupRowsToSourceShards(rows: readonly HistoryRow[]): { shardMonth: string; csv: string }[] {
  const byShard = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const bucket = byShard.get(row.shardMonth) ?? [];
    bucket.push(row);
    byShard.set(row.shardMonth, bucket);
  }
  return [...byShard.keys()]
    .sort()
    .map((shardMonth) => ({ shardMonth, csv: renderHistoryCsv(byShard.get(shardMonth)!) }));
}

export interface PostAppendValidation {
  ok: boolean;
  total_rows: number;
  booking_rows: number;
  jalan_rows: number;
  rakuten_rows: number;
  duplicate_row_id_count: number;
  empty_row_hash_count: number;
  shard_month_mismatch_count: number;
  touched_shards_only: boolean;
  new_booking_rows: number;
  new_rows_direct: number;
  new_rows_directional: number;
  new_rows_excluded: number;
  new_rows_basis_B: number;
  errors: string[];
}

export function validateAfterAppend(input: {
  before: HistoryInventory;
  after: HistoryInventory;
  approvedRows: readonly HistoryRow[];
  expectedTouchedShards: readonly string[];
}): PostAppendValidation {
  const expectedTouched = [...input.expectedTouchedShards].sort().join(",");
  const actualTouched = [...new Set(input.approvedRows.map((row) => row.shardMonth))].sort().join(",");
  const errors: string[] = [];
  const newRows = input.approvedRows.length;
  const directional = input.approvedRows.filter((row) => row.isPriceUsableForDpDirectional && !row.isPriceUsableForDpDirect).length;
  const direct = input.approvedRows.filter((row) => row.isPriceUsableForDpDirect).length;
  const excluded = input.approvedRows.filter((row) => row.isPriceExcludedFromDp).length;
  const basisB = input.approvedRows.filter((row) => row.basisConfidence === "B").length;

  if (input.after.total_rows !== input.before.total_rows + newRows) errors.push("total_rows_mismatch");
  if (input.after.booking_rows !== input.before.booking_rows + newRows) errors.push("booking_rows_mismatch");
  if (input.after.jalan_rows !== input.before.jalan_rows) errors.push("jalan_rows_changed");
  if (input.after.rakuten_rows !== input.before.rakuten_rows) errors.push("rakuten_rows_changed");
  if (input.after.duplicate_row_id_count !== 0) errors.push("duplicate_row_id_count_nonzero");
  if (input.after.empty_row_hash_count !== 0) errors.push("empty_row_hash_count_nonzero");
  if (input.after.shard_month_mismatch_count !== 0) errors.push("shard_month_mismatch_nonzero");
  if (actualTouched !== expectedTouched) errors.push(`touched_shards_mismatch:${actualTouched}`);
  if (direct !== 0) errors.push("new_rows_direct_nonzero");
  if (directional !== newRows) errors.push("new_rows_directional_mismatch");
  if (excluded !== 0) errors.push("new_rows_excluded_nonzero");
  if (basisB !== newRows) errors.push("new_rows_basis_B_mismatch");

  return {
    ok: errors.length === 0,
    total_rows: input.after.total_rows,
    booking_rows: input.after.booking_rows,
    jalan_rows: input.after.jalan_rows,
    rakuten_rows: input.after.rakuten_rows,
    duplicate_row_id_count: input.after.duplicate_row_id_count,
    empty_row_hash_count: input.after.empty_row_hash_count,
    shard_month_mismatch_count: input.after.shard_month_mismatch_count,
    touched_shards_only: actualTouched === expectedTouched,
    new_booking_rows: newRows,
    new_rows_direct: direct,
    new_rows_directional: directional,
    new_rows_excluded: excluded,
    new_rows_basis_B: basisB,
    errors
  };
}

export function decideBeforeWrite(input: {
  gateAllowed: boolean;
  selection: ApprovedRowsSelection;
  preflight: AppendPreflight;
  expectedApprovedRows: number;
}): BookingPreviewHistoryAppendDecision {
  if (!input.gateAllowed) return "booking_preview_history_append_ready_not_run";
  if (input.selection.approved_rows.length !== input.expectedApprovedRows) return "booking_preview_history_append_not_ready";
  if (input.selection.validation_errors.length > 0) return "booking_preview_history_append_not_ready";
  if (input.preflight.conflict_count > 0) return "booking_preview_history_append_not_ready";
  if (input.preflight.new_row_count !== input.expectedApprovedRows) return "booking_preview_history_append_not_ready";
  return "booking_preview_history_append_success";
}

export function buildSafetyConfirmation(input: { appended: boolean; envFlagSet: boolean; approvalSentencePresent: boolean }) {
  return {
    history_appended: input.appended,
    history_modified: input.appended,
    db_written: false,
    db_synced: false,
    ai_context_refreshed: false,
    live_booking_collection: false,
    collect_booking_env_used: false,
    jalan_collection: false,
    rakuten_collection: false,
    google_hotels_collection: false,
    query_smoke_run: false,
    pricing_csv_generated: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    launchd_collector_install: false,
    direct_pricing_promotion: false,
    existing_rows_overwritten: false,
    started_auto_runner08aa: false,
    approval_sentence_present: input.approvalSentencePresent,
    env_flag_set: input.envFlagSet
  };
}

export const APPEND_ACTION_CSV_HEADERS = [
  "row_id",
  "canonical_property_name",
  "checkin",
  "shard_month",
  "normalized_total_price",
  "basis_confidence",
  "source_phase",
  "collector_stage",
  "is_price_usable_for_dp_direct",
  "is_price_usable_for_dp_directional",
  "is_price_excluded_from_dp"
] as const;

export function renderAppendActionCsv(rows: readonly HistoryRow[]): string {
  const body = rows.map((row) =>
    [
      row.rowId,
      row.canonicalPropertyName,
      row.checkin,
      row.shardMonth,
      row.normalizedTotalPrice === null ? "" : String(row.normalizedTotalPrice),
      row.basisConfidence,
      row.sourcePhase,
      row.collectorStage,
      String(row.isPriceUsableForDpDirect),
      String(row.isPriceUsableForDpDirectional),
      String(row.isPriceExcludedFromDp)
    ]
      .map(csvEscape)
      .join(",")
  );
  return [APPEND_ACTION_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  runId: string;
  decision: BookingPreviewHistoryAppendDecision;
  gate: GateResult;
  sourceProposalPath: string;
  preflight: AppendPreflight;
  selection: ApprovedRowsSelection;
  before: HistoryInventory;
  after: HistoryInventory;
  rowsWritten: number;
  filesUpdated: number;
  backupsCreated: number;
  rollbackPerformed: boolean;
  postValidation: PostAppendValidation | null;
  dbRowsBefore: number | null;
  dbRowsAfter: number | null;
  aiContextRowsBefore: number | null;
  aiContextRowsAfter: number | null;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
}): string {
  return [
    "# Booking Preview History Append Real Run",
    "",
    `Generated at JST: ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${input.decision}`,
    `- rows_written=${input.rowsWritten}`,
    `- history_before=${input.before.total_rows}`,
    `- history_after=${input.after.total_rows}`,
    `- booking_before=${input.before.booking_rows}`,
    `- booking_after=${input.after.booking_rows}`,
    "",
    "## 2. Gate",
    "",
    `- allowed=${input.gate.allowed}`,
    `- approval_sentence_present=${input.gate.approvalSentencePresent}`,
    `- env_flag_present=${input.gate.envFlagPresent}`,
    `- failed_conditions=${JSON.stringify(input.gate.failedConditions)}`,
    "",
    "## 3. Source Proposal",
    "",
    `- source_proposal=${input.sourceProposalPath}`,
    `- approved_rows=${input.selection.approved_rows.length}`,
    `- rejected_rows=${input.selection.rejected_row_ids.length}`,
    `- validation_errors=${JSON.stringify(input.selection.validation_errors)}`,
    "",
    "## 4. Preflight",
    "",
    `- existing_history_row_count=${input.preflight.existing_history_row_count}`,
    `- new_row_count=${input.preflight.new_row_count}`,
    `- skip_identical_count=${input.preflight.skip_identical_count}`,
    `- conflict_count=${input.preflight.conflict_count}`,
    `- touched_shards=${JSON.stringify(input.preflight.touched_shards)}`,
    `- expected_total_after_append=${input.preflight.expected_total_after_append}`,
    "",
    "## 5. Post-Write Validation",
    "",
    `- post_validation_ok=${input.postValidation?.ok ?? false}`,
    `- duplicate_row_id_count=${input.after.duplicate_row_id_count}`,
    `- empty_row_hash_count=${input.after.empty_row_hash_count}`,
    `- shard_month_mismatch_count=${input.after.shard_month_mismatch_count}`,
    `- new_rows_direct=${input.postValidation?.new_rows_direct ?? 0}`,
    `- new_rows_directional=${input.postValidation?.new_rows_directional ?? 0}`,
    `- new_rows_excluded=${input.postValidation?.new_rows_excluded ?? 0}`,
    "",
    "## 6. DB / AI Context State",
    "",
    "- AUTO-RUNNER08Z appends local history only. DB and AI context intentionally remain stale.",
    `- db_rows_before=${input.dbRowsBefore ?? ""}`,
    `- db_rows_after=${input.dbRowsAfter ?? ""}`,
    `- ai_context_rows_before=${input.aiContextRowsBefore ?? ""}`,
    `- ai_context_rows_after=${input.aiContextRowsAfter ?? ""}`,
    "",
    "## 7. Safety",
    "",
    "- No live collection, no DB sync, no AI context refresh, no pricing/PMS output.",
    "- Booking rows remain directional only; no direct-pricing promotion.",
    "",
    "## 8. Output Paths",
    "",
    `- report_path=${input.reportPath}`,
    `- json_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugPath}`,
    "",
    "## 9. Next Step",
    "",
    "- AUTO-RUNNER08AA — Sync updated history to DB and rebuild AI context. Do not start without explicit instruction.",
    ""
  ].join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
