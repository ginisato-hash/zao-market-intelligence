// Phase JALAN-AUTO01X - build Jalan auto integration plan.
//
// Reads local code, history shards, AI context, reports, and the DB mirror in
// read-only mode. Writes plan/debug artifacts only. No live Jalan collection,
// Playwright run, history append, DB write/sync, AI context refresh, or pricing
// output.

import Database from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildBookingBaseline,
  buildDirectDirectionalExcludedPolicy,
  buildFuturePhasePlan,
  buildIntegrationPath,
  buildJalanDataQualityAudit,
  buildJalanFileInventory,
  buildRisks,
  buildSafetyConfirmation,
  decideJalanAutoIntegrationPlan,
  renderInventoryCsv,
  renderReport,
  summarizeSignalRows,
  type FileSource,
  type SignalRowLike
} from "../services/jalanAutoIntegrationPlan";
import { parseCsvTable } from "../services/historyToDbSyncDryRun";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/jalan-auto-integration-plan";
const DB_PATH = ".data/zao-market-intelligence.sqlite";
const HISTORY_DIR = ".data/history";
const AI_CONTEXT_PATHS = [
  ".data/ai-context/latest_market_snapshot.json",
  ".data/ai-context/latest_demand_context.json",
  ".data/ai-context/latest_property_signal_context.json",
  ".data/ai-context/latest_caveats_and_guardrails.json",
  ".data/ai-context/latest_ai_task_entrypoint.json"
];
const SOURCE_DIRS = ["src/collectors", "src/planner", "src/prototype", "src/services", "src/scripts", "tests"];
const REPORT_SCAN_DIRS = [".data/reports/source-discovery", ".data/reports/automation", ".data/reports/market-update"];

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

function listFilesRecursive(root: string): string[] {
  const abs = resolve(root);
  try {
    const entries = readdirSync(abs).sort();
    const out: string[] = [];
    for (const entry of entries) {
      const full = join(abs, entry);
      const rel = join(root, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        out.push(...listFilesRecursive(rel));
      } else if (/\.(ts|tsx|json|md|csv)$/u.test(entry)) {
        out.push(rel);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function loadSourceFiles(): FileSource[] {
  const files = SOURCE_DIRS.flatMap(listFilesRecursive).filter((path) => /jalan|dpSafe|dp-safe|marketSignal|localHistory|crossSource/iu.test(path));
  return files.map((file) => ({ file_path: file, source_text: readFileSync(resolve(file), "utf8") }));
}

function loadHistoryRows(): SignalRowLike[] {
  const files = readdirSync(resolve(HISTORY_DIR)).filter((file) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(file)).sort();
  const rows: SignalRowLike[] = [];
  for (const file of files) {
    const parsed = parseCsvTable(readFileSync(resolve(HISTORY_DIR, file), "utf8"));
    rows.push(...parsed.rows.map((row) => ({ ...row, __source_file: join(HISTORY_DIR, file) } as SignalRowLike)));
  }
  return rows;
}

function loadDbRows(): SignalRowLike[] {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='market_signal_history'").get();
    if (exists === undefined) return [];
    return db.prepare("SELECT * FROM market_signal_history").all() as SignalRowLike[];
  } finally {
    db.close();
  }
}

function loadAiContextSummary(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of AI_CONTEXT_PATHS) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
      out[path] = {
        keys: Object.keys(parsed).slice(0, 20),
        market_signal_history_row_count: parsed["market_signal_history_row_count"],
        source_counts: parsed["source_counts"],
        dp_usage_counts: parsed["dp_usage_counts"],
        basis_confidence_counts: parsed["basis_confidence_counts"]
      };
    } catch {
      out[path] = { missing: true };
    }
  }
  return out;
}

function listRelevantReports(): string[] {
  return REPORT_SCAN_DIRS.flatMap(listFilesRecursive)
    .filter((path) => /jalan|dp_safe|cross_source|market_signal|market_update|local_history/iu.test(path))
    .sort();
}

async function run(): Promise<{ reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string }> {
  const ts = timestamp();
  const runId = `jalan_auto_integration_plan_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugPath, { recursive: true });

  const sourceFiles = loadSourceFiles();
  const fileInventory = buildJalanFileInventory(sourceFiles);
  const historyRows = loadHistoryRows();
  const dbRows = loadDbRows();
  const jalanHistoryRows = historyRows.filter((row) => row.source === "jalan");
  const jalanDbRows = dbRows.filter((row) => row.source === "jalan");
  const bookingDbRows = dbRows.filter((row) => row.source === "booking");
  const historySummary = summarizeSignalRows(historyRows);
  const dbSummary = summarizeSignalRows(dbRows);
  const jalanHistorySummary = summarizeSignalRows(jalanHistoryRows);
  const jalanDbSummary = summarizeSignalRows(jalanDbRows);
  const bookingDbSummary = summarizeSignalRows(bookingDbRows);
  const bookingBaseline = buildBookingBaseline({
    dbSummary,
    bookingSummary: bookingDbSummary,
    historyRowCount: historySummary.total_rows
  });
  const jalanAiContextSummary = loadAiContextSummary();
  const audit = buildJalanDataQualityAudit({ jalanRows: jalanDbRows, inventory: fileInventory });
  const directDirectionalExcludedPolicy = buildDirectDirectionalExcludedPolicy();
  const integrationPath = buildIntegrationPath();
  const futurePhasePlan = buildFuturePhasePlan();
  const risks = buildRisks();
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideJalanAutoIntegrationPlan({ inventory: fileInventory, jalanSummary: jalanDbSummary, audit });
  const relevantReports = listRelevantReports();
  const jalanCurrentState =
    `Jalan rows exist in history/DB/context: DB=${jalanDbSummary.total_rows}, direct=${jalanDbSummary.direct_rows}, directional=${jalanDbSummary.directional_rows}, excluded=${jalanDbSummary.excluded_rows}, property_coverage=${JSON.stringify(jalanDbSummary.property_coverage)}.`;

  const reportPath = resolve(REPORT_DIR, `jalan_auto_integration_plan_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `jalan_auto_integration_plan_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `jalan_auto_integration_plan_${ts}.csv`);

  writeFileSync(csvPath, renderInventoryCsv(fileInventory), "utf8");
  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      bookingBaseline,
      jalanCurrentState,
      fileInventory,
      jalanDbSummary,
      jalanHistorySummary,
      jalanAiContextSummary,
      audit,
      policy: directDirectionalExcludedPolicy,
      integrationPath,
      futurePhasePlan,
      risks,
      reportPath,
      jsonPath,
      csvPath,
      debugPath
    }),
    "utf8"
  );

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    booking_baseline: bookingBaseline,
    jalan_current_state: {
      summary: jalanCurrentState,
      relevant_report_count: relevantReports.length,
      relevant_reports: relevantReports.slice(-80)
    },
    jalan_file_inventory: fileInventory,
    jalan_db_summary: jalanDbSummary,
    jalan_history_summary: jalanHistorySummary,
    jalan_ai_context_summary: jalanAiContextSummary,
    jalan_data_quality_audit: audit,
    direct_directional_excluded_policy: directDirectionalExcludedPolicy,
    integration_path: integrationPath,
    future_phase_plan: futurePhasePlan,
    risks,
    safety_confirmation: safetyConfirmation,
    next_phase: "JALAN-AUTO02X — Jalan target matrix and bounded collection proposal",
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };
  writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf8");

  await writeFile(join(debugPath, "jalan_file_inventory.json"), JSON.stringify(fileInventory, null, 2), "utf8");
  await writeFile(join(debugPath, "jalan_db_summary.json"), JSON.stringify(jalanDbSummary, null, 2), "utf8");
  await writeFile(join(debugPath, "jalan_history_summary.json"), JSON.stringify(jalanHistorySummary, null, 2), "utf8");
  await writeFile(join(debugPath, "jalan_ai_context_summary.json"), JSON.stringify(jalanAiContextSummary, null, 2), "utf8");
  await writeFile(join(debugPath, "jalan_data_quality_audit.json"), JSON.stringify(audit, null, 2), "utf8");
  await writeFile(join(debugPath, "booking_comparison_summary.json"), JSON.stringify({ bookingBaseline, bookingDbSummary }, null, 2), "utf8");
  await writeFile(join(debugPath, "future_phase_plan.json"), JSON.stringify(futurePhasePlan, null, 2), "utf8");
  await writeFile(join(debugPath, "safety_confirmation.json"), JSON.stringify(safetyConfirmation, null, 2), "utf8");

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

run()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`json_path=${result.jsonPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`debug_artifact_path=${result.debugPath}`);
    console.log(`decision=${result.decision}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
