// Phase AUTO-RUNNER07C - fresh history-to-DB sync helper.
//
// This service builds a fresh mapping from the current history shards on every
// run and reports it against the DB. runFreshHistoryToDbSync is permanently
// read-only (TD private #13 P0): the only DB writer is trustedAppendAndMirror,
// which mirrors exactly the rows its own process appended.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { MAX_TOTAL_LIVE_PAGES } from "./autoRunnerMarketRefresh";
import { renderHistoryCsv, type HistoryRow } from "./localHistorySchemaDesign";
import { APPEND_LOCK_FILENAME } from "./localHistoryRealAppend";
import { MAX_MULTIPLIER, scaleCap } from "./crawlVolumeConfig";
import { ROTATING_CAPS } from "./rotatingCollectionScopePlanner";

// A natural run may only mirror rows it appended itself, and never more than
// one run's page cap at the maximum crawl multiplier (rotating 24x5, 09:00 live
// 30x5). Anything larger is a backfill and needs a separately approved recovery
// path; there is no such path in this helper.
export const SYNC_PERMIT_MAX_ROWS = Math.max(
  scaleCap(ROTATING_CAPS.total_pages_per_run, MAX_MULTIPLIER),
  scaleCap(MAX_TOTAL_LIVE_PAGES, MAX_MULTIPLIER)
);
export const SYNC_WRITE_OK_DECISIONS: readonly FreshHistoryToDbSyncDecision[] = ["fresh_history_to_db_sync_success", "fresh_history_to_db_sync_noop"];

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
  permit_row_count: number | null;
  permit_max_rows: number;
  would_insert_rows: number;
  unpermitted_insert_rows: number;
  db_only_row_count: number;
  reasons: string[];
  // Reasons found when the gate was re-evaluated under the DB write lock.
  point_of_use_reasons: string[];
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
  // DB row_id->row_hash set equals history exactly (read after the run).
  mirror_exact_match: boolean;
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
  contentDigest: string;
  shards: LoadedShard[];
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
  // Read-only: no write flag and no permitted row set can be supplied.
  const permit: SyncPermit = { rowIds: null, error: null };
  const gateInput = {
    envFlag: undefined,
    expectedHistoryRowCount: options.expectedHistoryRowCount,
    permit,
    duplicateRowIdCount: sourceDuplicateConflicts.length,
    schemaValid: requiredColumnCheck.passed
  };
  const gate = evaluateFreshSyncGate({
    ...gateInput,
    invariants: evaluateMirrorInvariants(mappedRows, new Map(existingRows.map((row) => [row.row_id, row.row_hash])), permit),
    historyCount: history.loadedRows.length,
    mapping: freshMappingSummary
  });

  let decision: FreshHistoryToDbSyncDecision = "fresh_history_to_db_sync_ready_not_run";
  const syncActions = preflight.actions;

  if (!freshMappingSummary.validation_passed || history.loadedRows.length === 0 || sourceDuplicateConflicts.length > 0) {
    decision = "fresh_history_to_db_sync_not_ready";
  } else if (freshMappingSummary.would_conflict_rows > 0) {
    decision = "fresh_history_to_db_sync_conflict";
  }

  const dbAfter = summarizeDb(options.dbPath);
  const historySummary = buildHistorySummary(options.historyDir, history, sourceDuplicateConflicts.length, requiredColumnCheck.missing_columns_by_file, history.mtimesBefore);
  const idempotencySummary = buildIdempotencySummary({
    mappedCount: mappedRows.length,
    syncResult: null,
    preflightSkipped: preflight.skipped.length,
    preflightConflicts: preflight.conflicts.length
  });
  const syncSummary: SyncResultSummary = {
    db_write_executed: false,
    inserted_rows: 0,
    skipped_identical_rows: 0,
    conflict_rows: preflight.conflicts.length,
    sync_run_record_status: "not_run",
    sync_run_id: "",
    db_schema_preflight: null
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
    mirror_exact_match: mirrorExactMatch(mappedRows, readDbHashesReadOnly(options.dbPath)),
    sync_result: syncSummary,
    db_after_summary: dbAfter,
    post_sync_validation: null,
    idempotency_summary: idempotencySummary,
    safety_confirmation: buildSafetyConfirmation({
      dbWriteExecuted: false,
      dbSyncUsedFreshMapping: true,
      collectorTablesChanged: false,
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
  permit: SyncPermit;
  invariants: ReturnType<typeof evaluateMirrorInvariants>;
  historyCount: number;
  mapping: FreshMappingSummary;
  duplicateRowIdCount: number;
  schemaValid: boolean;
}): GateResult {
  const reasons: string[] = [];
  const expected = input.expectedHistoryRowCount === undefined || input.expectedHistoryRowCount === "" ? null : Number(input.expectedHistoryRowCount);
  const expectedMatches = expected === null ? true : Number.isInteger(expected) && expected === input.historyCount;
  const inv = input.invariants;
  const permitRows = input.permit.rowIds === null ? null : input.permit.rowIds.size;
  if (input.historyCount === 0) reasons.push("history row count is 0");
  if (input.duplicateRowIdCount > 0) reasons.push("duplicate row_id in history");
  if (!input.schemaValid) reasons.push("history schema invalid");
  if (!input.mapping.mapped_count_matches_history) reasons.push("mapped row count does not match history row count");
  if (inv.conflictRows > 0) reasons.push("fresh mapping has DB row_hash conflicts");
  if (!expectedMatches) reasons.push("EXPECTED_HISTORY_ROW_COUNT does not match current history count");
  // Mirror-alignment guards: stop BEFORE any DB mutation when the DB is not an
  // exact subset of history, or when this run would insert any row it did not
  // append itself (a backfill needs its own approved recovery path).
  if (inv.dbOnlyRowCount > 0) reasons.push(`DB has ${inv.dbOnlyRowCount} row_ids absent from history; approved mirror reconciliation required`);
  if (input.envFlag === "1" && input.permit.rowIds === null && input.permit.error === null) reasons.push("no in-process trusted row set; DB writes only happen inside trustedAppendAndMirror");
  if (input.permit.error !== null) reasons.push(input.permit.error);
  if (permitRows !== null && permitRows > SYNC_PERMIT_MAX_ROWS) reasons.push(`trusted row set lists ${permitRows} rows > per-run cap ${SYNC_PERMIT_MAX_ROWS}`);
  if (inv.permitRowsNotInHistory > 0) reasons.push(`trusted row set lists ${inv.permitRowsNotInHistory} row_ids absent from history`);
  if (input.envFlag === "1" && inv.unpermittedInsertRows > 0) reasons.push(`would insert ${inv.unpermittedInsertRows} rows not appended by this run; backfill requires a separately approved recovery`);
  if (input.envFlag !== "1") reasons.push("HISTORY_TO_DB_SYNC env flag is not 1");
  return {
    passed: reasons.length === 0,
    env_flag_present: input.envFlag === "1",
    expected_history_row_count: expected,
    expected_history_row_count_matches: expectedMatches,
    permit_row_count: permitRows,
    permit_max_rows: SYNC_PERMIT_MAX_ROWS,
    would_insert_rows: inv.insertRowIds.length,
    unpermitted_insert_rows: inv.unpermittedInsertRows,
    db_only_row_count: inv.dbOnlyRowCount,
    reasons,
    point_of_use_reasons: []
  };
}

// Positive success protocol for callers: an explicit success/noop decision AND
// an exact row_id/row_hash mirror AND the caller's own history count. Counts
// alone, or a zero exit from a refused write, are never success.
export function isVerifiedSyncOutput(status: number | null, parsed: Record<string, unknown>, historyRows: number): boolean {
  return status === 0
    && (SYNC_WRITE_OK_DECISIONS as readonly string[]).includes(String(parsed["decision"] ?? ""))
    && String(parsed["mirror_exact_match"] ?? "") === "true"
    && Number(parsed["history_count"]) === historyRows
    && Number(parsed["db_after_count"]) === historyRows;
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

function loadHistoryRows(historyDir: string, afterShardParsed?: (file: string) => void): LoadedHistory {
  const fullDir = resolve(historyDir);
  const files = readdirSync(fullDir)
    .filter((name) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(name))
    .sort()
    .map((name) => `${historyDir}/${name}`);
  const loadedRows: LoadedHistoryRow[] = [];
  const headersByFile: { path: string; headers: string[] }[] = [];
  const rowsByFile: Record<string, number> = {};
  const mtimesBefore: Record<string, number> = {};
  const shards: LoadedShard[] = [];
  const digest = createHash("sha256");
  for (const file of files) {
    // One read per shard: the same bytes are parsed AND digested, so the digest
    // is a proof of exactly what mappedRows was built from.
    const bytes = readFileSync(resolve(file));
    const table = parseCsvTable(bytes.toString("utf8"));
    const name = file.slice(file.lastIndexOf("/") + 1);
    digest.update(name).update("\0").update(bytes).update("\0");
    shards.push({ name, bytes, sha256: sha256Hex(bytes) });
    headersByFile.push({ path: file, headers: table.headers });
    rowsByFile[file] = table.rows.length;
    mtimesBefore[file] = statSync(resolve(file)).mtimeMs;
    for (const row of table.rows) loadedRows.push({ sourceFile: file, row: { ...row, __source_file: file } });
    afterShardParsed?.(file);
  }
  return { files, loadedRows, headersByFile, rowsByFile, mtimesBefore, contentDigest: digest.digest("hex"), shards };
}

interface LoadedShard { name: string; bytes: Buffer; sha256: string }
const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

// Same formula as loadHistoryRows' digest, from a fresh read; used under the
// write lock (and before commit) to prove history still equals the parsed bytes.
function historyContentDigest(historyDir: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(resolve(historyDir)).filter((n) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(n)).sort()) {
    hash.update(name).update("\0").update(readFileSync(resolve(historyDir, name))).update("\0");
  }
  return hash.digest("hex");
}

interface SyncPermit { rowIds: Set<string> | null; error: string | null }

// Mirror invariants of mapped history rows against a DB row_id->row_hash map.
export function evaluateMirrorInvariants(mappedRows: readonly { row_id: string; row_hash: string }[], dbHashes: ReadonlyMap<string, string>, permit: SyncPermit): {
  dbOnlyRowCount: number; conflictRows: number; insertRowIds: string[]; unpermittedInsertRows: number; permitRowsNotInHistory: number;
} {
  const historyIds = new Set(mappedRows.map((row) => row.row_id));
  let conflictRows = 0; const insertRowIds: string[] = [];
  for (const row of mappedRows) {
    const existing = dbHashes.get(row.row_id);
    if (existing === undefined) insertRowIds.push(row.row_id);
    else if (existing !== row.row_hash) conflictRows += 1;
  }
  let dbOnlyRowCount = 0;
  for (const id of dbHashes.keys()) if (!historyIds.has(id)) dbOnlyRowCount += 1;
  const unpermittedInsertRows = permit.rowIds === null ? insertRowIds.length : insertRowIds.filter((id) => !permit.rowIds!.has(id)).length;
  const permitRowsNotInHistory = permit.rowIds === null ? 0 : [...permit.rowIds].filter((id) => !historyIds.has(id)).length;
  return { dbOnlyRowCount, conflictRows, insertRowIds, unpermittedInsertRows, permitRowsNotInHistory };
}

function readDbHashes(db: Database.Database): Map<string, string> {
  if (!tableExists(db, "market_signal_history")) return new Map();
  return new Map((db.prepare("SELECT row_id, row_hash FROM market_signal_history").all() as { row_id: string; row_hash: string }[]).map((r) => [r.row_id, r.row_hash]));
}

function readDbHashesReadOnly(dbPath: string): Map<string, string> {
  if (!existsSync(resolve(dbPath))) return new Map();
  const db = new Database(resolve(dbPath), { readonly: true, fileMustExist: true });
  try { return readDbHashes(db); } finally { db.close(); }
}

function mirrorExactMatch(mappedRows: readonly { row_id: string; row_hash: string }[], dbHashes: ReadonlyMap<string, string>): boolean {
  return dbHashes.size === mappedRows.length && mappedRows.every((row) => dbHashes.get(row.row_id) === row.row_hash);
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

// ---------------------------------------------------------------------------
// P0-G2 trusted append + mirror (TD private #13, design #6280295102).
//
// Every scheduled history writer (rotating, 09:00 live, pricing-critical own and
// competitor, booking-market-recrawl) calls this AFTER collection. The rows it
// INSERTs are the rows this process itself appended, taken from the history
// re-read under the same locks; nothing outside the process (file, env, CLI,
// backup, receipt) can widen that set.
//
// Lock order (fixed, every writer): history-writer lock -> DB BEGIN IMMEDIATE ->
// the append primitive's own lock (runRealAppend's .append.lock, which never
// waits). The history-writer lock is an EXCLUSIVE transaction on a dedicated
// SQLite file: an OS lock that the kernel releases when the holder exits or
// crashes, so a live writer's lock is never broken by age and a dead one never
// blocks the next run.

export type TrustedAppendStatus =
  | "MIRRORED" // appended W, DB == history exactly, committed
  | "NOTHING_TO_APPEND" // every row already in history with the same row_hash
  | "HISTORY_APPENDED_MIRROR_DISABLED" // DB == history but the mirror flag is off: append-only
  | "HISTORY_APPENDED_MIRROR_BLOCKED" // DB != history (confirmed): append-only, DB untouched
  | "HISTORY_APPEND_FAILED_MIRROR_BLOCKED" // the append threw (history may be partial); no DB change
  | "HISTORY_APPEND_UNVERIFIED_MIRROR_BLOCKED" // history after != before + W; no DB change
  | "MIRROR_FAILED_ROLLED_BACK" // post-sync validation/exact mirror failed; DB rolled back
  | "LOCK_BUSY_CAPTURE_PRESERVED" // history or DB writer lock not obtained: no append
  | "STATE_UNKNOWN_CAPTURE_PRESERVED" // history/DB could not be read: no append
  | "APPEND_CONFLICT_CAPTURE_PRESERVED" // a row_id already exists with another row_hash: no append
  | "APPEND_CAP_EXCEEDED_CAPTURE_PRESERVED" // more rows than the job's legal per-run cap: no append
  | "CAPTURE_FAILED_ROWS_UNSAVED"; // rows reached neither history nor the capture file (fatal; see unsaved_row_ids)

export interface TrustedAppendResult {
  status: TrustedAppendStatus;
  state: "consistent" | "inconsistent" | "unknown" | "not_evaluated";
  mirror_enabled: boolean;
  rows_requested: number;
  rows_skipped_identical: number;
  rows_appended: number;
  inserted_rows: number;
  history_rows_before: number | null;
  history_rows_after: number | null;
  db_rows_before: number | null;
  db_rows_after: number | null;
  mirror_exact_match: boolean;
  lock_wait_ms: number;
  capture_path: string | null;
  reasons: string[];
  // W: the row_ids this call actually appended and verified (empty otherwise).
  appended_row_ids: string[];
  // Rows that reached neither canonical history nor a verified capture file.
  unsaved_row_ids: string[];
}

export function isTrustedAppendCollected(result: TrustedAppendResult): boolean {
  return (TRUSTED_APPEND_COLLECTED_STATUSES as readonly string[]).includes(result.status);
}

// Outcomes in which this run's collected rows are now in canonical history
// (mirrored, already present, or appended with the DB mirror off/blocked).
export const TRUSTED_APPEND_COLLECTED_STATUSES: readonly TrustedAppendStatus[] = ["MIRRORED", "NOTHING_TO_APPEND", "HISTORY_APPENDED_MIRROR_DISABLED", "HISTORY_APPENDED_MIRROR_BLOCKED"];

// Only the rows of this run that were actually appended (e.g. for evidence).
export function rowsActuallyAppended<T extends { rowId: string }>(rows: readonly T[], result: TrustedAppendResult): T[] {
  const w = new Set(result.appended_row_ids);
  return rows.filter((row) => w.has(row.rowId));
}

// A job with several append parts (pricing-critical: competitor child process +
// own-property in-process) is a success only if every attempted part collected.
export function combineAppendOutcomes(parts: ReadonlyArray<{ name: string; attempted: boolean; exitCode?: number | null; status?: string | null }>): { ok: boolean; failed: string[] } {
  const failed = parts.filter((p) => p.attempted && (p.exitCode !== undefined && p.exitCode !== 0 || !(TRUSTED_APPEND_COLLECTED_STATUSES as readonly string[]).includes(String(p.status ?? "")))).map((p) => `${p.name}:${p.status ?? "unknown"}${p.exitCode === undefined ? "" : `(exit ${p.exitCode})`}`);
  return { ok: failed.length === 0, failed };
}

// Measured on the 70,051-row production snapshot (scratch copies, 2026-10-20):
// one locked append+mirror holds the history-writer lock 7.8-11.6 s (two full
// history reads, 63-row append/rebuild, insert, post-validation); a second
// writer started at the same time waited 9.7 s and then mirrored normally. At
// most two writers collide (rotating at even hours vs 09:00 live / 13:35
// pricing-critical / 14:35 recrawl), so 120 s is >10x the longest measured hold
// and far below every job's own period (2 h / 1 day).
export const HISTORY_WRITER_LOCK_WAIT_MS = 120_000;
export const TRUSTED_MIRROR_FLAG = "ZMI_TRUSTED_MIRROR_ENABLED";

export function historyWriterLockPath(historyDir: string): string {
  return join(dirname(resolve(historyDir)), "locks", "history_writer.lock.sqlite");
}

// True only for an explicit, verified mirror: the G3 positive-success rule for
// callers deciding on AI context refresh / publish.
export function isVerifiedTrustedMirror(result: TrustedAppendResult): boolean {
  return result.mirror_enabled && result.mirror_exact_match && (result.status === "MIRRORED" || (result.status === "NOTHING_TO_APPEND" && result.state === "consistent"));
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function rowWithoutSource(row: Record<string, string>): string {
  return JSON.stringify(Object.entries(row).filter(([k]) => k !== "__source_file").sort(([a], [b]) => a.localeCompare(b)));
}

export function trustedAppendAndMirror(input: {
  historyDir: string;
  dbPath: string;
  runId: string;
  generatedAtJst: string;
  rows: readonly HistoryRow[]; // in-memory rows this process collected and approved
  write: (rows: HistoryRow[]) => void; // the caller's real append primitive (injected; this module never writes history)
  mirrorEnabled: boolean; // default OFF: callers pass env[TRUSTED_MIRROR_FLAG] === "1"
  captureDir: string; // where unappended rows are preserved
  lockWaitMs?: number;
  // The calling job's legal per-run maximum (pages per run, one row per page),
  // clamped to SYNC_PERMIT_MAX_ROWS. More rows than this is refused unappended.
  maxRows: number;
  // "hold": take runRealAppend's legacy .append.lock around write() (callers
  // whose primitive has no lock of its own, so manual runRealAppend backs off);
  // "primitive": the write itself (runRealAppend) takes it.
  legacyAppendLock?: "hold" | "primitive";
  hooks?: { afterLock?: () => void; afterClassify?: () => void; afterShardParsed?: (file: string) => void; afterAppend?: () => void; beforeCommit?: () => void; afterCommit?: () => void } | undefined;
}): TrustedAppendResult {
  const waitMs = input.lockWaitMs ?? HISTORY_WRITER_LOCK_WAIT_MS;
  const result: TrustedAppendResult = {
    status: "NOTHING_TO_APPEND", state: "not_evaluated", mirror_enabled: input.mirrorEnabled, rows_requested: input.rows.length,
    rows_skipped_identical: 0, rows_appended: 0, inserted_rows: 0, history_rows_before: null, history_rows_after: null,
    db_rows_before: null, db_rows_after: null, mirror_exact_match: false, lock_wait_ms: 0, capture_path: null, reasons: [], appended_row_ids: [], unsaved_row_ids: []
  };
  // Saved only if the file is actually on disk and reads back with every row.
  const capture = (status: TrustedAppendStatus, reason: string, rows: readonly HistoryRow[]): boolean => {
    const path = resolve(input.captureDir, `trusted_append_unappended_${input.runId}.json`);
    try {
      mkdirSync(resolve(input.captureDir), { recursive: true });
      writeFileSync(`${path}.tmp`, `${JSON.stringify({ run_id: input.runId, status, reason, rows }, null, 2)}\n`, "utf8");
      renameSync(`${path}.tmp`, path);
      const back = JSON.parse(readFileSync(path, "utf8")) as { rows?: Array<{ rowId?: string }> };
      if (back.rows?.length !== rows.length || back.rows.some((r, i) => r.rowId !== rows[i]!.rowId)) throw new Error("capture read-back mismatch");
      result.capture_path = path;
      return true;
    } catch (error) {
      result.reasons.push(`capture not written: ${(error as Error).message}`);
      result.unsaved_row_ids.push(...rows.map((r) => r.rowId));
      return false;
    }
  };
  const preserve = (status: TrustedAppendStatus, reason: string, rows: readonly HistoryRow[]): TrustedAppendResult => {
    result.reasons.push(reason);
    // Never report "preserved" when nothing was saved: no history/DB fallback write.
    result.status = capture(status, reason, rows) ? status : "CAPTURE_FAILED_ROWS_UNSAVED";
    if (result.status !== status) result.reasons.push(`intended outcome ${status} not reached: rows unsaved`);
    return result;
  };
  if (input.rows.length === 0) return result;
  const cap = Math.min(Number.isInteger(input.maxRows) && input.maxRows > 0 ? input.maxRows : 0, SYNC_PERMIT_MAX_ROWS);
  if (input.rows.length > cap) return preserve("APPEND_CAP_EXCEEDED_CAPTURE_PRESERVED", `${input.rows.length} rows > per-run cap ${cap}`, input.rows);

  // 1. History-writer lock (after collection, before reading canonical state).
  const lockPath = historyWriterLockPath(input.historyDir);
  mkdirSync(dirname(lockPath), { recursive: true });
  const lock = new Database(lockPath);
  const t0 = Date.now();
  try {
    lock.pragma(`busy_timeout = ${waitMs}`);
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    result.lock_wait_ms = Date.now() - t0;
    if (isBusy(error)) return preserve("LOCK_BUSY_CAPTURE_PRESERVED", "history writer lock busy", input.rows);
    return preserve("STATE_UNKNOWN_CAPTURE_PRESERVED", `history writer lock error: ${(error as Error).message}`, input.rows);
  }
  result.lock_wait_ms = Date.now() - t0;
  let db: ReturnType<typeof openLocalDatabase> | null = null;
  try {
    input.hooks?.afterLock?.();
    // 2. Classify under the lock: read history (G1 single-pass bytes) and DB.
    let before: LoadedHistory;
    let dbHashes: Map<string, string>;
    try {
      before = loadHistoryRows(input.historyDir, input.hooks?.afterShardParsed);
      dbHashes = readDbHashesReadOnly(input.dbPath);
    } catch (error) {
      result.state = "unknown";
      return preserve("STATE_UNKNOWN_CAPTURE_PRESERVED", `history/DB read failed: ${(error as Error).message}`, input.rows);
    }
    const mappedBefore = before.loadedRows.map((e) => mapHistoryRowToMarketSignalHistoryRow(e.row, input.generatedAtJst));
    const beforeById = new Map(before.loadedRows.map((e) => [e.row["row_id"] ?? "", e.row]));
    const historyDuplicates = beforeById.size !== before.loadedRows.length;
    result.history_rows_before = before.loadedRows.length;
    result.db_rows_before = dbHashes.size;
    result.state = !historyDuplicates && mirrorExactMatch(mappedBefore, dbHashes) ? "consistent" : "inconsistent";
    if (result.state === "inconsistent") result.reasons.push(historyDuplicates ? "history has duplicate row_ids" : "DB is not an exact mirror of history (mirror blocked; no backfill)");

    // 3. Point-of-use plan against canonical history.
    const toWrite: HistoryRow[] = [];
    for (const row of input.rows) {
      const existing = beforeById.get(row.rowId);
      if (existing === undefined) toWrite.push(row);
      else if (existing["row_hash"] === row.rowHash) result.rows_skipped_identical += 1;
      else return preserve("APPEND_CONFLICT_CAPTURE_PRESERVED", `row_id ${row.rowId} already in history with another row_hash`, input.rows);
    }
    if (new Set(toWrite.map((r) => r.rowId)).size !== toWrite.length) return preserve("APPEND_CONFLICT_CAPTURE_PRESERVED", "duplicate row_ids in this run's rows", input.rows);
    if (toWrite.length === 0) {
      result.mirror_exact_match = result.state === "consistent";
      result.history_rows_after = result.history_rows_before;
      result.db_rows_after = result.db_rows_before;
      return result; // NOTHING_TO_APPEND
    }

    input.hooks?.afterClassify?.();
    // Legacy .append.lock (manual / runRealAppend writers outside this lock): any
    // existing one is a busy writer, whatever its age or recorded pid. It is
    // never removed automatically (a check-then-delete could remove a lock that
    // another process replaced in between); an operator inspects and removes it.
    const appendLockPath = join(resolve(input.historyDir), APPEND_LOCK_FILENAME);
    if (existsSync(appendLockPath)) return preserve("LOCK_BUSY_CAPTURE_PRESERVED", `${APPEND_LOCK_FILENAME} present (${describeLegacyLock(appendLockPath)}); operator must inspect and remove`, input.rows);

    // 4. Normal mode takes the DB writer lock BEFORE appending: if it cannot be
    //    had, canonical history is not touched.
    const normal = result.state === "consistent" && input.mirrorEnabled;
    if (normal) {
      db = openLocalDatabase(input.dbPath);
      db.pragma(`busy_timeout = ${Math.max(0, waitMs - result.lock_wait_ms)}`);
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (isBusy(error)) return preserve("LOCK_BUSY_CAPTURE_PRESERVED", "DB writer lock busy", input.rows);
        throw error;
      }
      const dbNow = readDbHashes(db);
      if (dbNow.size !== dbHashes.size || [...dbHashes].some(([id, h]) => dbNow.get(id) !== h)) {
        return preserve("STATE_UNKNOWN_CAPTURE_PRESERVED", "DB changed between classification and write lock", input.rows);
      }
    }

    // 5. The real append, in this process.
    let appendError: Error | null = null;
    const holdLegacy = (input.legacyAppendLock ?? "primitive") === "hold";
    const ownLock = `${input.runId}\n${new Date().toISOString()}\npid=${process.pid}\nhost=${hostname()}\n`;
    if (holdLegacy) {
      try {
        writeFileSync(appendLockPath, ownLock, { encoding: "utf8", flag: "wx" });
      } catch {
        return preserve("LOCK_BUSY_CAPTURE_PRESERVED", `${APPEND_LOCK_FILENAME} taken by another writer`, input.rows);
      }
    }
    try {
      input.write(toWrite);
    } catch (error) {
      appendError = error as Error;
    } finally {
      // Remove only our own lock (byte-identical content).
      if (holdLegacy && existsSync(appendLockPath) && readFileSync(appendLockPath, "utf8") === ownLock) rmSync(appendLockPath, { force: true });
    }
    input.hooks?.afterAppend?.();

    // 6. Derive W from canonical history before/after, never from the writer's claims.
    const after = loadHistoryRows(input.historyDir);
    result.history_rows_after = after.loadedRows.length;
    const intended = new Map(toWrite.map((r) => [r.rowId, r.rowHash]));
    const afterById = new Map<string, Record<string, string>>();
    const problems: string[] = [];
    for (const e of after.loadedRows) {
      const id = e.row["row_id"] ?? "";
      if (afterById.has(id)) problems.push(`duplicate row_id after append: ${id}`);
      afterById.set(id, e.row);
    }
    for (const [id, row] of beforeById) {
      const now = afterById.get(id);
      if (now === undefined) problems.push(`existing row removed: ${id}`);
      else if (rowWithoutSource(now) !== rowWithoutSource(row)) problems.push(`existing row changed: ${id}`);
    }
    const appended: string[] = [];
    const intendedRecord = new Map(toWrite.map((r) => [r.rowId, r]));
    for (const [id, row] of afterById) {
      if (beforeById.has(id)) continue;
      if (intended.get(id) !== row["row_hash"]) problems.push(`unexpected row appended: ${id}`);
      else if (rowWithoutSource(row) !== rowWithoutSource(parsedHistoryRecord(intendedRecord.get(id)!))) problems.push(`appended row differs from the intended 45 columns: ${id}`);
      else appended.push(id);
    }
    result.rows_appended = appended.length;
    if (appendError === null && appended.length !== toWrite.length) problems.push(`${toWrite.length - appended.length} intended rows missing after append`);
    if (appendError !== null) {
      result.reasons.push(`append failed: ${appendError.message}`, ...problems.slice(0, 5));
      result.status = "HISTORY_APPEND_FAILED_MIRROR_BLOCKED";
      result.appended_row_ids = appended;
      const landed = new Set(appended);
      capture(result.status, `append failed: ${appendError.message}`, toWrite.filter((r) => !landed.has(r.rowId))); // rows that did not reach history
      return result;
    }
    if (problems.length > 0) {
      result.reasons.push(...problems.slice(0, 10));
      result.status = "HISTORY_APPEND_UNVERIFIED_MIRROR_BLOCKED";
      // Intended rows that did not land (e.g. a writer that returned without
      // writing all of W) are preserved; nothing here reports success.
      const landed = new Set(appended);
      const missing = toWrite.filter((r) => !landed.has(r.rowId));
      if (missing.length > 0) capture(result.status, "intended rows missing after append", missing);
      return result;
    }
    result.appended_row_ids = appended; // verified W (history side)
    if (!normal) {
      result.status = result.state === "consistent" ? "HISTORY_APPENDED_MIRROR_DISABLED" : "HISTORY_APPENDED_MIRROR_BLOCKED";
      if (result.state === "consistent") result.reasons.push(`${TRUSTED_MIRROR_FLAG} is not 1 (default OFF)`);
      return result;
    }

    // 7. Mirror exactly W inside the open DB transaction, validate, commit.
    const d = db!;
    const mappedAfter = after.loadedRows.map((e) => mapHistoryRowToMarketSignalHistoryRow(e.row, input.generatedAtJst));
    const appendedSet = new Set(appended);
    let sync: RealSyncResult; let validation: PostSyncValidation; let exact: boolean;
    try {
      const collectorBaselineBefore = readCollectorBaseline(d);
      ensureMirrorSchema(d);
      sync = applyRealSync({ db: d, runId: input.runId, generatedAtJst: input.generatedAtJst, reportPath: "", sourceHistoryFiles: after.files, rows: mappedAfter.filter((r) => appendedSet.has(r.row_id)) });
      validation = validatePostSync({ db: d, sourceRows: mappedAfter, syncRunId: sync.sync_run_record.sync_run_id, collectorBaselineBefore, historyMtimesUnchanged: historyContentDigest(input.historyDir) === after.contentDigest });
      exact = mirrorExactMatch(mappedAfter, readDbHashes(d));
    } catch (error) {
      d.exec("ROLLBACK");
      result.reasons.push(`mirror failed inside the transaction: ${(error as Error).message}`);
      result.status = "MIRROR_FAILED_ROLLED_BACK";
      return result;
    }
    if (sync.conflict_rows > 0 || sync.inserted_rows !== appended.length || !validation.passed || !exact) {
      d.exec("ROLLBACK");
      result.reasons.push(...validation.errors, ...(exact ? [] : ["DB is not an exact mirror after insert"]));
      result.status = "MIRROR_FAILED_ROLLED_BACK";
      return result;
    }
    input.hooks?.beforeCommit?.();
    d.exec("COMMIT");
    input.hooks?.afterCommit?.();
    result.inserted_rows = sync.inserted_rows;
    result.status = "MIRRORED";
    // Re-read after commit (still under the history-writer lock) for the report.
    result.mirror_exact_match = mirrorExactMatch(mappedAfter, readDbHashesReadOnly(input.dbPath));
    result.db_rows_after = mappedAfter.length;
    return result;
  } finally {
    if (db !== null) {
      if (db.inTransaction) db.exec("ROLLBACK");
      closeDatabase(db);
    }
    if (result.db_rows_after === null && result.db_rows_before !== null) {
      try { result.db_rows_after = readDbHashesReadOnly(input.dbPath).size; } catch { /* report only */ }
    }
    try { lock.exec("ROLLBACK"); } catch { /* already released */ }
    lock.close();
  }
}

// The intended row as the canonical CSV renderer writes it, parsed back: a
// value-level (not byte/quoting-level) view of all 45 columns.
function parsedHistoryRecord(row: HistoryRow): Record<string, string> {
  return parseCsvTable(renderHistoryCsv([row])).rows[0] ?? {};
}

function describeLegacyLock(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    const pid = /^pid=(\d+)$/mu.exec(text)?.[1];
    const ageMin = Math.round((Date.now() - statSync(path).mtimeMs) / 60000);
    return `${(text.split("\n", 1)[0] ?? "").slice(0, 80)}${pid === undefined ? ", no pid" : `, pid ${pid}`}, ${ageMin} min old`;
  } catch {
    return "unreadable";
  }
}
