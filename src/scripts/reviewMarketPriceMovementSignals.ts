// Phase ZMI MARKET-PRICE-MOVEMENT01 — review (read-only, prints summary).
//
// Validates the derived competitor price-movement / DP-pressure proxy signals.
// --dp-pressure focuses the output on the checkin-level DP pressure ranking.
// No scraping, no live collection, no history write, no pricing/PMS output.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assembleMovementArtifacts, latestCollectedAt, type MovementType } from "../services/marketPriceMovementSignals";

const HISTORY_DIR = ".data/history";
function readHistoryFiles(): { filename: string; content: string }[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR).filter((f) => /^zao_signals_.*\.csv$/u.test(f)).sort().map((f) => ({ filename: f, content: readFileSync(join(HISTORY_DIR, f), "utf8") }));
}
function buildMovementArtifacts(): ReturnType<typeof assembleMovementArtifacts> & { movementLatest: string } {
  const a = assembleMovementArtifacts(readHistoryFiles());
  return { ...a, movementLatest: latestCollectedAt(a.movements) };
}

function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function plusDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function run(): void {
  const dpFocus = process.argv.includes("--dp-pressure");
  const a = buildMovementArtifacts();
  const m = a.movements;
  const count = (t: MovementType): number => m.filter((x) => x.movement_type === t).length;

  const upward = [...a.dpPressure].sort((x, y) => y.dp_pressure_score_normalized - x.dp_pressure_score_normalized);
  const downward = [...a.dpPressure].sort((x, y) => x.dp_pressure_score_normalized - y.dp_pressure_score_normalized);
  const top = (rows: typeof upward): string => rows.slice(0, 10).map((r) => `${r.checkin}:${r.dp_pressure_score_normalized}(${r.dp_pressure_level})`).join(";");

  const today = todayJst();
  const next30End = plusDays(today, 30);
  const inNext30 = a.dpPressure.filter((r) => r.checkin >= today && r.checkin <= next30End);
  const n30High = inNext30.filter((r) => r.dp_pressure_level === "high_upward_pressure").map((r) => r.checkin);
  const n30Mod = inNext30.filter((r) => r.dp_pressure_level === "moderate_upward_pressure").map((r) => r.checkin);
  const n30Down = inNext30.filter((r) => r.dp_pressure_level === "downward_pressure" || r.dp_pressure_level === "strong_downward_pressure").map((r) => r.checkin);

  console.log(`decision=market_price_movement_review`);
  console.log(`movement_rows=${m.length}`);
  console.log(`dp_pressure_rows=${a.dpPressure.length}`);
  console.log(`own_property_rows=${a.ownPropertyRows}`);
  console.log(`not_comparable_rows=${count("not_comparable")}`);
  console.log(`price_up_available=${count("price_up_available")}`);
  console.log(`price_down_available=${count("price_down_available")}`);
  console.log(`sold_out_after_price_up=${count("sold_out_after_price_up")}`);
  console.log(`sold_out_after_price_down=${count("sold_out_after_price_down")}`);
  console.log(`sold_out_after_same_price=${count("sold_out_after_same_price")}`);
  console.log(`newly_sold_out=${count("newly_sold_out")}`);
  console.log(`newly_available=${count("newly_available")}`);
  console.log(`same_price_available=${count("same_price_available")}`);
  console.log(`noise=${count("noise")}`);
  console.log(`unknown=${count("unknown")}`);
  console.log(`top_upward_pressure_checkins=${top(upward)}`);
  console.log(`top_downward_pressure_checkins=${top(downward)}`);
  console.log(`next30_high_upward_pressure_dates=${n30High.join(",")}`);
  console.log(`next30_moderate_upward_pressure_dates=${n30Mod.join(",")}`);
  console.log(`next30_downward_pressure_dates=${n30Down.join(",")}`);

  if (dpFocus) {
    for (const r of upward.slice(0, 20)) {
      console.log(`dp_checkin=${r.checkin} level=${r.dp_pressure_level} normalized=${r.dp_pressure_score_normalized} raw=${r.dp_pressure_score_raw} samples=${r.movement_sample_count} reason=${r.dp_pressure_reason}`);
    }
  }
}

run();
