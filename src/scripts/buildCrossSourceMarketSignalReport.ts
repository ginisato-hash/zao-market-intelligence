// Phase M01X — build the cross-source unified market-signal report.
//
// Reads three local source artifacts (no collectors are re-run):
//   1. Booking B04X JSON  (.rows[] = NormalizedMarketSignalRow)
//   2. Rakuten Phase 66X CSV (day rows)
//   3. Jalan DP-safe CSV (date-level aggregate rows)
// Normalizes each into the unified schema, builds summaries, and writes
// timestamped MD/CSV/JSON plus debug artifacts. NO DB writes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCrossSourceDateSummary,
  buildSourceDateSummary,
  decideM01X,
  normalizeBookingToUnified,
  normalizeJalanToUnified,
  normalizeRakutenToUnified,
  renderCrossSourceReport,
  renderUnifiedCsv,
  summarizeDpGateBySource,
  type JalanDpSafeInput,
  type RakutenDayInput,
  type SourceArtifactPaths,
  type UnifiedMarketSignalRow
} from "../services/crossSourceMarketSignalNormalization";
import { type NormalizedMarketSignalRow as BookingB04XRow } from "../services/bookingMarketSignalNormalization";

const SOURCE_DISCOVERY_DIR = ".data/reports/source-discovery";
const MARKET_UPDATE_DIR = ".data/reports/market-update";
const DEBUG_ROOT = ".data/debug/cross-source-market-signals";

const BOOKING_PREFIX = "booking_market_signal_normalization_";
const RAKUTEN_PREFIX = "rakuten_limited_collector_prototype_";
const JALAN_CSV_PREFIX = "dp_safe_market_signals_";
const JALAN_REPORT_PREFIX = "dp_safe_market_signal_report_";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function normalizedAtJst(): string {
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

function latestWithPrefix(dir: string, prefix: string, suffix: string): string {
  const abs = resolve(dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    throw new Error(`Missing artifact directory: ${abs}. Do not re-run collectors; produce the source artifact first.`);
  }
  const matches = entries.filter((name) => name.startsWith(prefix) && name.endsWith(suffix)).sort();
  const latest = matches.at(-1);
  if (!latest) {
    throw new Error(
      `Missing required source artifact (expected ${prefix}*${suffix} in ${abs}). Do not re-run collectors; stop and report the missing path.`
    );
  }
  return resolve(abs, latest);
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toRecords(content: string): Record<string, string>[] {
  const rows = parseCsv(content).filter((r) => r.some((cell) => cell.trim() !== ""));
  const header = rows[0];
  if (!header) return [];
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((key, idx) => {
      record[key] = cells[idx] ?? "";
    });
    return record;
  });
}

function numOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function boolOf(value: string | undefined): boolean {
  return (value ?? "").trim() === "true";
}

// ---------------------------------------------------------------------------
// Source loaders
// ---------------------------------------------------------------------------

function loadBookingRows(jsonPath: string): BookingB04XRow[] {
  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf8");
  } catch {
    throw new Error(`Missing Booking B04X source JSON: ${jsonPath}. Stop and report the missing artifact path.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    throw new Error(`Malformed Booking B04X JSON ${jsonPath}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const rows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Booking B04X JSON ${jsonPath} has no rows[]. Stop and report the malformed artifact.`);
  }
  return rows as BookingB04XRow[];
}

function loadRakutenRows(csvPath: string): RakutenDayInput[] {
  let raw: string;
  try {
    raw = readFileSync(csvPath, "utf8");
  } catch {
    throw new Error(`Missing Rakuten Phase 66X source CSV: ${csvPath}. Stop and report the missing artifact path.`);
  }
  const records = toRecords(raw);
  if (records.length === 0) {
    throw new Error(`Rakuten source CSV ${csvPath} has no day rows. Stop and report the malformed artifact.`);
  }
  return records.map((r) => ({
    runId: r.run_id ?? "",
    collectedAtJst: r.collected_at_jst ?? "",
    propertyName: r.property_name ?? "",
    hotelNo: r.hotel_no ?? "",
    // Use date_iso, never Rakuten epoch (UTC day-shift bug).
    dateIso: r.date_iso ?? "",
    isPast: boolOf(r.is_past),
    isFull: boolOf(r.is_full),
    isVacant: boolOf(r.is_vacant),
    rawPrice: numOrNull(r.raw_price) ?? 0,
    computed2AdultTotal: (() => {
      const n = numOrNull(r.computed_2_adult_total);
      return n === null || n === 0 ? null : n;
    })(),
    chargeType: r.charge_type ?? "",
    sourcePriceBasis: r.source_price_basis ?? "",
    basisConfidence: r.basis_confidence ?? "",
    basisNote: r.basis_note ?? "",
    linkPresent: boolOf(r.link_present),
    classification: r.classification ?? "",
    debugArtifactPath: r.debug_artifact_path ?? ""
  }));
}

function loadJalanRows(csvPath: string, runId: string, normalizedAt: string): JalanDpSafeInput[] {
  let raw: string;
  try {
    raw = readFileSync(csvPath, "utf8");
  } catch {
    throw new Error(`Missing Jalan DP-safe source CSV: ${csvPath}. Stop and report the missing artifact path.`);
  }
  const records = toRecords(raw);
  if (records.length === 0) {
    throw new Error(`Jalan source CSV ${csvPath} has no aggregate rows. Stop and report the malformed artifact.`);
  }
  return records.map((r) => ({
    runId,
    normalizedAtJst: normalizedAt,
    stayDate: r.stay_date ?? "",
    confidence: r.confidence ?? "",
    rawMedianJpy: numOrNull(r.raw_median_jpy),
    qualityAdjustedMedianJpy: numOrNull(r.quality_adjusted_median_jpy),
    dpSafeMedianJpy: numOrNull(r.dp_safe_median_jpy),
    useClass: r.use_class ?? "",
    availableCount: numOrNull(r.available_count) ?? 0,
    failedCount: numOrNull(r.failed_count) ?? 0,
    excludedQualityRowsCount: numOrNull(r.excluded_quality_rows_count) ?? 0,
    reason: r.reason ?? "",
    warningFlags: r.warning_flags ?? ""
  }));
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function build(): {
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
  rows: UnifiedMarketSignalRow[];
  decision: string;
} {
  const ts = timestamp();
  const normalizedAt = normalizedAtJst();

  // Resolve latest source artifacts (do not re-run collectors).
  const bookingJson = latestWithPrefix(SOURCE_DISCOVERY_DIR, BOOKING_PREFIX, ".json");
  const bookingBase = bookingJson.slice(0, -".json".length);
  const bookingPaths: SourceArtifactPaths = { reportPath: `${bookingBase}.md`, csvPath: `${bookingBase}.csv` };

  const rakutenCsv = latestWithPrefix(SOURCE_DISCOVERY_DIR, RAKUTEN_PREFIX, ".csv");
  const rakutenBase = rakutenCsv.slice(0, -".csv".length);
  const rakutenPaths: SourceArtifactPaths = { reportPath: `${rakutenBase}.md`, csvPath: rakutenCsv };
  const rakutenJson = `${rakutenBase}.json`;

  const jalanCsv = latestWithPrefix(MARKET_UPDATE_DIR, JALAN_CSV_PREFIX, ".csv");
  const jalanTs = jalanCsv.slice(resolve(MARKET_UPDATE_DIR).length + 1 + JALAN_CSV_PREFIX.length, -".csv".length);
  const jalanReport = resolve(MARKET_UPDATE_DIR, `${JALAN_REPORT_PREFIX}${jalanTs}.md`);
  const jalanPaths: SourceArtifactPaths = { reportPath: jalanReport, csvPath: jalanCsv };

  // Load + normalize.
  const bookingSourceRows = loadBookingRows(bookingJson);
  const rakutenSourceRows = loadRakutenRows(rakutenCsv);
  const jalanRunId = `jalan_dp_safe_${jalanTs}`;
  const jalanSourceRows = loadJalanRows(jalanCsv, jalanRunId, normalizedAt);

  const bookingRows = bookingSourceRows.map((r) => normalizeBookingToUnified(r, bookingPaths));
  const rakutenRows = rakutenSourceRows.map((r) => normalizeRakutenToUnified(r, rakutenPaths));
  const jalanRows = jalanSourceRows.map((r) => normalizeJalanToUnified(r, jalanPaths));
  const rows: UnifiedMarketSignalRow[] = [...bookingRows, ...rakutenRows, ...jalanRows];

  const decision = decideM01X(rows);
  const dpGate = summarizeDpGateBySource(rows);
  const sourceDateSummary = buildSourceDateSummary(rows);
  const crossSourceDateSummary = buildCrossSourceDateSummary(rows);
  const warnings = rows
    .filter((r) => r.warningFlags.trim() !== "")
    .map((r) => ({ source: r.source, checkin: r.checkin, property: r.canonicalPropertyName, warningFlags: r.warningFlags }));

  // Write outputs.
  const reportDir = resolve(SOURCE_DISCOVERY_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `cross_source_market_signals_${ts}.md`);
  const csvPath = resolve(reportDir, `cross_source_market_signals_${ts}.csv`);
  const jsonPath = resolve(reportDir, `cross_source_market_signals_${ts}.json`);

  const summary = {
    decision,
    unifiedRows: rows.length,
    rowCountBySource: {
      booking: bookingRows.length,
      rakuten: rakutenRows.length,
      jalan: jalanRows.length
    },
    dpGateBySource: dpGate,
    rows,
    sourceDateSummary,
    crossSourceDateSummary,
    normalizationWarnings: warnings,
    sourceArtifacts: {
      booking: { reportPath: bookingPaths.reportPath, csvPath: bookingPaths.csvPath, jsonPath: bookingJson },
      rakuten: { reportPath: rakutenPaths.reportPath, csvPath: rakutenPaths.csvPath, jsonPath: rakutenJson },
      jalan: { reportPath: jalanPaths.reportPath, csvPath: jalanPaths.csvPath }
    }
  };

  writeFileSync(csvPath, renderUnifiedCsv(rows), "utf8");
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(
    reportPath,
    renderCrossSourceReport({
      generatedAt: new Date().toISOString(),
      rows,
      decision,
      dpGate,
      sourceDateSummary,
      crossSourceDateSummary,
      artifacts: {
        booking: { reportPath: bookingPaths.reportPath, csvPath: bookingPaths.csvPath, jsonPath: bookingJson },
        rakuten: { reportPath: rakutenPaths.reportPath, csvPath: rakutenPaths.csvPath, jsonPath: rakutenJson },
        jalan: jalanPaths
      },
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath
    }),
    "utf8"
  );

  // Debug artifacts.
  writeFileSync(
    resolve(debugRootPath, "source_artifacts_used.json"),
    JSON.stringify(summary.sourceArtifacts, null, 2),
    "utf8"
  );
  writeFileSync(resolve(debugRootPath, "booking_rows_normalized.json"), JSON.stringify(bookingRows, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "rakuten_rows_normalized.json"), JSON.stringify(rakutenRows, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "jalan_rows_normalized.json"), JSON.stringify(jalanRows, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "unified_rows.json"), JSON.stringify(rows, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "source_date_summary.json"), JSON.stringify(sourceDateSummary, null, 2), "utf8");
  writeFileSync(
    resolve(debugRootPath, "cross_source_date_summary.json"),
    JSON.stringify(crossSourceDateSummary, null, 2),
    "utf8"
  );
  writeFileSync(resolve(debugRootPath, "dp_gate_summary.json"), JSON.stringify(dpGate, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "normalization_warnings.json"), JSON.stringify(warnings, null, 2), "utf8");

  return { reportPath, csvPath, jsonPath, debugRootPath, rows, decision };
}

try {
  const result = build();
  const dpGate = summarizeDpGateBySource(result.rows);
  console.log(`report_path=${result.reportPath}`);
  console.log(`csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`unified_rows=${result.rows.length}`);
  console.log(`booking_rows=${result.rows.filter((r) => r.source === "booking").length}`);
  console.log(`rakuten_rows=${result.rows.filter((r) => r.source === "rakuten").length}`);
  console.log(`jalan_rows=${result.rows.filter((r) => r.source === "jalan").length}`);
  console.log(`dp_gate_by_source=${JSON.stringify(dpGate)}`);
  console.log(`decision=${result.decision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
