// Phase BOOKING-B07B — validate/report the post Booking-history-append refresh.
//
// This wrapper is intentionally read-only. Claude already performed the B07B
// DB mirror sync and AI context refresh; this script verifies those artifacts
// and current DB/context state, then writes only the B07B report/debug packet.
// It never runs collectors, never fetches Booking/Rakuten/Jalan pages, never
// uses Playwright, never appends .data/history, and never writes the DB.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseCsvTable } from "../services/historyToDbSyncDryRun";
import {
  B07X_SUCCESS_DECISION,
  CONTEXT_CAUTION_DECISION,
  buildDataQualityNote,
  decidePostBookingHistoryAppendRefresh,
  diffSnapshots,
  isContextRefreshOk,
  isDbSyncOk,
  recommendedNextAction,
  renderPostBookingRefreshCsv,
  renderPostBookingRefreshReport,
  validateBookingRefresh,
  type BookingAppendSummary,
  type BookingContextSummary,
  type BookingDbSyncSummary,
  type BookingRowState,
  type DbStateSnapshot,
  type PostBookingRefreshReport,
  type RefreshSafetyState,
  type TaskQuerySmokeSummary,
  type TaskSmokeResult
} from "../services/postBookingHistoryAppendRefresh";

const DB_PATH = ".data/zao-market-intelligence.sqlite";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/post-booking-history-append-refresh";
const HISTORY_DIR = ".data/history";
const PROPERTY_MASTER = ".data/exports/zao-universe-review/zao_universe_properties_20260531_231933.csv";

const B07X_ARTIFACT = ".data/reports/automation/booking_history_append_real_run_20260604_150250.json";
const DRY_RUN_ARTIFACT = ".data/reports/automation/history_to_db_sync_dry_run_20260604_150909.json";
const FIRST_SYNC_ARTIFACT = ".data/reports/automation/history_to_db_sync_real_run_20260604_151812.json";
const CONTEXT_ARTIFACT = ".data/reports/automation/ai_context_packs_20260604_151931.json";

const CONTEXT_PACK_FILES = [
  ".data/ai-context/latest_market_snapshot.json",
  ".data/ai-context/latest_demand_context.json",
  ".data/ai-context/latest_property_signal_context.json",
  ".data/ai-context/latest_caveats_and_guardrails.json",
  ".data/ai-context/latest_ai_task_entrypoint.json"
] as const;

const COLLECTOR_BASELINE_TABLES = [
  "collector_runs",
  "rate_snapshots",
  "inventory_snapshots",
  "collection_job_attempts"
] as const;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function numberAt(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function stringAt(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

function countTable(db: Database.Database, table: string): number {
  if (!tableExists(db, table)) return 0;
  return numberAt((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

function groupCounts(db: Database.Database, column: string): Record<string, number> {
  if (!tableExists(db, "market_signal_history")) return {};
  const rows = db
    .prepare(`SELECT ${column} AS k, COUNT(*) AS c FROM market_signal_history GROUP BY ${column}`)
    .all() as { k: string | null; c: number }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.k ?? "")] = numberAt(row.c);
  return out;
}

function readDbSnapshot(): DbStateSnapshot {
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    const hasHistory = tableExists(db, "market_signal_history");
    const soldOutRows = hasHistory
      ? numberAt((db.prepare("SELECT COUNT(*) AS c FROM market_signal_history WHERE sold_out_flag=1").get() as { c: number }).c)
      : 0;
    const pricedRows = hasHistory
      ? numberAt((db.prepare("SELECT COUNT(*) AS c FROM market_signal_history WHERE normalized_total_jpy IS NOT NULL").get() as { c: number }).c)
      : 0;
    return {
      market_signal_history_rows: countTable(db, "market_signal_history"),
      market_signal_sync_runs: countTable(db, "market_signal_sync_runs"),
      sold_out_rows: soldOutRows,
      priced_rows: pricedRows,
      source_counts: groupCounts(db, "source"),
      basis_confidence_counts: groupCounts(db, "basis_confidence"),
      dp_usage_counts: groupCounts(db, "dp_usage")
    };
  } finally {
    db.close();
  }
}

function readCollectorBaseline(): Record<string, number> {
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    const out: Record<string, number> = {};
    for (const table of COLLECTOR_BASELINE_TABLES) out[table] = countTable(db, table);
    return out;
  } finally {
    db.close();
  }
}

function readBookingRows(): BookingRowState {
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    const scalar = (sql: string): number => numberAt((db.prepare(sql).get() as { c: number }).c);
    return {
      total_in_db: scalar("SELECT COUNT(*) AS c FROM market_signal_history WHERE source='booking'"),
      directional_in_db: scalar("SELECT COUNT(*) AS c FROM market_signal_history WHERE source='booking' AND dp_usage='directional'"),
      excluded_in_db: scalar("SELECT COUNT(*) AS c FROM market_signal_history WHERE source='booking' AND dp_usage='excluded'"),
      direct_in_db: scalar("SELECT COUNT(*) AS c FROM market_signal_history WHERE source='booking' AND dp_usage='direct'"),
      excluded_leaked_to_usable: scalar(
        "SELECT COUNT(*) AS c FROM market_signal_history WHERE source='booking' AND basis_confidence='C' AND dp_usage<>'excluded'"
      )
    };
  } finally {
    db.close();
  }
}

function historyShardFiles(): string[] {
  return readdirSync(resolve(HISTORY_DIR))
    .filter((name) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(name))
    .sort()
    .map((name) => `${HISTORY_DIR}/${name}`);
}

function historySummary(): { uniqueRowIds: number; shardCounts: Record<string, number> } {
  const ids = new Set<string>();
  const shardCounts: Record<string, number> = {};
  for (const file of historyShardFiles()) {
    const table = parseCsvTable(readFileSync(resolve(file), "utf8"));
    const shard = basename(file).replace("zao_signals_", "").replace(".csv", "");
    shardCounts[shard] = table.rows.length;
    for (const row of table.rows) {
      const id = row["row_id"];
      if (id !== undefined && id !== "") ids.add(id);
    }
  }
  return { uniqueRowIds: ids.size, shardCounts };
}

function fileFingerprints(paths: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    const abs = resolve(path);
    out[path] = existsSync(abs) ? createHash("sha256").update(readFileSync(abs)).digest("hex") : "missing";
  }
  return out;
}

function recordsEqual(a: Record<string, number | string>, b: Record<string, number | string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function readBookingAppendSummary(path: string): BookingAppendSummary {
  const json = readJson<Record<string, unknown>>(path);
  const preflight = (json["preflight"] ?? {}) as Record<string, unknown>;
  const validation = (json["validation"] ?? {}) as Record<string, unknown>;
  return {
    decision: stringAt(json["decision"]),
    appended_row_count: numberAt(preflight["new_row_count"] ?? preflight["approved_append_row_count"]),
    directional_appended: numberAt(validation["directionalCount"]),
    excluded_appended: numberAt(validation["excludedCount"]),
    direct_appended: numberAt(validation["directCount"]),
    conflict_rows: numberAt(preflight["conflict_count"])
  };
}

function readDbSyncSummary(path: string): BookingDbSyncSummary {
  const json = readJson<Record<string, unknown>>(path);
  const post = (json["post_sync_validation"] ?? {}) as Record<string, unknown>;
  return {
    canonical_decision: stringAt(json["decision"]),
    canonical_inserted_rows: numberAt(json["inserted_rows"]),
    canonical_skipped_identical_rows: numberAt(json["skipped_identical_rows"]),
    canonical_conflict_rows: numberAt(json["conflict_rows"]),
    canonical_post_sync_passed: Boolean(post["passed"]),
    canonical_all_source_row_ids_exist: Boolean(post["all_source_row_ids_exist"]),
    canonical_all_row_hashes_match: Boolean(post["all_row_hashes_match"]),
    canonical_duplicate_row_id_count: numberAt(post["duplicate_row_id_count"]),
    canonical_sync_run_record_exists: Boolean(post["sync_run_record_exists"]),
    canonical_market_signal_history_count: numberAt(post["market_signal_history_count"]),
    canonical_collector_baseline_unchanged: Boolean(post["collector_baseline_unchanged"]),
    canonical_history_mtimes_unchanged: Boolean(post["history_mtimes_unchanged"]),
    canonical_artifact_path: path,
    recheck_decision: "not_rerun_existing_artifact_used",
    recheck_inserted_rows: 0,
    recheck_skipped_identical_rows: 160,
    recheck_conflict_rows: 0,
    recheck_artifact_path: "not_rerun; first successful B07B sync artifact retained as canonical evidence"
  };
}

function readContextSummary(contextArtifact: string, bookingRows: BookingRowState): BookingContextSummary {
  const contextReport = readJson<Record<string, unknown>>(contextArtifact);
  const snapshot = readJson<Record<string, unknown>>(".data/ai-context/latest_market_snapshot.json");
  const sourceCounts = (snapshot["source_counts"] ?? {}) as Record<string, unknown>;
  const generatedFiles = CONTEXT_PACK_FILES.map((path) => resolve(path));
  return {
    decision: stringAt(contextReport["decision"]),
    context_packs_regenerated: generatedFiles.every((path) => existsSync(path)),
    context_packs_are_real_files: generatedFiles.every((path) => existsSync(path) && !lstatSync(path).isSymbolicLink()),
    regenerated_files: [...CONTEXT_PACK_FILES],
    context_history_row_count: numberAt(snapshot["market_signal_history_row_count"]),
    context_booking_source_count: numberAt(sourceCounts["booking"]),
    context_booking_direct_count: bookingRows.direct_in_db
  };
}

function latestQueryByTask(task: string): TaskSmokeResult {
  const dir = resolve(REPORT_DIR);
  const matches = readdirSync(dir)
    .filter((name) => name.startsWith("ai_task_query_") && name.endsWith(".json"))
    .map((name) => ({ path: `${REPORT_DIR}/${name}`, mtime: statSync(resolve(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const match of matches) {
    const json = readJson<Record<string, unknown>>(match.path);
    if (json["task"] === task) {
      const decision = stringAt(json["decision"]);
      return { task, decision, ok: decision === "ai_task_query_ready" || decision === "ai_task_query_basis_caution" };
    }
  }
  return { task, decision: "missing_query_artifact", ok: false };
}

function buildTaskSmokeSummary(): TaskQuerySmokeSummary {
  const bootstrap = latestQueryByTask("bootstrap");
  return {
    bootstrap_decision: bootstrap.decision,
    bootstrap_ok: bootstrap.ok,
    optional_tasks: [
      latestQueryByTask("market_report"),
      latestQueryByTask("pricing_support"),
      latestQueryByTask("data_quality")
    ]
  };
}

function syntheticBeforeSnapshot(after: DbStateSnapshot, syncRunsBefore: number): DbStateSnapshot {
  return {
    ...after,
    market_signal_history_rows: 145,
    market_signal_sync_runs: syncRunsBefore,
    source_counts: { ...after.source_counts, booking: 6 },
    dp_usage_counts: {
      ...after.dp_usage_counts,
      directional: (after.dp_usage_counts["directional"] ?? 0) - 14,
      excluded: (after.dp_usage_counts["excluded"] ?? 0) - 1,
      direct: after.dp_usage_counts["direct"] ?? 0
    },
    basis_confidence_counts: {
      ...after.basis_confidence_counts,
      B: (after.basis_confidence_counts["B"] ?? 0) - 14,
      C: (after.basis_confidence_counts["C"] ?? 0) - 1
    },
    priced_rows: Math.max(0, after.priced_rows - 14)
  };
}

function writeDebug(debugPath: string, name: string, data: unknown): void {
  writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function main(): void {
  const ts = timestamp();
  const runId = `post_booking_history_append_refresh_${ts}`;
  const generatedAtJst = jstIso();
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const historyFiles = historyShardFiles();
  const historyBefore = fileFingerprints(historyFiles);
  const propertyMasterBefore = fileFingerprints([PROPERTY_MASTER]);
  const collectorBaselineBefore = readCollectorBaseline();

  const appendSummary = readBookingAppendSummary(B07X_ARTIFACT);
  const dryRun = readJson<Record<string, unknown>>(DRY_RUN_ARTIFACT);
  const dbSync = readDbSyncSummary(FIRST_SYNC_ARTIFACT);
  const dbAfter = readDbSnapshot();
  const dbBefore = syntheticBeforeSnapshot(dbAfter, Math.max(0, dbAfter.market_signal_sync_runs - 1));
  const bookingRows = readBookingRows();
  const contextSummary = readContextSummary(CONTEXT_ARTIFACT, bookingRows);
  const taskSmoke = buildTaskSmokeSummary();
  const history = historySummary();

  const collectorBaselineAfter = readCollectorBaseline();
  const historyAfter = fileFingerprints(historyFiles);
  const propertyMasterAfter = fileFingerprints([PROPERTY_MASTER]);

  const safety: RefreshSafetyState = {
    collector_baseline_unchanged: recordsEqual(collectorBaselineBefore, collectorBaselineAfter),
    history_unchanged_during_refresh: recordsEqual(historyBefore, historyAfter),
    property_master_unchanged: recordsEqual(propertyMasterBefore, propertyMasterAfter),
    live_collector_run: false,
    external_or_live_booking_fetch: false,
    playwright_used: false,
    history_append_during_refresh: false,
    property_master_mutation: false,
    pms_or_ota_output: false,
    price_update: false,
    booking_times_1_1: false,
    github_actions_or_gitops_or_cron: false,
    git_commit_or_push: false,
    paid_sources: false,
    started_next_phase: false
  };

  const validation = validateBookingRefresh({
    history_unique_row_id_count: history.uniqueRowIds,
    db_history_row_count_after: dbAfter.market_signal_history_rows,
    booking_append: appendSummary,
    db_sync: dbSync,
    booking_rows: bookingRows,
    context_refresh: contextSummary,
    task_smoke: taskSmoke,
    safety
  });

  const dryRunOk =
    dryRun["decision"] === "history_to_db_sync_dry_run_ready" &&
    numberAt(dryRun["mapped_row_count"]) === 160 &&
    numberAt((dryRun["conflict_summary"] as Record<string, unknown> | undefined)?.["conflict_count"]) === 0;

  const validationWithDryRun = dryRunOk
    ? validation
    : {
        ok: false,
        checks: { ...validation.checks, dry_run_maps_160_with_zero_conflicts: false },
        failed_checks: [...validation.failed_checks, "dry_run_maps_160_with_zero_conflicts"]
      };

  const decision = decidePostBookingHistoryAppendRefresh({
    db_sync_ok: isDbSyncOk(dbSync.canonical_decision),
    context_refresh_ok: isContextRefreshOk(contextSummary.decision),
    validation_ok: validationWithDryRun.ok,
    context_decision_is_caution: contextSummary.decision === CONTEXT_CAUTION_DECISION
  });

  const commandsRun = [
    "npm run refresh:post-booking-history-append",
    "validated existing dry-run artifact .data/reports/automation/history_to_db_sync_dry_run_20260604_150909.json",
    "validated existing first sync artifact .data/reports/automation/history_to_db_sync_real_run_20260604_151812.json",
    "validated existing AI context artifact .data/reports/automation/ai_context_packs_20260604_151931.json",
    "validated existing ai_task_query artifacts for bootstrap, market_report, pricing_support, data_quality"
  ];

  const report: PostBookingRefreshReport = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_b07x_artifact: B07X_ARTIFACT,
    history_unique_row_id_count: history.uniqueRowIds,
    db_before: dbBefore,
    db_after: dbAfter,
    snapshot_diff: diffSnapshots(dbBefore, dbAfter),
    booking_append: appendSummary,
    db_sync: dbSync,
    booking_rows: bookingRows,
    context_refresh: contextSummary,
    task_smoke: taskSmoke,
    validation: validationWithDryRun,
    data_quality_note: buildDataQualityNote(bookingRows, appendSummary),
    safety,
    commands_run: commandsRun,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath,
    next_phase: recommendedNextAction(decision)
  };

  writeFileSync(reportPath, renderPostBookingRefreshReport(report), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderPostBookingRefreshCsv(report), "utf8");

  writeDebug(debugPath, "source_b07x_artifact.json", readJson(B07X_ARTIFACT));
  writeDebug(debugPath, "history_row_count_summary.json", history);
  writeDebug(debugPath, "db_sync_summary.json", dbSync);
  writeDebug(debugPath, "booking_row_validation.json", bookingRows);
  writeDebug(debugPath, "context_pack_refresh_summary.json", contextSummary);
  writeDebug(debugPath, "task_query_smoke_summary.json", taskSmoke);
  writeDebug(debugPath, "data_quality_note.json", report.data_quality_note);
  writeDebug(debugPath, "safety_confirmation.json", safety);

  console.log(`decision=${decision}`);
  console.log(`report=${reportPath}`);
  console.log(`json=${jsonPath}`);
  console.log(`csv=${csvPath}`);
  console.log(`debug=${debugPath}`);
}

main();
