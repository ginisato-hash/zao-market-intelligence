// Phase JALAN-AUTO06X — Jalan price-pressure usability verification (report).
//
// READ-ONLY orchestrator. Opens the DB mirror in readonly mode (no migration, no
// DB mutation), selects Jalan rows from market_signal_history, classifies them
// for SUPPLEMENTARY domestic-OTA price-pressure usability, compares against
// Booking (the primary directional backbone), corroborates with the latest AI
// task query artifacts and AI context snapshot, evaluates invariants, and writes
// a md/json/csv report plus debug artifacts.
//
// This script writes NO history, NO DB rows, runs NO live request / browser
// automation, emits NO property-management or channel-manager output, and
// performs NO price update.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeUsabilitySummary,
  decideUsability,
  evaluateInvariants,
  renderAUTO06XReport,
  renderUsabilityCsv,
  type BookingComparisonSummary,
  type InvariantEnvInput,
  type JalanSignalRow,
  type QueryArtifactRef
} from "../services/jalanPricePressureUsability";

const DB_PATH = ".data/zao-market-intelligence.sqlite";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/jalan-price-pressure-usability";
const AI_CONTEXT_DIR = ".data/ai-context";
const QUERY_TASKS = ["bootstrap", "data_quality", "market_report", "pricing_support"] as const;

// Authoritative list of the 25 rows appended in Phase JALAN-AUTO05X.
const AUTO05X_SELECTED_ROWS =
  ".data/debug/jalan-history-append-real-run/20260605_103629/selected_append_rows.json";

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

function mapDbRow(r: MarketSignalHistoryDbRow): JalanSignalRow {
  return {
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
  };
}

function readSourceRows(db: Database.Database, source: string): JalanSignalRow[] {
  const rows = db
    .prepare(
      `SELECT row_id, source, canonical_property_name, source_property_id, checkin_date, checkout_date,
              stay_scope, collected_date_jst, availability_status, normalized_total_jpy, basis_confidence,
              dp_usage, exclusion_reason
       FROM market_signal_history
       WHERE source = ?
       ORDER BY collected_date_jst, row_id`
    )
    .all(source) as MarketSignalHistoryDbRow[];
  return rows.map(mapDbRow);
}

function countHistoryRows(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM market_signal_history").get() as { count: number }).count;
}

// Authoritative AUTO05X row_id set, from the approved append artifact. Falls back
// to the collected_date_jst='2026-06-05' cohort if the artifact is unavailable.
function readAuto05xRowIds(jalanRows: readonly JalanSignalRow[]): Set<string> {
  const path = resolve(AUTO05X_SELECTED_ROWS);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Array<{ rowId?: string }>;
      const ids = parsed.map((r) => r.rowId).filter((id): id is string => typeof id === "string");
      if (ids.length > 0) return new Set(ids);
    } catch {
      // Fall through to the date-cohort fallback below.
    }
  }
  return new Set(jalanRows.filter((r) => r.collectedDateJst === "2026-06-05").map((r) => r.rowId));
}

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
      latestByTask.set(task, { task, decision: parsed.decision ?? "unknown", jsonPath: path });
    } catch {
      // Ignore unparseable artifacts.
    }
  }

  return QUERY_TASKS.map((task) => latestByTask.get(task)).filter((r): r is QueryArtifactRef => r !== undefined);
}

// Most-recent post_jalan_history_append_refresh JSON (AUTO05B source artifact).
function latestAuto05bArtifact(): string {
  const dir = resolve(REPORT_DIR);
  if (!existsSync(dir)) return "(none)";
  const files = readdirSync(dir)
    .filter((name) => /^post_jalan_history_append_refresh_.*\.json$/.test(name))
    .sort();
  const last = files[files.length - 1];
  return last === undefined ? "(none)" : `${REPORT_DIR}/${last}`;
}

function readAiContextSummary(): unknown {
  const path = resolve(AI_CONTEXT_DIR, "latest_market_snapshot.json");
  if (!existsSync(path)) return { available: false };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      available: true,
      generated_at_jst: j["generated_at_jst"],
      market_signal_history_row_count: j["market_signal_history_row_count"],
      source_counts: j["source_counts"],
      dp_usage_counts: j["dp_usage_counts"],
      basis_confidence_counts: j["basis_confidence_counts"]
    };
  } catch {
    return { available: false };
  }
}

function queryDecisionOk(decision: string): boolean {
  if (/not_ready|not_usable|fail|blocked|error/u.test(decision)) return false;
  return /ready|basis_caution|pass|ok/u.test(decision);
}

function writeDebug(debugPath: string, name: string, data: unknown): void {
  writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function main(): void {
  const ts = timestamp();
  const runId = `jalan_price_pressure_usability_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);

  // READ-ONLY: open the existing DB in readonly mode; never migrate or write.
  const db = new Database(resolve(DB_PATH), { readonly: true });
  let jalanRows: JalanSignalRow[];
  let bookingRows: JalanSignalRow[];
  let dbHistoryRowCount: number;
  try {
    jalanRows = readSourceRows(db, "jalan");
    bookingRows = readSourceRows(db, "booking");
    dbHistoryRowCount = countHistoryRows(db);
  } finally {
    db.close();
  }

  const auto05xRowIds = readAuto05xRowIds(jalanRows);
  const summary = computeUsabilitySummary(jalanRows, auto05xRowIds);

  const bookingDirectionalCount = bookingRows.filter((r) => r.dpUsage === "directional").length;
  const bookingDirectCount = bookingRows.filter((r) => r.dpUsage === "direct").length;
  const bookingComparison: BookingComparisonSummary = {
    totalBookingRows: bookingRows.length,
    bookingDirectionalCount,
    bookingDirectCount,
    jalanDirectionalCount: summary.directionalCount,
    bookingRemainsPrimary: bookingDirectionalCount > summary.directionalCount
  };

  const queryArtifacts = latestQueryArtifacts();
  const querySmokeOk = queryArtifacts.length > 0 && queryArtifacts.every((q) => queryDecisionOk(q.decision));

  // This phase performs no history/DB/context mutation by construction.
  const env: InvariantEnvInput = {
    dbTotalRows: dbHistoryRowCount,
    dbJalanRows: jalanRows.length,
    dbBookingRows: bookingRows.length,
    bookingDirectionalCount,
    jalanDirectionalCount: summary.directionalCount,
    querySmokeOk,
    historyNotModified: true,
    dbNotWritten: true,
    contextNotRefreshed: true
  };
  const invariantChecks = evaluateInvariants(summary, env);
  const decision = decideUsability(summary, invariantChecks);

  const sourceAuto05bArtifactPath = latestAuto05bArtifact();
  const aiContextSummary = readAiContextSummary();

  const reportInput = {
    generatedAtJst,
    runId,
    decision,
    dbHistoryRowCount,
    summary,
    bookingComparison,
    invariantChecks,
    queryArtifacts,
    sourceAuto05bArtifactPath,
    reportPath,
    jsonPath,
    csvPath,
    debugRootPath: debugPath
  };

  const pricePressurePolicy = {
    booking_role: "primary directional market price-pressure backbone",
    jalan_role: "supplementary domestic OTA / same-property trend signal",
    rakuten_role: "frozen / caution",
    jalan_directional_priced_rows_feed_supplementary_price_pressure: true,
    jalan_excluded_rows_are_audit_only_never_price_pressure: true,
    jalan_legacy_direct_rows_are_pre_existing_not_added_by_auto05x: true,
    auto05x_added_zero_direct_rows: summary.auto05x.directCount === 0
  };

  const safetyConfirmation = {
    no_history_mutation: true,
    no_db_write: true,
    no_db_sync: true,
    no_ai_context_refresh: true,
    no_live_request: true,
    no_browser_automation: true,
    no_property_management_or_channel_manager_output: true,
    no_price_update: true,
    no_paid_sources: true
  };

  const risks: string[] = [];
  if (decision !== "jalan_price_pressure_usability_ready") {
    risks.push("jalan_evidence_is_supplementary_b_confidence_use_booking_as_primary");
  }
  if (summary.excludedWithPriceCount > 0) {
    risks.push("some_excluded_rows_carry_a_price_but_are_classified_audit_only");
  }
  if (!querySmokeOk) {
    risks.push("ai_task_query_smoke_incomplete_or_not_passing");
  }

  const jsonPayload = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto05b_artifact: sourceAuto05bArtifactPath,
    db_summary: {
      market_signal_history_row_count: dbHistoryRowCount,
      jalan_rows: jalanRows.length,
      booking_rows: bookingRows.length
    },
    jalan_usability_summary: summary,
    booking_comparison_summary: bookingComparison,
    ai_context_summary: aiContextSummary,
    query_smoke_summary: { ok: querySmokeOk, artifacts: queryArtifacts },
    price_pressure_policy: pricePressurePolicy,
    invariant_checks: invariantChecks,
    risks,
    safety_confirmation: safetyConfirmation,
    next_phase: "AUTO-RUNNER00X (do not start without explicit instruction)"
  };

  writeFileSync(reportPath, renderAUTO06XReport(reportInput), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderUsabilityCsv(jalanRows, auto05xRowIds), "utf8");

  writeDebug(debugPath, "source_auto05b_artifact.json", { path: sourceAuto05bArtifactPath });
  writeDebug(debugPath, "jalan_signal_rows.json", jalanRows);
  writeDebug(debugPath, "jalan_usability_summary.json", summary);
  writeDebug(debugPath, "booking_comparison_summary.json", bookingComparison);
  writeDebug(debugPath, "query_artifacts.json", { ok: querySmokeOk, artifacts: queryArtifacts });
  writeDebug(debugPath, "pricing_support_visibility.json", {
    ai_context_summary: aiContextSummary,
    price_pressure_policy: pricePressurePolicy,
    invariant_checks: invariantChecks
  });
  writeDebug(debugPath, "safety_confirmation.json", safetyConfirmation);

  console.log(`decision=${decision}`);
  console.log(`market_signal_history_row_count=${dbHistoryRowCount}`);
  console.log(`total_jalan_rows=${summary.totalJalanRows}`);
  console.log(`directional=${summary.directionalCount} excluded=${summary.excludedCount} direct=${summary.directCount}`);
  console.log(`jalan_price_pressure_usable=${summary.pricePressureUsableCount}`);
  console.log(`excluded_classified_usable (must be 0)=${summary.excludedClassifiedUsableCount}`);
  console.log(
    `auto05x rows=${summary.auto05x.rowsCount} directional=${summary.auto05x.directionalCount} excluded=${summary.auto05x.excludedCount} direct=${summary.auto05x.directCount}`
  );
  console.log(`booking_directional=${bookingDirectionalCount} jalan_directional=${summary.directionalCount} booking_primary=${bookingComparison.bookingRemainsPrimary}`);
  console.log(`query_smoke_ok=${querySmokeOk}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

if (process.argv[1]?.endsWith("buildJalanPricePressureUsabilityReport.ts")) {
  main();
}
