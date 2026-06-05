// Phase M03X — run the local history append dry-run prototype.
//
// Reads the latest M02X history-ready rows (from the paired debug artifact),
// simulates monthly-shard append in two scenarios (empty-shard append, then
// idempotent replay), writes simulated shard CSVs + summaries under the debug
// dir only. NEVER writes to .data/history/. No DB writes, no collector re-runs.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HISTORY_CSV_HEADERS,
  HISTORY_SCHEMA_VERSION,
  findDuplicateRowIds,
  validateHistoryRows,
  validateHistorySchemaColumns,
  type HistoryRow
} from "../services/localHistorySchemaDesign";
import {
  assertNotRealHistoryPath,
  buildDryRunShards,
  decideM03X,
  findShardDuplicateRowIds,
  renderAppendActionCsv,
  renderDryRunReport,
  simulateAppend,
  type AppendActionRecord,
  type DryRunSummary
} from "../services/localHistoryAppendDryRun";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/history-append-dry-run";
const HISTORY_DIR = ".data/history";
const M02X_REPORT_PREFIX = "local_history_schema_design_";
const M02X_DEBUG_ROOT = ".data/debug/history-schema-design";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function resolveLatestM02X(): { jsonPath: string; rowsPath: string } {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing M02X artifact directory: ${reportDir}. Do not re-run collectors; produce the M02X artifact first.`);
  }
  const jsonFiles = entries.filter((name) => name.startsWith(M02X_REPORT_PREFIX) && name.endsWith(".json")).sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(
      `Missing M02X source JSON (expected ${M02X_REPORT_PREFIX}*.json in ${reportDir}). Do not re-run collectors; stop and report the missing artifact path.`
    );
  }
  const ts = latest.slice(M02X_REPORT_PREFIX.length, -".json".length);
  const rowsPath = resolve(M02X_DEBUG_ROOT, ts, "history_rows_prototype.json");
  return { jsonPath: resolve(reportDir, latest), rowsPath };
}

function loadHistoryRows(rowsPath: string): HistoryRow[] {
  let raw: string;
  try {
    raw = readFileSync(rowsPath, "utf8");
  } catch {
    throw new Error(`Missing M02X history rows artifact: ${rowsPath}. Stop and report the missing artifact path.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    throw new Error(`Malformed M02X history rows JSON ${rowsPath}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`M02X history rows JSON ${rowsPath} is empty. Stop and report the malformed artifact.`);
  }
  return parsed as HistoryRow[];
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  // Safety: capture .data/history state up front; it must not change.
  const historyDir = resolve(HISTORY_DIR);
  const historyExistedBefore = existsSync(historyDir);
  const historyBefore = historyExistedBefore ? readdirSync(historyDir) : [];

  const ts = timestamp();
  const runId = `local_history_append_dry_run_${ts}`;
  const source = resolveLatestM02X();
  const rows = loadHistoryRows(source.rowsPath);

  // Validation (reuse M02X logic).
  const forbiddenColumnErrors = validateHistorySchemaColumns([...HISTORY_CSV_HEADERS]);
  const validation = validateHistoryRows(rows);
  const inputDuplicates = findDuplicateRowIds(rows);

  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  const shardsDir = resolve(debugRootPath, "shards");
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(shardsDir, { recursive: true });

  // Path safety guard before any shard write.
  assertNotRealHistoryPath(shardsDir);

  // Scenario A — append onto an empty shard set.
  const scenarioA = simulateAppend([], rows, { scenario: "A_empty_shard", runId, dryRunShardDir: shardsDir });
  // Scenario B — replay raw input rows against Scenario A's shard output.
  const scenarioB = simulateAppend(scenarioA.shardRows, rows, { scenario: "B_idempotent_replay", runId, dryRunShardDir: shardsDir });

  const shards = buildDryRunShards(scenarioA.shardRows, shardsDir);
  const shardDuplicates = findShardDuplicateRowIds(shards);

  // Write simulated shard CSVs (debug dir only — guarded).
  for (const shard of shards) {
    assertNotRealHistoryPath(shard.dryRunShardPath);
    writeFileSync(shard.dryRunShardPath, shard.csv, "utf8");
  }

  const historyDirCreatedDuringRun = existsSync(historyDir) && !historyExistedBefore;
  const summary: DryRunSummary = {
    runId,
    sourceM02xArtifactPath: source.jsonPath,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    inputRowCount: rows.length,
    uniqueRowIdCount: scenarioA.shardRows.length,
    duplicateInputRowCount: scenarioA.skippedIdenticalCount,
    hashConflictCount: scenarioA.conflictCount + scenarioB.conflictCount,
    scenarioAAppendedCount: scenarioA.appendedCount,
    scenarioASkippedIdenticalCount: scenarioA.skippedIdenticalCount,
    scenarioAConflictCount: scenarioA.conflictCount,
    scenarioBAppendedCount: scenarioB.appendedCount,
    scenarioBSkippedIdenticalCount: scenarioB.skippedIdenticalCount,
    scenarioBConflictCount: scenarioB.conflictCount,
    shardCount: shards.length,
    shardPathsDryRun: shards.map((sh) => sh.dryRunShardPath),
    historyDirCreated: historyDirCreatedDuringRun,
    decision: "local_history_append_dry_run_not_ready"
  };
  summary.decision = decideM03X({
    inputRowCount: rows.length,
    validationInvalidRows: validation.invalidRowCount,
    forbiddenColumnErrors: forbiddenColumnErrors.length,
    hashConflictCount: summary.hashConflictCount,
    scenarioBAppendedCount: scenarioB.appendedCount,
    shardDuplicateRowIdCount: shardDuplicates.length,
    historyDirCreated: historyDirCreatedDuringRun
  });

  const conflicts: AppendActionRecord[] = [...scenarioA.conflicts, ...scenarioB.conflicts];
  const allActions = [...scenarioA.actions, ...scenarioB.actions];

  const reportPath = resolve(reportDir, `local_history_append_dry_run_${ts}.md`);
  const csvPath = resolve(reportDir, `local_history_append_dry_run_${ts}.csv`);
  const jsonPath = resolve(reportDir, `local_history_append_dry_run_${ts}.json`);

  writeFileSync(csvPath, renderAppendActionCsv(allActions), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ summary, shardDuplicates, validation, inputDuplicateRowIdCount: inputDuplicates.length, forbiddenColumnErrors }, null, 2), "utf8");
  writeFileSync(
    reportPath,
    renderDryRunReport({
      generatedAt: new Date().toISOString(),
      summary,
      shards,
      scenarioA,
      scenarioB,
      conflicts,
      forbiddenColumnErrors,
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath
    }),
    "utf8"
  );

  // Debug artifacts.
  writeFileSync(resolve(debugRootPath, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "scenario_a_actions.json"), JSON.stringify(scenarioA.actions, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "scenario_b_actions.json"), JSON.stringify(scenarioB.actions, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "conflicts.json"), JSON.stringify(conflicts, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "shard_duplicates.json"), JSON.stringify(shardDuplicates, null, 2), "utf8");
  writeFileSync(
    resolve(debugRootPath, "validation_summary.json"),
    JSON.stringify({ validation, forbiddenColumnErrors, inputDuplicateRowIdCount: inputDuplicates.length }, null, 2),
    "utf8"
  );

  // Safety: confirm .data/history did not change.
  const historyAfter = existsSync(historyDir) ? readdirSync(historyDir) : [];
  if (historyDirCreatedDuringRun || historyAfter.length !== historyBefore.length) {
    throw new Error(
      `Safety violation: ${HISTORY_DIR} changed during M03X (existedBefore=${historyExistedBefore}, before=${historyBefore.length}, after=${historyAfter.length}). M03X must not touch real history.`
    );
  }

  return { reportPath, csvPath, jsonPath, debugRootPath, decision: summary.decision };
}

try {
  const result = build();
  console.log(`report_path=${result.reportPath}`);
  console.log(`action_csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`history_dir_exists=${existsSync(resolve(HISTORY_DIR))}`);
  console.log(`decision=${result.decision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
