// Phase AUTO04X — guarded real DB mirror sync from history.
//
// Requires explicit user approval plus HISTORY_TO_DB_SYNC=1. Without the env
// flag, this script fails closed and does not open/write the DB.

import { closeDatabase, openLocalDatabase } from "../db/client";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  APPROVED_TARGET_TABLES,
  applyRealSync,
  buildReadyNotRunReport,
  buildSuccessReport,
  ensureMirrorSchema,
  evaluateApprovalGate,
  readCollectorBaseline,
  renderHistoryToDbSyncRealRunCsv,
  renderHistoryToDbSyncRealRunReport,
  validatePostSync,
  type DryRunSourceSummary,
  type HistoryToDbSyncRealRunReport
} from "../services/historyToDbSyncRealRun";
import type { MarketSignalHistoryDryRunRow } from "../services/historyToDbSyncDryRun";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/history-to-db-sync-real-run";
const HISTORY_DIR = ".data/history";
// JALAN-AUTO05B: repointed to the fresh dry-run regenerated from the current
// .data/history (210 rows = 185 prior baseline + 25 approved Jalan AUTO05X rows).
// The prior 20260604_212242 pointer was the 185-row B11B dry-run and predates the
// AUTO05X Jalan append, so syncing from it would have missed the 25 new Jalan rows.
// This pointer + APPROVED_MAPPED_ROW_COUNT=210 keep the gate aligned with the
// on-disk history.
const AUTO03X_JSON = ".data/reports/automation/history_to_db_sync_dry_run_20260605_104149.json";
const AUTO03X_MAPPED_ROWS = ".data/debug/history-to-db-sync-dry-run/20260605_104149/mapped_market_signal_history_rows.json";

const EXPLICIT_USER_APPROVED = true;

interface MappedRowsArtifact {
  rows: MarketSignalHistoryDryRunRow[];
}

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

function historyFiles(): string[] {
  return readdirSync(resolve(HISTORY_DIR))
    .filter((name) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(name))
    .sort()
    .map((name) => `${HISTORY_DIR}/${name}`);
}

function historyMtimes(files: string[]): Record<string, number> {
  return Object.fromEntries(files.map((file) => [file, statSync(resolve(file)).mtimeMs]));
}

function mtimesUnchanged(before: Record<string, number>): boolean {
  return Object.entries(before).every(([file, mtime]) => existsSync(resolve(file)) && statSync(resolve(file)).mtimeMs === mtime);
}

function writeArtifacts(report: HistoryToDbSyncRealRunReport, debugPath: string): void {
  writeFileSync(report.report_path, renderHistoryToDbSyncRealRunReport(report), "utf8");
  writeFileSync(report.json_path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(report.csv_path, renderHistoryToDbSyncRealRunCsv(report), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_dry_run.json", safeReadJson(AUTO03X_JSON));
  writeDebug("approval_gate_result.json", report.explicit_approval_result);
  writeDebug("db_schema_preflight.json", report.db_schema_handling);
  writeDebug("source_history_files.json", historyFiles());
  writeDebug("mapped_rows_preview.json", report.sync_actions.slice(0, 20));
  writeDebug("sync_actions.json", report.sync_actions);
  writeDebug("sync_run_record.json", report.sync_run_record);
  writeDebug("post_sync_validation.json", report.post_sync_validation);
  writeDebug("idempotency_check.json", report.idempotency_check);
  writeDebug("safety_confirmation.json", report.safety_confirmation);
}

function safeReadJson(path: string): unknown {
  if (!existsSync(resolve(path))) return { missing: path };
  return readJson<unknown>(path);
}

function main(): void {
  const ts = timestamp();
  const runId = `history_to_db_sync_real_run_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);

  const dryRun = existsSync(resolve(AUTO03X_JSON)) ? readJson<DryRunSourceSummary>(AUTO03X_JSON) : null;
  const gate = evaluateApprovalGate({
    explicitUserApproved: EXPLICIT_USER_APPROVED,
    envFlag: process.env["HISTORY_TO_DB_SYNC"],
    dryRun,
    targetTables: [...APPROVED_TARGET_TABLES],
    collectorTableWriteMode: false,
    liveCollectorMode: false,
    githubActionsMode: false
  });

  if (!gate.passed) {
    const report = buildReadyNotRunReport({
      runId,
      generatedAtJst,
      gate,
      sourceArtifact: AUTO03X_JSON,
      reportPath,
      jsonPath,
      csvPath,
      debugPath
    });
    writeArtifacts(report, debugPath);
    printReportSummary(report);
    return;
  }

  const sourceRows = readJson<MappedRowsArtifact>(AUTO03X_MAPPED_ROWS).rows;
  const sourceHistoryFiles = historyFiles();
  const historyMtimesBefore = historyMtimes(sourceHistoryFiles);
  const db = openLocalDatabase();
  try {
    const collectorBaselineBefore = readCollectorBaseline(db);
    const schemaPreflight = ensureMirrorSchema(db);
    const syncResult = applyRealSync({
      db,
      runId,
      generatedAtJst,
      reportPath,
      sourceHistoryFiles,
      rows: sourceRows
    });
    const validation = validatePostSync({
      db,
      sourceRows,
      syncRunId: syncResult.sync_run_record.sync_run_id,
      collectorBaselineBefore,
      historyMtimesUnchanged: mtimesUnchanged(historyMtimesBefore)
    });
    const report = buildSuccessReport({
      runId,
      generatedAtJst,
      gate,
      sourceArtifact: AUTO03X_JSON,
      schemaPreflight,
      syncResult,
      postSyncValidation: validation,
      reportPath,
      jsonPath,
      csvPath,
      debugPath
    });
    writeArtifacts(report, debugPath);
    printReportSummary(report);
  } finally {
    closeDatabase(db);
  }
}

function printReportSummary(report: HistoryToDbSyncRealRunReport): void {
  console.log(`decision=${report.decision}`);
  console.log(`approval_gate_passed=${report.explicit_approval_result.passed}`);
  console.log(`inserted_rows=${report.inserted_rows}`);
  console.log(`skipped_identical_rows=${report.skipped_identical_rows}`);
  console.log(`conflict_rows=${report.conflict_rows}`);
  console.log(`report_path=${report.report_path}`);
  console.log(`json_path=${report.json_path}`);
  console.log(`csv_path=${report.csv_path}`);
  console.log(`debug_artifact_path=${report.debug_artifact_path}`);
}

main();
