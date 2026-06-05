import type {
  PricingRecommendationConfidence,
  PricingRecommendationRecord
} from "./generatePricingRecommendations";

// Default gap threshold (ratio, not percent). 0.25 == 25%.
export const DEFAULT_LARGE_GAP_THRESHOLD = 0.25;

export type PricingRecommendationAuditFlag =
  | "fallback_recommendation"
  | "low_confidence_recommendation"
  | "raw_fallback_quality_excluded"
  | "adjusted_median_unavailable"
  | "clamped_recommendation"
  | "large_gap_from_market_median"
  | "no_market_signal";

export type ChosenMarketMedianKind = "adjusted" | "raw" | "none";

export interface PricingRecommendationAuditRow {
  id: string;
  targetId: string;
  stayDate: string;
  sourceMarket: string;
  recommendedPriceJpy: number;
  confidence: PricingRecommendationConfidence;
  flags: PricingRecommendationAuditFlag[];
  reason: string;
  marketSignalId: string | null;
  chosenMarketMedianJpy: number | null;
  chosenMarketMedianKind: ChosenMarketMedianKind;
  gapFromChosenMarketMedianPct: number | null;
}

export interface PricingRecommendationAuditSummary {
  totalRecommendations: number;
  countsByConfidence: Record<string, number>;
  countsByFlag: Record<string, number>;
  flaggedRows: PricingRecommendationAuditRow[];
}

export interface AuditPricingRecommendationsOptions {
  largeGapThreshold?: number;
}

/** Computes audit flags for a single recommendation. Read-only / pure. */
export function auditPricingRecommendationRow(
  record: PricingRecommendationRecord,
  options: AuditPricingRecommendationsOptions = {}
): PricingRecommendationAuditRow {
  const threshold = options.largeGapThreshold ?? DEFAULT_LARGE_GAP_THRESHOLD;
  const chosen = chooseMarketMedian(record);
  const ratio =
    chosen.value !== null && chosen.value > 0
      ? Math.abs(record.recommendedPriceJpy - chosen.value) / chosen.value
      : null;

  const flags: PricingRecommendationAuditFlag[] = [];

  if (record.confidence === "fallback") flags.push("fallback_recommendation");
  if (record.confidence === "C") flags.push("low_confidence_recommendation");
  if (record.rawMarketMedianJpy !== null && record.qualityAdjustedMarketMedianJpy === null) {
    flags.push("raw_fallback_quality_excluded");
  }
  if (record.qualityAdjustedMarketMedianJpy === null && record.marketSignalId !== null) {
    flags.push("adjusted_median_unavailable");
  }
  if (
    record.recommendationReason.includes("clamped_to_min_price") ||
    record.recommendationReason.includes("clamped_to_max_price")
  ) {
    flags.push("clamped_recommendation");
  }
  if (ratio !== null && ratio > threshold) {
    flags.push("large_gap_from_market_median");
  }
  if (record.marketSignalId === null) flags.push("no_market_signal");

  return {
    id: record.id,
    targetId: record.targetId,
    stayDate: record.stayDate,
    sourceMarket: record.sourceMarket,
    recommendedPriceJpy: record.recommendedPriceJpy,
    confidence: record.confidence,
    flags,
    reason: record.recommendationReason,
    marketSignalId: record.marketSignalId,
    chosenMarketMedianJpy: chosen.value,
    chosenMarketMedianKind: chosen.kind,
    gapFromChosenMarketMedianPct: ratio === null ? null : Math.round(ratio * 1000) / 10
  };
}

/** Audits a set of recommendations and aggregates counts + flagged rows. Read-only / pure. */
export function auditPricingRecommendations(
  records: PricingRecommendationRecord[],
  options: AuditPricingRecommendationsOptions = {}
): PricingRecommendationAuditSummary {
  const auditRows = records.map((record) => auditPricingRecommendationRow(record, options));

  const countsByConfidence: Record<string, number> = {};
  const countsByFlag: Record<string, number> = {};
  for (const row of auditRows) {
    countsByConfidence[row.confidence] = (countsByConfidence[row.confidence] ?? 0) + 1;
    for (const flag of row.flags) {
      countsByFlag[flag] = (countsByFlag[flag] ?? 0) + 1;
    }
  }

  return {
    totalRecommendations: auditRows.length,
    countsByConfidence,
    countsByFlag,
    flaggedRows: auditRows.filter((row) => row.flags.length > 0)
  };
}

function chooseMarketMedian(record: PricingRecommendationRecord): {
  value: number | null;
  kind: ChosenMarketMedianKind;
} {
  if (record.qualityAdjustedMarketMedianJpy !== null) {
    return { value: record.qualityAdjustedMarketMedianJpy, kind: "adjusted" };
  }
  if (record.rawMarketMedianJpy !== null) {
    return { value: record.rawMarketMedianJpy, kind: "raw" };
  }
  return { value: null, kind: "none" };
}
