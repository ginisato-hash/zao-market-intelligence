// Phase ZMI Inventory KPI — inventory-first market report runner (read-only).
//
// Reads canonical history CSVs and emits an inventory-first market report
// (md + csv + json): inventory KPI summary, date-level inventory pressure,
// room-only competitor inventory (HAMMOND / ONSEN & STAY OAKHILL / 吉田屋),
// then price pressure, then 喜らく / 三浦屋 decisions. NEVER collects, appends,
// syncs the DB, refreshes AI context, or emits pricing/PMS output.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildInventoryKpiReport,
  buildPricePressureRows,
  renderInventoryCsv,
  renderInventoryReport,
  type InventoryHistoryRow
} from "../services/inventoryPressureKpi";

const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/inventory-kpi";

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

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function jstIso(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}
function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function readHistoryRows(): InventoryHistoryRow[] {
  const rows: InventoryHistoryRow[] = [];
  for (const f of readdirSync(HISTORY_DIR).filter((x) => /^zao_signals_.*\.csv$/u.test(x))) {
    const lines = readFileSync(join(HISTORY_DIR, f), "utf8").split(/\r?\n/u).filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const h = parseCsvLine(lines[0]!);
    const idx = (name: string): number => h.indexOf(name);
    const si = idx("source");
    const ni = idx("canonical_property_name");
    const ci = idx("checkin");
    const ai = idx("availability_status");
    const ti = idx("collected_at_jst");
    const pi = idx("normalized_total_price");
    const ddi = idx("is_price_usable_for_dp_directional");
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      const rawPrice = pi >= 0 ? (c[pi] ?? "").trim() : "";
      rows.push({
        source: c[si] ?? "",
        canonical_property_name: c[ni] ?? "",
        checkin: c[ci] ?? "",
        availability_status: c[ai] ?? "",
        collected_at_jst: c[ti] ?? "",
        normalized_total_price: rawPrice === "" ? null : Number(rawPrice),
        is_price_usable_for_dp_directional: ddi >= 0 ? (c[ddi] ?? "").toLowerCase() === "true" : false
      });
    }
  }
  return rows;
}

function run(): void {
  if (!existsSync(HISTORY_DIR)) {
    console.log("decision=inventory_kpi_no_history");
    process.exitCode = 1;
    return;
  }
  const ts = timestamp();
  const generatedAtJst = jstIso();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });

  // Forward-looking report: only stay dates from today (JST) onward are
  // actionable for pricing. Past checkins are excluded via env-overridable floor.
  const minCheckin = (process.env["INVENTORY_KPI_MIN_CHECKIN"] ?? todayJst()).trim();
  const allRows = readHistoryRows();
  const rows = allRows.filter((r) => r.checkin >= minCheckin);
  const report = buildInventoryKpiReport({ rows, generatedAtJst });
  const pricePressure = buildPricePressureRows(rows);

  const reportPath = resolve(REPORT_DIR, `inventory_kpi_${ts}.md`);
  const csvPath = resolve(REPORT_DIR, `inventory_kpi_${ts}.csv`);
  const jsonPath = resolve(REPORT_DIR, `inventory_kpi_${ts}.json`);
  writeFileSync(reportPath, renderInventoryReport({ report, pricePressure }), "utf8");
  writeFileSync(csvPath, renderInventoryCsv(report), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify({ ...report, price_pressure: pricePressure }, null, 2)}\n`, "utf8");

  const s = report.summary;
  console.log("decision=inventory_kpi_report_ready");
  console.log(`generated_at_jst=${generatedAtJst}`);
  console.log(`min_checkin=${minCheckin}`);
  console.log(`history_rows_total=${allRows.length}`);
  console.log(`history_rows_in_scope=${rows.length}`);
  console.log(`distinct_checkins=${s.distinct_checkins}`);
  console.log(`area_sold_out_rate_overall=${s.area_sold_out_rate_overall}`);
  console.log(`room_only_comp_inventory_pressure=${s.room_only_comp_inventory_pressure}`);
  console.log(`overall_inventory_pressure_level=${s.overall_inventory_pressure_level}`);
  console.log(`level_strong=${s.level_counts.strong_inventory_pressure}`);
  console.log(`level_medium=${s.level_counts.medium_inventory_pressure}`);
  console.log(`level_weak=${s.level_counts.weak_inventory_pressure}`);
  console.log(`pricing_output_generated=false`);
  console.log(`pms_output_generated=false`);
  console.log(`report_path=${reportPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`json_path=${jsonPath}`);
}

run();
