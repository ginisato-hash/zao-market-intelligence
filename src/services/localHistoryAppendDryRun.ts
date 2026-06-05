// Phase M03X — Local history append dry-run prototype with monthly shard dedupe.
//
// Simulates appending M02X history-ready rows into monthly shard CSV files,
// deduplicating idempotent duplicates (same row_id + same row_hash) and
// detecting true conflicts (same row_id, different row_hash).
//
// DRY-RUN / LOCAL-OUTPUT ONLY. Never writes to .data/history/. No DB writes,
// no GitHub Actions, no GitOps, no collector re-runs.

import {
  HISTORY_CSV_HEADERS,
  futureShardPath,
  renderHistoryCsv,
  type HistoryRow
} from "./localHistorySchemaDesign";

export type AppendAction = "append" | "skip_duplicate_identical" | "conflict_same_id_different_hash";

export interface AppendActionRecord {
  runId: string;
  scenario: string;
  shardMonth: string;
  futureHistoryPath: string;
  dryRunShardPath: string;
  rowId: string;
  rowHash: string;
  source: string;
  canonicalPropertyName: string;
  checkin: string;
  appendAction: AppendAction;
  reason: string;
}

export const APPEND_ACTION_CSV_HEADERS = [
  "run_id",
  "scenario",
  "shard_month",
  "future_history_path",
  "dry_run_shard_path",
  "row_id",
  "row_hash",
  "source",
  "canonical_property_name",
  "checkin",
  "append_action",
  "reason"
] as const;

export interface AppendSimulationResult {
  scenario: string;
  actions: AppendActionRecord[];
  shardRows: HistoryRow[];
  appendedCount: number;
  skippedIdenticalCount: number;
  conflictCount: number;
  conflicts: AppendActionRecord[];
}

export interface SimulateAppendOptions {
  scenario: string;
  runId: string;
  dryRunShardDir: string;
}

function dryRunShardPathFor(dir: string, shardMonth: string): string {
  return `${dir}/zao_signals_${shardMonth}.csv`;
}

// Append newRows on top of existingRows, deduping by row_id within each target
// shard. Identical (same hash) repeats are skipped; differing hashes conflict.
export function simulateAppend(
  existingRows: HistoryRow[],
  newRows: HistoryRow[],
  options: SimulateAppendOptions
): AppendSimulationResult {
  // Per-shard map: (shardMonth::rowId) -> row_hash already present in the shard.
  const present = new Map<string, string>();
  const shardRows: HistoryRow[] = [];

  for (const row of existingRows) {
    const key = `${row.shardMonth}::${row.rowId}`;
    if (!present.has(key)) {
      present.set(key, row.rowHash);
      shardRows.push(row);
    }
  }

  const actions: AppendActionRecord[] = [];
  const conflicts: AppendActionRecord[] = [];
  let appendedCount = 0;
  let skippedIdenticalCount = 0;
  let conflictCount = 0;

  for (const row of newRows) {
    const key = `${row.shardMonth}::${row.rowId}`;
    const existingHash = present.get(key);

    let appendAction: AppendAction;
    let reason: string;
    if (existingHash === undefined) {
      appendAction = "append";
      reason = "new_row_id_in_shard";
      present.set(key, row.rowHash);
      shardRows.push(row);
      appendedCount += 1;
    } else if (existingHash === row.rowHash) {
      appendAction = "skip_duplicate_identical";
      reason = "same_row_id_same_row_hash";
      skippedIdenticalCount += 1;
    } else {
      appendAction = "conflict_same_id_different_hash";
      reason = `existing_hash=${existingHash};incoming_hash=${row.rowHash}`;
      conflictCount += 1;
    }

    const record: AppendActionRecord = {
      runId: options.runId,
      scenario: options.scenario,
      shardMonth: row.shardMonth,
      futureHistoryPath: futureShardPath(row.shardMonth),
      dryRunShardPath: dryRunShardPathFor(options.dryRunShardDir, row.shardMonth),
      rowId: row.rowId,
      rowHash: row.rowHash,
      source: row.source,
      canonicalPropertyName: row.canonicalPropertyName,
      checkin: row.checkin,
      appendAction,
      reason
    };
    actions.push(record);
    if (appendAction === "conflict_same_id_different_hash") conflicts.push(record);
  }

  return { scenario: options.scenario, actions, shardRows, appendedCount, skippedIdenticalCount, conflictCount, conflicts };
}

// ---------------------------------------------------------------------------
// Shard grouping of final (deduped) rows
// ---------------------------------------------------------------------------

export interface DryRunShard {
  shardMonth: string;
  futureHistoryPath: string;
  dryRunShardPath: string;
  rows: HistoryRow[];
  csv: string;
}

export function buildDryRunShards(shardRows: HistoryRow[], dryRunShardDir: string): DryRunShard[] {
  const byShard = new Map<string, HistoryRow[]>();
  for (const row of shardRows) {
    const bucket = byShard.get(row.shardMonth) ?? [];
    bucket.push(row);
    byShard.set(row.shardMonth, bucket);
  }
  const out: DryRunShard[] = [];
  for (const [shardMonth, rows] of byShard) {
    out.push({
      shardMonth,
      futureHistoryPath: futureShardPath(shardMonth),
      dryRunShardPath: dryRunShardPathFor(dryRunShardDir, shardMonth),
      rows,
      csv: renderHistoryCsv(rows)
    });
  }
  return out.sort((a, b) => a.shardMonth.localeCompare(b.shardMonth));
}

// True if any shard contains a repeated row_id (must never happen post-dedupe).
export function findShardDuplicateRowIds(shards: DryRunShard[]): { shardMonth: string; rowId: string; count: number }[] {
  const out: { shardMonth: string; rowId: string; count: number }[] = [];
  for (const shard of shards) {
    const counts = new Map<string, number>();
    for (const row of shard.rows) counts.set(row.rowId, (counts.get(row.rowId) ?? 0) + 1);
    for (const [rowId, count] of counts) {
      if (count > 1) out.push({ shardMonth: shard.shardMonth, rowId, count });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

const REAL_HISTORY_PATTERN = /(^|[\\/])\.data[\\/]history([\\/]|$)/u;

export function isRealHistoryPath(path: string): boolean {
  return REAL_HISTORY_PATTERN.test(path);
}

export function assertNotRealHistoryPath(path: string): void {
  if (isRealHistoryPath(path)) {
    throw new Error(`Refusing to write to real history path: ${path}. M03X is dry-run only; shards must live under .data/debug/history-append-dry-run/.`);
  }
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type M03XDecision =
  | "local_history_append_dry_run_ready"
  | "local_history_append_dry_run_basis_caution"
  | "local_history_append_dry_run_not_ready";

export function decideM03X(input: {
  inputRowCount: number;
  validationInvalidRows: number;
  forbiddenColumnErrors: number;
  hashConflictCount: number;
  scenarioBAppendedCount: number;
  shardDuplicateRowIdCount: number;
  historyDirCreated: boolean;
}): M03XDecision {
  if (
    input.inputRowCount === 0 ||
    input.validationInvalidRows > 0 ||
    input.forbiddenColumnErrors > 0 ||
    input.hashConflictCount > 0 ||
    input.scenarioBAppendedCount > 0 ||
    input.shardDuplicateRowIdCount > 0 ||
    input.historyDirCreated
  ) {
    return "local_history_append_dry_run_not_ready";
  }
  return "local_history_append_dry_run_ready";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderAppendActionCsv(actions: AppendActionRecord[]): string {
  const body = actions.map((a) =>
    [
      a.runId,
      a.scenario,
      a.shardMonth,
      a.futureHistoryPath,
      a.dryRunShardPath,
      a.rowId,
      a.rowHash,
      a.source,
      a.canonicalPropertyName,
      a.checkin,
      a.appendAction,
      a.reason
    ]
      .map(csvEscape)
      .join(",")
  );
  return [APPEND_ACTION_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export interface DryRunSummary {
  runId: string;
  sourceM02xArtifactPath: string;
  schemaVersion: string;
  inputRowCount: number;
  uniqueRowIdCount: number;
  duplicateInputRowCount: number;
  hashConflictCount: number;
  scenarioAAppendedCount: number;
  scenarioASkippedIdenticalCount: number;
  scenarioAConflictCount: number;
  scenarioBAppendedCount: number;
  scenarioBSkippedIdenticalCount: number;
  scenarioBConflictCount: number;
  shardCount: number;
  shardPathsDryRun: string[];
  historyDirCreated: boolean;
  decision: M03XDecision;
}

export function renderDryRunReport(input: {
  generatedAt: string;
  summary: DryRunSummary;
  shards: DryRunShard[];
  scenarioA: AppendSimulationResult;
  scenarioB: AppendSimulationResult;
  conflicts: AppendActionRecord[];
  forbiddenColumnErrors: string[];
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}): string {
  const s = input.summary;
  return [
    "# Local History Append Dry-Run (Phase M03X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Policy & safety",
    "",
    "- Dry-run / prototype only: NO DB writes, no collector_runs/rate_snapshots/inventory_snapshots.",
    "- No production cron, no GitHub Actions, no GitOps auto-commit.",
    "- No real .data/history/zao_signals_YYYY_MM.csv writes; simulated shards live under the debug dir only.",
    "- No Beds24/AirHost/PMS/OTA columns; no deprecated tax_multiplier/tax_included_price/tax_normalization_rule; no base × 1.1.",
    "",
    "## 2. Summary",
    "",
    `- decision=${s.decision}`,
    `- schema_version=${s.schemaVersion}`,
    `- input_row_count=${s.inputRowCount}`,
    `- unique_row_id_count=${s.uniqueRowIdCount}`,
    `- duplicate_input_row_count=${s.duplicateInputRowCount}`,
    `- hash_conflict_count=${s.hashConflictCount}`,
    `- history_dir_created=${s.historyDirCreated}`,
    "",
    "## 3. Source M02X artifact used",
    "",
    `- ${s.sourceM02xArtifactPath}`,
    "",
    "## 4. Scenario A — empty-shard append",
    "",
    `- appended=${s.scenarioAAppendedCount}`,
    `- skipped_identical=${s.scenarioASkippedIdenticalCount}`,
    `- conflicts=${s.scenarioAConflictCount}`,
    "",
    "## 5. Scenario B — idempotent replay (raw input rows vs Scenario A shard output)",
    "",
    `- appended=${s.scenarioBAppendedCount}`,
    `- skipped_identical=${s.scenarioBSkippedIdenticalCount}`,
    `- conflicts=${s.scenarioBConflictCount}`,
    "",
    "## 6. Shard output preview (dry-run only)",
    "",
    "| shard_month | future_history_path (NOT written) | dry_run_shard_path | rows |",
    "|---|---|---|---|",
    ...input.shards.map(
      (sh) => `| ${sh.shardMonth} | ${sh.futureHistoryPath} | ${sh.dryRunShardPath} | ${sh.rows.length} |`
    ),
    "",
    "## 7. Conflict detection",
    "",
    `- hash_conflict_count=${s.hashConflictCount}`,
    ...(input.conflicts.length > 0 ? input.conflicts.map((c) => `- ${c.rowId} (${c.reason})`) : ["- none"]),
    "",
    "## 8. Forbidden column check",
    "",
    `- forbidden_column_errors=${input.forbiddenColumnErrors.length}`,
    ...(input.forbiddenColumnErrors.length > 0 ? input.forbiddenColumnErrors.map((e) => `- ${e}`) : ["- none"]),
    "",
    "## 9. Future real history paths (examples, NOT written this phase)",
    "",
    ...input.shards.slice(0, 6).map((sh) => `- ${sh.futureHistoryPath} (not written)`),
    "",
    "## 10. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- action_csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 11. Recommended next action",
    "",
    recommendedNextAction(s.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: M03XDecision): string {
  if (decision === "local_history_append_dry_run_ready") {
    return "- Proceed to Phase M04X history append validation and conflict policy hardening (schema migration guard, conflict policy, shard integrity, append lock, dry-run vs real-run switch). Keep real .data/history writes / DB / GitHub Actions disabled.";
  }
  if (decision === "local_history_append_dry_run_basis_caution") {
    return "- Dry-run works but skip/duplicate counts need review before hardening. Do not perform real append.";
  }
  return "- Hash conflicts, validation failure, or a real .data/history write occurred. Fix append/dedupe/conflict behavior before any real history work. Do not proceed to M04X.";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
