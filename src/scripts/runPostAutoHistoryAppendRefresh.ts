// Phase AUTO08B — orchestrate the post auto-history-append refresh.
//
// After AUTO08X appended guarded history rows, the DB mirror and AI context
// packs are stale. This script orchestrates the EXISTING scripts (it does not
// re-implement their logic):
//   1. real-run:history-to-db-sync  (HISTORY_TO_DB_SYNC=1)   — DB mirror sync
//   2. build:ai-context-packs                                — AI context refresh
//   3. query:ai-task --task bootstrap (+ optional smoke)     — read-only check
// It captures before/after DB state, validates the result, and writes AUTO08B
// report/json/csv + debug artifacts.
//
// This script NEVER runs a collector, NEVER fetches externally, NEVER appends
// .data/history, NEVER mutates the property master, NEVER produces PMS/Beds24/
// AirHost/OTA output, NEVER updates prices, NEVER enables GitHub Actions/GitOps/
// cron, and NEVER commits/pushes. Its own DB reads are { readonly: true }.

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvTable } from "../services/historyToDbSyncDryRun";
import {
  buildDataQualityNote,
  decidePostAutoHistoryAppendRefresh,
  diffSnapshots,
  isContextRefreshOk,
  isDbSyncOk,
  recommendedNextAction,
  renderPostRefreshCsv,
  renderPostRefreshReport,
  validateRefresh,
  CONTEXT_CAUTION_DECISION,
  type ContextRefreshSummary,
  type DbStateSnapshot,
  type DbSyncSummary,
  type PostRefreshReport,
  type RefreshSafetyState,
  type TaskQuerySmokeSummary,
  type TaskSmokeResult
} from "../services/postAutoHistoryAppendRefresh";

const DB_PATH = ".data/zao-market-intelligence.sqlite";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/post-auto-history-append-refresh";
const HISTORY_DIR = ".data/history";
const AI_CONTEXT_DIR = ".data/ai-context";
const PROPERTY_MASTER = ".data/exports/zao-universe-review/zao_universe_properties_20260531_231933.csv";

const CONTEXT_PACK_FILES = [
  "latest_market_snapshot.json",
  "latest_demand_context.json",
  "latest_property_signal_context.json",
  "latest_caveats_and_guardrails.json",
  "latest_ai_task_entrypoint.json"
].map((name) => `${AI_CONTEXT_DIR}/${name}`);

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

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

function countTable(db: Database.Database, name: string): number {
  if (!tableExists(db, name)) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c);
}

function groupCounts(db: Database.Database, column: string): Record<string, number> {
  if (!tableExists(db, "market_signal_history")) return {};
  const rows = db
    .prepare(`SELECT ${column} AS k, COUNT(*) AS c FROM market_signal_history GROUP BY ${column}`)
    .all() as { k: string | null; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.k ?? "")] = Number(r.c);
  return out;
}

function readDbSnapshot(): DbStateSnapshot {
  if (!existsSync(resolve(DB_PATH))) {
    return {
      market_signal_history_rows: 0,
      market_signal_sync_runs: 0,
      sold_out_rows: 0,
      priced_rows: 0,
      availability_counts: {},
      basis_confidence_counts: {},
      dp_usage_counts: {}
    };
  }
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    const hasHistory = tableExists(db, "market_signal_history");
    const soldOut = hasHistory
      ? Number((db.prepare("SELECT COUNT(*) AS c FROM market_signal_history WHERE availability_status='sold_out'").get() as { c: number }).c)
      : 0;
    const priced = hasHistory
      ? Number((db.prepare("SELECT COUNT(*) AS c FROM market_signal_history WHERE normalized_total_jpy IS NOT NULL").get() as { c: number }).c)
      : 0;
    return {
      market_signal_history_rows: countTable(db, "market_signal_history"),
      market_signal_sync_runs: countTable(db, "market_signal_sync_runs"),
      sold_out_rows: soldOut,
      priced_rows: priced,
      availability_counts: groupCounts(db, "availability_status"),
      basis_confidence_counts: groupCounts(db, "basis_confidence"),
      dp_usage_counts: groupCounts(db, "dp_usage")
    };
  } finally {
    db.close();
  }
}

function readCollectorBaseline(): Record<string, number> {
  if (!existsSync(resolve(DB_PATH))) return {};
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    const out: Record<string, number> = {};
    for (const t of COLLECTOR_BASELINE_TABLES) out[t] = countTable(db, t);
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

function historyUniqueRowIdCount(): number {
  const ids = new Set<string>();
  for (const file of historyShardFiles()) {
    const table = parseCsvTable(readFileSync(resolve(file), "utf8"));
    for (const row of table.rows) {
      const id = row["row_id"];
      if (id !== undefined && id !== "") ids.add(id);
    }
  }
  return ids.size;
}

function mtimes(paths: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of paths) out[p] = existsSync(resolve(p)) ? statSync(resolve(p)).mtimeMs : -1;
  return out;
}

function mtimeMsOrNeg(path: string): number {
  return existsSync(resolve(path)) ? statSync(resolve(path)).mtimeMs : -1;
}

function recordsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function newestReportJson(prefix: string): string | null {
  const dir = resolve(REPORT_DIR);
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .map((n) => ({ name: n, mtime: statSync(resolve(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return matches.length > 0 ? resolve(dir, matches[0]!.name) : null;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  error: string | null;
}

function runScript(scriptPath: string, args: string[], extraEnv: Record<string, string>): CommandResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { encoding: "utf8", env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] }
    );
    return { ok: true, stdout, error: null };
  } catch (error) {
    const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "";
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    return { ok: false, stdout, error: stderr || e.message || "unknown error" };
  }
}

function main(): void {
  const ts = timestamp();
  const runId = `post_auto_history_append_refresh_${ts}`;
  const generatedAtJst = jstIso();
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugPath, { recursive: true });
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const sourceAuto08x = newestReportJson("auto_history_append_") ?? "(none found)";

  // ---- BEFORE state ----
  const dbBefore = readDbSnapshot();
  const collectorBaselineBefore = readCollectorBaseline();
  const historyMtimesBefore = mtimes(historyShardFiles());
  const propertyMasterMtimeBefore = mtimeMsOrNeg(PROPERTY_MASTER);
  const contextMtimesBefore = mtimes(CONTEXT_PACK_FILES);
  const historyUnique = historyUniqueRowIdCount();

  const commandsRun: string[] = [];

  // ---- 1. DB mirror sync ----
  commandsRun.push("HISTORY_TO_DB_SYNC=1 npm run real-run:history-to-db-sync");
  const syncRun = runScript("src/scripts/runHistoryToDbSyncRealRun.ts", [], { HISTORY_TO_DB_SYNC: "1" });
  const syncReportPath = newestReportJson("history_to_db_sync_real_run_");
  const syncReport = syncReportPath ? readJson<Record<string, unknown>>(syncReportPath) : null;
  const psv = (syncReport?.["post_sync_validation"] ?? null) as Record<string, unknown> | null;
  const dbSync: DbSyncSummary = {
    decision: String(syncReport?.["decision"] ?? "missing_sync_report"),
    inserted_rows: Number(syncReport?.["inserted_rows"] ?? 0),
    skipped_identical_rows: Number(syncReport?.["skipped_identical_rows"] ?? 0),
    conflict_rows: Number(syncReport?.["conflict_rows"] ?? 0),
    post_sync_passed: Boolean(psv?.["passed"] ?? false),
    all_source_row_ids_exist: Boolean(psv?.["all_source_row_ids_exist"] ?? false),
    all_row_hashes_match: Boolean(psv?.["all_row_hashes_match"] ?? false),
    duplicate_row_id_count: Number(psv?.["duplicate_row_id_count"] ?? -1),
    sync_run_record_exists: Boolean(psv?.["sync_run_record_exists"] ?? false),
    market_signal_history_count: Number(psv?.["market_signal_history_count"] ?? 0),
    collector_baseline_unchanged: Boolean(psv?.["collector_baseline_unchanged"] ?? false),
    history_mtimes_unchanged: Boolean(psv?.["history_mtimes_unchanged"] ?? false)
  };

  // ---- 2. AI context refresh ----
  commandsRun.push("npm run build:ai-context-packs");
  const contextRun = runScript("src/scripts/buildAiContextPacks.ts", [], {});
  const contextReportPath = newestReportJson("ai_context_packs_");
  const contextReport = contextReportPath ? readJson<Record<string, unknown>>(contextReportPath) : null;
  const contextMtimesAfter = mtimes(CONTEXT_PACK_FILES);
  const regeneratedFiles = CONTEXT_PACK_FILES.filter((p) => (contextMtimesAfter[p] ?? -1) > (contextMtimesBefore[p] ?? -1));
  const realFiles = CONTEXT_PACK_FILES.every((p) => existsSync(resolve(p)) && !lstatSync(resolve(p)).isSymbolicLink());
  const contextRefresh: ContextRefreshSummary = {
    decision: String(contextReport?.["decision"] ?? (contextRun.ok ? "missing_context_report" : "context_refresh_failed")),
    context_packs_regenerated: regeneratedFiles.length === CONTEXT_PACK_FILES.length,
    context_packs_are_real_files: realFiles,
    regenerated_files: regeneratedFiles
  };

  // ---- 3. Task query smoke ----
  const bootstrap = runScript("src/scripts/runAiTaskQuery.ts", ["--task", "bootstrap"], {});
  commandsRun.push("npm run query:ai-task -- --task bootstrap");
  let bootstrapDecision = "query_failed";
  if (bootstrap.ok) {
    const p = newestReportJson("ai_task_query_");
    if (p) bootstrapDecision = String(readJson<Record<string, unknown>>(p)["decision"] ?? "unknown");
  }
  const optionalTasks: TaskSmokeResult[] = [];
  const optionalSpecs: Array<{ label: string; args: string[]; task: string }> = [
    { label: "npm run query:ai-task -- --task sold_out_pressure --limit 10", args: ["--task", "sold_out_pressure", "--limit", "10"], task: "sold_out_pressure" },
    { label: "npm run query:ai-task -- --task market_report --start 2026-06-04 --end 2026-07-31", args: ["--task", "market_report", "--start", "2026-06-04", "--end", "2026-07-31"], task: "market_report" }
  ];
  for (const spec of optionalSpecs) {
    const r = runScript("src/scripts/runAiTaskQuery.ts", spec.args, {});
    commandsRun.push(spec.label);
    let decision = "query_failed";
    if (r.ok) {
      const p = newestReportJson("ai_task_query_");
      if (p) decision = String(readJson<Record<string, unknown>>(p)["decision"] ?? "unknown");
    }
    optionalTasks.push({ task: spec.task, decision, ok: r.ok });
  }
  const taskSmoke: TaskQuerySmokeSummary = {
    bootstrap_decision: bootstrapDecision,
    bootstrap_ok: bootstrap.ok,
    optional_tasks: optionalTasks
  };

  // ---- AFTER state ----
  const dbAfter = readDbSnapshot();
  const collectorBaselineAfter = readCollectorBaseline();
  const historyMtimesAfter = mtimes(historyShardFiles());
  const propertyMasterMtimeAfter = mtimeMsOrNeg(PROPERTY_MASTER);

  const safety: RefreshSafetyState = {
    collector_baseline_unchanged: recordsEqual(collectorBaselineBefore, collectorBaselineAfter),
    history_unchanged_during_refresh: recordsEqual(historyMtimesBefore, historyMtimesAfter),
    property_master_unchanged: propertyMasterMtimeBefore === propertyMasterMtimeAfter,
    live_collector_run: false,
    external_fetch: false,
    history_append_during_refresh: false,
    property_master_mutation: propertyMasterMtimeBefore !== propertyMasterMtimeAfter,
    pms_or_ota_output: false,
    github_actions_or_gitops_or_cron: false,
    git_commit_or_push: false,
    paid_sources: false,
    started_auto09x: false
  };

  const snapshotDiff = diffSnapshots(dbBefore, dbAfter);
  const validation = validateRefresh({
    history_unique_row_id_count: historyUnique,
    db_history_row_count_after: dbAfter.market_signal_history_rows,
    db_sync: dbSync,
    context_refresh: contextRefresh,
    task_smoke: taskSmoke,
    safety
  });

  const decision = decidePostAutoHistoryAppendRefresh({
    db_sync_ok: syncRun.ok && isDbSyncOk(dbSync.decision),
    context_refresh_ok: contextRun.ok && isContextRefreshOk(contextRefresh.decision),
    validation_ok: validation.ok,
    context_decision_is_caution: contextRefresh.decision === CONTEXT_CAUTION_DECISION
  });

  const dataQualityNote = buildDataQualityNote(snapshotDiff);

  const report: PostRefreshReport = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto08x_artifact: sourceAuto08x,
    history_unique_row_id_count: historyUnique,
    db_before: dbBefore,
    db_after: dbAfter,
    snapshot_diff: snapshotDiff,
    db_sync: dbSync,
    context_refresh: contextRefresh,
    task_smoke: taskSmoke,
    validation,
    data_quality_note: dataQualityNote,
    safety,
    commands_run: commandsRun,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath,
    next_phase: recommendedNextAction(decision)
  };

  writeFileSync(reportPath, renderPostRefreshReport(report), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderPostRefreshCsv(report), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_auto08x_artifact.json", { path: sourceAuto08x });
  writeDebug("history_row_count_summary.json", {
    history_unique_row_id_count: historyUnique,
    db_history_rows_before: dbBefore.market_signal_history_rows,
    db_history_rows_after: dbAfter.market_signal_history_rows
  });
  writeDebug("db_sync_summary.json", { ...dbSync, sync_report_path: syncReportPath, stdout: syncRun.stdout, error: syncRun.error });
  writeDebug("context_pack_refresh_summary.json", { ...contextRefresh, context_report_path: contextReportPath, stdout: contextRun.stdout, error: contextRun.error });
  writeDebug("task_query_smoke_summary.json", { ...taskSmoke, bootstrap_stdout: bootstrap.stdout });
  writeDebug("data_quality_note.json", dataQualityNote);
  writeDebug("safety_confirmation.json", { ...safety, validation });

  console.log(`decision=${decision}`);
  console.log(`db_sync_decision=${dbSync.decision} inserted=${dbSync.inserted_rows} skipped=${dbSync.skipped_identical_rows} conflicts=${dbSync.conflict_rows}`);
  console.log(`db_history_rows_after=${dbAfter.market_signal_history_rows} history_unique_row_id=${historyUnique}`);
  console.log(`context_decision=${contextRefresh.decision} regenerated=${contextRefresh.context_packs_regenerated}`);
  console.log(`bootstrap_decision=${taskSmoke.bootstrap_decision} ok=${taskSmoke.bootstrap_ok}`);
  console.log(`validation_ok=${validation.ok} failed_checks=${JSON.stringify(validation.failed_checks)}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);

  const acceptable = new Set([
    "post_auto_history_append_refresh_success",
    "post_auto_history_append_refresh_basis_caution"
  ]);
  if (!acceptable.has(decision)) process.exitCode = 1;
}

main();
