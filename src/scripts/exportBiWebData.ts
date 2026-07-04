// Phase ZMI BI Web — export the unified BI dataset (read-only).
//
// Reads ZMI canonical history and writes the static BI page's data files:
//   apps/zmi-bi-web/data/zmi_market_unified.csv
//   apps/zmi-bi-web/data/metadata.json
// All sources are unified into one market view (no source selector). NEVER
// collects, appends, syncs the DB, refreshes AI context, publishes, or emits
// pricing/PMS output. `--check` validates output without failing the build.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BI_CSV_HEADERS,
  applyPeriodRetention,
  buildBiMetadata,
  latestObservations,
  renderUnifiedCsv,
  unifyByPropertyCheckin,
  type BiHistoryRow
} from "../services/biWebDataExport";
import {
  assembleMovementArtifacts,
  latestCollectedAt,
  renderDpPressureCsv,
  renderMovementCsv
} from "../services/marketPriceMovementSignals";
import { parseHistoryForPriceHistory } from "../services/priceHistorySignals";
import { PRIORITY_COMPETITORS } from "../services/priorityCompetitors";
import { OWN_PROPERTY_TARGETS } from "../services/ownPropertyTargets";
import { buildJstDateRange } from "../services/priorityRecrawlTargets";
import {
  OWN_PROPERTY_THRESHOLDS,
  PRIORITY_COMPETITOR_THRESHOLDS,
  computeCoverageForProperties,
  type PropertyCoverageResult
} from "../services/priorityCoverageReport";
import { buildOwnPropertyPriceRows, renderOwnPropertyPriceCsv } from "../services/ownPropertyPricesExport";
import { detectPriceChanges, type PriceChangeRecord } from "../services/priorityPriceChangeDetection";
import { liveTargets } from "../services/marketRefreshTargetUniverse";

function renderPriceChangeCsv(rows: readonly PriceChangeRecord[]): string {
  const headers = ["target_type", "property", "display_name", "source", "checkin", "previous_price", "latest_price", "delta_amount", "delta_rate", "direction", "previous_collected_at_jst", "latest_collected_at_jst"];
  const esc = (v: string): string => (/[",\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v);
  const body = rows.map((r) => [r.target_type, r.property, r.display_name, r.source, r.checkin, String(r.previous_price), String(r.latest_price), String(r.delta_amount), String(r.delta_rate), r.direction, r.previous_collected_at_jst, r.latest_collected_at_jst].map(esc).join(","));
  return [headers.join(","), ...body].join("\n") + "\n";
}

function renderCoverageCsv(rows: readonly PropertyCoverageResult[]): string {
  const headers = [
    "property", "display_name", "price_source_type", "is_ota_price", "is_pms_price",
    "coverage_30d", "coverage_45d", "coverage_90d", "status", "latest_collected_at_jst", "missing_dates_30d_count",
    "booking_live_supported", "booking_coverage_30d", "booking_coverage_45d", "booking_coverage_90d", "booking_latest_collected_at_jst",
    "jalan_live_supported", "jalan_coverage_30d", "jalan_coverage_45d", "jalan_coverage_90d", "jalan_latest_collected_at_jst",
    "rakuten_live_supported", "rakuten_coverage_30d", "rakuten_coverage_45d", "rakuten_coverage_90d", "rakuten_latest_collected_at_jst",
    "warnings", "reasons"
  ];
  const esc = (v: string): string => (/[",\n]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v);
  const body = rows.map((r) => {
    const booking = r.coverage["booking"];
    const jalan = r.coverage["jalan"];
    const rakuten = r.coverage["rakuten"];
    return [
      r.property, r.display_name, "ota_display_price", "true", "false",
      String(r.coverage_30d), String(r.coverage_45d), String(r.coverage_90d), r.status, r.latest_collected_at_jst ?? "", String(r.missing_dates_30d.length),
      String(booking?.live_supported ?? false), String(booking?.coverage_30d ?? 0), String(booking?.coverage_45d ?? 0), String(booking?.coverage_90d ?? 0), booking?.latest_collected_at_jst ?? "",
      String(jalan?.live_supported ?? false), String(jalan?.coverage_30d ?? 0), String(jalan?.coverage_45d ?? 0), String(jalan?.coverage_90d ?? 0), jalan?.latest_collected_at_jst ?? "",
      String(rakuten?.live_supported ?? false), String(rakuten?.coverage_30d ?? 0), String(rakuten?.coverage_45d ?? 0), String(rakuten?.coverage_90d ?? 0), rakuten?.latest_collected_at_jst ?? "",
      r.warnings.join(";"), r.reasons.join(";")
    ].map(esc).join(",");
  });
  return [headers.join(","), ...body].join("\n") + "\n";
}

const HISTORY_DIR = ".data/history";
const OUT_DIR = "apps/zmi-bi-web/data";

function readHistoryFiles(): { filename: string; content: string }[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x)).sort().map((f) => ({ filename: f, content: readFileSync(join(HISTORY_DIR, f), "utf8") }));
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += (ch ?? "");
  }
  cells.push(cur);
  return cells;
}

// Split CSV text into LOGICAL records (quote-aware). A newline inside a quoted
// field (history shards do contain these, e.g. multi-line basis_note) is field
// content, not a record boundary. A naive line split fractures such rows into
// partial garbage rows whose blank checkin/name produced the invalid
// "_early / 年NaN月" BI row — this is the root cause being fixed.
function splitCsvRecords(content: string): string[] {
  const records: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '"') { q = !q; cur += ch; continue; }
    if ((ch === "\n" || ch === "\r") && !q) {
      if (ch === "\r" && content[i + 1] === "\n") i += 1;
      records.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur !== "") records.push(cur);
  return records.filter((r) => r.length > 0);
}

const CHECKIN_RE = /^\d{4}-\d{2}-\d{2}$/u;

function jstIso(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const LIVE_COLLECT_SOURCES = new Set(["booking"]);

function verifiedSourcesFor(canonicalPropertyName: string): string[] {
  return [...new Set(liveTargets().filter((t) => t.canonical_property_name === canonicalPropertyName).map((t) => t.source))];
}

function readHistory(): { rows: BiHistoryRow[]; total: number; skipped: number } {
  const rows: BiHistoryRow[] = [];
  let total = 0;
  let skipped = 0;
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const lines = splitCsvRecords(readFileSync(join(HISTORY_DIR, f), "utf8"));
    if (lines.length < 2) continue;
    const h = parseCsvLine(lines[0]!);
    const idx = (name: string): number => h.indexOf(name);
    const si = idx("source");
    const ni = idx("canonical_property_name");
    const sci = idx("source_slug_or_code");
    const ci = idx("checkin");
    const coi = idx("checkout");
    const ai = idx("availability_status");
    const pi = idx("normalized_total_price");
    const ddi = idx("is_price_usable_for_dp_directional");
    const ti = idx("collected_at_jst");
    const tieri = idx("tier");
    // Existing v1 columns used to derive meal/room basis at export time.
    const scli = idx("source_classification");
    const wfi = idx("warning_flags");
    const bci = idx("basis_confidence");
    const exi = idx("is_price_excluded_from_dp");
    const deri = idx("dp_exclusion_reason");
    const bni = idx("basis_note");
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      total += 1;
      // Skip structurally invalid rows so they can never become a BI row
      // (blank/garbage checkin or property name, or blank source).
      const ckRaw = (c[ci] ?? "").trim();
      const nameRaw = (c[ni] ?? "").trim();
      const srcRaw = (c[si] ?? "").trim();
      if (srcRaw === "" || nameRaw === "" || !CHECKIN_RE.test(ckRaw)) { skipped += 1; continue; }
      const rawPrice = pi >= 0 ? (c[pi] ?? "").trim() : "";
      rows.push({
        source: c[si] ?? "",
        canonical_property_name: c[ni] ?? "",
        source_slug_or_code: sci >= 0 ? (c[sci] ?? "") : "",
        checkin: c[ci] ?? "",
        checkout: coi >= 0 ? (c[coi] ?? "") : "",
        availability_status: c[ai] ?? "",
        normalized_total_price: rawPrice === "" ? null : Number(rawPrice),
        is_price_usable_for_dp_directional: ddi >= 0 ? (c[ddi] ?? "").toLowerCase() === "true" : false,
        collected_at_jst: ti >= 0 ? (c[ti] ?? "") : "",
        tier: tieri >= 0 ? (c[tieri] ?? "") : "",
        source_classification: scli >= 0 ? (c[scli] ?? "") : "",
        warning_flags: wfi >= 0 ? (c[wfi] ?? "") : "",
        basis_confidence: bci >= 0 ? (c[bci] ?? "") : "",
        is_price_excluded_from_dp: exi >= 0 ? (c[exi] ?? "").toLowerCase() === "true" : false,
        dp_exclusion_reason: deri >= 0 ? (c[deri] ?? "") : "",
        basis_note: bni >= 0 ? (c[bni] ?? "") : ""
      });
    }
  }
  return { rows, total, skipped };
}

const PERIOD_KEY_RE = /^\d{4}-\d{2}_(early|late)$/u;

// Strict validation of the rendered BI artifacts. Returns a list of human
// errors; an empty list means the output is publish-safe.
function collectBiValidationErrors(csvText: string, metadata: { sources_included?: string[]; retained_period_keys?: string[]; unified_rows?: number }): string[] {
  const errors: string[] = [];
  if (/(^|\n)_early|(^|\n)_late/u.test(csvText)) errors.push("csv_contains_blank_period_key");
  if (csvText.includes("年NaN月") || csvText.includes("NaN")) errors.push("csv_contains_NaN_label");

  const lines = csvText.split("\n").filter((l) => l.length > 0);
  const header = lines[0] ?? "";
  if (header !== BI_CSV_HEADERS.join(",")) errors.push("csv_header_mismatch");
  const cols = BI_CSV_HEADERS as readonly string[];
  const pk = cols.indexOf("period_key");
  const pl = cols.indexOf("period_label");
  const ck = cols.indexOf("checkin");
  const nm = cols.indexOf("canonical_property_name");
  const dataRows = lines.slice(1);
  dataRows.forEach((line, i) => {
    const c = parseCsvLine(line);
    const rowNo = i + 2;
    if (!PERIOD_KEY_RE.test(c[pk] ?? "")) errors.push(`invalid_period_key@row${rowNo}:${(c[pk] ?? "").slice(0, 20)}`);
    if (!CHECKIN_RE.test(c[ck] ?? "")) errors.push(`invalid_checkin@row${rowNo}`);
    if ((c[nm] ?? "").trim() === "") errors.push(`blank_canonical_property_name@row${rowNo}`);
    if ((c[pl] ?? "").includes("NaN")) errors.push(`period_label_NaN@row${rowNo}`);
  });

  if ((metadata.sources_included ?? []).some((s) => String(s).trim() === "")) errors.push("metadata_sources_included_has_blank");
  if ((metadata.retained_period_keys ?? []).some((k) => !PERIOD_KEY_RE.test(String(k)))) errors.push("metadata_retained_period_keys_invalid");
  if ((metadata.unified_rows ?? -1) !== dataRows.length) errors.push(`metadata_unified_rows_mismatch:${metadata.unified_rows}!=${dataRows.length}`);
  return errors;
}

function run(): void {
  const checkOnly = process.argv.includes("--check");
  if (!existsSync(HISTORY_DIR)) {
    console.log("decision=bi_web_export_no_history");
    process.exitCode = 1;
    return;
  }
  const generatedAtJst = jstIso();
  const { rows, total, skipped } = readHistory();
  const latest = latestObservations(rows);
  const unifiedAll = unifyByPropertyCheckin(latest);
  // BI publish scope: keep default period + 3 previous + all future periods.
  const retention = applyPeriodRetention(unifiedAll, new Date());
  const unified = retention.retainedRows;
  const metadata = buildBiMetadata({ generatedAtJst, historyRowsTotal: total, latest, unifiedBeforeRetention: unifiedAll, retention });

  // Market price movement / DP pressure proxy — additive public CSVs (the
  // existing unified CSV schema is untouched). Read-only; no pricing/PMS output.
  const movement = assembleMovementArtifacts(readHistoryFiles());
  const movementMeta = {
    price_movement_rows: movement.movements.length,
    dp_pressure_rows: movement.dpPressure.length,
    price_movement_own_property_rows: movement.ownPropertyRows,
    price_movement_latest_collected_at_jst: latestCollectedAt(movement.movements),
    dp_pressure_latest_collected_at_jst: latestCollectedAt(movement.dpPressure),
    price_movement_policy: "inventory/DP pressure proxy; latest-vs-previous comparable observations within one source; own properties excluded; room-only two-person standard high/medium confidence only"
  };

  // Priority competitor / own property coverage + own price + price-change axes
  // (§5/§6/§7) — additive only; zmi_market_unified.csv schema is untouched.
  const priceHistoryParsed = parseHistoryForPriceHistory(readHistoryFiles());
  const dateRange90d = buildJstDateRange();
  const todayIso = todayJst();
  const competitorRefs = PRIORITY_COMPETITORS.map((c) => ({ canonical_property_key: c.canonical_property_key, display_name: c.display_name, canonical_property_name: c.canonical_property_name, verified_sources: verifiedSourcesFor(c.canonical_property_name) }));
  const ownRefs = OWN_PROPERTY_TARGETS.map((p) => ({ canonical_property_key: p.canonical_property_key, display_name: p.display_name, canonical_property_name: p.canonical_property_name, verified_sources: verifiedSourcesFor(p.canonical_property_name) }));
  const priorityCompetitorCoverage = computeCoverageForProperties({ rows: priceHistoryParsed.rows, properties: competitorRefs, dateRange90d, thresholds: PRIORITY_COMPETITOR_THRESHOLDS, liveCollectSources: LIVE_COLLECT_SOURCES, todayIso });
  const ownPropertyCoverage = computeCoverageForProperties({ rows: priceHistoryParsed.rows, properties: ownRefs, dateRange90d, thresholds: OWN_PROPERTY_THRESHOLDS, liveCollectSources: LIVE_COLLECT_SOURCES, todayIso });
  const ownCoverageByKey = new Map(ownPropertyCoverage.map((c) => [c.property, c]));
  const ownPropertyPrices = buildOwnPropertyPriceRows({ rows: priceHistoryParsed.rows, properties: ownRefs, coverageByPropertyKey: ownCoverageByKey });
  const priorityCompetitorPriceChanges = detectPriceChanges({ rows: priceHistoryParsed.rows, properties: competitorRefs, targetType: "competitor" });
  const ownPropertyPriceChanges = detectPriceChanges({ rows: priceHistoryParsed.rows, properties: ownRefs, targetType: "own_property" });

  // Simple, defensible own-vs-competitor price gap: latest available own price
  // (min across sources) vs the latest available priority-competitor median.
  function latestOwnPrice(propertyName: string): number | null {
    const rows = priceHistoryParsed.rows.filter((r) => r.property_name === propertyName && r.normalized_total_price !== null).sort((a, b) => b.observed_at.localeCompare(a.observed_at));
    return rows[0]?.normalized_total_price ?? null;
  }
  const ownMiurayaPrice = latestOwnPrice("三浦屋");
  const ownKirakuPrice = latestOwnPrice("ホテル喜らく");
  const latestCompetitorPrices = competitorRefs.map((c) => latestOwnPrice(c.canonical_property_name)).filter((p): p is number => p !== null);
  const competitorMedianPrice = latestCompetitorPrices.length === 0 ? null : latestCompetitorPrices.sort((a, b) => a - b)[Math.floor(latestCompetitorPrices.length / 2)]!;
  const ownAvgPrice = [ownMiurayaPrice, ownKirakuPrice].filter((p): p is number => p !== null);
  const ownAvg = ownAvgPrice.length === 0 ? null : ownAvgPrice.reduce((a, b) => a + b, 0) / ownAvgPrice.length;
  const priorityCompetitorVsOwnGap = competitorMedianPrice !== null && ownAvg !== null ? Math.round(competitorMedianPrice - ownAvg) : null;

  const pricingCriticalMeta = {
    own_miuraya_price: ownMiurayaPrice,
    own_kiraku_price: ownKirakuPrice,
    own_property_price_status: ownPropertyCoverage.map((c) => ({ property: c.property, status: c.status })),
    own_property_coverage_status: ownPropertyCoverage.map((c) => ({ property: c.property, coverage_30d: c.coverage_30d, coverage_90d: c.coverage_90d, status: c.status })),
    priority_competitor_coverage_status: priorityCompetitorCoverage.map((c) => ({ property: c.property, coverage_30d: c.coverage_30d, coverage_90d: c.coverage_90d, status: c.status })),
    competitor_vs_own_price_gap: priorityCompetitorVsOwnGap,
    priority_competitor_vs_own_price_gap: priorityCompetitorVsOwnGap,
    priority_competitor_price_changes_count: priorityCompetitorPriceChanges.length,
    own_property_price_changes_count: ownPropertyPriceChanges.length
  };

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const csvPath = resolve(OUT_DIR, "zmi_market_unified.csv");
  const metaPath = resolve(OUT_DIR, "metadata.json");
  const movementCsvPath = resolve(OUT_DIR, "market_price_movement_signals.csv");
  const dpCsvPath = resolve(OUT_DIR, "market_dp_pressure_by_checkin.csv");
  writeFileSync(csvPath, renderUnifiedCsv(unified), "utf8");
  writeFileSync(metaPath, `${JSON.stringify({ ...metadata, ...movementMeta, ...pricingCriticalMeta }, null, 2)}\n`, "utf8");
  writeFileSync(movementCsvPath, renderMovementCsv(movement.movements), "utf8");
  writeFileSync(dpCsvPath, renderDpPressureCsv(movement.dpPressure), "utf8");
  writeFileSync(resolve(OUT_DIR, "own_property_prices.csv"), renderOwnPropertyPriceCsv(ownPropertyPrices), "utf8");
  writeFileSync(resolve(OUT_DIR, "own_property_coverage.csv"), renderCoverageCsv(ownPropertyCoverage), "utf8");
  writeFileSync(resolve(OUT_DIR, "priority_competitor_coverage.csv"), renderCoverageCsv(priorityCompetitorCoverage), "utf8");
  writeFileSync(resolve(OUT_DIR, "own_property_price_changes.csv"), renderPriceChangeCsv(ownPropertyPriceChanges), "utf8");
  writeFileSync(resolve(OUT_DIR, "priority_competitor_price_changes.csv"), renderPriceChangeCsv(priorityCompetitorPriceChanges), "utf8");

  // Strict validation of the written artifacts (guards against invalid BI rows
  // ever reaching Cloudflare). Applies to both export and --check.
  const csvText = renderUnifiedCsv(unified);
  const validationErrors = collectBiValidationErrors(csvText, metadata);
  const nonEmpty = metadata.unified_rows > 0 && metadata.latest_collected_at_jst !== "";
  const ok = validationErrors.length === 0 && nonEmpty;

  const decision = checkOnly
    ? (ok ? "bi_web_export_check_ok" : "bi_web_export_check_failed")
    : (ok ? "bi_web_export_ready" : "bi_web_export_invalid");
  console.log(`decision=${decision}`);
  console.log(`validation_ok=${ok}`);
  console.log(`validation_errors=${validationErrors.join(" | ") || "none"}`);
  console.log(`history_rows_skipped_invalid=${skipped}`);
  console.log(`generated_at_jst=${generatedAtJst}`);
  console.log(`history_rows_total=${metadata.history_rows_total}`);
  console.log(`latest_observation_rows=${metadata.latest_observation_rows}`);
  console.log(`unified_rows=${metadata.unified_rows}`);
  console.log(`distinct_properties=${metadata.distinct_properties}`);
  console.log(`distinct_checkins=${metadata.distinct_checkins}`);
  console.log(`unified_rows_before_retention=${metadata.unified_rows_before_retention}`);
  console.log(`current_period_key_jst=${metadata.current_period_key_jst}`);
  console.log(`default_period_key=${metadata.default_period_key}`);
  console.log(`retained_period_keys=${metadata.retained_period_keys.join(",")}`);
  console.log(`dropped_past_period_keys_count=${metadata.dropped_past_period_keys_count}`);
  console.log(`dropped_past_rows_count=${metadata.dropped_past_rows_count}`);
  console.log(`latest_collected_at_jst=${metadata.latest_collected_at_jst}`);
  console.log(`sources_included=${metadata.sources_included.join(",")}`);
  console.log(`availability_breakdown=${JSON.stringify(metadata.availability_breakdown)}`);
  console.log(`ota_unavailable_rate=${metadata.availability_breakdown.ota_unavailable_rate}`);
  console.log(`data_missing_rate=${metadata.availability_breakdown.data_missing_rate}`);
  console.log(`data_reliability_rate=${metadata.availability_breakdown.data_reliability_rate}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`metadata_path=${metaPath}`);
  console.log(`price_movement_rows=${movementMeta.price_movement_rows}`);
  console.log(`dp_pressure_rows=${movementMeta.dp_pressure_rows}`);
  console.log(`price_movement_own_property_rows=${movementMeta.price_movement_own_property_rows}`);
  console.log(`priority_competitor_coverage=${JSON.stringify(priorityCompetitorCoverage.map((c) => ({ property: c.property, coverage_30d: c.coverage_30d, status: c.status })))}`);
  console.log(`own_property_coverage=${JSON.stringify(ownPropertyCoverage.map((c) => ({ property: c.property, coverage_30d: c.coverage_30d, status: c.status })))}`);
  console.log(`own_property_prices_rows=${ownPropertyPrices.length}`);
  console.log(`priority_competitor_price_changes_count=${pricingCriticalMeta.priority_competitor_price_changes_count}`);
  console.log(`own_property_price_changes_count=${pricingCriticalMeta.own_property_price_changes_count}`);
  console.log(`own_miuraya_price=${ownMiurayaPrice ?? "null"}`);
  console.log(`own_kiraku_price=${ownKirakuPrice ?? "null"}`);
  console.log(`priority_competitor_vs_own_price_gap=${priorityCompetitorVsOwnGap ?? "null"}`);
  console.log(`pricing_output_generated=false`);
  console.log(`pms_output_generated=false`);
  // Fail closed whenever the output is invalid — for --check AND plain export —
  // so bi:web:publish's export step aborts before any Cloudflare deploy.
  if (!ok) process.exitCode = 1;
}

run();
