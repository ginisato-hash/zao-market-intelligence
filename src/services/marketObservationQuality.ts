// Phase ZMI-MKT-OBS01 — market compression raw features + data quality (pure). §15/§16/§17.
//
// ZMI's responsibility stops at observation + normalization (§16): this
// module aggregates RAW counts/magnitudes per stay_date and classifies data
// QUALITY (is there enough data to trust at all), but never produces a
// single weighted "compression score" — Refine decides how (and whether) to
// weight these features after its own replay validation.
//
// §17: UNKNOWN inputs must never quietly become "NORMAL" — the quality
// classifier is a coverage/reliability GATE (enough real data or not), not a
// pricing weight, so discrete HIGH/MEDIUM/LOW/INSUFFICIENT tiers here do not
// conflict with §16's "no weighted score" rule.
//
// No I/O, no network.

import type { MarketObservationRow } from "./marketObservationSchema";
import { comparisonKeyOf } from "./searchContextIdentity";
import {
  buildAdjacentTransitionPairs,
  generateBinaryTransition,
  generateNumericInventoryTransition,
  generatePriceTransition
} from "./marketObservationTransitions";

export interface MarketCompressionRawFeatures {
  stayDate: string;
  observedCompetitorCount: number;
  availableCompetitorCount: number;
  soldOutCompetitorCount: number;
  numericInventoryObservationCount: number;
  binaryObservationCount: number;
  depletionEventCount: number;
  depletionMagnitudeTotal: number;
  expansionEventCount: number;
  expansionMagnitudeTotal: number;
  sellOutTransitionCount: number;
  reopenCount: number;
  priceUpCount: number;
  priceDownCount: number;
  medianPriceChangeAbsolute: number | null;
  medianPriceChangePercentage: number | null;
  repeatedPairCount: number;
  failedCollectionCount: number;
  newestObservationAgeMinutes: number | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// nowIso is supplied by the caller (never Date.now() inside a pure module) so
// this stays deterministic and testable.
export function computeMarketCompressionRawFeatures(input: {
  stayDate: string;
  rows: readonly MarketObservationRow[];
  nowIso: string;
}): MarketCompressionRawFeatures {
  const rows = input.rows.filter((r) => r.stayDate === input.stayDate);
  const byProperty = new Set(rows.map((r) => r.propertyId));
  const available = rows.filter((r) => r.availabilityStatus === "AVAILABLE");
  const soldOut = rows.filter((r) => r.availabilityStatus === "SOLD_OUT");
  const failed = rows.filter((r) => r.availabilityStatus === "COLLECTION_FAILED" || r.availabilityStatus === "PARSE_FAILED");
  const numericInventory = rows.filter(
    (r) => r.inventoryCount !== null && r.inventoryCountSemantics !== "BINARY_AVAILABILITY" && r.inventoryCountSemantics !== "UNKNOWN"
  );
  const binaryOnly = rows.filter((r) => r.inventoryCountSemantics === "BINARY_AVAILABILITY");

  const pairs = buildAdjacentTransitionPairs(rows);
  const numericTransitions = pairs.map(generateNumericInventoryTransition).filter((t) => t !== null);
  const binaryTransitions = pairs.map(generateBinaryTransition).filter((t) => t !== null);
  const priceTransitions = pairs.map(generatePriceTransition).filter((t) => t !== null);

  const depletions = numericTransitions.filter((t) => t!.type === "OBSERVED_INVENTORY_DEPLETION");
  const expansions = numericTransitions.filter((t) => t!.type === "INVENTORY_EXPANSION");
  const sellOuts = binaryTransitions.filter((t) => t!.type === "SELL_OUT_TRANSITION");
  const reopens = binaryTransitions.filter((t) => t!.type === "INVENTORY_REOPENED");
  const priceUps = priceTransitions.filter((t) => t!.type === "PRICE_UP");
  const priceDowns = priceTransitions.filter((t) => t!.type === "PRICE_DOWN");

  const byKey = new Map<string, number>();
  for (const row of rows) {
    const key = comparisonKeyOf(row);
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  const repeatedPairCount = [...byKey.values()].filter((count) => count >= 2).length;

  const newest = rows.reduce<string | null>((acc, r) => (acc === null || r.observedAtJst > acc ? r.observedAtJst : acc), null);
  const newestObservationAgeMinutes =
    newest === null ? null : Math.max(0, Math.round((Date.parse(input.nowIso) - Date.parse(newest)) / 60_000));

  return {
    stayDate: input.stayDate,
    observedCompetitorCount: byProperty.size,
    availableCompetitorCount: new Set(available.map((r) => r.propertyId)).size,
    soldOutCompetitorCount: new Set(soldOut.map((r) => r.propertyId)).size,
    numericInventoryObservationCount: numericInventory.length,
    binaryObservationCount: binaryOnly.length,
    depletionEventCount: depletions.length,
    depletionMagnitudeTotal: depletions.reduce((sum, t) => sum + t!.magnitude, 0),
    expansionEventCount: expansions.length,
    expansionMagnitudeTotal: expansions.reduce((sum, t) => sum + t!.magnitude, 0),
    sellOutTransitionCount: sellOuts.length,
    reopenCount: reopens.length,
    priceUpCount: priceUps.length,
    priceDownCount: priceDowns.length,
    medianPriceChangeAbsolute: median(priceTransitions.map((t) => t!.absoluteDelta)),
    medianPriceChangePercentage: median(priceTransitions.map((t) => t!.percentageDelta)),
    repeatedPairCount,
    failedCollectionCount: failed.length,
    newestObservationAgeMinutes
  };
}

export type DataQualityTier = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";

export interface DataQualityAssessment {
  stayDate: string;
  observationCount: number;
  comparisonPairCount: number;
  competitorCoverage: number; // observed / expectedCompetitorCount, 0..1
  exactNumericCoverage: number; // numeric-inventory rows / observationCount, 0..1
  binaryCoverage: number; // binary-only rows / observationCount, 0..1
  failedRatio: number; // failed / (observationCount + failed), 0..1
  observationFreshnessMinutes: number | null;
  tier: DataQualityTier;
}

// Deliberately simple, transparent GATE thresholds (not a tuned/weighted
// score — see module doc). expectedCompetitorCount lets callers express "3
// CORE competitors" or any other cohort size without hardcoding it here.
export function assessDataQuality(input: {
  stayDate: string;
  rows: readonly MarketObservationRow[];
  expectedCompetitorCount: number;
  nowIso: string;
}): DataQualityAssessment {
  const features = computeMarketCompressionRawFeatures({ stayDate: input.stayDate, rows: input.rows, nowIso: input.nowIso });
  const observationCount = input.rows.filter((r) => r.stayDate === input.stayDate).length;
  const failedTotal = features.failedCollectionCount;
  const competitorCoverage = input.expectedCompetitorCount > 0 ? features.observedCompetitorCount / input.expectedCompetitorCount : 0;
  const exactNumericCoverage = observationCount > 0 ? features.numericInventoryObservationCount / observationCount : 0;
  const binaryCoverage = observationCount > 0 ? features.binaryObservationCount / observationCount : 0;
  const failedRatio = observationCount + failedTotal > 0 ? failedTotal / (observationCount + failedTotal) : 0;

  let tier: DataQualityTier;
  if (observationCount === 0 || competitorCoverage === 0) {
    tier = "INSUFFICIENT";
  } else if (features.repeatedPairCount === 0 || failedRatio > 0.5) {
    tier = "LOW";
  } else if (competitorCoverage >= 1 && features.repeatedPairCount >= input.expectedCompetitorCount && failedRatio <= 0.1) {
    tier = "HIGH";
  } else {
    tier = "MEDIUM";
  }

  return {
    stayDate: input.stayDate,
    observationCount,
    comparisonPairCount: features.repeatedPairCount,
    competitorCoverage,
    exactNumericCoverage,
    binaryCoverage,
    failedRatio,
    observationFreshnessMinutes: features.newestObservationAgeMinutes,
    tier
  };
}
