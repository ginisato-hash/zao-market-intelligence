// Phase ZMI MARKET-CURVE01 — market booking curve runner.
//
// Read-only: reads canonical history, derives the per-(checkin, observation-day)
// market booking curve, and writes artifacts under .data/market-curve/. No
// collection, append, DB write/sync, AI context, publish, or pricing/PMS output.
//   --check  validates the previously written artifacts.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildPriceChanges,
  dedupeObservations,
  parseHistoryForPriceHistory
} from "../services/priceHistorySignals";
import {
  buildMarketBookingCurve,
  buildMarketCurveValidation,
  renderMarketCurveCsv,
  type MarketCurveValidation
} from "../services/marketIntelligenceSignals";

const HISTORY_DIR = ".data/history";
const OUT_DIR = ".data/market-curve";
export const MARKET_CURVE_FILES = { curve: "market_booking_curve.csv", validation: "market_booking_curve_validation.json" } as const;

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

function readHistoryFiles(): { filename: string; content: string }[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR).filter((f) => /^zao_signals_.*\.csv$/u.test(f)).sort().map((f) => ({ filename: f, content: readFileSync(join(HISTORY_DIR, f), "utf8") }));
}

const REQUIRED_KEYS: (keyof MarketCurveValidation)[] = [
  "run_at", "input_history_rows", "booking_curve_rows", "min_checkin_date", "max_checkin_date",
  "min_observed_at", "max_observed_at", "unique_checkin_dates", "unique_observed_ats", "decision", "warnings"
];

function runCheck(): void {
  const path = resolve(OUT_DIR, MARKET_CURVE_FILES.validation);
  if (!existsSync(path)) {
    console.error("decision=market_booking_curve_failed");
    console.error("reason=validation_json_missing (run build:market-booking-curve first)");
    process.exitCode = 1;
    return;
  }
  const v = JSON.parse(readFileSync(path, "utf8")) as MarketCurveValidation;
  const missing = REQUIRED_KEYS.filter((k) => !(k in v));
  const okDecision = v.decision === "market_booking_curve_ready" || v.decision === "market_booking_curve_ready_with_warnings";
  const ok = missing.length === 0 && okDecision;
  console.log(`decision=${v.decision}`);
  console.log(`validation_keys_complete=${missing.length === 0}`);
  if (missing.length > 0) console.log(`missing_keys=${missing.join(",")}`);
  console.log(`booking_curve_rows=${v.booking_curve_rows}`);
  console.log(`validate:market-booking-curve=${ok ? "passed" : "failed"}`);
  if (!ok) process.exitCode = 1;
}

function run(): void {
  if (process.argv.includes("--check")) { runCheck(); return; }
  const files = readHistoryFiles();
  const parsed = parseHistoryForPriceHistory(files);
  const changes = buildPriceChanges(dedupeObservations(parsed.rows).rows);
  const curve = buildMarketBookingCurve(parsed.rows, changes);
  const validation = buildMarketCurveValidation({ runAt: jstNow(), inputHistoryRows: parsed.totalRawRows, curve });

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const curvePath = resolve(OUT_DIR, MARKET_CURVE_FILES.curve);
  const validationPath = resolve(OUT_DIR, MARKET_CURVE_FILES.validation);
  writeFileSync(curvePath, renderMarketCurveCsv(curve), "utf8");
  writeFileSync(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf8");

  console.log(`decision=${validation.decision}`);
  console.log(`market_booking_curve_rows=${curve.length}`);
  console.log(`unique_checkin_dates=${validation.unique_checkin_dates}`);
  console.log(`unique_observed_ats=${validation.unique_observed_ats}`);
  console.log(`curve_path=${curvePath}`);
  console.log(`validation_path=${validationPath}`);
  for (const w of validation.warnings) console.log(`warning=${w}`);
}

run();
