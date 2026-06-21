// Phase ZMI MARKET-PRICE-MOVEMENT01 — exporter.
//
// Read-only: reads canonical history, derives competitor price-movement + DP
// pressure proxy signals, and writes validation artifacts (.data/validation/) and
// public BI CSVs (apps/zmi-bi-web/data/). No scraping, no live collection, no
// history write, no pricing/PMS output, no Beds24.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assembleMovementArtifacts,
  latestCollectedAt,
  renderDpPressureCsv,
  renderMovementCsv,
  type MarketDpPressureRow,
  type MarketPriceMovementRow
} from "../services/marketPriceMovementSignals";

const HISTORY_DIR = ".data/history";
const VALIDATION_DIR = ".data/validation";
const BI_DATA_DIR = "apps/zmi-bi-web/data";

export const MOVEMENT_FILES = {
  movementCsvPublic: "market_price_movement_signals.csv",
  dpCsvPublic: "market_dp_pressure_by_checkin.csv"
} as const;

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

function readHistoryFiles(): { filename: string; content: string }[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR).filter((f) => /^zao_signals_.*\.csv$/u.test(f)).sort().map((f) => ({ filename: f, content: readFileSync(join(HISTORY_DIR, f), "utf8") }));
}

function countBy<T extends string>(rows: { movement_type: T }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.movement_type] = (out[r.movement_type] ?? 0) + 1;
  return out;
}

export interface MovementArtifacts {
  generatedAtJst: string;
  movements: MarketPriceMovementRow[];
  dpPressure: MarketDpPressureRow[];
  ownPropertyRows: number;
  notComparableRows: number;
  movementLatest: string;
  dpLatest: string;
}

export function buildMovementArtifacts(): MovementArtifacts {
  const { movements, dpPressure, ownPropertyRows, notComparableRows } = assembleMovementArtifacts(readHistoryFiles());
  return {
    generatedAtJst: jstNow(),
    movements,
    dpPressure,
    ownPropertyRows,
    notComparableRows,
    movementLatest: latestCollectedAt(movements),
    dpLatest: latestCollectedAt(dpPressure)
  };
}

function run(): void {
  const a = buildMovementArtifacts();
  mkdirSync(resolve(VALIDATION_DIR), { recursive: true });
  mkdirSync(resolve(BI_DATA_DIR), { recursive: true });

  const movementCsv = renderMovementCsv(a.movements);
  const dpCsv = renderDpPressureCsv(a.dpPressure);
  const movementSummary = {
    generated_at_jst: a.generatedAtJst,
    movement_rows: a.movements.length,
    own_property_rows: a.ownPropertyRows,
    not_comparable_rows: a.notComparableRows,
    movement_type_counts: countBy(a.movements),
    latest_collected_at_jst: a.movementLatest,
    policy: "inventory/DP pressure proxy; latest-vs-previous comparable observations within one source; own properties excluded; room-only two-person standard high/medium confidence only"
  };
  const dpSummary = {
    generated_at_jst: a.generatedAtJst,
    dp_pressure_rows: a.dpPressure.length,
    latest_collected_at_jst: a.dpLatest,
    level_counts: a.dpPressure.reduce<Record<string, number>>((m, r) => { m[r.dp_pressure_level] = (m[r.dp_pressure_level] ?? 0) + 1; return m; }, {})
  };

  // Validation (internal) artifacts.
  writeFileSync(resolve(VALIDATION_DIR, "market_price_movement_signals.json"), `${JSON.stringify(movementSummary, null, 2)}\n`, "utf8");
  writeFileSync(resolve(VALIDATION_DIR, "market_price_movement_signals.csv"), movementCsv, "utf8");
  writeFileSync(resolve(VALIDATION_DIR, "market_dp_pressure_by_checkin.json"), `${JSON.stringify(dpSummary, null, 2)}\n`, "utf8");
  writeFileSync(resolve(VALIDATION_DIR, "market_dp_pressure_by_checkin.csv"), dpCsv, "utf8");

  // Public BI artifacts (additive CSVs; existing unified CSV schema untouched).
  writeFileSync(resolve(BI_DATA_DIR, MOVEMENT_FILES.movementCsvPublic), movementCsv, "utf8");
  writeFileSync(resolve(BI_DATA_DIR, MOVEMENT_FILES.dpCsvPublic), dpCsv, "utf8");

  console.log(`decision=market_price_movement_export`);
  console.log(`movement_rows=${a.movements.length}`);
  console.log(`dp_pressure_rows=${a.dpPressure.length}`);
  console.log(`own_property_rows=${a.ownPropertyRows}`);
  console.log(`not_comparable_rows=${a.notComparableRows}`);
  console.log(`movement_type_counts=${JSON.stringify(movementSummary.movement_type_counts)}`);
  console.log(`pricing_output_generated=false`);
  console.log(`pms_output_generated=false`);
}

run();
