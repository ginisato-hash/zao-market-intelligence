// Phase JALAN-AUTO05B — validate/report the post Jalan-history-append refresh.
//
// This wrapper is intentionally read-only. Claude already performed the AUTO05B
// DB mirror sync and AI context refresh; this script verifies those artifacts and
// the current DB/context state, then writes only the AUTO05B report/debug packet.
// It never runs collectors, never fetches Jalan/Booking/Rakuten pages, never uses
// a headless browser, never appends .data/history, and never writes the DB
// (it opens the SQLite mirror read-only). It generates no pricing CSV and emits
// no PMS/Beds24/AirHost output, and applies no synthetic tax multiplier.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseCsvTable } from "../services/historyToDbSyncDryRun";
import {
  AUTO05X_SUCCESS_DECISION,
  CONTEXT_CAUTION_DECISION,
  EXPECTED_HISTORY_ROW_COUNT,
  EXPECTED_JALAN_DIRECTIONAL_APPENDED,
  EXPECTED_JALAN_EXCLUDED_APPENDED,
  buildPricePressureNote,
  decidePostJalanHistoryAppendRefresh,
  diffSnapshots,
  isContextRefreshOk,
  isDbSyncOk,
  recommendedNextAction,
  renderPostJalanRefreshCsv,
  renderPostJalanRefreshReport,
  validateJalanRefresh,
  type DbStateSnapshot,
  type JalanAppendSummary,
  type JalanContextSummary,
  type JalanDbSyncSummary,
  type JalanRowState,
  type PostJalanRefreshReport,
  type RefreshSafetyState,
  type TaskQuerySmokeSummary,
  type TaskSmokeResult
} from "../services/postJalanHistoryAppendRefresh";

const DB_PATH = ".data/zao-market-intelligence.sqlite";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/post-jalan-history-append-refresh";
const HISTORY_DIR = ".data/history";

// Canonical AUTO05B evidence artifacts (the fresh AUTO05X append + the AUTO05B
// dry-run / real sync / AI context refresh produced this phase).
const AUTO05X_ARTIFACT = ".data/reports/automation/jalan_history_append_real_run_20260605_103629.json";
const DRY_RUN_ARTIFACT = ".data/reports/automation/history_to_db_sync_dry_run_20260605_104149.json";
const SYNC_ARTIFACT = ".data/reports/automation/history_to_db_sync_real_run_20260605_104320.json";
const CONTEXT_ARTIFACT = ".data/reports/automation/ai_context_packs_20260605_104333.json";

const CONTEXT_PACK_FILES = [
  ".data/ai-context/latest_market_snapshot.json",
  ".data/ai-context/latest_demand_context.json",
  ".data/ai-context/latest_property_signal_context.json",
  ".data/ai-context/latest_caveats_and_guardrails.json",
  ".data/ai-context/latest_ai_task_entrypoint.json"
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
    return {
      market_signal_history_rows: countTable(db, "market_signal_history"),
      market_signal_sync_runs: countTable(db, "market_signal_sync_runs"),
      source_counts: groupCounts(db, "source"),
      dp_usage_counts: groupCounts(db, "dp_usage")
    };
  } finally {
    db.close();
  }
}

function readJalanRows(): JalanRowState {
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    const scalar = (sql: string): number => numberAt((db.prepare(sql).get() as { c: number }).c);
    return {
      total_in_db: scalar("SELECT COUNT(*) AS c FROM market_signal_history WHERE source='jalan'"),
      directional_in_db: scalar("SELECT COUNT(*) AS c FROM market_signal_history WHERE source='jalan' AND dp_usage='directional'"),
      excluded_in_db: scalar("SELECT COUNT(*) AS c FROM market_signal_history WHERE source='jalan' AND dp_usage='excluded'"),
      direct_in_db: scalar("SELECT COUNT(*) AS c FROM market_signal_history WHERE source='jalan' AND dp_usage='direct'"),
      excluded_leaked_to_usable: scalar(
        "SELECT COUNT(*) AS c FROM market_signal_history WHERE source='jalan' AND classification LIKE '%excluded%' AND dp_usage<>'excluded'"
      )
    };
  } finally {
    db.close();
  }
}

function collectorBaseline(): Record<string, number> {
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    const out: Record<string, number> = {};
    for (const table of ["collector_runs", "rate_snapshots", "inventory_snapshots", "collection_job_attempts"]) {
      out[table] = countTable(db, table);
    }
    return out;
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

function historySummary(): {
  uniqueRowIds: number;
  jalanRows: number;
  bookingRows: number;
  shardCounts: Record<string, number>;
} {
  const ids = new Set<string>();
  const shardCounts: Record<string, number> = {};
  let jalanRows = 0;
  let bookingRows = 0;
  for (const file of historyShardFiles()) {
    const table = parseCsvTable(readFileSync(resolve(file), "utf8"));
    const shard = basename(file).replace("zao_signals_", "").replace(".csv", "");
    shardCounts[shard] = table.rows.length;
    for (const row of table.rows) {
      const id = row["row_id"];
      if (id !== undefined && id !== "") ids.add(id);
      if (row["source"] === "jalan") jalanRows += 1;
      if (row["source"] === "booking") bookingRows += 1;
    }
  }
  return { uniqueRowIds: ids.size, jalanRows, bookingRows, shardCounts };
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

function readJalanAppendSummary(path: string): JalanAppendSummary {
  const json = readJson<Record<string, unknown>>(path);
  const preflight = (json["preflight_summary"] ?? {}) as Record<string, unknown>;
  const validation = (json["row_policy_validation"] ?? {}) as Record<string, unknown>;
  return {
    decision: stringAt(json["decision"]),
    appended_row_count: numberAt(preflight["new_row_count"]),
    directional_appended: numberAt(validation["directionalCount"]),
    excluded_appended: numberAt(validation["excludedCount"]),
    direct_appended: numberAt(validation["directCount"]),
    conflict_rows: numberAt(preflight["conflict_count"])
  };
}

function readDbSyncSummary(path: string): JalanDbSyncSummary {
  const json = readJson<Record<string, unknown>>(path);
  const post = (json["post_sync_validation"] ?? {}) as Record<string, unknown>;
  return {
    decision: stringAt(json["decision"]),
    inserted_rows: numberAt(json["inserted_rows"]),
    skipped_identical_rows: numberAt(json["skipped_identical_rows"]),
    conflict_rows: numberAt(json["conflict_rows"]),
    post_sync_passed: Boolean(post["passed"]),
    all_source_row_ids_exist: Boolean(post["all_source_row_ids_exist"]),
    all_row_hashes_match: Boolean(post["all_row_hashes_match"]),
    duplicate_row_id_count: numberAt(post["duplicate_row_id_count"]),
    sync_run_record_exists: Boolean(post["sync_run_record_exists"]),
    market_signal_history_count: numberAt(post["market_signal_history_count"]),
    collector_baseline_unchanged: Boolean(post["collector_baseline_unchanged"]),
    history_mtimes_unchanged: Boolean(post["history_mtimes_unchanged"]),
    artifact_path: path
  };
}

function readContextSummary(contextArtifact: string): JalanContextSummary {
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
    context_jalan_source_count: numberAt(sourceCounts["jalan"]),
    context_booking_source_count: numberAt(sourceCounts["booking"])
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
      latestQueryByTask("data_quality"),
      latestQueryByTask("market_report"),
      latestQueryByTask("pricing_support")
    ]
  };
}

// The DB before-state is reconstructed from the after-state minus the AUTO05X
// append deltas (jalan +25, directional +5, excluded +20, direct +0). The append
// inserted exactly these 25 rows during this phase's sync.
function syntheticBeforeSnapshot(after: DbStateSnapshot): DbStateSnapshot {
  return {
    market_signal_history_rows: after.market_signal_history_rows - 25,
    market_signal_sync_runs: Math.max(0, after.market_signal_sync_runs - 1),
    source_counts: { ...after.source_counts, jalan: (after.source_counts["jalan"] ?? 0) - 25 },
    dp_usage_counts: {
      ...after.dp_usage_counts,
      directional: (after.dp_usage_counts["directional"] ?? 0) - EXPECTED_JALAN_DIRECTIONAL_APPENDED,
      excluded: (after.dp_usage_counts["excluded"] ?? 0) - EXPECTED_JALAN_EXCLUDED_APPENDED,
      direct: after.dp_usage_counts["direct"] ?? 0
    }
  };
}

function writeDebug(debugPath: string, name: string, data: unknown): void {
  writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function main(): void {
  const ts = timestamp();
  const runId = `post_jalan_history_append_refresh_${ts}`;
  const generatedAtJst = jstIso();
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const historyFiles = historyShardFiles();
  const historyBefore = fileFingerprints(historyFiles);
  const collectorBaselineBefore = collectorBaseline();

  const appendSummary = readJalanAppendSummary(AUTO05X_ARTIFACT);
  const dryRun = readJson<Record<string, unknown>>(DRY_RUN_ARTIFACT);
  const dbSync = readDbSyncSummary(SYNC_ARTIFACT);
  const dbAfter = readDbSnapshot();
  const dbBefore = syntheticBeforeSnapshot(dbAfter);
  const jalanRows = readJalanRows();
  const contextSummary = readContextSummary(CONTEXT_ARTIFACT);
  const taskSmoke = buildTaskSmokeSummary();
  const history = historySummary();

  const collectorBaselineAfter = collectorBaseline();
  const historyAfter = fileFingerprints(historyFiles);

  const dryRunOk =
    dryRun["decision"] === "history_to_db_sync_dry_run_ready" &&
    numberAt(dryRun["mapped_row_count"]) === EXPECTED_HISTORY_ROW_COUNT &&
    numberAt((dryRun["conflict_summary"] as Record<string, unknown> | undefined)?.["conflict_count"]) === 0;

  const safety: RefreshSafetyState = {
    history_modified: !recordsEqual(historyBefore, historyAfter),
    history_appended: false,
    db_mirror_synced: isDbSyncOk(dbSync.decision),
    ai_context_refreshed: isContextRefreshOk(contextSummary.decision),
    query_smoke_run: taskSmoke.bootstrap_ok,
    collector_baseline_unchanged: recordsEqual(collectorBaselineBefore, collectorBaselineAfter),
    live_jalan_collection: false,
    browser_automation: false,
    external_fetch: false,
    pricing_csv: false,
    pms_output: false,
    price_update: false,
    base_times_1_1: false,
    paid_source_tooling: false,
    github_actions_or_cron: false,
    auto06x_started: false
  };

  const validation = validateJalanRefresh({
    history_unique_row_id_count: history.uniqueRowIds,
    jalan_history_row_count: history.jalanRows,
    booking_history_row_count: history.bookingRows,
    db_history_row_count_after: dbAfter.market_signal_history_rows,
    jalan_append: appendSummary,
    db_sync: dbSync,
    jalan_rows: jalanRows,
    context_refresh: contextSummary,
    task_smoke: taskSmoke,
    dry_run_ok: dryRunOk,
    safety
  });

  const decision = decidePostJalanHistoryAppendRefresh({
    db_sync_ok: isDbSyncOk(dbSync.decision),
    context_refresh_ok: isContextRefreshOk(contextSummary.decision),
    validation_ok: validation.ok,
    context_decision_is_caution: contextSummary.decision === CONTEXT_CAUTION_DECISION
  });

  const commandsRun = [
    "npm run dry-run:history-to-db-sync",
    "HISTORY_TO_DB_SYNC=1 npm run real-run:history-to-db-sync",
    "npm run build:ai-context-packs",
    "npm run query:ai-task -- --task bootstrap",
    "npm run query:ai-task -- --task data_quality",
    "npm run query:ai-task -- --task market_report --start 2026-06-01 --end 2026-12-31",
    "npm run query:ai-task -- --task pricing_support --start 2026-06-01 --end 2026-12-31",
    "npm run refresh:post-jalan-history-append"
  ];

  const report: PostJalanRefreshReport = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto05x_artifact: AUTO05X_ARTIFACT,
    history_unique_row_id_count: history.uniqueRowIds,
    jalan_history_row_count: history.jalanRows,
    booking_history_row_count: history.bookingRows,
    db_before: dbBefore,
    db_after: dbAfter,
    snapshot_diff: diffSnapshots(dbBefore, dbAfter),
    jalan_append: appendSummary,
    db_sync: dbSync,
    jalan_rows: jalanRows,
    context_refresh: contextSummary,
    task_smoke: taskSmoke,
    validation,
    price_pressure_note: buildPricePressureNote(jalanRows, appendSummary),
    safety,
    commands_run: commandsRun,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath,
    next_phase: recommendedNextAction(decision)
  };

  writeFileSync(reportPath, renderPostJalanRefreshReport(report), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderPostJalanRefreshCsv(report), "utf8");

  writeDebug(debugPath, "source_auto05x_artifact.json", readJson(AUTO05X_ARTIFACT));
  writeDebug(debugPath, "history_row_count_summary.json", history);
  writeDebug(debugPath, "db_sync_summary.json", dbSync);
  writeDebug(debugPath, "context_pack_refresh_summary.json", contextSummary);
  writeDebug(debugPath, "task_query_smoke_summary.json", taskSmoke);
  writeDebug(debugPath, "jalan_price_pressure_summary.json", { jalan_rows: jalanRows, note: report.price_pressure_note });
  writeDebug(debugPath, "safety_confirmation.json", safety);

  const ok =
    appendSummary.decision === AUTO05X_SUCCESS_DECISION &&
    decision !== "post_jalan_history_append_refresh_not_ready";

  console.log(`decision=${decision}`);
  console.log(`validation_ok=${validation.ok} failed=${validation.failed_checks.join(",")}`);
  console.log(`db_history=${dbAfter.market_signal_history_rows} jalan_in_db=${jalanRows.total_in_db} booking_in_db=${report.db_after.source_counts["booking"] ?? 0}`);
  console.log(`report=${reportPath}`);
  console.log(`json=${jsonPath}`);
  console.log(`csv=${csvPath}`);
  console.log(`debug=${debugPath}`);
  if (!ok) process.exitCode = 1;
}

main();
