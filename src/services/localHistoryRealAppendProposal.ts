// Phase M05X — First real local history append PROPOSAL with explicit opt-in gate.
//
// Proposal-only layer. Computes exactly what a future real append would do
// (target files, per-shard row counts, dedupe/conflict counts), documents the
// rollback plan + preflight checklist, and evaluates the approval gate that
// keeps real writes BLOCKED by default.
//
// NO real .data/history writes. NO DB writes. NO GitHub Actions. NO GitOps.
// The approval gate is intentionally closed in M05X (explicitUserApproved=false).

import { type AppendActionRecord } from "./localHistoryAppendDryRun";
import { futureShardPath } from "./localHistorySchemaDesign";

export const TARGET_HISTORY_DIR = ".data/history";
export const HISTORY_BACKUP_DIR = ".data/history/.backup";
export const REQUIRED_OPT_IN_FLAGS: readonly string[] = ["REAL_HISTORY_APPEND=1"];
export const PROPOSED_REAL_RUN_COMMAND =
  "REAL_HISTORY_APPEND=1 npm run real-run:local-history-append  # (script intentionally not created in M05X)";

// ---------------------------------------------------------------------------
// Per-shard aggregation from M03X scenario-A append actions
// ---------------------------------------------------------------------------

export interface ShardAppendStats {
  shardMonth: string;
  futureHistoryPath: string;
  appendRows: number;
  skipDuplicates: number;
  conflictRows: number;
}

export function aggregateAppendActionsByShard(actions: AppendActionRecord[]): ShardAppendStats[] {
  const byShard = new Map<string, ShardAppendStats>();
  for (const action of actions) {
    const stats =
      byShard.get(action.shardMonth) ??
      {
        shardMonth: action.shardMonth,
        futureHistoryPath: futureShardPath(action.shardMonth),
        appendRows: 0,
        skipDuplicates: 0,
        conflictRows: 0
      };
    if (action.appendAction === "append") stats.appendRows += 1;
    else if (action.appendAction === "skip_duplicate_identical") stats.skipDuplicates += 1;
    else stats.conflictRows += 1;
    byShard.set(action.shardMonth, stats);
  }
  return [...byShard.values()].sort((a, b) => a.shardMonth.localeCompare(b.shardMonth));
}

// ---------------------------------------------------------------------------
// Target file plan
// ---------------------------------------------------------------------------

export interface TargetFilePlanEntry {
  targetFile: string;
  shardMonth: string;
  wouldCreateFile: boolean;
  wouldModifyFile: boolean;
  wouldAppendRows: number;
  wouldSkipDuplicates: number;
  wouldConflictRows: number;
  futureBackupPath: string;
  dryRunShardSource: string;
}

export interface BuildTargetFilePlanInput {
  shardStats: ShardAppendStats[];
  existingHistoryFiles: string[]; // base file names present under .data/history
  backupTimestamp: string;
  dryRunShardSourceByMonth: Record<string, string>;
}

export function buildTargetFilePlan(input: BuildTargetFilePlanInput): TargetFilePlanEntry[] {
  const existing = new Set(input.existingHistoryFiles);
  return input.shardStats.map((stats) => {
    const fileName = `zao_signals_${stats.shardMonth}.csv`;
    const fileExists = existing.has(fileName);
    return {
      targetFile: futureShardPath(stats.shardMonth),
      shardMonth: stats.shardMonth,
      wouldCreateFile: !fileExists,
      wouldModifyFile: fileExists,
      wouldAppendRows: stats.appendRows,
      wouldSkipDuplicates: stats.skipDuplicates,
      wouldConflictRows: stats.conflictRows,
      futureBackupPath: `${HISTORY_BACKUP_DIR}/${input.backupTimestamp}/${fileName}.bak`,
      dryRunShardSource: input.dryRunShardSourceByMonth[stats.shardMonth] ?? ""
    };
  });
}

// ---------------------------------------------------------------------------
// 7. Opt-in approval gate (closed by default)
// ---------------------------------------------------------------------------

export interface RealAppendApprovalInput {
  explicitUserApproved: boolean;
  envRealHistoryAppend: string | undefined;
  dryRunDecision: string;
  policyDecision: string;
  hashConflictCount: number;
  schemaValid: boolean;
  shardIntegrityPassed: boolean;
  forbiddenColumnErrors: number;
  dbWriteMode: boolean;
  githubActionsMode: boolean;
}

export interface RealAppendApprovalResult {
  realAppendCurrentlyAllowed: boolean;
  failedConditions: string[];
}

export function evaluateRealAppendApproval(input: RealAppendApprovalInput): RealAppendApprovalResult {
  const failed: string[] = [];
  if (!input.explicitUserApproved) failed.push("explicitUserApproved!=true");
  if (input.envRealHistoryAppend !== "1") failed.push("REAL_HISTORY_APPEND!=1");
  if (input.dryRunDecision !== "local_history_append_dry_run_ready") failed.push("dryRunDecision!=ready");
  if (input.policyDecision !== "local_history_append_validation_policy_ready") failed.push("policyDecision!=ready");
  if (input.hashConflictCount !== 0) failed.push("hashConflictCount!=0");
  if (!input.schemaValid) failed.push("schemaValid!=true");
  if (!input.shardIntegrityPassed) failed.push("shardIntegrityPassed!=true");
  if (input.forbiddenColumnErrors !== 0) failed.push("forbiddenColumnErrors!=0");
  if (input.dbWriteMode) failed.push("dbWriteMode!=false");
  if (input.githubActionsMode) failed.push("githubActionsMode!=false");
  return { realAppendCurrentlyAllowed: failed.length === 0, failedConditions: failed };
}

// ---------------------------------------------------------------------------
// 8. Rollback plan (documented only; no backups created in M05X)
// ---------------------------------------------------------------------------

export interface RollbackPlan {
  backupPathTemplate: string;
  firstTimeCreate: string;
  appendToExisting: string;
  conflictMidRun: string;
  noPartialWrites: string;
  backupsCreated: boolean;
}

export function buildRollbackPlan(backupTimestamp: string): RollbackPlan {
  return {
    backupPathTemplate: `${HISTORY_BACKUP_DIR}/${backupTimestamp}/zao_signals_YYYY_MM.csv.bak`,
    firstTimeCreate:
      "If first real append creates .data/history for the first time: rollback = remove the .data/history directory, or remove only the newly created shard files.",
    appendToExisting:
      "If appending to existing shard files: rollback = restore each touched file from the .bak created immediately before append.",
    conflictMidRun:
      "If a conflict occurs mid-run: abort before writing, or restore all touched files from backup.",
    noPartialWrites:
      "No partial writes allowed: write to a temp file first, validate, then atomic rename into place.",
    backupsCreated: false
  };
}

// ---------------------------------------------------------------------------
// 9. Preflight checklist
// ---------------------------------------------------------------------------

export interface PreflightCheck {
  id: number;
  check: string;
}

export function buildPreflightChecklist(): PreflightCheck[] {
  return [
    { id: 1, check: "Re-run M03X dry-run and confirm decision=local_history_append_dry_run_ready." },
    { id: 2, check: "Re-run M04X validation policy and confirm decision=local_history_append_validation_policy_ready." },
    { id: 3, check: "Confirm .data/history current state (exists? which files present?)." },
    { id: 4, check: "Confirm target files and row counts match the proposal." },
    { id: 5, check: "Confirm zero hash conflicts." },
    { id: 6, check: "Confirm schema version exactly zao_local_history_v1." },
    { id: 7, check: "Confirm no forbidden columns." },
    { id: 8, check: "Confirm explicit user approval." },
    { id: 9, check: "Confirm REAL_HISTORY_APPEND=1." },
    { id: 10, check: "Confirm backup plan prepared (backup dir + .bak files)." }
  ];
}

// ---------------------------------------------------------------------------
// 11. Decision
// ---------------------------------------------------------------------------

export type M05XDecision =
  | "local_history_real_append_proposal_ready"
  | "local_history_real_append_proposal_basis_caution"
  | "local_history_real_append_proposal_not_ready";

export function decideM05X(input: {
  dryRunDecision: string;
  policyDecision: string;
  hashConflictCount: number;
  schemaValid: boolean;
  targetFilePlanGenerated: boolean;
  rollbackPlanGenerated: boolean;
  realAppendCurrentlyAllowed: boolean;
  historyDirModified: boolean;
  historyDirPreExisted: boolean;
}): M05XDecision {
  if (
    input.hashConflictCount > 0 ||
    input.dryRunDecision !== "local_history_append_dry_run_ready" ||
    input.policyDecision !== "local_history_append_validation_policy_ready" ||
    !input.schemaValid ||
    !input.targetFilePlanGenerated ||
    !input.rollbackPlanGenerated ||
    input.realAppendCurrentlyAllowed ||
    input.historyDirModified
  ) {
    return "local_history_real_append_proposal_not_ready";
  }
  if (input.historyDirPreExisted) {
    return "local_history_real_append_proposal_basis_caution";
  }
  return "local_history_real_append_proposal_ready";
}

// ---------------------------------------------------------------------------
// 10. Rendering
// ---------------------------------------------------------------------------

export const TARGET_FILE_PLAN_CSV_HEADERS = [
  "proposal_id",
  "target_file",
  "shard_month",
  "would_create_file",
  "would_modify_file",
  "would_append_rows",
  "would_skip_duplicates",
  "would_conflict_rows",
  "future_backup_path",
  "dry_run_shard_source"
] as const;

export function renderTargetFilePlanCsv(proposalId: string, plan: TargetFilePlanEntry[]): string {
  const body = plan.map((e) =>
    [
      proposalId,
      e.targetFile,
      e.shardMonth,
      String(e.wouldCreateFile),
      String(e.wouldModifyFile),
      String(e.wouldAppendRows),
      String(e.wouldSkipDuplicates),
      String(e.wouldConflictRows),
      e.futureBackupPath,
      e.dryRunShardSource
    ]
      .map(csvEscape)
      .join(",")
  );
  return [TARGET_FILE_PLAN_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export interface ProposalSummary {
  proposalId: string;
  generatedAtJst: string;
  sourceDryRunArtifact: string;
  sourcePolicyArtifact: string;
  schemaVersion: string;
  realAppendDefaultEnabled: boolean;
  realAppendCurrentlyAllowed: boolean;
  requiredOptInFlags: string[];
  targetHistoryDir: string;
  targetFiles: string[];
  wouldCreateHistoryDir: boolean;
  wouldCreateFiles: string[];
  wouldModifyFiles: string[];
  wouldAppendRows: number;
  wouldSkipDuplicates: number;
  wouldBlockConflicts: number;
  decision: M05XDecision;
}

export function renderProposalReport(input: {
  summary: ProposalSummary;
  approval: RealAppendApprovalResult;
  targetFilePlan: TargetFilePlanEntry[];
  rollbackPlan: RollbackPlan;
  preflightChecklist: PreflightCheck[];
  proposedRealRunCommand: string;
  historyDirExistedBefore: boolean;
  historyDirExistingFiles: string[];
  historyDirModified: boolean;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}): string {
  const s = input.summary;
  return [
    "# First Real Local History Append PROPOSAL (Phase M05X)",
    "",
    `Generated at (JST): ${s.generatedAtJst}`,
    `Proposal ID: ${s.proposalId}`,
    "",
    "## 1. Policy & safety",
    "",
    "- PROPOSAL ONLY: M05X performs NO real .data/history write.",
    "- Real append is DISABLED by default; the approval gate is closed in M05X.",
    "- Real append would require BOTH explicit user approval in code/config AND REAL_HISTORY_APPEND=1.",
    "- No DB writes, no collector re-runs, no GitHub Actions, no GitOps, no cron.",
    "- No Beds24/AirHost/PMS/OTA columns; no deprecated tax fields; no base × 1.1.",
    "",
    "## 2. Decision",
    "",
    `- decision=${s.decision}`,
    `- real_append_default_enabled=${s.realAppendDefaultEnabled}`,
    `- real_append_currently_allowed=${s.realAppendCurrentlyAllowed}`,
    "",
    "## 3. Source artifacts used",
    "",
    `- dry_run (M03X)=${s.sourceDryRunArtifact}`,
    `- policy (M04X)=${s.sourcePolicyArtifact}`,
    "",
    "## 4. Target file plan (future paths — NOT written this phase)",
    "",
    `- target_history_dir=${s.targetHistoryDir}`,
    `- would_create_history_dir=${s.wouldCreateHistoryDir}`,
    `- schema_version=${s.schemaVersion}`,
    "",
    "| target_file (NOT written) | shard_month | create | modify | append_rows | skip_dupes | conflicts | future_backup_path |",
    "|---|---|---|---|---|---|---|---|",
    ...input.targetFilePlan.map(
      (e) =>
        `| ${e.targetFile} | ${e.shardMonth} | ${e.wouldCreateFile} | ${e.wouldModifyFile} | ${e.wouldAppendRows} | ${e.wouldSkipDuplicates} | ${e.wouldConflictRows} | ${e.futureBackupPath} |`
    ),
    "",
    "## 5. Row count plan",
    "",
    `- would_append_rows=${s.wouldAppendRows}`,
    `- would_skip_duplicates=${s.wouldSkipDuplicates}`,
    `- would_block_conflicts=${s.wouldBlockConflicts}`,
    `- target_file_count=${s.targetFiles.length}`,
    "",
    "## 6. Approval gate result (closed by default)",
    "",
    `- real_append_currently_allowed=${input.approval.realAppendCurrentlyAllowed} (expected false in M05X)`,
    `- failed_conditions=${JSON.stringify(input.approval.failedConditions)}`,
    `- required_opt_in_flags=${JSON.stringify(s.requiredOptInFlags)}`,
    "",
    "## 7. Proposed future real-run command (NOT executed)",
    "",
    "```bash",
    input.proposedRealRunCommand,
    "```",
    "",
    "Note: even with REAL_HISTORY_APPEND=1, real append stays blocked unless explicitUserApproved is set true in code/config in a later, separately approved phase.",
    "",
    "## 8. Rollback plan (documented only; no backups created)",
    "",
    `- backup_path_template=${input.rollbackPlan.backupPathTemplate}`,
    `- backups_created=${input.rollbackPlan.backupsCreated}`,
    `- first_time_create: ${input.rollbackPlan.firstTimeCreate}`,
    `- append_to_existing: ${input.rollbackPlan.appendToExisting}`,
    `- conflict_mid_run: ${input.rollbackPlan.conflictMidRun}`,
    `- no_partial_writes: ${input.rollbackPlan.noPartialWrites}`,
    "",
    "## 9. Preflight checklist for future real append",
    "",
    ...input.preflightChecklist.map((c) => `${c.id}. ${c.check}`),
    "",
    "## 10. .data/history safety check",
    "",
    `- history_dir_existed_before=${input.historyDirExistedBefore}`,
    `- history_dir_existing_files=${JSON.stringify(input.historyDirExistingFiles)}`,
    `- history_dir_modified=${input.historyDirModified}`,
    ...(input.historyDirExistedBefore
      ? ["- NOTE: .data/history existed before this run; it was NOT deleted or modified. Future real append must back up existing files first."]
      : ["- .data/history does not exist; proposal mode did not create it."]),
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
    recommendedNextAction(s.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: M05XDecision): string {
  if (decision === "local_history_real_append_proposal_ready") {
    return "- Proposal is ready and real append remains BLOCKED by default. Proceed to Phase M06X (first guarded real local history append) ONLY after an explicit, separate user approval such as: \"Approve Phase M06X real history append. You may create .data/history monthly shard files.\" Without that approval, do not write .data/history.";
  }
  if (decision === "local_history_real_append_proposal_basis_caution") {
    return "- Proposal generated, but .data/history already exists (or a non-critical caution exists). Review existing files and the backup plan before any real append. Do not write .data/history.";
  }
  return "- Proposal preconditions failed (conflicts, M03X/M04X not ready, or the approval gate incorrectly allowed real append). Fix proposal/approval/rollback logic before proceeding. Do not write .data/history.";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
