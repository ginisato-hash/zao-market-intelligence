// Phase M06X — First guarded real local history append (write engine).
//
// This is the FIRST phase allowed to create .data/history and its monthly shard
// CSV files — but ONLY after the hard approval gate + preflight pass. The write
// engine is parameterized by `historyDir` so tests can exercise it against a
// temp directory; the script wires it to the real .data/history.
//
// Safety model:
//   - Hard approval gate (explicit user approval + REAL_HISTORY_APPEND=1 + all
//     prior-phase decisions ready + zero conflicts + valid schema).
//   - Append lock (.append.lock) acquired before any write; stale after 30 min.
//   - Temp-file write + post-validate + atomic rename (no partial writes).
//   - Backup of any pre-existing shard before it is modified.
//   - Rollback on failure: delete newly created files, restore backups.
//
// STILL FORBIDDEN: DB writes, collector re-runs, GitHub Actions, GitOps,
// Beds24/AirHost/PMS/OTA columns, deprecated tax fields, base × 1.1. Writes are
// limited to .data/history/zao_signals_YYYY_MM.csv (+ .backup/.tmp/.append.lock).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import {
  HISTORY_SCHEMA_VERSION,
  renderHistoryCsv,
  type HistoryRow
} from "./localHistorySchemaDesign";
import { isRealHistoryPath, simulateAppend } from "./localHistoryAppendDryRun";
import {
  historyRowFromCsvRecord,
  parseCsv,
  validateSchemaMigrationGuard,
  validateShardIntegrity,
  type ShardIntegrityResult
} from "./localHistoryAppendValidationPolicy";

export { isRealHistoryPath };

// The deduped per-shard row counts the first real append must produce (= number
// of rows in each M03X dry-run shard file). Total = 145.
export const EXPECTED_SHARD_ROW_COUNTS: Readonly<Record<string, number>> = {
  "2026_05": 2,
  "2026_06": 60,
  "2026_07": 65,
  "2026_08": 13,
  "2026_10": 4,
  "2026_12": 1
};
export const EXPECTED_TOTAL_ROWS = 145;

export const STALE_LOCK_THRESHOLD_MINUTES = 30;
export const APPEND_LOCK_FILENAME = ".append.lock";
export const BACKUP_DIRNAME = ".backup";
export const TMP_DIRNAME = ".tmp";

export type M06XDecision =
  | "local_history_real_append_ready_not_run"
  | "local_history_real_append_success"
  | "local_history_real_append_failed_preflight"
  | "local_history_real_append_failed_write"
  | "local_history_real_append_failed_rolled_back"
  | "local_history_real_append_failed_manual_recovery_required";

// ---------------------------------------------------------------------------
// 7. Hard approval gate
// ---------------------------------------------------------------------------

export interface RealAppendGateInput {
  explicitUserApproved: boolean;
  envRealHistoryAppend: string | undefined;
  m03xDecision: string;
  m04xDecision: string;
  m05xDecision: string;
  hashConflictCount: number;
  schemaValid: boolean;
  shardIntegrityPassed: boolean;
  forbiddenColumnErrors: number;
  dbWriteMode: boolean;
  githubActionsMode: boolean;
}

export interface RealAppendGateResult {
  realAppendAllowed: boolean;
  failedConditions: string[];
}

export function evaluateRealAppendGate(input: RealAppendGateInput): RealAppendGateResult {
  const failed: string[] = [];
  if (!input.explicitUserApproved) failed.push("explicitUserApproved!=true");
  if (input.envRealHistoryAppend !== "1") failed.push("REAL_HISTORY_APPEND!=1");
  if (input.m03xDecision !== "local_history_append_dry_run_ready") failed.push("m03xDecision!=ready");
  if (input.m04xDecision !== "local_history_append_validation_policy_ready") failed.push("m04xDecision!=ready");
  if (input.m05xDecision !== "local_history_real_append_proposal_ready") failed.push("m05xDecision!=ready");
  if (input.hashConflictCount !== 0) failed.push("hashConflictCount!=0");
  if (!input.schemaValid) failed.push("schemaValid!=true");
  if (!input.shardIntegrityPassed) failed.push("shardIntegrityPassed!=true");
  if (input.forbiddenColumnErrors !== 0) failed.push("forbiddenColumnErrors!=0");
  if (input.dbWriteMode) failed.push("dbWriteMode!=false");
  if (input.githubActionsMode) failed.push("githubActionsMode!=false");
  return { realAppendAllowed: failed.length === 0, failedConditions: failed };
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

export function parseShardRows(csv: string): HistoryRow[] {
  const records = parseCsv(csv).filter((r) => !(r.length === 1 && r[0] === ""));
  return records.slice(1).map(historyRowFromCsvRecord);
}

function shardFileName(shardMonth: string): string {
  return `zao_signals_${shardMonth}.csv`;
}

// ---------------------------------------------------------------------------
// 8. Preflight
// ---------------------------------------------------------------------------

export interface PreflightInput {
  gate: RealAppendGateResult;
  sourceShards: { shardMonth: string; csv: string }[];
  expectedCountsByShard: Readonly<Record<string, number>>;
  expectedTotalRows: number;
}

export interface PreflightResult {
  ok: boolean;
  gateAllowed: boolean;
  schemaValid: boolean;
  schemaVersion: string;
  totalIncomingRows: number;
  perShardIncoming: Record<string, number>;
  countMismatches: string[];
  duplicateRowIdCount: number;
  forbiddenColumnErrors: number;
  shardIntegrity: ShardIntegrityResult[];
  failedChecks: string[];
}

export function runPreflight(input: PreflightInput): PreflightResult {
  const failedChecks: string[] = [];
  const gateAllowed = input.gate.realAppendAllowed;
  if (!gateAllowed) failedChecks.push(`gate_not_allowed:${JSON.stringify(input.gate.failedConditions)}`);

  const perShardIncoming: Record<string, number> = {};
  const countMismatches: string[] = [];
  const shardIntegrity: ShardIntegrityResult[] = [];
  let duplicateRowIdCount = 0;
  let totalIncomingRows = 0;
  let schemaValid = true;
  let forbiddenColumnErrors = 0;

  for (const shard of input.sourceShards) {
    const fileName = shardFileName(shard.shardMonth);
    const integ = validateShardIntegrity({ fileName, csv: shard.csv });
    shardIntegrity.push(integ);
    perShardIncoming[shard.shardMonth] = integ.rowCount;
    totalIncomingRows += integ.rowCount;
    duplicateRowIdCount += integ.duplicateRowIds.length;
    if (!integ.headerPresent || !integ.columnCountValid) schemaValid = false;
    if (!integ.ok) failedChecks.push(`shard_integrity_failed:${fileName}:${JSON.stringify(integ.errors)}`);

    const header = parseCsv(shard.csv).filter((r) => !(r.length === 1 && r[0] === ""))[0] ?? [];
    const guard = validateSchemaMigrationGuard(header, HISTORY_SCHEMA_VERSION);
    if (!guard.schemaValid) schemaValid = false;
    forbiddenColumnErrors += guard.forbiddenColumns.length + guard.deprecatedColumns.length;

    const expected = input.expectedCountsByShard[shard.shardMonth];
    if (expected !== undefined && expected !== integ.rowCount) {
      countMismatches.push(`${shard.shardMonth}:expected=${expected},actual=${integ.rowCount}`);
    }
  }

  if (!schemaValid) failedChecks.push("schema_invalid");
  if (countMismatches.length > 0) failedChecks.push(`count_mismatch:${JSON.stringify(countMismatches)}`);
  if (duplicateRowIdCount > 0) failedChecks.push(`duplicate_row_id_count:${duplicateRowIdCount}`);
  if (forbiddenColumnErrors > 0) failedChecks.push(`forbidden_column_errors:${forbiddenColumnErrors}`);
  if (totalIncomingRows !== input.expectedTotalRows) {
    failedChecks.push(`total_row_mismatch:expected=${input.expectedTotalRows},actual=${totalIncomingRows}`);
  }

  return {
    ok: failedChecks.length === 0,
    gateAllowed,
    schemaValid,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    totalIncomingRows,
    perShardIncoming,
    countMismatches,
    duplicateRowIdCount,
    forbiddenColumnErrors,
    shardIntegrity,
    failedChecks
  };
}

// ---------------------------------------------------------------------------
// Append lock helpers
// ---------------------------------------------------------------------------

export function isLockStale(lockAgeMs: number, thresholdMinutes: number = STALE_LOCK_THRESHOLD_MINUTES): boolean {
  return lockAgeMs > thresholdMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// 9. Write engine (temp + atomic rename, backup, rollback)
// ---------------------------------------------------------------------------

export type ShardWriteStatus = "success" | "blocked" | "rolled_back" | "not_attempted";

export interface ShardWriteAction {
  targetFile: string;
  shardMonth: string;
  action: "create" | "update" | "conflict";
  rowsWritten: number;
  rowsSkippedDuplicate: number;
  rowsConflict: number;
  backupPath: string;
  tempPath: string;
  finalRowCount: number;
  status: ShardWriteStatus;
}

export interface RunRealAppendInput {
  historyDir: string;
  runId: string;
  backupTimestamp: string;
  sourceShards: { shardMonth: string; csv: string }[];
  nowMs?: number;
  // Test seam: force a failure right before renaming this shard to prove
  // rollback restores backups / deletes newly created files.
  failWriteForShard?: string;
}

export interface RunRealAppendResult {
  runId: string;
  historyDir: string;
  lockFilePath: string;
  lockAcquired: boolean;
  lockRemoved: boolean;
  backupDir: string;
  backupsCreated: number;
  filesCreated: number;
  filesUpdated: number;
  rowsWritten: number;
  rowsSkippedDuplicate: number;
  rowsConflict: number;
  shardActions: ShardWriteAction[];
  rollbackPerformed: boolean;
  rollbackActions: string[];
  decision: M06XDecision;
  message: string;
}

export function runRealAppend(input: RunRealAppendInput): RunRealAppendResult {
  const nowMs = input.nowMs ?? Date.now();
  const historyDir = input.historyDir;

  // Refuse to operate anywhere that is not a real-history-shaped directory in
  // production; the script always passes .data/history. (Temp dirs in tests are
  // intentionally NOT real-history paths, so this guard is script-side only —
  // see runLocalHistoryRealAppend.ts which asserts the target before calling.)
  const lockFilePath = join(historyDir, APPEND_LOCK_FILENAME);
  const tmpDir = join(historyDir, TMP_DIRNAME);
  const backupDir = join(historyDir, BACKUP_DIRNAME, input.backupTimestamp);

  const base: Omit<RunRealAppendResult, "decision" | "message"> = {
    runId: input.runId,
    historyDir,
    lockFilePath,
    lockAcquired: false,
    lockRemoved: false,
    backupDir,
    backupsCreated: 0,
    filesCreated: 0,
    filesUpdated: 0,
    rowsWritten: 0,
    rowsSkippedDuplicate: 0,
    rowsConflict: 0,
    shardActions: [],
    rollbackPerformed: false,
    rollbackActions: []
  };

  // 1. Ensure the history dir exists (this is the approved creation point).
  mkdirSync(historyDir, { recursive: true });

  // 2. Acquire append lock; abort on a fresh existing lock.
  if (existsSync(lockFilePath)) {
    const ageMs = nowMs - statSync(lockFilePath).mtimeMs;
    if (!isLockStale(ageMs)) {
      return {
        ...base,
        decision: "local_history_real_append_failed_preflight",
        message: `Fresh append lock present at ${lockFilePath} (age ${Math.round(ageMs / 1000)}s < ${STALE_LOCK_THRESHOLD_MINUTES}min). Aborting; another append may be in progress.`
      };
    }
    rmSync(lockFilePath, { force: true });
    base.rollbackActions.push(`removed_stale_lock:${lockFilePath}`);
  }
  writeFileSync(lockFilePath, `${input.runId}\n${new Date(nowMs).toISOString()}\n`, "utf8");
  base.lockAcquired = true;

  // 3. Build the merge plan (existing target rows + incoming source rows).
  const sortedShards = [...input.sourceShards].sort((a, b) => a.shardMonth.localeCompare(b.shardMonth));
  const existingRows: HistoryRow[] = [];
  const targetExisted = new Map<string, boolean>();
  for (const shard of sortedShards) {
    const targetPath = join(historyDir, shardFileName(shard.shardMonth));
    const existed = existsSync(targetPath);
    targetExisted.set(shard.shardMonth, existed);
    if (existed) existingRows.push(...parseShardRows(readFileSync(targetPath, "utf8")));
  }
  const newRows: HistoryRow[] = [];
  for (const shard of sortedShards) newRows.push(...parseShardRows(shard.csv));

  const sim = simulateAppend(existingRows, newRows, {
    scenario: "real_append",
    runId: input.runId,
    dryRunShardDir: historyDir
  });

  // 4. Hard block on any hash conflict — abort before writing anything.
  if (sim.conflictCount > 0) {
    rmSync(lockFilePath, { force: true });
    base.lockRemoved = true;
    base.rowsConflict = sim.conflictCount;
    base.shardActions = sortedShards.map((shard) => ({
      targetFile: join(historyDir, shardFileName(shard.shardMonth)),
      shardMonth: shard.shardMonth,
      action: "conflict",
      rowsWritten: 0,
      rowsSkippedDuplicate: 0,
      rowsConflict: sim.conflicts.filter((c) => c.shardMonth === shard.shardMonth).length,
      backupPath: "",
      tempPath: "",
      finalRowCount: 0,
      status: "blocked"
    }));
    return {
      ...base,
      decision: "local_history_real_append_failed_write",
      message: `Aborted before write: ${sim.conflictCount} hash conflict(s) detected (same row_id, different row_hash).`
    };
  }

  // 5. Group merged rows + per-shard append/skip counts.
  const mergedByShard = new Map<string, HistoryRow[]>();
  for (const row of sim.shardRows) {
    const bucket = mergedByShard.get(row.shardMonth) ?? [];
    bucket.push(row);
    mergedByShard.set(row.shardMonth, bucket);
  }
  const appendByShard = new Map<string, number>();
  const skipByShard = new Map<string, number>();
  for (const action of sim.actions) {
    if (action.appendAction === "append") appendByShard.set(action.shardMonth, (appendByShard.get(action.shardMonth) ?? 0) + 1);
    else if (action.appendAction === "skip_duplicate_identical") skipByShard.set(action.shardMonth, (skipByShard.get(action.shardMonth) ?? 0) + 1);
  }

  // 6. Write each shard: backup (if existing) → temp → validate → atomic rename.
  mkdirSync(tmpDir, { recursive: true });
  const createdFiles: string[] = [];
  const backups: { target: string; backup: string }[] = [];
  const shardActions: ShardWriteAction[] = [];

  try {
    for (const shard of sortedShards) {
      const shardMonth = shard.shardMonth;
      const fileName = shardFileName(shardMonth);
      const targetPath = join(historyDir, fileName);
      const existed = targetExisted.get(shardMonth) === true;
      let backupPath = "";

      if (existed) {
        mkdirSync(backupDir, { recursive: true });
        backupPath = join(backupDir, `${fileName}.bak`);
        copyFileSync(targetPath, backupPath);
        backups.push({ target: targetPath, backup: backupPath });
        base.backupsCreated += 1;
      }

      const rows = mergedByShard.get(shardMonth) ?? [];
      const csv = renderHistoryCsv(rows);

      // Validate the would-be file BEFORE it lands at the target path.
      const integ = validateShardIntegrity({ fileName, csv });
      if (!integ.ok) {
        throw new Error(`temp validation failed for ${fileName}: ${JSON.stringify(integ.errors)}`);
      }

      const tempPath = join(tmpDir, `${fileName}.tmp`);
      writeFileSync(tempPath, csv, "utf8");

      if (input.failWriteForShard === shardMonth) {
        throw new Error(`injected write failure for shard ${shardMonth}`);
      }

      renameSync(tempPath, targetPath);
      if (existed) base.filesUpdated += 1;
      else {
        createdFiles.push(targetPath);
        base.filesCreated += 1;
      }

      const rowsWritten = appendByShard.get(shardMonth) ?? 0;
      const rowsSkipped = skipByShard.get(shardMonth) ?? 0;
      base.rowsWritten += rowsWritten;
      base.rowsSkippedDuplicate += rowsSkipped;
      shardActions.push({
        targetFile: targetPath,
        shardMonth,
        action: existed ? "update" : "create",
        rowsWritten,
        rowsSkippedDuplicate: rowsSkipped,
        rowsConflict: 0,
        backupPath,
        tempPath,
        finalRowCount: rows.length,
        status: "success"
      });
    }
  } catch (err) {
    // 11. Rollback: delete newly created files, restore backups, clean temp/lock.
    const rollbackActions: string[] = [...base.rollbackActions];
    let rollbackOk = true;
    try {
      for (const created of createdFiles) {
        if (existsSync(created)) {
          rmSync(created, { force: true });
          rollbackActions.push(`deleted_created_file:${created}`);
        }
      }
      for (const { target, backup } of backups) {
        if (existsSync(backup)) {
          copyFileSync(backup, target);
          rollbackActions.push(`restored_from_backup:${target}`);
        }
      }
      rmSync(tmpDir, { recursive: true, force: true });
      rollbackActions.push(`removed_temp_dir:${tmpDir}`);
      rmSync(lockFilePath, { force: true });
      base.lockRemoved = true;
      rollbackActions.push(`removed_lock:${lockFilePath}`);
    } catch (rollbackErr) {
      rollbackOk = false;
      rollbackActions.push(`rollback_error:${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
    }
    return {
      ...base,
      shardActions,
      rollbackPerformed: true,
      rollbackActions,
      decision: rollbackOk
        ? "local_history_real_append_failed_rolled_back"
        : "local_history_real_append_failed_manual_recovery_required",
      message: `Write failed: ${err instanceof Error ? err.message : String(err)}. Rollback ${rollbackOk ? "completed" : "FAILED — manual recovery required"}.`
    };
  }

  // 7. Success: remove temp dir + lock.
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(lockFilePath, { force: true });
  base.lockRemoved = true;

  return {
    ...base,
    shardActions,
    decision: "local_history_real_append_success",
    message: `Wrote ${base.rowsWritten} rows across ${shardActions.length} shard(s); created=${base.filesCreated}, updated=${base.filesUpdated}, backups=${base.backupsCreated}.`
  };
}

// ---------------------------------------------------------------------------
// 10. Post-write validation
// ---------------------------------------------------------------------------

export interface PostWriteShardResult extends ShardIntegrityResult {
  expectedRowCount: number;
  rowCountMatches: boolean;
}

export interface PostWriteValidationResult {
  ok: boolean;
  results: PostWriteShardResult[];
  lockRemoved: boolean;
  tmpRemoved: boolean;
}

export function validatePostWriteShards(
  shards: { fileName: string; csv: string; expectedRowCount: number }[]
): { ok: boolean; results: PostWriteShardResult[] } {
  const results = shards.map((s) => {
    const integ = validateShardIntegrity({ fileName: s.fileName, csv: s.csv });
    return {
      ...integ,
      expectedRowCount: s.expectedRowCount,
      rowCountMatches: integ.rowCount === s.expectedRowCount
    };
  });
  return { ok: results.every((r) => r.ok && r.rowCountMatches), results };
}

// ---------------------------------------------------------------------------
// 12. Write-action CSV
// ---------------------------------------------------------------------------

export const WRITE_ACTION_CSV_HEADERS = [
  "run_id",
  "target_file",
  "shard_month",
  "action",
  "rows_written",
  "rows_skipped_duplicate",
  "rows_conflict",
  "backup_path",
  "temp_path",
  "final_row_count",
  "status"
] as const;

export function renderWriteActionCsv(runId: string, actions: ShardWriteAction[]): string {
  const body = actions.map((a) =>
    [
      runId,
      a.targetFile,
      a.shardMonth,
      a.action,
      String(a.rowsWritten),
      String(a.rowsSkippedDuplicate),
      String(a.rowsConflict),
      a.backupPath,
      a.tempPath,
      String(a.finalRowCount),
      a.status
    ]
      .map(csvEscape)
      .join(",")
  );
  return [WRITE_ACTION_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export interface RealAppendReportInput {
  generatedAtJst: string;
  runId: string;
  decision: M06XDecision;
  gate: RealAppendGateResult;
  preflight: PreflightResult;
  writeResult: RunRealAppendResult;
  postWrite: { ok: boolean; results: PostWriteShardResult[] };
  sourceArtifacts: { m03xJson: string; m04xJson: string; m05xJson: string; dryRunShardDir: string };
  historyDirExistedBefore: boolean;
  historyDirFilesAfter: string[];
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

export function renderRealAppendReport(input: RealAppendReportInput): string {
  const w = input.writeResult;
  return [
    "# First Guarded Real Local History Append (Phase M06X)",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Policy & safety",
    "",
    "- M06X performs a REAL append only after explicit user approval + REAL_HISTORY_APPEND=1 + all prior-phase gates pass.",
    "- Writes limited to .data/history/zao_signals_YYYY_MM.csv (+ .backup/.tmp/.append.lock).",
    "- No DB writes, no collector re-runs, no GitHub Actions, no GitOps, no cron.",
    "- No Beds24/AirHost/PMS/OTA columns; no deprecated tax fields; no base × 1.1.",
    "- Temp-file write + post-validate + atomic rename (no partial writes); rollback on failure.",
    "",
    "## 2. Decision",
    "",
    `- decision=${input.decision}`,
    `- message=${w.message}`,
    "",
    "## 3. Approval gate",
    "",
    `- real_append_allowed=${input.gate.realAppendAllowed}`,
    `- failed_conditions=${JSON.stringify(input.gate.failedConditions)}`,
    "",
    "## 4. Source artifacts used",
    "",
    `- M03X dry-run json=${input.sourceArtifacts.m03xJson}`,
    `- M04X policy json=${input.sourceArtifacts.m04xJson}`,
    `- M05X proposal json=${input.sourceArtifacts.m05xJson}`,
    `- dry-run shard source dir=${input.sourceArtifacts.dryRunShardDir}`,
    "",
    "## 5. Preflight result",
    "",
    `- preflight_ok=${input.preflight.ok}`,
    `- schema_valid=${input.preflight.schemaValid}`,
    `- total_incoming_rows=${input.preflight.totalIncomingRows}`,
    `- per_shard_incoming=${JSON.stringify(input.preflight.perShardIncoming)}`,
    `- count_mismatches=${JSON.stringify(input.preflight.countMismatches)}`,
    `- duplicate_row_id_count=${input.preflight.duplicateRowIdCount}`,
    `- forbidden_column_errors=${input.preflight.forbiddenColumnErrors}`,
    `- failed_checks=${JSON.stringify(input.preflight.failedChecks)}`,
    "",
    "## 6. Files written",
    "",
    `- history_dir_existed_before=${input.historyDirExistedBefore}`,
    `- files_created=${w.filesCreated}`,
    `- files_updated=${w.filesUpdated}`,
    `- backups_created=${w.backupsCreated}`,
    "",
    "| target_file | shard_month | action | rows_written | rows_skipped | rows_conflict | final_rows | status |",
    "|---|---|---|---|---|---|---|---|",
    ...w.shardActions.map(
      (a) =>
        `| ${a.targetFile} | ${a.shardMonth} | ${a.action} | ${a.rowsWritten} | ${a.rowsSkippedDuplicate} | ${a.rowsConflict} | ${a.finalRowCount} | ${a.status} |`
    ),
    "",
    "## 7. Row counts by shard",
    "",
    `- total_rows_written=${w.rowsWritten}`,
    `- total_rows_skipped_duplicate=${w.rowsSkippedDuplicate}`,
    `- total_rows_conflict=${w.rowsConflict}`,
    "",
    "## 8. Backup / rollback",
    "",
    `- backup_dir=${w.backupDir}`,
    `- backups_created=${w.backupsCreated}`,
    `- rollback_performed=${w.rollbackPerformed}`,
    `- rollback_actions=${JSON.stringify(w.rollbackActions)}`,
    "",
    "## 9. Post-write validation",
    "",
    `- post_write_ok=${input.postWrite.ok}`,
    "| shard_file | rows | header | dup_row_id | empty_hash | month_match | invalid | count_match | ok |",
    "|---|---|---|---|---|---|---|---|---|",
    ...input.postWrite.results.map(
      (r) =>
        `| ${r.fileName} | ${r.rowCount} | ${r.headerPresent} | ${r.duplicateRowIds.length} | ${r.emptyRowHashCount} | ${r.shardMonthMatchesFilename} | ${r.invalidRowCount} | ${r.rowCountMatches} | ${r.ok && r.rowCountMatches} |`
    ),
    "",
    "## 10. Append lock",
    "",
    `- lock_file_path=${w.lockFilePath}`,
    `- lock_acquired=${w.lockAcquired}`,
    `- lock_removed=${w.lockRemoved}`,
    `- stale_lock_threshold_minutes=${STALE_LOCK_THRESHOLD_MINUTES}`,
    "",
    "## 11. .data/history final state",
    "",
    `- files_after=${JSON.stringify(input.historyDirFilesAfter)}`,
    "",
    "## 12. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- write_action_csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 13. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: M06XDecision): string {
  if (decision === "local_history_real_append_success") {
    return "- First real local history append succeeded. Proceed to Phase M07X (GitOps/data-repo separation DESIGN ONLY). Do NOT enable GitHub Actions automatically.";
  }
  if (decision === "local_history_real_append_ready_not_run") {
    return "- Approval and/or REAL_HISTORY_APPEND=1 missing; nothing was written. Provide explicit approval + the env flag to run.";
  }
  if (decision === "local_history_real_append_failed_preflight") {
    return "- Preflight failed (or a fresh lock was present). Fix the reported condition before retrying. Nothing was written.";
  }
  if (decision === "local_history_real_append_failed_rolled_back") {
    return "- Write failed and was rolled back. Investigate the failure, then retry. .data/history was restored to its prior state.";
  }
  if (decision === "local_history_real_append_failed_manual_recovery_required") {
    return "- Write failed AND rollback failed. MANUAL RECOVERY REQUIRED: inspect .data/history and .data/history/.backup to restore state.";
  }
  return "- Write blocked by a conflict. Resolve the conflicting row(s) before retrying. Nothing was written.";
}
