// Phase DP01X — build the Zao Demand Index / DP Matrix design report.
//
// Reads .data/history/zao_signals_*.csv (read-only) and produces a local
// Markdown/CSV/JSON + debug design packet. This script NEVER modifies
// .data/history, NEVER writes the DB, NEVER updates prices, NEVER produces
// PMS/Beds24/AirHost/OTA output, NEVER enables GitHub Actions/GitOps/cron,
// NEVER commits/pushes, and NEVER performs a live external fetch.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildDemandIndexRows,
  computePriceReference,
  countBy,
  decideDP01X,
  renderDemandIndexCsv,
  renderDesignReport,
  type DemandIndexRow,
  type DesignSummary,
  type HistoryRow
} from "../services/zaoDemandIndexDesign";

const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/market-update";
const DEBUG_ROOT = ".data/debug/zao-demand-index-design";
const HISTORY_FILE_RE = /^zao_signals_\d{4}_\d{2}\.csv$/;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstParts(): { iso: string; date: string } {
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
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { iso: `${date}T${get("hour")}:${get("minute")}:${get("second")}+09:00`, date };
}

// Quote-aware CSV parse → array of header-keyed records.
function parseCsv(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    const next = csv[i + 1];
    if (inQuotes && ch === "\"" && next === "\"") {
      cell += "\"";
      i++;
    } else if (ch === "\"") {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((v) => v !== "")) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((v) => v !== "")) matrix.push(row);
  }
  const headers = matrix.shift() ?? [];
  const rows = matrix.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { headers, rows };
}

function toHistoryRow(r: Record<string, string>): HistoryRow {
  return {
    source: r["source"] ?? "",
    canonicalPropertyName: r["canonical_property_name"] ?? "",
    checkin: r["checkin"] ?? "",
    checkout: r["checkout"] ?? "",
    stayScope: r["stay_scope"] ?? "",
    availabilityStatus: r["availability_status"] ?? "",
    soldOutStatus: r["sold_out_status"] ?? "",
    normalizedTotalPrice: r["normalized_total_price"] ?? "",
    basisConfidence: r["basis_confidence"] ?? "",
    isPriceUsableForDpDirect: r["is_price_usable_for_dp_direct"] ?? "",
    isPriceUsableForDpDirectional: r["is_price_usable_for_dp_directional"] ?? "",
    isPriceExcludedFromDp: r["is_price_excluded_from_dp"] ?? "",
    dpExclusionReason: r["dp_exclusion_reason"] ?? "",
    warningFlags: r["warning_flags"] ?? ""
  };
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  const ts = timestamp();
  const runId = `zao_demand_index_design_${ts}`;
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  const jst = jstParts();

  // ---- Read history (read-only) ----
  const historyDir = resolve(HISTORY_DIR);
  let fileNames: string[];
  try {
    fileNames = readdirSync(historyDir).filter((n) => HISTORY_FILE_RE.test(n)).sort();
  } catch {
    throw new Error(`Missing history directory: ${historyDir}. Stop and report the missing .data/history path. Do not re-run collectors.`);
  }

  const historyFiles = fileNames.map((n) => resolve(historyDir, n));
  const allRows: HistoryRow[] = [];
  const schemaHeaders = new Set<string>();
  for (const path of historyFiles) {
    const parsed = parseCsv(readFileSync(path, "utf8"));
    parsed.headers.forEach((h) => schemaHeaders.add(h));
    for (const r of parsed.rows) allRows.push(toHistoryRow(r));
  }

  const reference = computePriceReference(allRows);

  const ctx = {
    runId,
    generatedAtJst: jst.iso,
    todayJst: jst.date,
    refP66: reference.refP66,
    refP90: reference.refP90,
    debugArtifactPath: debugRootPath
  };

  const rows: DemandIndexRow[] = buildDemandIndexRows(allRows, ctx);

  const directPriceRowCount = rows.reduce((s, r) => s + r.directPriceRowCount, 0);
  const directionalPriceRowCount = rows.reduce((s, r) => s + r.directionalPriceRowCount, 0);
  const avgSourceCount = rows.length > 0 ? rows.reduce((s, r) => s + r.sourceCount, 0) / rows.length : 0;

  const decision = decideDP01X({
    historyFileCount: historyFiles.length,
    historyRowCount: allRows.length,
    demandRowCount: rows.length,
    directPriceRowCount,
    directionalPriceRowCount,
    avgSourceCount
  });

  // ---- Output paths ----
  const reportDir = resolve(REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `zao_demand_index_design_${ts}.md`);
  const csvPath = resolve(reportDir, `zao_demand_index_design_${ts}.csv`);
  const jsonPath = resolve(reportDir, `zao_demand_index_design_${ts}.json`);

  const summary: DesignSummary = {
    runId,
    generatedAt: jst.iso,
    sourceHistoryFiles: historyFiles,
    historyRowCount: allRows.length,
    demandRowCount: rows.length,
    refP66: reference.refP66,
    refP90: reference.refP90,
    decision,
    demandBandCounts: countBy(rows.map((r) => r.demandBand)),
    pricingPostureCounts: countBy(rows.map((r) => r.pricingPosture)),
    congestionRankCounts: countBy(rows.map((r) => r.congestionForecastRank)),
    confidenceLevelCounts: countBy(rows.map((r) => r.confidenceLevel)),
    reportPath,
    csvPath,
    jsonPath,
    debugRootPath
  };

  writeFileSync(csvPath, renderDemandIndexCsv(rows), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ summary, rows }, null, 2), "utf8");
  writeFileSync(reportPath, renderDesignReport({ summary, rows }), "utf8");

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_history_files.json", { historyFiles, fileCount: historyFiles.length, historyRowCount: allRows.length });
  writeDebug("history_schema_summary.json", { headers: [...schemaHeaders], priceReference: reference });
  writeDebug("date_aggregation_rows.json", rows.map((r) => ({
    checkinDate: r.checkinDate,
    checkoutDate: r.checkoutDate,
    stayScope: r.stayScope,
    rowCount: r.rowCount,
    sourceCount: r.sourceCount,
    propertyCount: r.propertyCount
  })));
  writeDebug("scoring_component_rows.json", rows.map((r) => ({
    checkinDate: r.checkinDate,
    soldOutPressureScore: r.soldOutPressureScore,
    pricePressureScore: r.pricePressureScore,
    confidenceScore: r.confidenceScore,
    calendarScore: r.calendarScore,
    bookingWindowScore: r.bookingWindowScore
  })));
  writeDebug("demand_index_rows.json", rows);
  writeDebug("pricing_posture_summary.json", summary.pricingPostureCounts);
  writeDebug("congestion_forecast_summary.json", summary.congestionRankCounts);
  writeDebug("safety_confirmation.json", {
    readDataHistoryOnly: true,
    modifiedDataHistory: false,
    modifiedPropertyMaster: false,
    dbWrites: false,
    priceUpdates: false,
    pmsOutput: false,
    beds24Output: false,
    airhostOutput: false,
    otaUpload: false,
    bookingBaseTimes1_1: false,
    githubActionsOrGitOps: false,
    versionControlCommitsOrPushes: false,
    liveExternalFetch: false,
    collectorReRun: false,
    paidSources: false
  });

  return { reportPath, csvPath, jsonPath, debugRootPath, decision };
}

try {
  const result = build();
  console.log(`report_path=${result.reportPath}`);
  console.log(`csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`decision=${result.decision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
