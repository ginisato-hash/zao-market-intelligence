// Phase ZMI PRICE-HISTORY01 — competitor price-change history runner.
//
// Read-only: reads the canonical history CSVs and writes three derived artifacts
// under .data/price-history/. It never collects, appends history, writes/syncs
// the DB, refreshes AI context, publishes, or emits pricing/PMS output.
//   --check  validates the previously written artifacts instead of rebuilding.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildPriceHistorySignals,
  parseHistoryForPriceHistory,
  renderCompetitorPriceChangesCsv,
  renderMarketDailySignalsCsv,
  type PriceHistoryValidation
} from "../services/priceHistorySignals";

const HISTORY_DIR = ".data/history";
const OUT_DIR = ".data/price-history";
export const PRICE_HISTORY_FILES = {
  changes: "competitor_price_changes.csv",
  daily: "market_daily_price_change_signals.csv",
  validation: "price_history_validation.json"
} as const;

function jstNow(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

function readHistoryFiles(): { filename: string; content: string }[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR)
    .filter((f) => /^zao_signals_.*\.csv$/u.test(f))
    .sort()
    .map((f) => ({ filename: f, content: readFileSync(join(HISTORY_DIR, f), "utf8") }));
}

const REQUIRED_VALIDATION_KEYS: (keyof PriceHistoryValidation)[] = [
  "run_at", "input_sources", "total_raw_rows", "normalized_rows", "comparable_rows", "non_comparable_rows",
  "comparison_pair_count", "change_type_counts", "signal_direction_counts", "excluded_meal_basis_count",
  "excluded_room_basis_count", "duplicate_group_count", "duplicate_rows_removed_count", "observed_at_column_used",
  "observed_at_confidence", "min_checkin_date", "max_checkin_date", "min_observed_at", "max_observed_at",
  "daily_signal_rows", "insufficient_data_days", "decision", "warnings"
];

function runCheck(): void {
  const path = resolve(OUT_DIR, PRICE_HISTORY_FILES.validation);
  if (!existsSync(path)) {
    console.error("decision=price_history_failed");
    console.error("reason=validation_json_missing (run build:price-history-signals first)");
    process.exitCode = 1;
    return;
  }
  const validation = JSON.parse(readFileSync(path, "utf8")) as PriceHistoryValidation;
  const missing = REQUIRED_VALIDATION_KEYS.filter((k) => !(k in validation));
  const okDecision = validation.decision === "price_history_ready" || validation.decision === "price_history_ready_with_warnings";
  const ok = missing.length === 0 && okDecision;
  console.log(`decision=${validation.decision}`);
  console.log(`validation_keys_complete=${missing.length === 0}`);
  if (missing.length > 0) console.log(`missing_keys=${missing.join(",")}`);
  console.log(`comparison_pair_count=${validation.comparison_pair_count}`);
  console.log(`daily_signal_rows=${validation.daily_signal_rows}`);
  console.log(`insufficient_data_days=${validation.insufficient_data_days}`);
  console.log(`validate:price-history-signals=${ok ? "passed" : "failed"}`);
  if (!ok) process.exitCode = 1;
}

function run(): void {
  if (process.argv.includes("--check")) {
    runCheck();
    return;
  }
  const files = readHistoryFiles();
  const parsed = parseHistoryForPriceHistory(files);
  const { changes, dailySignals, validation } = buildPriceHistorySignals(parsed.rows, {
    runAt: jstNow(),
    inputSources: files.map((f) => `${HISTORY_DIR}/${f.filename}`),
    totalRawRows: parsed.totalRawRows,
    observedAtColumnUsed: parsed.observedAtColumnUsed,
    observedAtConfidence: parsed.observedAtConfidence
  });

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const changesPath = resolve(OUT_DIR, PRICE_HISTORY_FILES.changes);
  const dailyPath = resolve(OUT_DIR, PRICE_HISTORY_FILES.daily);
  const validationPath = resolve(OUT_DIR, PRICE_HISTORY_FILES.validation);
  writeFileSync(changesPath, renderCompetitorPriceChangesCsv(changes), "utf8");
  writeFileSync(dailyPath, renderMarketDailySignalsCsv(dailySignals), "utf8");
  writeFileSync(validationPath, `${JSON.stringify(validation, null, 2)}\n`, "utf8");

  console.log(`decision=${validation.decision}`);
  console.log(`competitor_price_changes_rows=${changes.length}`);
  console.log(`market_daily_price_change_signals_rows=${dailySignals.length}`);
  console.log(`comparison_pair_count=${validation.comparison_pair_count}`);
  console.log(`comparable_rows=${validation.comparable_rows}`);
  console.log(`non_comparable_rows=${validation.non_comparable_rows}`);
  console.log(`excluded_meal_basis_count=${validation.excluded_meal_basis_count}`);
  console.log(`excluded_room_basis_count=${validation.excluded_room_basis_count}`);
  console.log(`insufficient_data_days=${validation.insufficient_data_days}`);
  console.log(`observed_at_column_used=${validation.observed_at_column_used}`);
  console.log(`change_type_counts=${JSON.stringify(validation.change_type_counts)}`);
  console.log(`changes_path=${changesPath}`);
  console.log(`daily_path=${dailyPath}`);
  console.log(`validation_path=${validationPath}`);
  for (const w of validation.warnings) console.log(`warning=${w}`);
}

run();
