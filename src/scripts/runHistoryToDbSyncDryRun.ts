// Phase AUTO03X — run history-to-DB sync dry-run.
//
// Reads local history shards and AUTO02X design artifacts. Writes dry-run
// reports/debug artifacts only. Does not execute SQL, open/write DB, create
// migrations, mutate history/property exports, run collectors, fetch external
// pages, or activate workflows.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildHistoryToDbSyncDryRun,
  mapHistoryRowToMarketSignalHistoryRow,
  parseCsvTable,
  renderHistoryToDbSyncDryRunCsv,
  renderHistoryToDbSyncDryRunReport,
  validateRequiredColumns,
  type LoadedHistoryRow
} from "../services/historyToDbSyncDryRun";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/history-to-db-sync-dry-run";
const HISTORY_DIR = ".data/history";

const AUTO02X_JSON = ".data/reports/automation/db_ai_views_schema_design_20260603_220358.json";
const AUTO02X_SCHEMA_DRAFT = ".data/debug/db-ai-views-schema-design/20260603_220358/schema_draft.sql";
const AUTO02X_VIEWS_DRAFT = ".data/debug/db-ai-views-schema-design/20260603_220358/views_draft.sql";
const AI_MANIFEST_JSON = ".data/reports/market-update/ai_readable_market_manifest_latest.json";
const DATA_DICTIONARY_JSON = ".data/reports/market-update/market_data_dictionary_latest.json";

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

function loadHistoryRows(): { files: string[]; loadedRows: LoadedHistoryRow[]; headersByFile: { path: string; headers: string[] }[] } {
  const files = readdirSync(resolve(HISTORY_DIR))
    .filter((name) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(name))
    .sort()
    .map((name) => `${HISTORY_DIR}/${name}`);
  const loadedRows: LoadedHistoryRow[] = [];
  const headersByFile: { path: string; headers: string[] }[] = [];
  for (const file of files) {
    const table = parseCsvTable(readFileSync(resolve(file), "utf8"));
    headersByFile.push({ path: file, headers: table.headers });
    for (const row of table.rows) {
      loadedRows.push({ sourceFile: file, row: { ...row, __source_file: file } });
    }
  }
  return { files, loadedRows, headersByFile };
}

function inspectInput(path: string): { path: string; exists: boolean; bytes: number } {
  const full = resolve(path);
  if (!existsSync(full)) return { path, exists: false, bytes: 0 };
  return { path, exists: true, bytes: readFileSync(full, "utf8").length };
}

function main(): void {
  const ts = timestamp();
  const runId = `history_to_db_sync_dry_run_${ts}`;
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);
  const history = loadHistoryRows();
  const requiredColumnCheck = validateRequiredColumns(history.headersByFile);

  const plan = buildHistoryToDbSyncDryRun({
    runId,
    generatedAtJst: jstIso(),
    reportPath,
    sourceHistoryFiles: history.files,
    loadedRows: history.loadedRows,
    requiredColumnCheck
  });

  writeFileSync(reportPath, renderHistoryToDbSyncDryRunReport(plan), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderHistoryToDbSyncDryRunCsv(plan), "utf8");

  const mappedRows = history.loadedRows.map((r) => mapHistoryRowToMarketSignalHistoryRow(r.row, plan.generated_at_jst));
  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_history_files.json", history.files);
  writeDebug("history_rows_loaded.json", {
    row_count: history.loadedRows.length,
    rows: history.loadedRows
  });
  writeDebug("mapped_market_signal_history_rows.json", {
    row_count: mappedRows.length,
    rows: mappedRows
  });
  writeDebug("dedupe_summary.json", plan.dedupe_summary);
  writeDebug("conflict_summary.json", plan.conflict_summary);
  writeDebug("sync_action_plan.json", plan.sync_action_plan);
  writeDebug("sync_run_preview.json", plan.sync_run_preview);
  writeDebug("validation_result.json", plan.validation_result);
  writeDebug("safety_confirmation.json", plan.safety_confirmation);
  writeDebug("input_artifacts_used.json", {
    AUTO02X_JSON: inspectInput(AUTO02X_JSON),
    AUTO02X_SCHEMA_DRAFT: inspectInput(AUTO02X_SCHEMA_DRAFT),
    AUTO02X_VIEWS_DRAFT: inspectInput(AUTO02X_VIEWS_DRAFT),
    AI_MANIFEST_JSON: inspectInput(AI_MANIFEST_JSON),
    DATA_DICTIONARY_JSON: inspectInput(DATA_DICTIONARY_JSON),
    package_json: inspectInput("package.json")
  });

  console.log(`decision=${plan.decision}`);
  console.log(`history_row_count=${plan.history_row_count}`);
  console.log(`mapped_row_count=${plan.mapped_row_count}`);
  console.log(`would_insert_rows=${plan.dedupe_summary.would_insert_rows}`);
  console.log(`would_skip_identical_rows=${plan.dedupe_summary.would_skip_identical_rows}`);
  console.log(`would_conflict_rows=${plan.dedupe_summary.would_conflict_rows}`);
  console.log(`sync_run_status=${plan.sync_run_preview.status}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

main();
