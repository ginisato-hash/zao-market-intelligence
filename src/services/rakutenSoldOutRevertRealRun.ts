// Phase AUTO08X-FIX02 — approved real revert for contaminated Rakuten rows.
//
// Real correction scope is deliberately narrow:
// - remove only approved AUTO08X row_ids from the two approved history shards
// - reconcile DB mirror by deleting only those same approved row_ids
// - rebuild derived AI context after DB reconciliation
// This module does not run collectors, fetch external sites, use Playwright,
// touch property masters, produce PMS/channel output, or enable automation.

import { isAuto08xAffectedRow, type HistoryRowLike } from "./rakutenSoldOutSemanticsAudit";
import type { RakutenSoldOutRevertProposal, ShardCountPlan } from "./rakutenSoldOutRevertProposal";

export type RakutenSoldOutRevertDecision =
  | "rakuten_sold_out_revert_ready_not_run"
  | "rakuten_sold_out_revert_success"
  | "rakuten_sold_out_revert_failed_preflight"
  | "rakuten_sold_out_revert_failed_write"
  | "rakuten_sold_out_revert_failed_validation"
  | "rakuten_sold_out_revert_failed_rolled_back"
  | "rakuten_sold_out_revert_failed_manual_recovery_required"
  | "rakuten_sold_out_revert_failed_db_resync"
  | "rakuten_sold_out_revert_failed_context_rebuild";

export interface ApprovalGateResult {
  passed: boolean;
  decision: RakutenSoldOutRevertDecision;
  reasons: string[];
  explicitApprovalPresent: boolean;
  envFlagPresent: boolean;
  proposalDecision: string;
  affectedRowCount: number;
  touchedShards: string[];
}

export interface CsvTable {
  headerLine: string;
  headers: string[];
  rows: Record<string, string>[];
}

export interface HistoryShardInput {
  path: string;
  csv: string;
}

export interface HistoryBeforeSummary {
  total_history_rows: number;
  shard_counts: Record<string, number>;
  touched_shard_counts: Record<string, number>;
}

export interface PreflightResult {
  passed: boolean;
  errors: string[];
  before_summary: HistoryBeforeSummary;
  expected_after_counts: Record<string, number>;
  target_row_ids_found: number;
}

export interface CleanedShard {
  path: string;
  headerLine: string;
  beforeRows: number;
  removedRows: number;
  afterRows: number;
  content: string;
}

export interface HistoryAfterSummary {
  total_history_rows: number;
  shard_counts: Record<string, number>;
  removed_row_ids_remaining: string[];
  duplicate_row_id_count: number;
  schema_versions: Record<string, number>;
  shard_month_mismatches: string[];
  row_hash_missing_count: number;
}

export interface DbReconciliationResult {
  attempted: boolean;
  deleted_rows: number;
  remaining_approved_row_ids: number;
  market_signal_history_rows: number;
  sync_run_recorded: boolean;
  errors: string[];
}

export interface ContextRebuildSummary {
  attempted: boolean;
  command: string;
  exit_code: number | null;
  market_signal_history_rows: number | null;
  sold_out_count: number | null;
  basis_confidence_insufficient: number | null;
  latest_files_regular: boolean;
  report_path: string;
  errors: string[];
}

export interface TaskQuerySmokeSummary {
  attempted: boolean;
  commands: string[];
  passed: boolean;
  outputs: string[];
  errors: string[];
}

export interface RakutenSoldOutRevertRealRunReport {
  run_id: string;
  generated_at_jst: string;
  decision: RakutenSoldOutRevertDecision;
  source_fix02p_artifact: string;
  explicit_approval_result: ApprovalGateResult;
  revert_preflight_result: PreflightResult;
  history_revert_actions: CleanedShard[];
  backup_path: string;
  backup_actions: string[];
  rollback_result: { attempted: boolean; success: boolean; message: string };
  db_resync_reconciliation_result: DbReconciliationResult;
  ai_context_rebuild_result: ContextRebuildSummary;
  task_query_smoke_result: TaskQuerySmokeSummary;
  final_row_counts: {
    history_total_rows: number;
    db_market_signal_history_rows: number | null;
    ai_context_sold_out_count: number | null;
    ai_context_basis_confidence_insufficient: number | null;
  };
  safety_confirmation: Record<string, boolean>;
  report_path: string;
  json_path: string;
  csv_path: string;
  debug_artifact_path: string;
}

export const REAL_REVERT_APPROVAL_SENTENCE =
  "Approve Phase AUTO08X-FIX02 revert contaminated Rakuten room-type sold-out rows. You may remove the 116 AUTO08X rows from .data/history, resync DB, and rebuild AI context packs.";
export const REAL_REVERT_ENV_FLAG = "RAKUTEN_SOLDOUT_REVERT";
export const APPROVED_TOUCHED_SHARDS = ["2026_06", "2026_07"] as const;
export const APPROVED_TOUCHED_FILES = [
  ".data/history/zao_signals_2026_06.csv",
  ".data/history/zao_signals_2026_07.csv"
] as const;

export function evaluateRakutenSoldOutRevertGate(input: {
  explicitApprovalPresent: boolean;
  envFlag: string | undefined;
  proposal: RakutenSoldOutRevertProposal | null;
}): ApprovalGateResult {
  const reasons: string[] = [];
  const proposalDecision = input.proposal?.decision ?? "";
  const affectedRowCount = input.proposal?.affected_row_ids.length ?? 0;
  const touchedShards = input.proposal?.touched_shards ?? [];
  if (!input.explicitApprovalPresent) reasons.push("explicit approval sentence missing");
  if (input.envFlag !== "1") reasons.push("RAKUTEN_SOLDOUT_REVERT env flag is not 1");
  if (input.proposal === null) reasons.push("FIX02-P proposal artifact missing");
  if (input.proposal !== null && !["rakuten_sold_out_revert_proposal_ready", "rakuten_sold_out_revert_proposal_basis_caution"].includes(input.proposal.decision))
    reasons.push(`proposal decision is not ready/basis_caution: ${input.proposal.decision}`);
  if (affectedRowCount !== 116) reasons.push(`affected row_ids count is not 116: ${affectedRowCount}`);
  if (touchedShards.slice().sort().join(",") !== APPROVED_TOUCHED_SHARDS.slice().sort().join(",")) reasons.push(`touched shards are not exactly 2026_06,2026_07: ${touchedShards.join(",")}`);
  return {
    passed: reasons.length === 0,
    decision: reasons.length === 0 ? "rakuten_sold_out_revert_success" : "rakuten_sold_out_revert_ready_not_run",
    reasons,
    explicitApprovalPresent: input.explicitApprovalPresent,
    envFlagPresent: input.envFlag === "1",
    proposalDecision,
    affectedRowCount,
    touchedShards
  };
}

export function parseCsvWithHeaderLine(csv: string): CsvTable {
  const firstNewline = csv.search(/\r?\n/u);
  const headerLine = firstNewline >= 0 ? csv.slice(0, firstNewline).replace(/\r$/u, "") : csv.replace(/\r$/u, "");
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    const next = csv[i + 1];
    if (inQuotes && ch === "\"" && next === "\"") {
      cell += "\"";
      i++;
    } else if (ch === "\"") {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((value) => value !== "")) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value !== "")) matrix.push(row);
  }
  const headers = matrix.shift() ?? [];
  return { headerLine, headers, rows: matrix.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) };
}

export function renderCsvTable(headers: string[], rows: Record<string, string>[]): string {
  return `${headers.join(",")}\n${rows.map((row) => headers.map((h) => csvEscape(row[h] ?? "")).join(",")).join("\n")}\n`;
}

export function preflightRakutenSoldOutRevert(input: {
  proposal: RakutenSoldOutRevertProposal;
  allHistoryRows: HistoryRowLike[];
  touchedShards: HistoryShardInput[];
}): PreflightResult {
  const errors: string[] = [];
  const targetIds = new Set(input.proposal.affected_row_ids);
  const touchedRows: HistoryRowLike[] = input.touchedShards.flatMap((shard) =>
    parseCsvWithHeaderLine(shard.csv).rows.map((row): HistoryRowLike => ({ ...row, __source_file: shard.path }))
  );
  const rowsById = new Map(touchedRows.map((row) => [row["row_id"] ?? "", row]));
  const foundRows = input.proposal.affected_row_ids.map((rowId) => rowsById.get(rowId)).filter((row): row is HistoryRowLike => row !== undefined);
  if (targetIds.size !== 116) errors.push(`target row_id count is not 116: ${targetIds.size}`);
  if (foundRows.length !== 116) errors.push(`target row_ids found is not 116: ${foundRows.length}`);
  for (const row of foundRows) {
    if (!isAuto08xAffectedRow(row)) errors.push(`target row is not AUTO08X contaminated: ${row["row_id"] ?? ""}`);
    if (!APPROVED_TOUCHED_SHARDS.includes((row["shard_month"] ?? "") as (typeof APPROVED_TOUCHED_SHARDS)[number])) errors.push(`target row outside approved shards: ${row["row_id"] ?? ""}`);
  }

  const touchedCounts = Object.fromEntries(input.touchedShards.map((shard) => {
    const table = parseCsvWithHeaderLine(shard.csv);
    const shardMonth = table.rows[0]?.["shard_month"] ?? shard.path.match(/(\d{4}_\d{2})/)?.[1] ?? "";
    return [shardMonth, table.rows.length];
  }));
  if (touchedCounts["2026_06"] !== 114) errors.push(`2026_06 current row count is not 114: ${touchedCounts["2026_06"] ?? 0}`);
  if (touchedCounts["2026_07"] !== 127) errors.push(`2026_07 current row count is not 127: ${touchedCounts["2026_07"] ?? 0}`);
  const expectedAfter = Object.fromEntries(input.proposal.shard_count_plan.map((plan) => [plan.shard_month, plan.after_rows]));
  if (expectedAfter["2026_06"] !== 60) errors.push(`2026_06 expected after count is not 60: ${expectedAfter["2026_06"] ?? 0}`);
  if (expectedAfter["2026_07"] !== 65) errors.push(`2026_07 expected after count is not 65: ${expectedAfter["2026_07"] ?? 0}`);

  return {
    passed: errors.length === 0,
    errors,
    before_summary: {
      total_history_rows: input.allHistoryRows.length,
      shard_counts: countBy(input.allHistoryRows, (row) => row.shard_month ?? ""),
      touched_shard_counts: touchedCounts
    },
    expected_after_counts: expectedAfter,
    target_row_ids_found: foundRows.length
  };
}

export function buildCleanedShards(input: {
  proposal: RakutenSoldOutRevertProposal;
  touchedShards: HistoryShardInput[];
}): CleanedShard[] {
  const targetIds = new Set(input.proposal.affected_row_ids);
  return input.touchedShards.map((shard) => {
    const table = parseCsvWithHeaderLine(shard.csv);
    const cleaned = table.rows.filter((row) => !targetIds.has(row["row_id"] ?? ""));
    return {
      path: shard.path,
      headerLine: table.headerLine,
      beforeRows: table.rows.length,
      removedRows: table.rows.length - cleaned.length,
      afterRows: cleaned.length,
      content: renderCsvTable(table.headers, cleaned)
    };
  });
}

export function validateHistoryAfterRevert(input: {
  allHistoryRows: HistoryRowLike[];
  removedRowIds: string[];
}): HistoryAfterSummary {
  const rowIds = input.allHistoryRows.map((row) => row.row_id ?? "");
  const counts = countBy(rowIds, (id) => id);
  const remaining = input.removedRowIds.filter((id) => counts[id] !== undefined);
  const duplicates = Object.values(counts).filter((count) => count > 1).length;
  return {
    total_history_rows: input.allHistoryRows.length,
    shard_counts: countBy(input.allHistoryRows, (row) => row.shard_month ?? ""),
    removed_row_ids_remaining: remaining,
    duplicate_row_id_count: duplicates,
    schema_versions: countBy(input.allHistoryRows, (row) => row.schema_version ?? ""),
    shard_month_mismatches: input.allHistoryRows
      .filter((row) => {
        const file = row.__source_file ?? "";
        const expected = file.match(/(\d{4}_\d{2})/)?.[1] ?? "";
        return expected !== "" && row.shard_month !== expected;
      })
      .map((row) => row.row_id ?? ""),
    row_hash_missing_count: input.allHistoryRows.filter((row) => (row.row_hash ?? "") === "").length
  };
}

export function validateExpectedHistoryAfter(summary: HistoryAfterSummary): string[] {
  const errors: string[] = [];
  if (summary.total_history_rows !== 145) errors.push(`total history rows is not 145: ${summary.total_history_rows}`);
  if (summary.shard_counts["2026_06"] !== 60) errors.push(`2026_06 row count is not 60: ${summary.shard_counts["2026_06"] ?? 0}`);
  if (summary.shard_counts["2026_07"] !== 65) errors.push(`2026_07 row count is not 65: ${summary.shard_counts["2026_07"] ?? 0}`);
  if (summary.removed_row_ids_remaining.length > 0) errors.push(`removed row_ids remain: ${summary.removed_row_ids_remaining.length}`);
  if (summary.duplicate_row_id_count !== 0) errors.push(`duplicate row_id count is not 0: ${summary.duplicate_row_id_count}`);
  if (summary.schema_versions["zao_local_history_v1"] !== 145) errors.push("schema_version is not consistently zao_local_history_v1");
  if (summary.shard_month_mismatches.length > 0) errors.push(`shard_month mismatches: ${summary.shard_month_mismatches.length}`);
  if (summary.row_hash_missing_count !== 0) errors.push(`row_hash missing count: ${summary.row_hash_missing_count}`);
  return errors;
}

export function validateDbReconciliation(input: {
  deletedRows: number;
  remainingApprovedRowIds: number;
  marketSignalHistoryRows: number;
}): string[] {
  const errors: string[] = [];
  if (input.deletedRows !== 116) errors.push(`DB deleted rows is not 116: ${input.deletedRows}`);
  if (input.remainingApprovedRowIds !== 0) errors.push(`approved row_ids remain in DB: ${input.remainingApprovedRowIds}`);
  if (input.marketSignalHistoryRows !== 145) errors.push(`market_signal_history rows is not 145: ${input.marketSignalHistoryRows}`);
  return errors;
}

export function validateContextRebuild(input: {
  marketSignalHistoryRows: number | null;
  soldOutCount: number | null;
  basisConfidenceInsufficient: number | null;
  latestFilesRegular: boolean;
}): string[] {
  const errors: string[] = [];
  if (input.marketSignalHistoryRows !== 145) errors.push(`context market rows is not 145: ${input.marketSignalHistoryRows ?? "null"}`);
  if (input.soldOutCount !== 66) errors.push(`context sold_out count is not 66: ${input.soldOutCount ?? "null"}`);
  if (input.basisConfidenceInsufficient !== 3) errors.push(`context insufficient count is not 3: ${input.basisConfidenceInsufficient ?? "null"}`);
  if (!input.latestFilesRegular) errors.push("latest context files are not all regular files");
  return errors;
}

export function renderRakutenSoldOutRevertRealRunCsv(report: RakutenSoldOutRevertRealRunReport): string {
  const rows = [
    ["decision", report.decision],
    ["approval_gate_passed", String(report.explicit_approval_result.passed)],
    ["preflight_passed", String(report.revert_preflight_result.passed)],
    ["history_total_rows", String(report.final_row_counts.history_total_rows)],
    ["db_market_signal_history_rows", String(report.final_row_counts.db_market_signal_history_rows ?? "")],
    ["ai_context_sold_out_count", String(report.final_row_counts.ai_context_sold_out_count ?? "")],
    ["ai_context_basis_confidence_insufficient", String(report.final_row_counts.ai_context_basis_confidence_insufficient ?? "")]
  ];
  return `key,value\n${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

export function renderRakutenSoldOutRevertRealRunMarkdown(report: RakutenSoldOutRevertRealRunReport): string {
  return [
    "# Rakuten Sold-Out Revert Real Run",
    "",
    `Generated at: ${report.generated_at_jst}`,
    `Decision: ${report.decision}`,
    "",
    "## 1. Summary",
    "",
    `- approval_gate_passed=${report.explicit_approval_result.passed}`,
    `- preflight_passed=${report.revert_preflight_result.passed}`,
    `- backup_path=${report.backup_path}`,
    "",
    "## 2. History Revert Actions",
    "",
    ...report.history_revert_actions.map((a) => `- ${a.path}: ${a.beforeRows} -> ${a.afterRows}; removed=${a.removedRows}`),
    "",
    "## 3. Rollback Result",
    "",
    `- attempted=${report.rollback_result.attempted}`,
    `- success=${report.rollback_result.success}`,
    `- message=${report.rollback_result.message}`,
    "",
    "## 4. DB Resync / Reconciliation",
    "",
    `- attempted=${report.db_resync_reconciliation_result.attempted}`,
    `- deleted_rows=${report.db_resync_reconciliation_result.deleted_rows}`,
    `- remaining_approved_row_ids=${report.db_resync_reconciliation_result.remaining_approved_row_ids}`,
    `- market_signal_history_rows=${report.db_resync_reconciliation_result.market_signal_history_rows}`,
    ...report.db_resync_reconciliation_result.errors.map((e) => `- error=${e}`),
    "",
    "## 5. AI Context Rebuild",
    "",
    `- attempted=${report.ai_context_rebuild_result.attempted}`,
    `- command=${report.ai_context_rebuild_result.command}`,
    `- exit_code=${report.ai_context_rebuild_result.exit_code}`,
    `- market_signal_history_rows=${report.ai_context_rebuild_result.market_signal_history_rows}`,
    `- sold_out_count=${report.ai_context_rebuild_result.sold_out_count}`,
    `- basis_confidence_insufficient=${report.ai_context_rebuild_result.basis_confidence_insufficient}`,
    ...report.ai_context_rebuild_result.errors.map((e) => `- error=${e}`),
    "",
    "## 6. Task Query Smoke",
    "",
    `- attempted=${report.task_query_smoke_result.attempted}`,
    `- passed=${report.task_query_smoke_result.passed}`,
    ...report.task_query_smoke_result.commands.map((cmd) => `- command=${cmd}`),
    ...report.task_query_smoke_result.errors.map((e) => `- error=${e}`),
    "",
    "## 7. Final Row Counts",
    "",
    `- history_total_rows=${report.final_row_counts.history_total_rows}`,
    `- db_market_signal_history_rows=${report.final_row_counts.db_market_signal_history_rows}`,
    `- ai_context_sold_out_count=${report.final_row_counts.ai_context_sold_out_count}`,
    `- ai_context_basis_confidence_insufficient=${report.final_row_counts.ai_context_basis_confidence_insufficient}`,
    "",
    "## 8. Safety Confirmation",
    "",
    ...Object.entries(report.safety_confirmation).map(([key, value]) => `- ${key}=${value}`),
    ""
  ].join("\n");
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item) || "(blank)";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}
