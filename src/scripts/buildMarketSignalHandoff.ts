// Phase ZMI-MKT-OBS03 — build the Refine/RMS market-signal handoff artifact.
//
// READ-ONLY over the append-only observation store: reads two collector runs
// (T0/T1), emits one JSON artifact of raw per-pair features and transitions.
// Never writes to .data/market-observations, never touches history, pricing,
// Beds24, or Refine policy — and never computes a weighted market score.
//
// Usage:
//   npm run market-observation:handoff -- --run-t0=<runId> --run-t1=<runId>
// With no arguments it uses the two most recent runs in the store.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CORE_COMPETITORS } from "../services/coreCompetitorTargets";
import { assessDataQuality } from "../services/marketObservationQuality";
import { buildAdjacentTransitionPairs } from "../services/marketObservationTransitions";
import {
  HANDOFF_UNKNOWN_FIELDS,
  HANDOFF_WEIGHTING_POLICY,
  MARKET_SIGNAL_HANDOFF_SCHEMA_VERSION,
  buildHandoffRow,
  summarizeHandoffRows,
  type MarketSignalHandoffArtifact,
  type MarketSignalHandoffRow
} from "../services/marketSignalHandoffContract";
import type { MarketObservationRow } from "../services/marketObservationSchema";
import { summarizeHandoffValidation, validateHandoffArtifact } from "../services/marketSignalHandoffValidation";

const OBSERVATIONS_DIR = ".data/market-observations";
const OUT_DIR = ".data/market-observation-handoff";

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
    const ix = (name: string): number => header.indexOf(name);
    for (const line of lines.slice(1)) {
      const c = splitCsvLine(line);
      const num = (name: string): number | null => {
        const v = c[ix(name)];
        return v === undefined || v === "" ? null : Number(v);
      };
      rows.push({
        observationId: c[ix("observation_id")] ?? "",
        observationHash: c[ix("observation_hash")] ?? "",
        propertyId: c[ix("property_id")] ?? "",
        propertyName: c[ix("property_name")] ?? "",
        sourcePlatform: (c[ix("source_platform")] ?? "booking") as MarketObservationRow["sourcePlatform"],
        stayDate: c[ix("stay_date")] ?? "",
        observedAtJst: c[ix("observed_at_jst")] ?? "",
        roomProductKey: c[ix("room_product_key")] ?? "",
        roomTypeName: c[ix("room_type_name")] ?? "",
        ratePlanKey: c[ix("rate_plan_key")] ?? "",
        ratePlanName: c[ix("rate_plan_name")] ?? "",
        searchAdults: num("search_adults") ?? 0,
        searchChildren: num("search_children") ?? 0,
        searchRooms: num("search_rooms") ?? 0,
        lengthOfStay: num("length_of_stay") ?? 0,
        currency: c[ix("currency")] ?? "JPY",
        observedPrice: num("observed_price"),
        availabilityStatus: (c[ix("availability_status")] ?? "UNKNOWN") as MarketObservationRow["availabilityStatus"],
        inventoryCount: num("inventory_count"),
        inventoryCountSemantics: (c[ix("inventory_count_semantics")] ?? "UNKNOWN") as MarketObservationRow["inventoryCountSemantics"],
        inventoryScope: (c[ix("inventory_scope")] ?? "UNKNOWN") as MarketObservationRow["inventoryScope"],
        sourceQuality: (c[ix("source_quality")] ?? "LOW") as MarketObservationRow["sourceQuality"],
        rawEvidenceHash: c[ix("raw_evidence_hash")] ?? "",
        collectorRunId: c[ix("collector_run_id")] ?? ""
      });
    }
  }
  return rows;
}

function jstIso(): string {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  return `${f.replace(" ", "T")}+09:00`;
}

function run(): void {
  const args = process.argv.slice(2);
  const argT0 = args.find((a) => a.startsWith("--run-t0="))?.split("=")[1] ?? "";
  const argT1 = args.find((a) => a.startsWith("--run-t1="))?.split("=")[1] ?? "";
  const all = loadObservations();
  const runIds = [...new Set(all.map((r) => r.collectorRunId))].sort();

  const t0Id = argT0 || runIds[runIds.length - 2] || "";
  const t1Id = argT1 || runIds[runIds.length - 1] || "";
  if (t0Id === "" || t1Id === "" || t0Id === t1Id) {
    console.log(`decision=market_signal_handoff_insufficient_runs`);
    console.log(`available_runs=${JSON.stringify(runIds)}`);
    process.exitCode = 1;
    return;
  }

  const paired = all.filter((r) => r.collectorRunId === t0Id || r.collectorRunId === t1Id);
  const t0Rows = paired.filter((r) => r.collectorRunId === t0Id);
  const t1Rows = paired.filter((r) => r.collectorRunId === t1Id);
  const firstOf = (rows: MarketObservationRow[]): string => rows.map((r) => r.observedAtJst).sort()[0] ?? "";
  const t0First = firstOf(t0Rows);
  const t1First = firstOf(t1Rows);
  const gapMinutes = Math.round(Math.abs(Date.parse(t1First) - Date.parse(t0First)) / 60_000);

  const stayDates = [...new Set(paired.map((r) => r.stayDate))].sort();
  const nowIso = jstIso();
  const qualityByStayDate = stayDates.map((stayDate) => {
    const q = assessDataQuality({ stayDate, rows: paired, expectedCompetitorCount: CORE_COMPETITORS.length, nowIso });
    return { stay_date: stayDate, tier: q.tier, observation_count: q.observationCount, comparison_pair_count: q.comparisonPairCount };
  });
  const tierByStayDate = new Map(qualityByStayDate.map((q) => [q.stay_date, q.tier]));

  // Only ADJACENT pairs within a comparison key, ordered by real observed_at —
  // reuses the same generator the collector and pair report use, so the
  // artifact can never disagree with them.
  const signals: MarketSignalHandoffRow[] = buildAdjacentTransitionPairs(paired).map((pair) =>
    buildHandoffRow(pair, tierByStayDate.get(pair.previous.stayDate) ?? "INSUFFICIENT")
  );

  const artifact: MarketSignalHandoffArtifact = {
    schema_version: MARKET_SIGNAL_HANDOFF_SCHEMA_VERSION,
    generated_at_jst: nowIso,
    source_run_ids: { t0: t0Id, t1: t1Id },
    pair: {
      t0_first_observed_jst: t0First,
      t1_first_observed_jst: t1First,
      gap_minutes: gapMinutes,
      is_same_instant_refetch: gapMinutes < 1
    },
    competitors: CORE_COMPETITORS.map((c) => c.propertyName),
    stay_dates: stayDates,
    quality_by_stay_date: qualityByStayDate,
    unknown_fields: [...HANDOFF_UNKNOWN_FIELDS],
    weighting_policy: HANDOFF_WEIGHTING_POLICY,
    signals,
    totals: summarizeHandoffRows(signals)
  };

  // §11 sanity audit of the artifact we are about to publish, derived from its
  // own published values so a generator bug cannot validate itself.
  const findings = validateHandoffArtifact(artifact, Date.now());
  const validation = summarizeHandoffValidation(findings);

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const dateStamp = nowIso.slice(0, 10);
  const outPath = resolve(OUT_DIR, `market_signal_handoff_${dateStamp}.json`);
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`schema_version=${artifact.schema_version}`);
  console.log(`source_run_t0=${t0Id}`);
  console.log(`source_run_t1=${t1Id}`);
  console.log(`t0_first_observed=${t0First}`);
  console.log(`t1_first_observed=${t1First}`);
  console.log(`gap_minutes=${gapMinutes}`);
  console.log(`is_same_instant_refetch=${artifact.pair.is_same_instant_refetch}`);
  console.log(`stay_dates=${stayDates.length}`);
  console.log(`signals=${artifact.totals.signal_count}`);
  console.log(`comparable_pairs=${artifact.totals.comparable_pairs}`);
  console.log(`numeric_inventory_pairs=${artifact.totals.numeric_inventory_pairs}`);
  console.log(`price_up=${artifact.totals.price_up} price_down=${artifact.totals.price_down} price_unchanged=${artifact.totals.price_unchanged}`);
  console.log(`observed_inventory_depletion=${artifact.totals.observed_inventory_depletion} inventory_expansion=${artifact.totals.inventory_expansion} inventory_unchanged=${artifact.totals.inventory_unchanged}`);
  console.log(`sell_out_transition=${artifact.totals.sell_out_transition} inventory_reopened=${artifact.totals.inventory_reopened}`);
  console.log(`parse_failures=${artifact.totals.parse_failures}`);
  console.log(`quality_tiers=${JSON.stringify(qualityByStayDate.reduce<Record<string, number>>((acc, q) => ({ ...acc, [q.tier]: (acc[q.tier] ?? 0) + 1 }), {}))}`);
  console.log(`artifact_path=${outPath}`);
  console.log(`validation_findings_total=${validation.total}`);
  console.log(`validation_findings_fatal=${validation.fatal}`);
  console.log(`validation_findings_review=${validation.review}`);
  console.log(`validation_by_code=${JSON.stringify(validation.byCode)}`);
  for (const f of findings.slice(0, 10)) console.log(`  finding: ${f.code} :: ${f.detail}`);
  console.log(`decision=${validation.fatal > 0 ? "market_signal_handoff_validation_failed" : "market_signal_handoff_ready"}`);
  if (validation.fatal > 0) process.exitCode = 1;
}

run();
