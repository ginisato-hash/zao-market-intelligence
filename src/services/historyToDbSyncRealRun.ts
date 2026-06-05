// Phase AUTO04X — first guarded DB mirror sync real run.
//
// Approved scope only: market_signal_history and market_signal_sync_runs.
// No collector table writes, no collectors, no external fetch, no history or
// property master mutation, and no PMS/channel output.

import type { LocalDatabase } from "../db/client";
import type {
  DedupeSummary,
  MarketSignalHistoryDryRunRow,
  SyncActionRecord,
  SyncRunPreview
} from "./historyToDbSyncDryRun";

export type HistoryToDbSyncDecision =
  | "history_to_db_sync_ready_not_run"
  | "history_to_db_sync_success"
  | "history_to_db_sync_failed_preflight"
  | "history_to_db_sync_failed_conflicts"
  | "history_to_db_sync_failed_db_error"
  | "history_to_db_sync_failed_validation";

export interface DryRunSourceSummary {
  decision: string;
  mapped_row_count: number;
  dedupe_summary: DedupeSummary;
}

export interface ApprovalGateInput {
  explicitUserApproved: boolean;
  envFlag: string | undefined;
  dryRun: DryRunSourceSummary | null;
  targetTables: string[];
  collectorTableWriteMode: boolean;
  liveCollectorMode: boolean;
  githubActionsMode: boolean;
}

export interface ApprovalGateResult {
  passed: boolean;
  decision: HistoryToDbSyncDecision;
  reasons: string[];
  explicitUserApproved: boolean;
  envFlagPresent: boolean;
  targetTables: string[];
}

export interface DbSchemaPreflight {
  target_tables: string[];
  tables_existed_before: Record<string, boolean>;
  tables_exist_after: Record<string, boolean>;
  schema_created_or_verified: boolean;
  indexes_created_or_verified: string[];
}

export interface RealSyncResult {
  inserted_rows: number;
  skipped_identical_rows: number;
  conflict_rows: number;
  actions: SyncActionRecord[];
  conflicts: SyncActionRecord[];
  sync_run_record: SyncRunRecord;
}

export interface SyncRunRecord {
  sync_run_id: string;
  started_at: string;
  finished_at: string;
  status: string;
  source_history_files: string;
  input_rows: number;
  inserted_rows: number;
  skipped_identical_rows: number;
  conflict_rows: number;
  error_message: string;
  report_path: string;
  created_at: string;
}

export interface CollectorBaseline {
  collector_runs_count: number;
  rate_snapshots_count: number;
  inventory_snapshots_count: number;
  collection_job_attempts_count: number;
}

export interface PostSyncValidation {
  passed: boolean;
  errors: string[];
  market_signal_history_count: number;
  all_source_row_ids_exist: boolean;
  all_row_hashes_match: boolean;
  duplicate_row_id_count: number;
  sync_run_record_exists: boolean;
  source_counts: Record<string, number>;
  dp_usage_counts: Record<string, number>;
  basis_confidence_counts: Record<string, number>;
  collector_baseline_before: CollectorBaseline;
  collector_baseline_after: CollectorBaseline;
  collector_baseline_unchanged: boolean;
  history_mtimes_unchanged: boolean;
}

export interface HistoryToDbSyncRealRunReport {
  run_id: string;
  generated_at_jst: string;
  decision: HistoryToDbSyncDecision;
  explicit_approval_result: ApprovalGateResult;
  source_auto03x_artifact: string;
  db_schema_handling: DbSchemaPreflight | null;
  sync_actions: SyncActionRecord[];
  inserted_rows: number;
  skipped_identical_rows: number;
  conflict_rows: number;
  sync_run_record: SyncRunRecord | null;
  post_sync_validation: PostSyncValidation | null;
  idempotency_check: {
    expected_next_inserted_rows: number;
    expected_next_skipped_identical_rows: number;
    expected_next_conflict_rows: number;
    note: string;
  };
  safety_confirmation: Record<string, boolean>;
  report_path: string;
  json_path: string;
  csv_path: string;
  debug_artifact_path: string;
}

export const APPROVED_TARGET_TABLES = ["market_signal_history", "market_signal_sync_runs"] as const;

// Approved mapped-row-count pin for the dry-run that feeds this real sync.
// AUTO04X originally pinned this at 145 (pre-AUTO08X history). The interim
// AUTO08B pin of 261 reflected a planned sold-out append that is NOT present in
// the current .data/history. Phase BOOKING-B07B repinned to 160. Phase
// BOOKING-B11B repinned to 185 (160 prior baseline + 25 approved Booking B11X rows).
// Phase JALAN-AUTO05B repins this to 210 to match the fresh dry-run regenerated
// from the current 210-row history (185 prior baseline + 25 approved Jalan AUTO05X
// rows). Bumping this is a deliberate, reviewed safety decision; the gate still
// blocks any dry-run whose mapped row count differs from this pin.
export const APPROVED_MAPPED_ROW_COUNT = 210;

export function evaluateApprovalGate(input: ApprovalGateInput): ApprovalGateResult {
  const reasons: string[] = [];
  if (!input.explicitUserApproved) reasons.push("explicit approval sentence missing");
  if (input.envFlag !== "1") reasons.push("HISTORY_TO_DB_SYNC env flag is not 1");
  if (input.dryRun === null) reasons.push("AUTO03X dry-run artifact missing");
  if (input.dryRun !== null && input.dryRun.decision !== "history_to_db_sync_dry_run_ready") reasons.push("AUTO03X dry-run is not ready");
  if (input.dryRun !== null && input.dryRun.dedupe_summary.would_conflict_rows !== 0) reasons.push("AUTO03X dry-run has conflicts");
  if (input.dryRun !== null && input.dryRun.mapped_row_count !== APPROVED_MAPPED_ROW_COUNT)
    reasons.push(`AUTO03X mapped row count is not ${APPROVED_MAPPED_ROW_COUNT}`);
  const unexpectedTargets = input.targetTables.filter((table) => !APPROVED_TARGET_TABLES.includes(table as (typeof APPROVED_TARGET_TABLES)[number]));
  if (unexpectedTargets.length > 0) reasons.push(`unexpected target tables: ${unexpectedTargets.join(",")}`);
  if (input.collectorTableWriteMode) reasons.push("collector table write mode is not allowed");
  if (input.liveCollectorMode) reasons.push("live collector mode is not allowed");
  if (input.githubActionsMode) reasons.push("GitHub Actions mode is not allowed");
  return {
    passed: reasons.length === 0,
    decision: reasons.length === 0 ? "history_to_db_sync_success" : "history_to_db_sync_ready_not_run",
    reasons,
    explicitUserApproved: input.explicitUserApproved,
    envFlagPresent: input.envFlag === "1",
    targetTables: input.targetTables
  };
}

export function schemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS market_signal_history (
      row_id TEXT PRIMARY KEY,
      row_hash TEXT NOT NULL,
      shard_month TEXT NOT NULL,
      collected_date_jst TEXT,
      collected_at_jst TEXT,
      normalized_at_jst TEXT,
      source TEXT NOT NULL,
      canonical_property_name TEXT,
      source_property_id TEXT,
      source_url TEXT,
      checkin_date TEXT,
      checkout_date TEXT,
      stay_scope TEXT,
      availability_status TEXT,
      sold_out_flag INTEGER,
      normalized_total_jpy INTEGER,
      price_basis TEXT,
      basis_confidence TEXT,
      dp_usage TEXT,
      classification TEXT,
      exclusion_reason TEXT,
      debug_artifact_path TEXT,
      schema_version TEXT,
      raw_json TEXT,
      created_at TEXT,
      updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS market_signal_sync_runs (
      sync_run_id TEXT PRIMARY KEY,
      started_at TEXT,
      finished_at TEXT,
      status TEXT,
      source_history_files TEXT,
      input_rows INTEGER,
      inserted_rows INTEGER,
      skipped_identical_rows INTEGER,
      conflict_rows INTEGER,
      error_message TEXT,
      report_path TEXT,
      created_at TEXT
    )`,
    "CREATE INDEX IF NOT EXISTS idx_market_signal_history_row_hash ON market_signal_history(row_hash)",
    "CREATE INDEX IF NOT EXISTS idx_market_signal_history_checkin_date ON market_signal_history(checkin_date)",
    "CREATE INDEX IF NOT EXISTS idx_market_signal_history_source ON market_signal_history(source)",
    "CREATE INDEX IF NOT EXISTS idx_market_signal_history_property ON market_signal_history(canonical_property_name)",
    "CREATE INDEX IF NOT EXISTS idx_market_signal_history_dp_usage ON market_signal_history(dp_usage)",
    "CREATE INDEX IF NOT EXISTS idx_market_signal_history_basis_confidence ON market_signal_history(basis_confidence)",
    "CREATE INDEX IF NOT EXISTS idx_market_signal_history_availability ON market_signal_history(availability_status)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_market_signal_history_row_id_hash ON market_signal_history(row_id, row_hash)"
  ];
}

export function ensureMirrorSchema(db: LocalDatabase): DbSchemaPreflight {
  const before = Object.fromEntries(APPROVED_TARGET_TABLES.map((table) => [table, tableExists(db, table)]));
  for (const sql of schemaStatements()) db.exec(sql);
  const after = Object.fromEntries(APPROVED_TARGET_TABLES.map((table) => [table, tableExists(db, table)]));
  return {
    target_tables: [...APPROVED_TARGET_TABLES],
    tables_existed_before: before,
    tables_exist_after: after,
    schema_created_or_verified: Object.values(after).every(Boolean),
    indexes_created_or_verified: [
      "idx_market_signal_history_row_hash",
      "idx_market_signal_history_checkin_date",
      "idx_market_signal_history_source",
      "idx_market_signal_history_property",
      "idx_market_signal_history_dp_usage",
      "idx_market_signal_history_basis_confidence",
      "idx_market_signal_history_availability",
      "uq_market_signal_history_row_id_hash"
    ]
  };
}

export function preflightSyncActions(runId: string, db: LocalDatabase, rows: MarketSignalHistoryDryRunRow[]): {
  actions: SyncActionRecord[];
  inserted: MarketSignalHistoryDryRunRow[];
  skipped: MarketSignalHistoryDryRunRow[];
  conflicts: SyncActionRecord[];
} {
  const existing = new Map<string, string>();
  for (const row of db.prepare("SELECT row_id, row_hash FROM market_signal_history").all() as { row_id: string; row_hash: string }[]) {
    existing.set(row.row_id, row.row_hash);
  }
  const actions: SyncActionRecord[] = [];
  const inserted: MarketSignalHistoryDryRunRow[] = [];
  const skipped: MarketSignalHistoryDryRunRow[] = [];
  const conflicts: SyncActionRecord[] = [];
  for (const row of rows) {
    const existingHash = existing.get(row.row_id);
    let action: SyncActionRecord["action"];
    let reason: string;
    if (existingHash === undefined) {
      action = "would_insert";
      reason = "new_row_id";
      inserted.push(row);
    } else if (existingHash === row.row_hash) {
      action = "would_skip_identical";
      reason = "same_row_id_same_row_hash";
      skipped.push(row);
    } else {
      action = "would_conflict_block";
      reason = `existing_hash=${existingHash};incoming_hash=${row.row_hash}`;
    }
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
    if (action === "would_conflict_block") conflicts.push(record);
  }
  return { actions, inserted, skipped, conflicts };
}

export function applyRealSync(input: {
  db: LocalDatabase;
  runId: string;
  generatedAtJst: string;
  reportPath: string;
  sourceHistoryFiles: string[];
  rows: MarketSignalHistoryDryRunRow[];
}): RealSyncResult {
  const preflight = preflightSyncActions(input.runId, input.db, input.rows);
  if (preflight.conflicts.length > 0) {
    const record = syncRunRecord(input, 0, preflight.skipped.length, preflight.conflicts.length, "failed_conflicts", "row_id/row_hash conflicts detected");
    input.db.prepare(
      `INSERT INTO market_signal_sync_runs (
        sync_run_id, started_at, finished_at, status, source_history_files, input_rows, inserted_rows,
        skipped_identical_rows, conflict_rows, error_message, report_path, created_at
      ) VALUES (
        @sync_run_id, @started_at, @finished_at, @status, @source_history_files, @input_rows, @inserted_rows,
        @skipped_identical_rows, @conflict_rows, @error_message, @report_path, @created_at
      )`
    ).run(record);
    return {
      inserted_rows: 0,
      skipped_identical_rows: preflight.skipped.length,
      conflict_rows: preflight.conflicts.length,
      actions: preflight.actions,
      conflicts: preflight.conflicts,
      sync_run_record: record
    };
  }

  const record = syncRunRecord(input, preflight.inserted.length, preflight.skipped.length, 0, "success", "");
  const work = input.db.transaction(() => {
    const insert = input.db.prepare(
      `INSERT INTO market_signal_history (
        row_id, row_hash, shard_month, collected_date_jst, collected_at_jst, normalized_at_jst,
        source, canonical_property_name, source_property_id, source_url, checkin_date, checkout_date,
        stay_scope, availability_status, sold_out_flag, normalized_total_jpy, price_basis, basis_confidence,
        dp_usage, classification, exclusion_reason, debug_artifact_path, schema_version, raw_json, created_at, updated_at
      ) VALUES (
        @row_id, @row_hash, @shard_month, @collected_date_jst, @collected_at_jst, @normalized_at_jst,
        @source, @canonical_property_name, @source_property_id, @source_url, @checkin_date, @checkout_date,
        @stay_scope, @availability_status, @sold_out_flag, @normalized_total_jpy, @price_basis, @basis_confidence,
        @dp_usage, @classification, @exclusion_reason, @debug_artifact_path, @schema_version, @raw_json, @created_at, @updated_at
      )`
    );
    for (const row of preflight.inserted) insert.run(row);
    input.db.prepare(
      `INSERT INTO market_signal_sync_runs (
        sync_run_id, started_at, finished_at, status, source_history_files, input_rows, inserted_rows,
        skipped_identical_rows, conflict_rows, error_message, report_path, created_at
      ) VALUES (
        @sync_run_id, @started_at, @finished_at, @status, @source_history_files, @input_rows, @inserted_rows,
        @skipped_identical_rows, @conflict_rows, @error_message, @report_path, @created_at
      )`
    ).run(record);
  });
  work();

  return {
    inserted_rows: preflight.inserted.length,
    skipped_identical_rows: preflight.skipped.length,
    conflict_rows: 0,
    actions: preflight.actions,
    conflicts: [],
    sync_run_record: record
  };
}

export function validatePostSync(input: {
  db: LocalDatabase;
  sourceRows: MarketSignalHistoryDryRunRow[];
  syncRunId: string;
  collectorBaselineBefore: CollectorBaseline;
  historyMtimesUnchanged: boolean;
}): PostSyncValidation {
  const errors: string[] = [];
  const rowIds = new Set(input.sourceRows.map((row) => row.row_id));
  const stored = input.db.prepare("SELECT row_id, row_hash FROM market_signal_history").all() as { row_id: string; row_hash: string }[];
  const storedById = new Map(stored.map((row) => [row.row_id, row.row_hash]));
  const all_source_row_ids_exist = [...rowIds].every((rowId) => storedById.has(rowId));
  const all_row_hashes_match = input.sourceRows.every((row) => storedById.get(row.row_id) === row.row_hash);
  const duplicate_row_id_count = (input.db.prepare(
    "SELECT COUNT(*) AS count FROM (SELECT row_id FROM market_signal_history GROUP BY row_id HAVING COUNT(*) > 1)"
  ).get() as { count: number }).count;
  const sync_run_record_exists = input.db
    .prepare("SELECT sync_run_id FROM market_signal_sync_runs WHERE sync_run_id = ?")
    .get(input.syncRunId) !== undefined;
  const collectorBaselineAfter = readCollectorBaseline(input.db);
  const collector_baseline_unchanged = JSON.stringify(input.collectorBaselineBefore) === JSON.stringify(collectorBaselineAfter);
  const sourceCounts = countBy(input.db, "source");
  const dpUsageCounts = countBy(input.db, "dp_usage");
  const basisConfidenceCounts = countBy(input.db, "basis_confidence");
  if (!all_source_row_ids_exist) errors.push("not all source row_ids exist");
  if (!all_row_hashes_match) errors.push("not all row_hashes match");
  if (duplicate_row_id_count > 0) errors.push("duplicate row_id found");
  if (!sync_run_record_exists) errors.push("sync run record missing");
  if (!collector_baseline_unchanged) errors.push("collector baseline changed");
  if (!input.historyMtimesUnchanged) errors.push(".data/history mtimes changed");
  return {
    passed: errors.length === 0,
    errors,
    market_signal_history_count: stored.length,
    all_source_row_ids_exist,
    all_row_hashes_match,
    duplicate_row_id_count,
    sync_run_record_exists,
    source_counts: sourceCounts,
    dp_usage_counts: dpUsageCounts,
    basis_confidence_counts: basisConfidenceCounts,
    collector_baseline_before: input.collectorBaselineBefore,
    collector_baseline_after: collectorBaselineAfter,
    collector_baseline_unchanged,
    history_mtimes_unchanged: input.historyMtimesUnchanged
  };
}

export function readCollectorBaseline(db: LocalDatabase): CollectorBaseline {
  return {
    collector_runs_count: safeCount(db, "collector_runs"),
    rate_snapshots_count: safeCount(db, "rate_snapshots"),
    inventory_snapshots_count: safeCount(db, "inventory_snapshots"),
    collection_job_attempts_count: safeCount(db, "collection_job_attempts")
  };
}

export function renderHistoryToDbSyncRealRunCsv(report: HistoryToDbSyncRealRunReport): string {
  const headers = ["run_id", "row_id", "row_hash", "source", "canonical_property_name", "checkin_date", "action", "reason"];
  const rows = report.sync_actions.map((a) =>
    [a.run_id, a.row_id, a.row_hash, a.source, a.canonical_property_name, a.checkin_date, a.action, a.reason].map(csvEscape).join(",")
  );
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

export function renderHistoryToDbSyncRealRunReport(report: HistoryToDbSyncRealRunReport): string {
  return [
    "# History-to-DB Sync Real Run",
    "",
    `Generated at: ${report.generated_at_jst}`,
    `Decision: ${report.decision}`,
    "",
    "## 1. Summary",
    "",
    `Inserted ${report.inserted_rows} rows, skipped ${report.skipped_identical_rows} identical rows, conflicts ${report.conflict_rows}.`,
    "",
    "## 2. Explicit Approval Result",
    "",
    `- passed=${report.explicit_approval_result.passed}`,
    `- explicitUserApproved=${report.explicit_approval_result.explicitUserApproved}`,
    `- envFlagPresent=${report.explicit_approval_result.envFlagPresent}`,
    `- reasons=${report.explicit_approval_result.reasons.join(" | ") || "none"}`,
    "",
    "## 3. Source AUTO03X Artifact",
    "",
    report.source_auto03x_artifact,
    "",
    "## 4. DB Schema Handling",
    "",
    report.db_schema_handling === null ? "- not run" : JSON.stringify(report.db_schema_handling, null, 2),
    "",
    "## 5. Sync Actions",
    "",
    `- action_count=${report.sync_actions.length}`,
    `- inserted=${report.inserted_rows}`,
    `- skipped_identical=${report.skipped_identical_rows}`,
    `- conflicts=${report.conflict_rows}`,
    "",
    "## 6. Sync Run Record",
    "",
    report.sync_run_record === null ? "- not recorded" : JSON.stringify(report.sync_run_record, null, 2),
    "",
    "## 7. Post-sync Validation",
    "",
    report.post_sync_validation === null ? "- not run" : JSON.stringify(report.post_sync_validation, null, 2),
    "",
    "## 8. Idempotency Result",
    "",
    JSON.stringify(report.idempotency_check, null, 2),
    "",
    "## 9. Collector Baseline Check",
    "",
    report.post_sync_validation === null ? "- not run" : `- unchanged=${report.post_sync_validation.collector_baseline_unchanged}`,
    "",
    "## 10. Safety Checks",
    "",
    ...Object.entries(report.safety_confirmation).map(([k, v]) => `- ${k}=${v}`),
    ""
  ].join("\n");
}

export function buildReadyNotRunReport(input: {
  runId: string;
  generatedAtJst: string;
  gate: ApprovalGateResult;
  sourceArtifact: string;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
}): HistoryToDbSyncRealRunReport {
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision: "history_to_db_sync_ready_not_run",
    explicit_approval_result: input.gate,
    source_auto03x_artifact: input.sourceArtifact,
    db_schema_handling: null,
    sync_actions: [],
    inserted_rows: 0,
    skipped_identical_rows: 0,
    conflict_rows: 0,
    sync_run_record: null,
    post_sync_validation: null,
    idempotency_check: {
      expected_next_inserted_rows: 0,
      expected_next_skipped_identical_rows: 0,
      expected_next_conflict_rows: 0,
      note: "No DB sync attempted because approval gate failed closed."
    },
    safety_confirmation: baseSafety(false),
    report_path: input.reportPath,
    json_path: input.jsonPath,
    csv_path: input.csvPath,
    debug_artifact_path: input.debugPath
  };
}

export function buildSuccessReport(input: {
  runId: string;
  generatedAtJst: string;
  gate: ApprovalGateResult;
  sourceArtifact: string;
  schemaPreflight: DbSchemaPreflight;
  syncResult: RealSyncResult;
  postSyncValidation: PostSyncValidation;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
}): HistoryToDbSyncRealRunReport {
  const validationPassed = input.postSyncValidation.passed;
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision: input.syncResult.conflict_rows > 0
      ? "history_to_db_sync_failed_conflicts"
      : validationPassed
        ? "history_to_db_sync_success"
        : "history_to_db_sync_failed_validation",
    explicit_approval_result: input.gate,
    source_auto03x_artifact: input.sourceArtifact,
    db_schema_handling: input.schemaPreflight,
    sync_actions: input.syncResult.actions,
    inserted_rows: input.syncResult.inserted_rows,
    skipped_identical_rows: input.syncResult.skipped_identical_rows,
    conflict_rows: input.syncResult.conflict_rows,
    sync_run_record: input.syncResult.sync_run_record,
    post_sync_validation: input.postSyncValidation,
    idempotency_check: {
      expected_next_inserted_rows: 0,
      expected_next_skipped_identical_rows: input.postSyncValidation.passed ? input.postSyncValidation.market_signal_history_count : 0,
      expected_next_conflict_rows: 0,
      note: "A second run should skip identical market_signal_history rows while adding only a new sync-run metadata row."
    },
    safety_confirmation: baseSafety(true),
    report_path: input.reportPath,
    json_path: input.jsonPath,
    csv_path: input.csvPath,
    debug_artifact_path: input.debugPath
  };
}

function syncRunRecord(input: {
  runId: string;
  generatedAtJst: string;
  reportPath: string;
  sourceHistoryFiles: string[];
  rows: MarketSignalHistoryDryRunRow[];
}, inserted: number, skipped: number, conflicts: number, status: string, errorMessage: string): SyncRunRecord {
  return {
    sync_run_id: input.runId,
    started_at: input.generatedAtJst,
    finished_at: input.generatedAtJst,
    status,
    source_history_files: JSON.stringify(input.sourceHistoryFiles),
    input_rows: input.rows.length,
    inserted_rows: inserted,
    skipped_identical_rows: skipped,
    conflict_rows: conflicts,
    error_message: errorMessage,
    report_path: input.reportPath,
    created_at: input.generatedAtJst
  };
}

function tableExists(db: LocalDatabase, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function safeCount(db: LocalDatabase, table: string): number {
  if (!tableExists(db, table)) return 0;
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function countBy(db: LocalDatabase, column: string): Record<string, number> {
  const rows = db.prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM market_signal_history GROUP BY ${column} ORDER BY ${column}`).all() as { key: string; count: number }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

function baseSafety(dbMirrorWriteAllowed: boolean): Record<string, boolean> {
  return {
    explicitScopeOnly: true,
    dbMirrorWriteAllowed,
    collectorRunsWritten: false,
    rateSnapshotsWritten: false,
    inventorySnapshotsWritten: false,
    collectionJobAttemptsWritten: false,
    liveExternalFetch: false,
    collectorRun: false,
    workflowCreatedOrActivated: false,
    cronActivated: false,
    gitCommitOrPush: false,
    dataRepoCreated: false,
    historyModified: false,
    propertyMasterModified: false,
    pmsOrChannelOutput: false,
    priceUpdate: false,
    paidSourceTooling: false,
    bookingBaseTimesOnePointOneLogic: false
  };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}
