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

const HISTORY_DIR = ".data/history";
const OUT_DIR = "apps/zmi-bi-web/data";

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

function jstIso(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

function readHistory(): { rows: BiHistoryRow[]; total: number } {
  const rows: BiHistoryRow[] = [];
  let total = 0;
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const lines = readFileSync(join(HISTORY_DIR, f), "utf8").split(/\r?\n/u).filter((l) => l.length > 0);
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
  return { rows, total };
}

function run(): void {
  const checkOnly = process.argv.includes("--check");
  if (!existsSync(HISTORY_DIR)) {
    console.log("decision=bi_web_export_no_history");
    process.exitCode = 1;
    return;
  }
  const generatedAtJst = jstIso();
  const { rows, total } = readHistory();
  const latest = latestObservations(rows);
  const unifiedAll = unifyByPropertyCheckin(latest);
  // BI publish scope: keep default period + 3 previous + all future periods.
  const retention = applyPeriodRetention(unifiedAll, new Date());
  const unified = retention.retainedRows;
  const metadata = buildBiMetadata({ generatedAtJst, historyRowsTotal: total, latest, unifiedBeforeRetention: unifiedAll, retention });

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const csvPath = resolve(OUT_DIR, "zmi_market_unified.csv");
  const metaPath = resolve(OUT_DIR, "metadata.json");
  writeFileSync(csvPath, renderUnifiedCsv(unified), "utf8");
  writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  // --check: validate schema + non-empty output.
  const headerOk = renderUnifiedCsv(unified).split("\n")[0] === BI_CSV_HEADERS.join(",");
  const ok = headerOk && metadata.unified_rows > 0 && metadata.latest_collected_at_jst !== "";

  console.log(`decision=${checkOnly ? (ok ? "bi_web_export_check_ok" : "bi_web_export_check_failed") : "bi_web_export_ready"}`);
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
  console.log(`pricing_output_generated=false`);
  console.log(`pms_output_generated=false`);
  if (checkOnly && !ok) process.exitCode = 1;
}

run();
