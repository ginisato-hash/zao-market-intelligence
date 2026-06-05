import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideB04X,
  normalizeBookingMarketSignalRows,
  renderBookingMarketSignalCsv,
  renderBookingMarketSignalReport,
  summarizeDpGate,
  type NormalizedMarketSignalRow
} from "../services/bookingMarketSignalNormalization";
import { type B04ARow } from "../services/bookingOfficialTaxFeeTotalHardening";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/booking-market-signal-normalization";
const SOURCE_PREFIX = "booking_official_tax_fee_total_hardening_";

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

function resolveLatestSource(): { jsonPath: string; reportPath: string; csvPath: string } {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing B04A artifact directory: ${reportDir}. Do not reimplement B04A; produce B04A artifacts first.`);
  }
  const jsonFiles = entries.filter((name) => name.startsWith(SOURCE_PREFIX) && name.endsWith(".json")).sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(
      `Missing B04A source JSON (expected ${SOURCE_PREFIX}*.json in ${reportDir}). Do not reimplement B04A; stop and report.`
    );
  }
  const base = latest.slice(0, -".json".length);
  return {
    jsonPath: resolve(reportDir, latest),
    reportPath: resolve(reportDir, `${base}.md`),
    csvPath: resolve(reportDir, `${base}.csv`)
  };
}

function loadSourceRows(jsonPath: string): B04ARow[] {
  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf8");
  } catch {
    throw new Error(`Missing B04A source JSON: ${jsonPath}. Stop and report the missing artifact path.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    throw new Error(`Malformed B04A source JSON ${jsonPath}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const rows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`B04A source JSON ${jsonPath} has no rows[]. Stop and report the malformed artifact.`);
  }
  return rows as B04ARow[];
}

function buildBookingMarketSignalNormalizationReport(): {
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
  rows: NormalizedMarketSignalRow[];
  decision: string;
} {
  const ts = timestamp();
  const source = resolveLatestSource();
  const sourceRows = loadSourceRows(source.jsonPath);
  const normalizedAt = normalizedAtJst();

  const normalizedRows = normalizeBookingMarketSignalRows(sourceRows, {
    normalizedAtJst: normalizedAt,
    sourceReportPath: source.reportPath,
    sourceCsvPath: source.csvPath
  });
  const decision = decideB04X(normalizedRows);
  const dpGate = summarizeDpGate(normalizedRows);

  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const csvPath = resolve(reportDir, `booking_market_signal_normalization_${ts}.csv`);
  const reportPath = resolve(reportDir, `booking_market_signal_normalization_${ts}.md`);
  const jsonPath = resolve(reportDir, `booking_market_signal_normalization_${ts}.json`);

  const classificationSummary = countBy(normalizedRows.map((row) => row.sourceClassification));
  const summary = {
    decision,
    pricePolicyVersion: normalizedRows[0]?.pricePolicyVersion ?? "booking_official_visible_adder_v1",
    rows: normalizedRows,
    normalizedTotalPriceCount: normalizedRows.filter((row) => row.normalizedTotalPrice !== null).length,
    dpGate,
    availabilityCounts: countBy(normalizedRows.map((row) => row.availabilityStatus)),
    soldOutCounts: countBy(normalizedRows.map((row) => row.soldOutStatus)),
    basisConfidenceCounts: countBy(normalizedRows.map((row) => row.basisConfidence)),
    classificationSummary,
    sourceJsonPath: source.jsonPath,
    sourceReportPath: source.reportPath,
    sourceCsvPath: source.csvPath
  };

  writeFileSync(csvPath, renderBookingMarketSignalCsv(normalizedRows), "utf8");
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(
    reportPath,
    renderBookingMarketSignalReport({
      generatedAt: new Date().toISOString(),
      rows: normalizedRows,
      decision,
      dpGate,
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath,
      sourceReportPath: source.reportPath,
      sourceCsvPath: source.csvPath,
      sourceJsonPath: source.jsonPath
    }),
    "utf8"
  );

  writeFileSync(resolve(debugRootPath, "source_rows.json"), JSON.stringify(sourceRows, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "normalized_rows.json"), JSON.stringify(normalizedRows, null, 2), "utf8");
  writeFileSync(
    resolve(debugRootPath, "normalization_summary.json"),
    JSON.stringify(
      {
        decision,
        normalizedTotalPriceCount: summary.normalizedTotalPriceCount,
        availabilityCounts: summary.availabilityCounts,
        soldOutCounts: summary.soldOutCounts,
        basisConfidenceCounts: summary.basisConfidenceCounts
      },
      null,
      2
    ),
    "utf8"
  );
  writeFileSync(resolve(debugRootPath, "dp_gate_summary.json"), JSON.stringify(dpGate, null, 2), "utf8");
  writeFileSync(resolve(debugRootPath, "classification_summary.json"), JSON.stringify(classificationSummary, null, 2), "utf8");

  return { reportPath, csvPath, jsonPath, debugRootPath, rows: normalizedRows, decision };
}

try {
  const result = buildBookingMarketSignalNormalizationReport();
  const dpGate = summarizeDpGate(result.rows);
  console.log(`report_path=${result.reportPath}`);
  console.log(`csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`rows=${result.rows.length}`);
  console.log(`normalized_total_price_count=${result.rows.filter((row) => row.normalizedTotalPrice !== null).length}`);
  console.log(`dp_gate=${JSON.stringify(dpGate)}`);
  console.log(`availability_counts=${JSON.stringify(countBy(result.rows.map((row) => row.availabilityStatus)))}`);
  console.log(`basis_confidence_counts=${JSON.stringify(countBy(result.rows.map((row) => row.basisConfidence)))}`);
  console.log(`decision=${result.decision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
