// Phase AUTO-RUNNER07C - fresh history-to-DB sync helper.
//
// This service builds a fresh mapping from the current history shards on every
// run. It writes the DB only when HISTORY_TO_DB_SYNC=1 is supplied by the caller.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { closeDatabase, openLocalDatabase } from "../db/client";
import {
  buildHistoryToDbSyncDryRun,
  mapHistoryRowToMarketSignalHistoryRow,
  parseCsvTable,
  validateRequiredColumns,
  type LoadedHistoryRow,
  type MarketSignalHistoryDryRunRow,
  type SyncActionRecord
} from "./historyToDbSyncDryRun";
import {
  applyRealSync,
  ensureMirrorSchema,
  preflightSyncActions,
  readCollectorBaseline,
  validatePostSync,
  type CollectorBaseline,
  type DbSchemaPreflight,
  type PostSyncValidation,
  type RealSyncResult
} from "./historyToDbSyncRealRun";

export type FreshHistoryToDbSyncDecision =
  | "fresh_history_to_db_sync_ready_not_run"
  | "fresh_history_to_db_sync_success"
  | "fresh_history_to_db_sync_noop"
  | "fresh_history_to_db_sync_not_ready"
  | "fresh_history_to_db_sync_failed"
  | "fresh_history_to_db_sync_conflict";

export interface FreshHistoryToDbSyncOptions {
  runId: string;
  generatedAtJst: string;
  historyDir: string;
  dbPath: string;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
  historyToDbSyncGate: string | undefined;
  expectedHistoryRowCount: string | undefined;
  sourceAutoRunner07bArtifact: string;
}

export interface HistorySummary {
  history_dir: string;
  source_history_files: string[];
  row_count: number;
  rows_by_file: Record<string, number>;
  duplicate_row_id_count: number;
  schema_valid: boolean;
  required_column_errors: Record<string, string[]>;
  mtimes_before: Record<string, number>;
  mtimes_after: Record<string, number>;
  history_modified: boolean;
}

export interface DbSummary {
  db_path: string;
  db_exists: boolean;
  market_signal_history_count: number;
  duplicate_row_id_count: number;
  source_counts: Record<string, number>;
  dp_usage_counts: Record<string, number>;
  collector_baseline: CollectorBaseline | null;
}

export interface FreshMappingSummary {
  history_row_count: number;
  mapped_row_count: number;
  mapped_count_matches_history: boolean;
  validation_passed: boolean;
  validation_errors: string[];
  dry_run_decision: string;
  would_insert_rows: number;
  would_skip_identical_rows: number;
  would_conflict_rows: number;
  source_duplicate_conflict_count: number;
}

export interface GateResult {
  passed: boolean;
  env_flag_present: boolean;
  expected_history_row_count: number | null;
  expected_history_row_count_matches: boolean;
  reasons: string[];
}

export interface SyncResultSummary {
  db_write_executed: boolean;
  inserted_rows: number;
  skipped_identical_rows: number;
  conflict_rows: number;
  sync_run_record_status: string;
  sync_run_id: string;
  db_schema_preflight: DbSchemaPreflight | null;
}

export interface IdempotencySummary {
  already_synced_noop: boolean;
  expected_next_inserted_rows: number;
  expected_next_skipped_identical_rows: number;
  expected_next_conflict_rows: number;
}

export interface FreshHistoryToDbSyncReport {
  run_id: string;
  generated_at_jst: string;
  decision: FreshHistoryToDbSyncDecision;
  source_auto_runner07b_artifact: string;
  history_summary: HistorySummary;
  db_before_summary: DbSummary;
  fresh_mapping_summary: FreshMappingSummary;
  gate_result: GateResult;
  sync_result: SyncResultSummary;
  db_after_summary: DbSummary;
  post_sync_validation: PostSyncValidation | null;
  idempotency_summary: IdempotencySummary;
  safety_confirmation: Record<string, boolean>;
  next_phase: string;
  report_path: string;
  json_path: string;
  csv_path: string;
  debug_artifact_path: string;
  sync_actions: SyncActionRecord[];
}

interface LoadedHistory {
  files: string[];
  loadedRows: LoadedHistoryRow[];
  headersByFile: { path: string; headers: string[] }[];
  rowsByFile: Record<string, number>;
  mtimesBefore: Record<string, number>;
}

export function runFreshHistoryToDbSync(options: FreshHistoryToDbSyncOptions): FreshHistoryToDbSyncReport {
  mkdirSync(dirname(options.reportPath), { recursive: true });
  mkdirSync(options.debugPath, { recursive: true });
  const history = loadHistoryRows(options.historyDir);
  const requiredColumnCheck = validateRequiredColumns(history.headersByFile);
  const mappedRows = history.loadedRows.map((entry) => mapHistoryRowToMarketSignalHistoryRow(entry.row, options.generatedAtJst));
  const sourceDuplicateConflicts = findDuplicateRowIdConflicts(mappedRows);
  const dbBefore = summarizeDb(options.dbPath);
  const existingRows = readExistingRows(options.dbPath);
  const dryRun = buildHistoryToDbSyncDryRun({
    runId: options.runId,
    generatedAtJst: options.generatedAtJst,
    reportPath: options.reportPath,
    sourceHistoryFiles: history.files,
    loadedRows: history.loadedRows,
    requiredColumnCheck,
    existingRows
  });
  const preflight = preflightRowsAgainstExisting(options.runId, mappedRows, existingRows);
  const freshMappingSummary = buildFreshMappingSummary({
    historyCount: history.loadedRows.length,
    mappedRows,
    dryRun,
    preflightConflicts: preflight.conflicts.length,
    sourceDuplicateConflictCount: sourceDuplicateConflicts.length
  });
  const gate = evaluateFreshSyncGate({
    envFlag: options.historyToDbSyncGate,
    expectedHistoryRowCount: options.expectedHistoryRowCount,
    historyCount: history.loadedRows.length,
    mapping: freshMappingSummary,
    duplicateRowIdCount: sourceDuplicateConflicts.length,
    schemaValid: requiredColumnCheck.passed
  });

  let decision: FreshHistoryToDbSyncDecision = "fresh_history_to_db_sync_ready_not_run";
  let syncResult: RealSyncResult | null = null;
  let schemaPreflight: DbSchemaPreflight | null = null;
  let postSyncValidation: PostSyncValidation | null = null;
  let collectorBaselineBefore = dbBefore.collector_baseline;
  let syncActions = preflight.actions;

  if (!freshMappingSummary.validation_passed || history.loadedRows.length === 0 || sourceDuplicateConflicts.length > 0) {
    decision = "fresh_history_to_db_sync_not_ready";
  } else if (freshMappingSummary.would_conflict_rows > 0) {
    decision = "fresh_history_to_db_sync_conflict";
  } else if (!gate.passed) {
    decision = "fresh_history_to_db_sync_ready_not_run";
  } else {
    const db = openLocalDatabase(options.dbPath);
    try {
      collectorBaselineBefore = readCollectorBaseline(db);
      schemaPreflight = ensureMirrorSchema(db);
      syncResult = applyRealSync({
        db,
        runId: options.runId,
        generatedAtJst: options.generatedAtJst,
        reportPath: options.reportPath,
        sourceHistoryFiles: history.files,
        rows: mappedRows
      });
      syncActions = syncResult.actions;
      postSyncValidation = validatePostSync({
        db,
        sourceRows: mappedRows,
        syncRunId: syncResult.sync_run_record.sync_run_id,
        collectorBaselineBefore,
        historyMtimesUnchanged: historyMtimesUnchanged(history.mtimesBefore)
      });
      if (syncResult.conflict_rows > 0) {
        decision = "fresh_history_to_db_sync_conflict";
      } else if (!postSyncValidation.passed) {
        decision = "fresh_history_to_db_sync_failed";
      } else if (syncResult.inserted_rows === 0 && syncResult.skipped_identical_rows === mappedRows.length) {
        decision = "fresh_history_to_db_sync_noop";
      } else {
        decision = "fresh_history_to_db_sync_success";
      }
    } finally {
      closeDatabase(db);
    }
  }

  const dbAfter = summarizeDb(options.dbPath);
  const historySummary = buildHistorySummary(options.historyDir, history, sourceDuplicateConflicts.length, requiredColumnCheck.missing_columns_by_file, history.mtimesBefore);
  const idempotencySummary = buildIdempotencySummary({
    mappedCount: mappedRows.length,
    syncResult,
    preflightSkipped: preflight.skipped.length,
    preflightConflicts: preflight.conflicts.length
  });
  const syncSummary: SyncResultSummary = {
    db_write_executed: syncResult !== null,
    inserted_rows: syncResult?.inserted_rows ?? 0,
    skipped_identical_rows: syncResult?.skipped_identical_rows ?? 0,
    conflict_rows: syncResult?.conflict_rows ?? preflight.conflicts.length,
    sync_run_record_status: syncResult?.sync_run_record.status ?? "not_run",
    sync_run_id: syncResult?.sync_run_record.sync_run_id ?? "",
    db_schema_preflight: schemaPreflight
  };

  const report: FreshHistoryToDbSyncReport = {
    run_id: options.runId,
    generated_at_jst: options.generatedAtJst,
    decision,
    source_auto_runner07b_artifact: options.sourceAutoRunner07bArtifact,
    history_summary: historySummary,
    db_before_summary: dbBefore,
    fresh_mapping_summary: freshMappingSummary,
    gate_result: gate,
    sync_result: syncSummary,
    db_after_summary: dbAfter,
    post_sync_validation: postSyncValidation,
    idempotency_summary: idempotencySummary,
    safety_confirmation: buildSafetyConfirmation({
      dbWriteExecuted: syncResult !== null,
      dbSyncUsedFreshMapping: true,
      collectorTablesChanged: postSyncValidation === null ? false : !postSyncValidation.collector_baseline_unchanged,
      historyModified: historySummary.history_modified
    }),
    next_phase: "AUTO-RUNNER07D — Integrate fresh DB sync helper into disabled DB update runner plan",
    report_path: options.reportPath,
    json_path: options.jsonPath,
    csv_path: options.csvPath,
    debug_artifact_path: options.debugPath,
    sync_actions: syncActions
  };
  writeFreshSyncArtifacts(report, {
    mappedRows,
    debugPath: options.debugPath,
    sourceAutoRunner07bArtifact: safeReadJson(options.sourceAutoRunner07bArtifact)
  });
  return report;
}

export function evaluateFreshSyncGate(input: {
  envFlag: string | undefined;
  expectedHistoryRowCount: string | undefined;
  historyCount: number;
  mapping: FreshMappingSummary;
  duplicateRowIdCount: number;
  schemaValid: boolean;
}): GateResult {
  const reasons: string[] = [];
  const expected = input.expectedHistoryRowCount === undefined || input.expectedHistoryRowCount === "" ? null : Number(input.expectedHistoryRowCount);
  const expectedMatches = expected === null ? true : Number.isInteger(expected) && expected === input.historyCount;
  if (input.historyCount === 0) reasons.push("history row count is 0");
  if (input.duplicateRowIdCount > 0) reasons.push("duplicate row_id in history");
  if (!input.schemaValid) reasons.push("history schema invalid");
  if (!input.mapping.mapped_count_matches_history) reasons.push("mapped row count does not match history row count");
  if (input.mapping.would_conflict_rows > 0) reasons.push("fresh mapping has DB row_hash conflicts");
  if (!expectedMatches) reasons.push("EXPECTED_HISTORY_ROW_COUNT does not match current history count");
  if (input.envFlag !== "1") reasons.push("HISTORY_TO_DB_SYNC env flag is not 1");
  return {
    passed: reasons.length === 0,
    env_flag_present: input.envFlag === "1",
    expected_history_row_count: expected,
    expected_history_row_count_matches: expectedMatches,
    reasons
  };
}

export function renderFreshHistoryToDbSyncReport(report: FreshHistoryToDbSyncReport): string {
  return [
    "# Fresh History-to-DB Sync",
    "",
    `Generated at: ${report.generated_at_jst}`,
    `Decision: ${report.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    `Freshly mapped ${report.fresh_mapping_summary.mapped_row_count} rows from ${report.history_summary.row_count} history rows. DB write executed: ${report.sync_result.db_write_executed}.`,
    "",
    "## 2. Source AUTO-RUNNER07B Result",
    "",
    report.source_auto_runner07b_artifact,
    "",
    "## 3. History Summary",
    "",
    JSON.stringify(report.history_summary, null, 2),
    "",
    "## 4. DB Before Summary",
    "",
    JSON.stringify(report.db_before_summary, null, 2),
    "",
    "## 5. Fresh Mapping Summary",
    "",
    JSON.stringify(report.fresh_mapping_summary, null, 2),
    "",
    "## 6. Gate Result",
    "",
    JSON.stringify(report.gate_result, null, 2),
    "",
    "## 7. Sync Result",
    "",
    JSON.stringify(report.sync_result, null, 2),
    "",
    "## 8. DB After Summary",
    "",
    JSON.stringify(report.db_after_summary, null, 2),
    "",
    "## 9. Post-Sync Validation",
    "",
    report.post_sync_validation === null ? "not run" : JSON.stringify(report.post_sync_validation, null, 2),
    "",
    "## 10. Idempotency Summary",
    "",
    JSON.stringify(report.idempotency_summary, null, 2),
    "",
    "## 11. Safety Confirmation",
    "",
    ...Object.entries(report.safety_confirmation).map(([key, value]) => `- ${key}=${value}`),
    "",
    "## 12. Decision",
    "",
    report.decision,
    "",
    "## 13. Next Phase",
    "",
    report.next_phase,
    ""
  ].join("\n");
}

export function renderFreshHistoryToDbSyncCsv(report: FreshHistoryToDbSyncReport): string {
  const headers = ["run_id", "row_id", "row_hash", "source", "canonical_property_name", "checkin_date", "action", "reason"];
  const rows = report.sync_actions.map((action) =>
    [action.run_id, action.row_id, action.row_hash, action.source, action.canonical_property_name, action.checkin_date, action.action, action.reason].map(csvEscape).join(",")
  );
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

function loadHistoryRows(historyDir: string): LoadedHistory {
  const fullDir = resolve(historyDir);
  const files = readdirSync(fullDir)
    .filter((name) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(name))
    .sort()
    .map((name) => `${historyDir}/${name}`);
  const loadedRows: LoadedHistoryRow[] = [];
  const headersByFile: { path: string; headers: string[] }[] = [];
  const rowsByFile: Record<string, number> = {};
  const mtimesBefore: Record<string, number> = {};
  for (const file of files) {
    const table = parseCsvTable(readFileSync(resolve(file), "utf8"));
    headersByFile.push({ path: file, headers: table.headers });
    rowsByFile[file] = table.rows.length;
    mtimesBefore[file] = statSync(resolve(file)).mtimeMs;
    for (const row of table.rows) loadedRows.push({ sourceFile: file, row: { ...row, __source_file: file } });
  }
  return { files, loadedRows, headersByFile, rowsByFile, mtimesBefore };
}

function buildHistorySummary(
  historyDir: string,
  history: LoadedHistory,
  duplicateRowIdCount: number,
  requiredColumnErrors: Record<string, string[]>,
  before: Record<string, number> | null
): HistorySummary {
  const mtimesAfter = Object.fromEntries(history.files.map((file) => [file, statSync(resolve(file)).mtimeMs]));
  const mtimesBefore = before ?? history.mtimesBefore;
  return {
    history_dir: historyDir,
    source_history_files: history.files,
    row_count: history.loadedRows.length,
    rows_by_file: history.rowsByFile,
    duplicate_row_id_count: duplicateRowIdCount,
    schema_valid: Object.keys(requiredColumnErrors).length === 0,
    required_column_errors: requiredColumnErrors,
    mtimes_before: mtimesBefore,
    mtimes_after: mtimesAfter,
    history_modified: !Object.entries(mtimesBefore).every(([file, mtime]) => mtimesAfter[file] === mtime)
  };
}

function summarizeDb(dbPath: string): DbSummary {
  if (!existsSync(resolve(dbPath))) {
    return {
      db_path: dbPath,
      db_exists: false,
      market_signal_history_count: 0,
      duplicate_row_id_count: 0,
      source_counts: {},
      dp_usage_counts: {},
      collector_baseline: null
    };
  }
  const db = new Database(resolve(dbPath), { readonly: true, fileMustExist: true });
  try {
    return {
      db_path: dbPath,
      db_exists: true,
      market_signal_history_count: tableExists(db, "market_signal_history") ? countRows(db, "market_signal_history") : 0,
      duplicate_row_id_count: tableExists(db, "market_signal_history") ? duplicateRowIdCount(db) : 0,
      source_counts: tableExists(db, "market_signal_history") ? countBy(db, "source") : {},
      dp_usage_counts: tableExists(db, "market_signal_history") ? countBy(db, "dp_usage") : {},
      collector_baseline: readCollectorBaseline(db)
    };
  } finally {
    db.close();
  }
}

function readExistingRows(dbPath: string): MarketSignalHistoryDryRunRow[] {
  if (!existsSync(resolve(dbPath))) return [];
  const db = new Database(resolve(dbPath), { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(db, "market_signal_history")) return [];
    return (db.prepare("SELECT row_id, row_hash FROM market_signal_history").all() as { row_id: string; row_hash: string }[]).map((row) => ({
      row_id: row.row_id,
      row_hash: row.row_hash,
      shard_month: "",
      collected_date_jst: "",
      collected_at_jst: "",
      normalized_at_jst: "",
      source: "rakuten",
      canonical_property_name: "",
      source_property_id: "",
      source_url: "",
      checkin_date: "",
      checkout_date: "",
      stay_scope: "",
      availability_status: "",
      sold_out_flag: null,
      normalized_total_jpy: null,
      price_basis: "",
      basis_confidence: "",
      dp_usage: "",
      classification: "",
      exclusion_reason: "",
      debug_artifact_path: "",
      schema_version: "zao_local_history_v1",
      raw_json: "",
      created_at: "",
      updated_at: ""
    }));
  } finally {
    db.close();
  }
}

function preflightRowsAgainstExisting(runId: string, rows: MarketSignalHistoryDryRunRow[], existingRows: MarketSignalHistoryDryRunRow[]) {
  const existing = new Map(existingRows.map((row) => [row.row_id, row.row_hash]));
  const actions: SyncActionRecord[] = [];
  const inserted: MarketSignalHistoryDryRunRow[] = [];
  const skipped: MarketSignalHistoryDryRunRow[] = [];
  const conflicts: SyncActionRecord[] = [];
  for (const row of rows) {
    const existingHash = existing.get(row.row_id);
    const action = existingHash === undefined ? "would_insert" : existingHash === row.row_hash ? "would_skip_identical" : "would_conflict_block";
    const reason = existingHash === undefined ? "new_row_id" : existingHash === row.row_hash ? "same_row_id_same_row_hash" : `existing_hash=${existingHash};incoming_hash=${row.row_hash}`;
    const record: SyncActionRecord = {
      run_id: runId,
      row_id: row.row_id,
      row_hash: row.row_hash,
      source: row.source,
      canonical_property_name: row.canonical_property_name,
      checkin_date: row.checkin_date,
      shard_month: row.shard_month,
      action,
      reason
    };
    actions.push(record);
    if (action === "would_insert") inserted.push(row);
    if (action === "would_skip_identical") skipped.push(row);
    if (action === "would_conflict_block") conflicts.push(record);
  }
  return { actions, inserted, skipped, conflicts };
}

function buildFreshMappingSummary(input: {
  historyCount: number;
  mappedRows: MarketSignalHistoryDryRunRow[];
  dryRun: { decision: string; validation_result: { passed: boolean; errors: string[] }; dedupe_summary: { would_insert_rows: number; would_skip_identical_rows: number; would_conflict_rows: number } };
  preflightConflicts: number;
  sourceDuplicateConflictCount: number;
}): FreshMappingSummary {
  return {
    history_row_count: input.historyCount,
    mapped_row_count: input.mappedRows.length,
    mapped_count_matches_history: input.mappedRows.length === input.historyCount,
    validation_passed: input.dryRun.validation_result.passed,
    validation_errors: input.dryRun.validation_result.errors,
    dry_run_decision: input.dryRun.decision,
    would_insert_rows: input.dryRun.dedupe_summary.would_insert_rows,
    would_skip_identical_rows: input.dryRun.dedupe_summary.would_skip_identical_rows,
    would_conflict_rows: input.preflightConflicts,
    source_duplicate_conflict_count: input.sourceDuplicateConflictCount
  };
}

function buildIdempotencySummary(input: {
  mappedCount: number;
  syncResult: RealSyncResult | null;
  preflightSkipped: number;
  preflightConflicts: number;
}): IdempotencySummary {
  const inserted = input.syncResult?.inserted_rows ?? 0;
  const skipped = input.syncResult?.skipped_identical_rows ?? input.preflightSkipped;
  const conflicts = input.syncResult?.conflict_rows ?? input.preflightConflicts;
  return {
    already_synced_noop: inserted === 0 && skipped === input.mappedCount && conflicts === 0,
    expected_next_inserted_rows: 0,
    expected_next_skipped_identical_rows: input.mappedCount,
    expected_next_conflict_rows: 0
  };
}

function buildSafetyConfirmation(input: {
  dbWriteExecuted: boolean;
  dbSyncUsedFreshMapping: boolean;
  collectorTablesChanged: boolean;
  historyModified: boolean;
}): Record<string, boolean> {
  return {
    history_modified: input.historyModified,
    history_appended: false,
    db_write_executed: input.dbWriteExecuted,
    db_sync_used_fresh_mapping: input.dbSyncUsedFreshMapping,
    stale_pointer_used: false,
    hardcoded_count_pin_used: false,
    ai_context_refreshed: false,
    live_collector_run: false,
    playwright_used: false,
    pricing_csv_generated: false,
    pms_output_generated: false,
    collector_tables_changed: input.collectorTablesChanged,
    git_mutation: false
  };
}

function writeFreshSyncArtifacts(
  report: FreshHistoryToDbSyncReport,
  extra: { mappedRows: MarketSignalHistoryDryRunRow[]; debugPath: string; sourceAutoRunner07bArtifact: unknown }
): void {
  writeFileSync(report.report_path, renderFreshHistoryToDbSyncReport(report), "utf8");
  writeFileSync(report.json_path, `${JSON.stringify(withoutSyncActions(report), null, 2)}\n`, "utf8");
  writeFileSync(report.csv_path, renderFreshHistoryToDbSyncCsv(report), "utf8");
  writeFileSync(resolve(extra.debugPath, "source_auto_runner07b_artifact.json"), `${JSON.stringify(extra.sourceAutoRunner07bArtifact, null, 2)}\n`, "utf8");
  writeFileSync(resolve(extra.debugPath, "history_summary.json"), `${JSON.stringify(report.history_summary, null, 2)}\n`, "utf8");
  writeFileSync(
    resolve(extra.debugPath, "fresh_mapped_rows_summary.json"),
    `${JSON.stringify({ row_count: extra.mappedRows.length, preview: extra.mappedRows.slice(0, 10) }, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(resolve(extra.debugPath, "gate_result.json"), `${JSON.stringify(report.gate_result, null, 2)}\n`, "utf8");
  writeFileSync(resolve(extra.debugPath, "sync_result.json"), `${JSON.stringify(report.sync_result, null, 2)}\n`, "utf8");
  writeFileSync(resolve(extra.debugPath, "post_sync_validation.json"), `${JSON.stringify(report.post_sync_validation, null, 2)}\n`, "utf8");
  writeFileSync(resolve(extra.debugPath, "safety_confirmation.json"), `${JSON.stringify(report.safety_confirmation, null, 2)}\n`, "utf8");
}

function withoutSyncActions(report: FreshHistoryToDbSyncReport): Omit<FreshHistoryToDbSyncReport, "sync_actions"> & { sync_actions_summary: { action_count: number } } {
  const { sync_actions: syncActions, ...rest } = report;
  return { ...rest, sync_actions_summary: { action_count: syncActions.length } };
}

function findDuplicateRowIdConflicts(rows: MarketSignalHistoryDryRunRow[]): Array<{ row_id: string; hashes: string[] }> {
  const hashesById = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!hashesById.has(row.row_id)) hashesById.set(row.row_id, new Set());
    hashesById.get(row.row_id)!.add(row.row_hash);
  }
  return [...hashesById.entries()]
    .filter(([, hashes]) => hashes.size > 1)
    .map(([row_id, hashes]) => ({ row_id, hashes: [...hashes].sort() }));
}

function historyMtimesUnchanged(before: Record<string, number>): boolean {
  return Object.entries(before).every(([file, mtime]) => existsSync(resolve(file)) && statSync(resolve(file)).mtimeMs === mtime);
}

function tableExists(db: Database.Database, table: string): boolean {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as { name: string } | undefined) !== undefined;
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function duplicateRowIdCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM (SELECT row_id FROM market_signal_history GROUP BY row_id HAVING COUNT(*) > 1)").get() as { count: number }).count;
}

function countBy(db: Database.Database, column: string): Record<string, number> {
  const rows = db.prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM market_signal_history GROUP BY ${column} ORDER BY ${column}`).all() as { key: string | null; count: number }[];
  return Object.fromEntries(rows.map((row) => [row.key ?? "", row.count]));
}

function safeReadJson(path: string): unknown {
  if (!existsSync(resolve(path))) return { missing: path };
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
