// Phase AUTO-RUNNER07C - fresh history-to-DB sync helper.
//
// This command writes the DB only when HISTORY_TO_DB_SYNC=1. It always builds a
// fresh mapping from current .data/history in the same run and does not use
// timestamped dry-run input pointers or manually pinned mapped-row constants.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_LOCAL_DB_PATH } from "../db/client";
import { runFreshHistoryToDbSync } from "../services/freshHistoryToDbSync";

const SOURCE_AUTO_RUNNER07B_ARTIFACT = ".data/reports/automation/auto_runner_fresh_db_sync_proposal_20260605_162934.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/fresh-history-to-db-sync";
const HISTORY_DIR = ".data/history";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

function main(): void {
  const ts = timestamp();
  const runId = `fresh_history_to_db_sync_${ts}`;
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const report = runFreshHistoryToDbSync({
    runId,
    generatedAtJst: jstIso(),
    historyDir: HISTORY_DIR,
    dbPath: DEFAULT_LOCAL_DB_PATH,
    reportPath: resolve(REPORT_DIR, `${runId}.md`),
    jsonPath: resolve(REPORT_DIR, `${runId}.json`),
    csvPath: resolve(REPORT_DIR, `${runId}.csv`),
    debugPath,
    historyToDbSyncGate: process.env["HISTORY_TO_DB_SYNC"],
    expectedHistoryRowCount: process.env["EXPECTED_HISTORY_ROW_COUNT"],
    sourceAutoRunner07bArtifact: SOURCE_AUTO_RUNNER07B_ARTIFACT
  });

  console.log(`decision=${report.decision}`);
  console.log(`history_count=${report.history_summary.row_count}`);
  console.log(`mapped_row_count=${report.fresh_mapping_summary.mapped_row_count}`);
  console.log(`conflicts=${report.fresh_mapping_summary.would_conflict_rows}`);
  console.log(`db_write_executed=${report.sync_result.db_write_executed}`);
  console.log(`inserted_rows=${report.sync_result.inserted_rows}`);
  console.log(`skipped_identical_rows=${report.sync_result.skipped_identical_rows}`);
  console.log(`conflict_rows=${report.sync_result.conflict_rows}`);
  console.log(`db_before_count=${report.db_before_summary.market_signal_history_count}`);
  console.log(`db_after_count=${report.db_after_summary.market_signal_history_count}`);
  console.log(`report_path=${report.report_path}`);
  console.log(`json_path=${report.json_path}`);
  console.log(`csv_path=${report.csv_path}`);
  console.log(`debug_artifact_path=${report.debug_artifact_path}`);
}

main();
