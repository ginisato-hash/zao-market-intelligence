// Phase ZMI-MKT-OBS02 — operational pair report (PART B4).
//
// Reads the append-only observation store and reports, per CORE competitor,
// what the morning and afternoon passes actually produced together: how many
// comparable product pairs formed, and what those pairs show (price moves,
// inventory depletion/expansion, sell-outs, reopens) — plus the honest
// negative categories (unavailable comparisons, identity mismatch, parse
// failures) rather than only the successes.
//
// Two runs are treated as a PAIR only when they are genuinely separated in
// wall-clock time; the report always states the real observed gap, so a
// same-instant refetch can never be presented as a 12h pair.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_COMPETITORS } from "../services/coreCompetitorTargets";
import { comparisonKeyOf } from "../services/searchContextIdentity";
import {
  buildAdjacentTransitionPairs,
  checkPairComparable,
  generateBinaryTransition,
  generateNumericInventoryTransition,
  generatePriceTransition
} from "../services/marketObservationTransitions";
import type { MarketObservationRow } from "../services/marketObservationSchema";

const OBSERVATIONS_DIR = ".data/market-observations";

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function loadObservations(): MarketObservationRow[] {
  if (!existsSync(OBSERVATIONS_DIR)) return [];
  const rows: MarketObservationRow[] = [];
  for (const file of readdirSync(OBSERVATIONS_DIR).filter((f) => /^mkt_obs_\d{4}_\d{2}\.csv$/u.test(f))) {
    const lines = readFileSync(join(OBSERVATIONS_DIR, file), "utf8").split(/\r?\n/u).filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const header = splitCsvLine(lines[0]!);
    const idx = (name: string): number => header.indexOf(name);
    for (const line of lines.slice(1)) {
      const c = splitCsvLine(line);
      const num = (name: string): number | null => {
        const v = c[idx(name)];
        return v === undefined || v === "" ? null : Number(v);
      };
      rows.push({
        observationId: c[idx("observation_id")] ?? "",
        observationHash: c[idx("observation_hash")] ?? "",
        propertyId: c[idx("property_id")] ?? "",
        propertyName: c[idx("property_name")] ?? "",
        sourcePlatform: (c[idx("source_platform")] ?? "booking") as MarketObservationRow["sourcePlatform"],
        stayDate: c[idx("stay_date")] ?? "",
        observedAtJst: c[idx("observed_at_jst")] ?? "",
        roomProductKey: c[idx("room_product_key")] ?? "",
        roomTypeName: c[idx("room_type_name")] ?? "",
        ratePlanKey: c[idx("rate_plan_key")] ?? "",
        ratePlanName: c[idx("rate_plan_name")] ?? "",
        searchAdults: num("search_adults") ?? 0,
        searchChildren: num("search_children") ?? 0,
        searchRooms: num("search_rooms") ?? 0,
        lengthOfStay: num("length_of_stay") ?? 0,
        currency: c[idx("currency")] ?? "JPY",
        observedPrice: num("observed_price"),
        availabilityStatus: (c[idx("availability_status")] ?? "UNKNOWN") as MarketObservationRow["availabilityStatus"],
        inventoryCount: num("inventory_count"),
        inventoryCountSemantics: (c[idx("inventory_count_semantics")] ?? "UNKNOWN") as MarketObservationRow["inventoryCountSemantics"],
        inventoryScope: (c[idx("inventory_scope")] ?? "UNKNOWN") as MarketObservationRow["inventoryScope"],
        sourceQuality: (c[idx("source_quality")] ?? "LOW") as MarketObservationRow["sourceQuality"],
        rawEvidenceHash: c[idx("raw_evidence_hash")] ?? "",
        collectorRunId: c[idx("collector_run_id")] ?? ""
      });
    }
  }
  return rows;
}

function run(): void {
  const args = process.argv.slice(2);
  const runA = args.find((a) => a.startsWith("--run-a="))?.split("=")[1] ?? "";
  const runB = args.find((a) => a.startsWith("--run-b="))?.split("=")[1] ?? "";
  const all = loadObservations();

  const runIds = [...new Set(all.map((r) => r.collectorRunId))].sort();
  console.log(`total_observations=${all.length}`);
  console.log(`distinct_collector_runs=${runIds.length}`);
  console.log(`collector_runs=${JSON.stringify(runIds)}`);

  // Default to the two most recent runs when not explicitly given.
  const a = runA || runIds[runIds.length - 2] || "";
  const b = runB || runIds[runIds.length - 1] || "";
  if (a === "" || b === "" || a === b) {
    console.log(`decision=core_competitor_pair_report_insufficient_runs`);
    return;
  }

  const rowsA = all.filter((r) => r.collectorRunId === a);
  const rowsB = all.filter((r) => r.collectorRunId === b);
  const tA = rowsA.map((r) => Date.parse(r.observedAtJst)).filter((n) => Number.isFinite(n));
  const tB = rowsB.map((r) => Date.parse(r.observedAtJst)).filter((n) => Number.isFinite(n));
  const startA = Math.min(...tA);
  const startB = Math.min(...tB);
  const gapMinutes = Math.round(Math.abs(startB - startA) / 60_000);

  console.log(`pair_run_a=${a} pair_run_b=${b}`);
  console.log(`pair_run_a_first_observed=${new Date(startA).toISOString()}`);
  console.log(`pair_run_b_first_observed=${new Date(startB).toISOString()}`);
  // Stated explicitly so a short gap can never be misread as a 12h AM/PM pair.
  console.log(`real_observed_gap_minutes=${gapMinutes}`);
  console.log(`is_same_instant_refetch=${gapMinutes < 1}`);

  const pairRows = [...rowsA, ...rowsB];
  console.log("");
  console.log("property\tsource\tmorning_obs\tafternoon_obs\tcomparable_pairs\tprice_up\tprice_down\tprice_unchanged\tdepletion\texpansion\tsell_out\treopen\tunavailable_cmp\tidentity_mismatch\tparse_failures");

  for (const competitor of CORE_COMPETITORS) {
    for (const source of ["booking", "jalan"] as const) {
      const mine = pairRows.filter((r) => r.propertyId === competitor.propertyId && r.sourcePlatform === source);
      const morning = mine.filter((r) => r.collectorRunId === a);
      const afternoon = mine.filter((r) => r.collectorRunId === b);

      const pairs = buildAdjacentTransitionPairs(mine);
      let priceUp = 0, priceDown = 0, priceUnchanged = 0;
      let depletion = 0, expansion = 0, sellOut = 0, reopen = 0;
      let unavailableCmp = 0, identityMismatch = 0;
      for (const pair of pairs) {
        const mismatch = checkPairComparable(pair);
        if (mismatch !== null) {
          identityMismatch += 1;
          continue;
        }
        const price = generatePriceTransition(pair);
        if (price === null) unavailableCmp += 1;
        else if (price.type === "PRICE_UP") priceUp += 1;
        else if (price.type === "PRICE_DOWN") priceDown += 1;
        else priceUnchanged += 1;

        const numeric = generateNumericInventoryTransition(pair);
        if (numeric?.type === "OBSERVED_INVENTORY_DEPLETION") depletion += 1;
        if (numeric?.type === "INVENTORY_EXPANSION") expansion += 1;

        const binary = generateBinaryTransition(pair);
        if (binary?.type === "SELL_OUT_TRANSITION") sellOut += 1;
        if (binary?.type === "INVENTORY_REOPENED") reopen += 1;
      }
      // A product observed in only ONE of the two runs cannot form a pair —
      // counted explicitly so a shrinking//growing product set is visible
      // rather than silently reducing the pair count.
      const keysA = new Set(morning.map(comparisonKeyOf));
      const keysB = new Set(afternoon.map(comparisonKeyOf));
      const oneSided = [...keysA].filter((k) => !keysB.has(k)).length + [...keysB].filter((k) => !keysA.has(k)).length;
      const parseFailures = mine.filter((r) => r.availabilityStatus === "PARSE_FAILED").length;

      console.log(
        [
          competitor.propertyId,
          source,
          morning.length,
          afternoon.length,
          pairs.length - identityMismatch,
          priceUp,
          priceDown,
          priceUnchanged,
          depletion,
          expansion,
          sellOut,
          reopen,
          `${unavailableCmp}(+${oneSided} one-sided)`,
          identityMismatch,
          parseFailures
        ].join("\t")
      );
    }
  }
  console.log("");
  console.log(`decision=core_competitor_pair_report_ready`);
}

run();
