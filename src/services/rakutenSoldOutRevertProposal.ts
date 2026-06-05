// Phase AUTO08X-FIX02-P — revert proposal for AUTO08X Rakuten sold-out rows.
//
// Proposal/preflight only. This module computes the exact row-id removal set
// and future revert plan. It does not mutate history, write DB rows, run DB
// sync, rebuild AI context, run collectors, use Playwright, or fetch live pages.

import { isAuto08xAffectedRow, type HistoryRowLike } from "./rakutenSoldOutSemanticsAudit";

export type RakutenSoldOutRevertProposalDecision =
  | "rakuten_sold_out_revert_proposal_ready"
  | "rakuten_sold_out_revert_proposal_basis_caution"
  | "rakuten_sold_out_revert_proposal_not_ready";

export interface LoadedHistoryRowForRevert extends HistoryRowLike {
  __source_file: string;
}

export interface AffectedRemovalRow {
  row_id: string;
  row_hash: string;
  shard_month: string;
  source_file: string;
  source: string;
  canonical_property_name: string;
  source_property_id: string;
  source_slug_or_code: string;
  checkin: string;
  source_phase: string;
  source_classification: string;
  debug_artifact_path: string;
}

export interface ShardCountPlan {
  shard_month: string;
  source_file: string;
  before_rows: number;
  affected_rows: number;
  after_rows: number;
}

export interface BackupRollbackPlan {
  backup_dir_template: string;
  touched_files: string[];
  backup_steps: string[];
  rollback_steps: string[];
}

export interface WritePlan {
  temp_file_pattern: string;
  steps: string[];
  validation_checks: string[];
}

export interface DbResyncPlan {
  expected_market_signal_history_rows_before: number;
  expected_market_signal_history_rows_after: number;
  steps: string[];
}

export interface AiContextRebuildPlan {
  expected_sold_out_row_count_before: number;
  expected_sold_out_row_count_after: number;
  expected_basis_confidence_insufficient_before: number;
  expected_basis_confidence_insufficient_after: number;
  steps: string[];
}

export interface ApprovalGateTemplate {
  approval_sentence_template: string;
  approval_is_active_in_this_phase: boolean;
  required_env_flag: string;
  required_command: string;
}

export interface RakutenSoldOutRevertProposal {
  run_id: string;
  generated_at_jst: string;
  decision: RakutenSoldOutRevertProposalDecision;
  source_fix01_artifact: string;
  affected_run_id: string;
  affected_source: string;
  affected_semantics: string;
  affected_history_rows: number;
  affected_row_ids: string[];
  affected_rows: AffectedRemovalRow[];
  touched_shards: string[];
  shard_count_plan: ShardCountPlan[];
  total_history_rows_before: number;
  total_history_rows_after: number;
  backup_rollback_plan: BackupRollbackPlan;
  write_plan: WritePlan;
  db_resync_plan: DbResyncPlan;
  ai_context_rebuild_plan: AiContextRebuildPlan;
  approval_gate_template: ApprovalGateTemplate;
  safety_confirmation: Record<string, boolean>;
  validation_notes: string[];
}

export const FIX01_AUDIT_JSON = ".data/reports/automation/rakuten_sold_out_semantics_audit_20260604_103811.json";
export const AFFECTED_RUN_ID = "20260604_094714";
export const FUTURE_APPROVAL_SENTENCE =
  "Approve Phase AUTO08X-FIX02 revert contaminated Rakuten room-type sold-out rows. You may remove the 116 AUTO08X rows from .data/history, resync DB, and rebuild AI context packs.";
export const FUTURE_ENV_FLAG = "RAKUTEN_SOLDOUT_REVERT=1";
export const FUTURE_REAL_RUN_COMMAND = "RAKUTEN_SOLDOUT_REVERT=1 npm run real-run:rakuten-sold-out-revert";

export function identifyAffectedRemovalRows(rows: LoadedHistoryRowForRevert[]): AffectedRemovalRow[] {
  return rows
    .filter(isAuto08xAffectedRow)
    .map((row) => ({
      row_id: row.row_id ?? "",
      row_hash: row.row_hash ?? "",
      shard_month: row.shard_month ?? "",
      source_file: row.__source_file,
      source: row.source ?? "",
      canonical_property_name: row.canonical_property_name ?? "",
      source_property_id: row.source_property_id ?? "",
      source_slug_or_code: row.source_slug_or_code ?? "",
      checkin: row.checkin ?? row.checkin_date ?? "",
      source_phase: row.source_phase ?? "",
      source_classification: row.source_classification ?? row.classification ?? "",
      debug_artifact_path: row.debug_artifact_path ?? ""
    }))
    .sort((a, b) => a.row_id.localeCompare(b.row_id));
}

export function groupAffectedRowsByShard(rows: AffectedRemovalRow[]): Record<string, number> {
  return countBy(rows, (row) => row.shard_month);
}

export function buildShardCountPlan(rows: LoadedHistoryRowForRevert[], affected: AffectedRemovalRow[]): ShardCountPlan[] {
  const touchedFiles = [...new Set(affected.map((row) => row.source_file))].sort();
  return touchedFiles.map((file) => {
    const rowsInFile = rows.filter((row) => row.__source_file === file);
    const affectedInFile = affected.filter((row) => row.source_file === file);
    const shardMonth = affectedInFile[0]?.shard_month ?? rowsInFile[0]?.shard_month ?? "";
    return {
      shard_month: shardMonth,
      source_file: file,
      before_rows: rowsInFile.length,
      affected_rows: affectedInFile.length,
      after_rows: rowsInFile.length - affectedInFile.length
    };
  });
}

export function ensureRemovalSetOnlyAuto08x(rows: LoadedHistoryRowForRevert[], removalIds: string[]): boolean {
  const byId = new Map(rows.map((row) => [row.row_id ?? "", row]));
  return removalIds.every((rowId) => {
    const row = byId.get(rowId);
    return row !== undefined && isAuto08xAffectedRow(row);
  });
}

export function buildBackupRollbackPlan(touchedFiles: string[]): BackupRollbackPlan {
  return {
    backup_dir_template: ".data/history/.backup/YYYYMMDD_HHmmss_rakuten_soldout_revert/",
    touched_files: touchedFiles,
    backup_steps: [
      "Create backup directory before any write.",
      "Copy each touched shard into the backup directory.",
      "Record source file path, backup path, byte size, and row count for each backup."
    ],
    rollback_steps: [
      "If validation or atomic rename fails, restore all touched shards from backup.",
      "Verify restored headers and row counts match pre-revert state.",
      "Do not continue to DB resync or AI context rebuild if rollback is needed."
    ]
  };
}

export function buildWritePlan(): WritePlan {
  return {
    temp_file_pattern: "{source_file}.tmp_rakuten_soldout_revert",
    steps: [
      "Read touched shard into memory.",
      "Remove rows whose row_id appears in affected_row_ids.",
      "Write cleaned content to a temp file beside the source shard.",
      "Validate temp file before replacing the source shard.",
      "Atomic rename temp file over source shard only after validation passes."
    ],
    validation_checks: [
      "header unchanged",
      "schema_version unchanged",
      "row_id uniqueness",
      "removed row count = 116",
      "no non-AUTO08X rows removed",
      "2026_06 final row count = 60",
      "2026_07 final row count = 65"
    ]
  };
}

export function buildDbResyncPlan(): DbResyncPlan {
  return {
    expected_market_signal_history_rows_before: 261,
    expected_market_signal_history_rows_after: 145,
    steps: [
      "Run history-to-DB dry-run from cleaned history.",
      "Verify dry-run reports 145 mapped rows and zero conflicts.",
      "Generalize or repoint the real history-to-DB sync to the cleaned history state.",
      "With explicit approval and gate, run HISTORY_TO_DB_SYNC=1 npm run real-run:history-to-db-sync.",
      "Verify market_signal_history row count is 145 and AUTO08X row_ids are absent."
    ]
  };
}

export function buildAiContextRebuildPlan(): AiContextRebuildPlan {
  return {
    expected_sold_out_row_count_before: 182,
    expected_sold_out_row_count_after: 66,
    expected_basis_confidence_insufficient_before: 119,
    expected_basis_confidence_insufficient_after: 3,
    steps: [
      "After DB mirror resync succeeds, run npm run build:ai-context-packs.",
      "Verify latest_market_snapshot.sold_out_row_count returns to 66.",
      "Verify latest_market_snapshot.basis_confidence_counts.insufficient returns to 3.",
      "Run query smoke checks against refreshed AI context packs."
    ]
  };
}

export function buildApprovalGateTemplate(): ApprovalGateTemplate {
  return {
    approval_sentence_template: FUTURE_APPROVAL_SENTENCE,
    approval_is_active_in_this_phase: false,
    required_env_flag: FUTURE_ENV_FLAG,
    required_command: FUTURE_REAL_RUN_COMMAND
  };
}

export function buildRakutenSoldOutRevertProposal(input: {
  runId: string;
  generatedAtJst: string;
  sourceFix01Artifact: string;
  fix01Decision: string;
  fix01AffectedHistoryRows: number;
  historyRows: LoadedHistoryRowForRevert[];
}): RakutenSoldOutRevertProposal {
  const affected = identifyAffectedRemovalRows(input.historyRows);
  const rowIds = affected.map((row) => row.row_id);
  const shardPlan = buildShardCountPlan(input.historyRows, affected);
  const touchedShards = shardPlan.map((plan) => plan.shard_month).sort();
  const touchedFiles = shardPlan.map((plan) => plan.source_file).sort();
  const totalBefore = input.historyRows.length;
  const totalAfter = totalBefore - affected.length;
  const validationNotes = validateProposal({
    fix01Decision: input.fix01Decision,
    fix01AffectedHistoryRows: input.fix01AffectedHistoryRows,
    historyRows: input.historyRows,
    affected,
    shardPlan
  });
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision: validationNotes.length === 0
      ? "rakuten_sold_out_revert_proposal_ready"
      : affected.length > 0
        ? "rakuten_sold_out_revert_proposal_basis_caution"
        : "rakuten_sold_out_revert_proposal_not_ready",
    source_fix01_artifact: input.sourceFix01Artifact,
    affected_run_id: AFFECTED_RUN_ID,
    affected_source: "rakuten",
    affected_semantics: "room_type_context_sold_out",
    affected_history_rows: affected.length,
    affected_row_ids: rowIds,
    affected_rows: affected,
    touched_shards: touchedShards,
    shard_count_plan: shardPlan,
    total_history_rows_before: totalBefore,
    total_history_rows_after: totalAfter,
    backup_rollback_plan: buildBackupRollbackPlan(touchedFiles),
    write_plan: buildWritePlan(),
    db_resync_plan: buildDbResyncPlan(),
    ai_context_rebuild_plan: buildAiContextRebuildPlan(),
    approval_gate_template: buildApprovalGateTemplate(),
    safety_confirmation: {
      historyModified: false,
      dbWrites: false,
      dbSyncRun: false,
      aiContextRebuilt: false,
      collectorsRun: false,
      playwrightUsed: false,
      liveExternalFetch: false,
      paidSourceTooling: false,
      futureApprovalActive: false
    },
    validation_notes: validationNotes
  };
}

export function renderRakutenSoldOutRevertProposalCsv(proposal: RakutenSoldOutRevertProposal): string {
  const headers = ["row_id", "shard_month", "source_file", "canonical_property_name", "source_property_id", "source_slug_or_code", "checkin", "source_classification"];
  const rows = proposal.affected_rows.map((row) => [
    row.row_id,
    row.shard_month,
    row.source_file,
    row.canonical_property_name,
    row.source_property_id,
    row.source_slug_or_code,
    row.checkin,
    row.source_classification
  ]);
  return `${headers.join(",")}\n${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

export function renderRakutenSoldOutRevertProposalMarkdown(proposal: RakutenSoldOutRevertProposal): string {
  return [
    "# Rakuten Sold-Out Revert Proposal",
    "",
    `Generated at: ${proposal.generated_at_jst}`,
    `Decision: ${proposal.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    `Proposal only. Remove exactly ${proposal.affected_history_rows} AUTO08X Rakuten room-type sold-out rows after future explicit approval.`,
    "",
    "## 2. Source FIX01 Artifact",
    "",
    `- ${proposal.source_fix01_artifact}`,
    "",
    "## 3. Affected Rows Proposed for Removal",
    "",
    `- affected_run_id=${proposal.affected_run_id}`,
    `- affected_source=${proposal.affected_source}`,
    `- affected_semantics=${proposal.affected_semantics}`,
    `- affected_history_rows=${proposal.affected_history_rows}`,
    "",
    "## 4. Shards Touched",
    "",
    ...proposal.shard_count_plan.map((plan) =>
      `- ${plan.shard_month}: ${plan.source_file}; before=${plan.before_rows}; remove=${plan.affected_rows}; after=${plan.after_rows}`
    ),
    "",
    "## 5. Backup / Rollback Plan",
    "",
    `- backup_dir_template=${proposal.backup_rollback_plan.backup_dir_template}`,
    ...proposal.backup_rollback_plan.backup_steps.map((step) => `- backup_step=${step}`),
    ...proposal.backup_rollback_plan.rollback_steps.map((step) => `- rollback_step=${step}`),
    "",
    "## 6. Temp Write / Atomic Rename Plan",
    "",
    `- temp_file_pattern=${proposal.write_plan.temp_file_pattern}`,
    ...proposal.write_plan.steps.map((step) => `- write_step=${step}`),
    ...proposal.write_plan.validation_checks.map((check) => `- validation=${check}`),
    "",
    "## 7. DB Resync Plan",
    "",
    `- expected_market_signal_history_rows=${proposal.db_resync_plan.expected_market_signal_history_rows_before} -> ${proposal.db_resync_plan.expected_market_signal_history_rows_after}`,
    ...proposal.db_resync_plan.steps.map((step) => `- ${step}`),
    "",
    "## 8. AI Context Rebuild Plan",
    "",
    `- sold_out_row_count=${proposal.ai_context_rebuild_plan.expected_sold_out_row_count_before} -> ${proposal.ai_context_rebuild_plan.expected_sold_out_row_count_after}`,
    `- basis_confidence.insufficient=${proposal.ai_context_rebuild_plan.expected_basis_confidence_insufficient_before} -> ${proposal.ai_context_rebuild_plan.expected_basis_confidence_insufficient_after}`,
    ...proposal.ai_context_rebuild_plan.steps.map((step) => `- ${step}`),
    "",
    "## 9. Future Approval Gate",
    "",
    `- approval_sentence_template=${proposal.approval_gate_template.approval_sentence_template}`,
    `- approval_is_active_in_this_phase=${proposal.approval_gate_template.approval_is_active_in_this_phase}`,
    `- required_env_flag=${proposal.approval_gate_template.required_env_flag}`,
    `- required_command=${proposal.approval_gate_template.required_command}`,
    "",
    "## 10. Safety Confirmation",
    "",
    ...Object.entries(proposal.safety_confirmation).map(([key, value]) => `- ${key}=${value}`),
    "",
    "## 11. Validation Notes",
    "",
    ...(proposal.validation_notes.length === 0 ? ["- none"] : proposal.validation_notes.map((note) => `- ${note}`)),
    ""
  ].join("\n");
}

function validateProposal(input: {
  fix01Decision: string;
  fix01AffectedHistoryRows: number;
  historyRows: LoadedHistoryRowForRevert[];
  affected: AffectedRemovalRow[];
  shardPlan: ShardCountPlan[];
}): string[] {
  const notes: string[] = [];
  if (input.fix01Decision !== "rakuten_sold_out_semantics_audit_basis_caution") notes.push(`FIX01 decision unexpected: ${input.fix01Decision}`);
  if (input.fix01AffectedHistoryRows !== input.affected.length) notes.push(`FIX01 affected count differs: ${input.fix01AffectedHistoryRows} vs ${input.affected.length}`);
  if (input.affected.length !== 116) notes.push(`affected row count is not 116: ${input.affected.length}`);
  const shardCounts = Object.fromEntries(input.shardPlan.map((plan) => [plan.shard_month, plan.affected_rows]));
  if (shardCounts["2026_06"] !== 54) notes.push(`2026_06 affected count is not 54: ${shardCounts["2026_06"] ?? 0}`);
  if (shardCounts["2026_07"] !== 62) notes.push(`2026_07 affected count is not 62: ${shardCounts["2026_07"] ?? 0}`);
  const touched = input.shardPlan.map((plan) => plan.shard_month).sort().join(",");
  if (touched !== "2026_06,2026_07") notes.push(`touched shards unexpected: ${touched}`);
  if (!ensureRemovalSetOnlyAuto08x(input.historyRows, input.affected.map((row) => row.row_id))) notes.push("removal set contains non-AUTO08X rows");
  const duplicateIds = duplicates(input.affected.map((row) => row.row_id));
  if (duplicateIds.length > 0) notes.push(`duplicate affected row_ids: ${duplicateIds.join(",")}`);
  return notes;
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item) || "(blank)";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function duplicates(values: string[]): string[] {
  const counts = countBy(values, (value) => value);
  return Object.entries(counts).filter(([, count]) => count > 1).map(([value]) => value);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}
