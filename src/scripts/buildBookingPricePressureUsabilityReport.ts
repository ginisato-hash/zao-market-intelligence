// Phase BOOKING-B12X — Booking price-pressure usability verification (report).
//
// READ-ONLY orchestrator. Opens the DB mirror WITHOUT running migrations (no DB
// mutation), selects Booking rows from market_signal_history, classifies them
// for price-pressure usability, corroborates with the latest AI task query
// artifacts, and writes a md/json/csv report plus debug artifacts.
//
// This script writes NO history, NO DB rows, runs NO live request / browser
// automation, emits NO property-management or channel-manager output, and
// performs NO price update.

import { closeDatabase, openLocalDatabase, type LocalDatabase } from "../db/client";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeUsabilitySummary,
  decideUsability,
  renderB12XReport,
  renderUsabilityCsv,
  type BookingSignalRow,
  type QueryArtifactRef
} from "../services/bookingPricePressureUsability";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/booking-price-pressure-usability";
const QUERY_TASKS = ["bootstrap", "data_quality", "market_report", "pricing_support"] as const;

interface MarketSignalHistoryDbRow {
  row_id: string;
  source: string;
  canonical_property_name: string;
  source_property_id: string;
  checkin_date: string;
  checkout_date: string;
  stay_scope: string;
  collected_date_jst: string;
  availability_status: string;
  normalized_total_jpy: number | null;
  basis_confidence: string;
  dp_usage: string;
  exclusion_reason: string;
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

function readBookingRows(db: LocalDatabase): BookingSignalRow[] {
  const rows = db
    .prepare(
      `SELECT row_id, source, canonical_property_name, source_property_id, checkin_date, checkout_date,
              stay_scope, collected_date_jst, availability_status, normalized_total_jpy, basis_confidence,
              dp_usage, exclusion_reason
       FROM market_signal_history
       WHERE source = 'booking'
       ORDER BY collected_date_jst, row_id`
    )
    .all() as MarketSignalHistoryDbRow[];
  return rows.map((r) => ({
    rowId: r.row_id,
    source: r.source,
    canonicalPropertyName: r.canonical_property_name,
    sourcePropertyId: r.source_property_id,
    checkinDate: r.checkin_date,
    checkoutDate: r.checkout_date,
    stayScope: r.stay_scope,
    collectedDateJst: r.collected_date_jst,
    availabilityStatus: r.availability_status,
    normalizedTotalJpy: r.normalized_total_jpy,
    basisConfidence: r.basis_confidence,
    dpUsage: r.dp_usage,
    exclusionReason: r.exclusion_reason
  }));
}

function countHistoryRows(db: LocalDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM market_signal_history").get() as { count: number }).count;
}

// Find the latest ai_task_query_*.json per task and capture task+decision+path.
function latestQueryArtifacts(): QueryArtifactRef[] {
  const dir = resolve(REPORT_DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => /^ai_task_query_.*\.json$/.test(name))
    .sort();

  const latestByTask = new Map<string, QueryArtifactRef>();
  for (const name of files) {
    const path = `${REPORT_DIR}/${name}`;
    try {
      const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as { task?: string; decision?: string };
      const task = parsed.task;
      if (task === undefined || !QUERY_TASKS.includes(task as (typeof QUERY_TASKS)[number])) continue;
      // Files are sorted ascending; later entries overwrite -> last (latest) wins.
      latestByTask.set(task, { task, decision: parsed.decision ?? "unknown", jsonPath: path });
    } catch {
      // Ignore unparseable artifacts.
    }
  }

  return QUERY_TASKS.map((task) => latestByTask.get(task)).filter((r): r is QueryArtifactRef => r !== undefined);
}

function writeDebug(debugPath: string, name: string, data: unknown): void {
  writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function main(): void {
  const ts = timestamp();
  const runId = `booking_price_pressure_usability_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);

  // READ-ONLY: open the existing DB, do NOT run migrations / write any rows.
  const db = openLocalDatabase();
  let bookingRows: BookingSignalRow[];
  let dbHistoryRowCount: number;
  try {
    bookingRows = readBookingRows(db);
    dbHistoryRowCount = countHistoryRows(db);
  } finally {
    closeDatabase(db);
  }

  const summary = computeUsabilitySummary(bookingRows);
  const decision = decideUsability(summary);
  const queryArtifacts = latestQueryArtifacts();

  const reportInput = {
    generatedAtJst,
    runId,
    decision,
    dbHistoryRowCount,
    summary,
    queryArtifacts,
    reportPath,
    jsonPath,
    csvPath,
    debugRootPath: debugPath
  };

  const safetyConfirmation = {
    no_history_mutation: true,
    no_db_mutation: true,
    no_live_request: true,
    no_browser_automation: true,
    no_property_management_or_channel_manager_output: true,
    no_price_update: true,
    no_paid_sources: true
  };

  writeFileSync(reportPath, renderB12XReport(reportInput), "utf8");
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ ...reportInput, safety_confirmation: safetyConfirmation }, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(csvPath, renderUsabilityCsv(bookingRows), "utf8");

  writeDebug(debugPath, "booking_signal_rows.json", bookingRows);
  writeDebug(debugPath, "usability_summary.json", summary);
  writeDebug(debugPath, "repeated_observations.json", summary.repeatedObservations);
  writeDebug(debugPath, "price_movement_samples.json", summary.priceMovementSamples);
  writeDebug(debugPath, "query_artifacts.json", queryArtifacts);
  writeDebug(debugPath, "safety_confirmation.json", safetyConfirmation);

  console.log(`decision=${decision}`);
  console.log(`market_signal_history_row_count=${dbHistoryRowCount}`);
  console.log(`total_booking_rows=${summary.totalBookingRows}`);
  console.log(`directional=${summary.directionalCount} excluded=${summary.excludedCount} direct=${summary.directCount}`);
  console.log(`price_pressure_usable=${summary.pricePressureUsableCount}`);
  console.log(`excluded_rows_with_a_price=${summary.excludedWithPriceCount}`);
  console.log(`obs_qualified_rows=${summary.obsQualifiedRowCount}`);
  console.log(`repeated_market_identities=${summary.repeatedMarketIdentityCount}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

if (process.argv[1]?.endsWith("buildBookingPricePressureUsabilityReport.ts")) {
  main();
}
