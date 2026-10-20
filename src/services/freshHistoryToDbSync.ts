// Phase AUTO-RUNNER07C - fresh history-to-DB sync helper.
//
// This service builds a fresh mapping from the current history shards on every
// run. It writes the DB only when HISTORY_TO_DB_SYNC=1 is supplied by the caller.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { MAX_TOTAL_LIVE_PAGES, type AppendReceipt } from "./autoRunnerMarketRefresh";
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
  historyToDbSyncGate: string | undefined;
  expectedHistoryRowCount: string | undefined;
  // AppendReceipt JSON produced by this run's history append. Required
  // whenever the write gate is on; verified by verifyAppendReceipt.
  appendReceiptPath?: string | undefined;
  sourceAutoRunner07bArtifact: string;
  // Fault-injection seam for tests only: runs after the gate is evaluated and
  // before the writer connection is opened.
  testHooks?: { afterGateEvaluated?: () => void; afterShardParsed?: (file: string) => void } | undefined;
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
  const history = loadHistoryRows(options.historyDir, options.testHooks?.afterShardParsed);
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
  const permit = verifyAppendReceipt(options.appendReceiptPath, history, options.historyDir, Date.now());
  const gateInput = {
    envFlag: options.historyToDbSyncGate,
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
    options.testHooks?.afterGateEvaluated?.();
    const db = openLocalDatabase(options.dbPath);
    try {
      // Shared writer protocol: both natural callers (rotating, 09:00 live) go
      // through this helper. BEGIN IMMEDIATE takes SQLite's cross-process write
      // lock (released on crash); busy_timeout 0 makes a held lock a refusal.
      // Under the lock the gate is re-evaluated on fresh history bytes and a
      // fresh DB read BEFORE any DDL, sync_run record or INSERT.
      db.pragma("busy_timeout = 0");
      const write = db.transaction(() => {
        const freshReasons: string[] = [];
        // history.contentDigest was computed from the exact bytes that were
        // parsed into mappedRows; a re-read that differs means mappedRows is stale.
        if (historyContentDigest(options.historyDir) !== history.contentDigest) freshReasons.push("history changed between gate evaluation and write");
        const freshPermit = verifyAppendReceipt(options.appendReceiptPath, history, options.historyDir, Date.now());
        const fresh = evaluateFreshSyncGate({ ...gateInput, permit: freshPermit, invariants: evaluateMirrorInvariants(mappedRows, readDbHashes(db), freshPermit), historyCount: history.loadedRows.length, mapping: freshMappingSummary });
        freshReasons.push(...fresh.reasons);
        if (fresh.would_insert_rows !== gate.would_insert_rows) freshReasons.push(`insert set changed since gate (${gate.would_insert_rows} -> ${fresh.would_insert_rows})`);
        if (freshReasons.length > 0) throw new SyncRefusedAtPointOfUse(freshReasons);
        collectorBaselineBefore = readCollectorBaseline(db);
        const schema = ensureMirrorSchema(db);
        const result = applyRealSync({
          db,
          runId: options.runId,
          generatedAtJst: options.generatedAtJst,
          reportPath: options.reportPath,
          sourceHistoryFiles: history.files,
          rows: mappedRows
        });
        const validation = validatePostSync({
          db,
          sourceRows: mappedRows,
          syncRunId: result.sync_run_record.sync_run_id,
          collectorBaselineBefore,
          historyMtimesUnchanged: historyContentDigest(options.historyDir) === history.contentDigest
        });
        // Roll the whole write back unless the mirror is exact afterwards.
        if (result.conflict_rows > 0 || !validation.passed || !mirrorExactMatch(mappedRows, readDbHashes(db))) throw new PostSyncValidationFailed(validation, result, schema);
        return { schema, result, validation };
      });
      try {
        const done = write.immediate();
        schemaPreflight = done.schema;
        syncResult = done.result;
        syncActions = done.result.actions;
        postSyncValidation = done.validation;
        decision = done.result.inserted_rows === 0 && done.result.skipped_identical_rows === mappedRows.length ? "fresh_history_to_db_sync_noop" : "fresh_history_to_db_sync_success";
      } catch (error) {
        if (error instanceof SyncRefusedAtPointOfUse) {
          gate.passed = false;
          gate.point_of_use_reasons = error.reasons;
          decision = "fresh_history_to_db_sync_ready_not_run";
        } else if (error instanceof PostSyncValidationFailed) {
          postSyncValidation = error.validation;
          decision = error.result.conflict_rows > 0 ? "fresh_history_to_db_sync_conflict" : "fresh_history_to_db_sync_failed";
        } else if ((error as { code?: string }).code === "SQLITE_BUSY") {
          gate.passed = false;
          gate.point_of_use_reasons = ["DB write lock held by another writer"];
          decision = "fresh_history_to_db_sync_ready_not_run";
        } else {
          throw error;
        }
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
    mirror_exact_match: mirrorExactMatch(mappedRows, readDbHashesReadOnly(options.dbPath)),
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
  if (input.envFlag === "1" && input.permit.rowIds === null && input.permit.error === null) reasons.push("HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH not set; writes require this run's verified append receipt");
  if (input.permit.error !== null) reasons.push(input.permit.error);
  if (permitRows !== null && permitRows > SYNC_PERMIT_MAX_ROWS) reasons.push(`append receipt lists ${permitRows} rows > per-run cap ${SYNC_PERMIT_MAX_ROWS}`);
  if (inv.permitRowsNotInHistory > 0) reasons.push(`append receipt lists ${inv.permitRowsNotInHistory} row_ids absent from history`);
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

export const APPEND_RECEIPT_MAX_AGE_MS = 30 * 60 * 1000;

// Turns this run's AppendReceipt into the set of row_ids it may mirror, but only
// if every claim is independently confirmed: the receipt is the canonical one
// for <historyDir>/.backup/<run_id>; each shard's .bak backup has the recorded
// "before" bytes; the bytes parsed into mappedRows are exactly "before" + the
// appended records; those records are exactly the receipt rows (row_id and
// row_hash); and the append happened within APPEND_RECEIPT_MAX_AGE_MS. A forged,
// copied or replayed receipt (shard appended since, or too old) yields no rows.
export function verifyAppendReceipt(path: string | undefined, history: Pick<LoadedHistory, "shards">, historyDir: string, nowMs: number): SyncPermit {
  if (path === undefined || path === "") return { rowIds: null, error: null };
  const fail = (why: string): SyncPermit => ({ rowIds: null, error: `append receipt rejected: ${why}` });
  let receipt: AppendReceipt;
  try { receipt = JSON.parse(readFileSync(resolve(path), "utf8")) as AppendReceipt; } catch { return fail("unreadable"); }
  if (receipt?.version !== 1 || typeof receipt.run_id !== "string" || !/^[A-Za-z0-9_.-]+$/u.test(receipt.run_id) || receipt.run_id.startsWith(".")) return fail("bad version or run_id");
  if (!Array.isArray(receipt.shards) || receipt.shards.length === 0 || !Array.isArray(receipt.rows) || receipt.rows.length === 0) return fail("no shards or rows");
  if (receipt.rows.length > SYNC_PERMIT_MAX_ROWS) return fail(`${receipt.rows.length} rows > per-run cap ${SYNC_PERMIT_MAX_ROWS}`);
  const ids = new Set(receipt.rows.map((r) => r.row_id));
  if (ids.size !== receipt.rows.length) return fail("duplicate row_ids");
  const backupDir = resolve(historyDir, ".backup", receipt.run_id);
  if (!existsSync(backupDir)) return fail(`no backup directory for run ${receipt.run_id}`);
  const loaded = new Map(history.shards.map((s) => [s.name, s]));
  const shardNames = new Set(receipt.shards.map((s) => s.file));
  if (receipt.rows.some((r) => !shardNames.has(r.shard_file))) return fail("row in an undeclared shard");
  const isSize = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v);
  for (const shard of receipt.shards) {
    // Malformed sizes/hashes must never fall through to the new-shard branch.
    if (!isSize(shard.before_size) || !isSize(shard.after_size) || !isSha(shard.before_sha256) || !isSha(shard.after_sha256) || shard.after_size <= shard.before_size) return fail(`${String(shard.file)} has invalid sizes or hashes`);
    const current = loaded.get(shard.file);
    if (current === undefined || !/^zao_signals_\d{4}_\d{2}\.csv$/u.test(shard.file)) return fail(`shard ${shard.file} not in history`);
    if (current.sha256 !== shard.after_sha256 || current.bytes.length !== shard.after_size) return fail(`${shard.file} changed after this append (stale or forged)`);
    const shardMtime = statSync(resolve(historyDir, shard.file)).mtimeMs;
    // The pre-append state is always proven from the producer's .bak, also for
    // before_size=0 (a new shard leaves an empty .bak): a missing backup is
    // never evidence of a new shard, and a real non-empty backup cannot be
    // claimed away by a receipt that says before_size=0.
    const bakPath = join(backupDir, `${shard.file}.bak`);
    if (!existsSync(bakPath)) return fail(`missing backup ${shard.file}.bak`);
    const bak = readFileSync(bakPath);
    if (bak.length !== shard.before_size || sha256Hex(bak) !== shard.before_sha256) return fail(`backup ${shard.file}.bak does not match the receipt's before state`);
    if (sha256Hex(current.bytes.subarray(0, shard.before_size)) !== shard.before_sha256) return fail(`${shard.file} is not an append to its backup`);
    const bakAge = nowMs - statSync(bakPath).mtimeMs;
    if (bakAge > APPEND_RECEIPT_MAX_AGE_MS || bakAge < -60_000) return fail(`backup ${shard.file}.bak is not from a current append`);
    let deltaText: string;
    if (shard.before_size > 0) {
      const header = current.bytes.toString("utf8").split(/\r?\n/u, 1)[0] ?? "";
      deltaText = `${header}\n${current.bytes.subarray(shard.before_size).toString("utf8")}`;
    } else {
      // A new shard must not have had content backed up by any other run.
      const backupRoot = resolve(historyDir, ".backup");
      const prior = readdirSync(backupRoot).find((run) => run !== receipt.run_id && existsSync(join(backupRoot, run, `${shard.file}.bak`)) && statSync(join(backupRoot, run, `${shard.file}.bak`)).size > 0);
      if (prior !== undefined) return fail(`${shard.file} claims to be new but run ${prior} backed up earlier content`);
      deltaText = current.bytes.toString("utf8"); // new shard: everything below the header was appended
    }
    const shardAge = nowMs - shardMtime;
    if (shardAge > APPEND_RECEIPT_MAX_AGE_MS || shardAge < -60_000) return fail(`${shard.file} was not written by a current append`);
    const appended = parseCsvTable(deltaText).rows.map((row) => `${row["row_id"]}\u0000${row["row_hash"]}`).sort();
    const claimed = receipt.rows.filter((r) => r.shard_file === shard.file).map((r) => `${r.row_id}\u0000${r.row_hash}`).sort();
    if (appended.length !== claimed.length || appended.some((v, i) => v !== claimed[i])) return fail(`${shard.file} appended records do not match the receipt rows`);
  }
  return { rowIds: ids, error: null };
}

export function writeAppendReceipt(path: string, receipt: AppendReceipt): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

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

class SyncRefusedAtPointOfUse extends Error {
  constructor(readonly reasons: string[]) { super(reasons.join("; ")); }
}
class PostSyncValidationFailed extends Error {
  constructor(readonly validation: PostSyncValidation, readonly result: RealSyncResult, readonly schema: DbSchemaPreflight) { super("post-sync validation failed"); }
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
