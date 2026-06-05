import crypto from "node:crypto";
import type { PricingTargetConfig } from "../config/pricingTargetSchema";
import type { MarketDailySignalRecord } from "./computeMarketSignals";
import type { TargetDatePriority } from "../domain/types";

export type PricingRecommendationConfidence = "A" | "B" | "C" | "fallback";

export interface PricingRecommendationRecord {
  id: string;
  targetId: string;
  stayDate: string;
  sourceMarket: "jalan";
  targetPriority: TargetDatePriority | null;
  rawMarketMedianJpy: number | null;
  qualityAdjustedMarketMedianJpy: number | null;
  baselineAdrJpy: number;
  recommendedPriceJpy: number;
  minPriceJpy: number;
  maxPriceJpy: number;
  confidence: PricingRecommendationConfidence;
  recommendationReason: string;
  marketSignalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function generatePricingRecommendation(input: {
  target: PricingTargetConfig;
  signal?: MarketDailySignalRecord;
  priority?: TargetDatePriority | null;
  createdAt?: string;
}): PricingRecommendationRecord | undefined {
  if (!input.target.active) return undefined;

  const now = input.createdAt ?? new Date().toISOString();
  const priority = input.priority ?? null;
  const base = chooseBasePrice(input.target, input.signal);
  const multiplier = priorityMultiplier(priority);
  const reasonParts = [`${base.reason}:${priority ?? "no"}_priority_multiplier`];
  const multiplied = Math.round(base.price * multiplier);
  const clamped = clamp(multiplied, input.target.min_price_jpy, input.target.max_price_jpy);
  if (clamped === input.target.min_price_jpy && multiplied < input.target.min_price_jpy) {
    reasonParts.push("clamped_to_min_price");
  }
  if (clamped === input.target.max_price_jpy && multiplied > input.target.max_price_jpy) {
    reasonParts.push("clamped_to_max_price");
  }
  const rounded = clamp(
    roundToUnit(clamped, input.target.rounding_unit_jpy),
    input.target.min_price_jpy,
    input.target.max_price_jpy
  );

  return {
    id: stableRecommendationId(input.target.target_id, input.signal?.stayDate ?? "no_signal", input.target.source_market),
    targetId: input.target.target_id,
    stayDate: input.signal?.stayDate ?? "",
    sourceMarket: input.target.source_market,
    targetPriority: priority,
    rawMarketMedianJpy: input.signal?.medianPriceJpy ?? null,
    qualityAdjustedMarketMedianJpy: input.signal?.qualityAdjustedMedianPriceJpy ?? null,
    baselineAdrJpy: input.target.baseline_adr_jpy,
    recommendedPriceJpy: rounded,
    minPriceJpy: input.target.min_price_jpy,
    maxPriceJpy: input.target.max_price_jpy,
    confidence: recommendationConfidence(input.signal, base.kind),
    recommendationReason: reasonParts.join(";"),
    marketSignalId: input.signal?.id ?? null,
    createdAt: now,
    updatedAt: now
  };
}

export function generatePricingRecommendations(input: {
  targets: PricingTargetConfig[];
  signals: MarketDailySignalRecord[];
  targetDatePriorities: Map<string, TargetDatePriority>;
  createdAt?: string;
}): PricingRecommendationRecord[] {
  const rows: PricingRecommendationRecord[] = [];
  for (const target of input.targets.filter((target) => target.active)) {
    const matchingSignals = input.signals.filter((signal) => signal.source === target.source_market);
    for (const signal of matchingSignals) {
      const row = generatePricingRecommendation({
        target,
        signal,
        priority: input.targetDatePriorities.get(signal.stayDate) ?? null,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
      });
      if (row !== undefined) rows.push(row);
    }
  }
  return rows;
}

function chooseBasePrice(
  target: PricingTargetConfig,
  signal: MarketDailySignalRecord | undefined
): { price: number; kind: "adjusted" | "raw" | "baseline"; reason: string } {
  if (target.strategy === "baseline_with_priority_multiplier") {
    return { price: target.baseline_adr_jpy, kind: "baseline", reason: "baseline_used_by_strategy" };
  }
  if (signal?.qualityAdjustedMedianPriceJpy !== null && signal?.qualityAdjustedMedianPriceJpy !== undefined) {
    return {
      price: signal.qualityAdjustedMedianPriceJpy,
      kind: "adjusted",
      reason: "quality_adjusted_market_median_used"
    };
  }
  if (signal?.medianPriceJpy !== null && signal?.medianPriceJpy !== undefined && signal.confidence !== "insufficient") {
    return {
      price: signal.medianPriceJpy,
      kind: "raw",
      reason: "raw_market_median_used_due_to_no_adjusted_metric"
    };
  }
  return {
    price: target.baseline_adr_jpy,
    kind: "baseline",
    reason: "baseline_used_due_to_insufficient_market_signal"
  };
}

function recommendationConfidence(
  signal: MarketDailySignalRecord | undefined,
  baseKind: "adjusted" | "raw" | "baseline"
): PricingRecommendationConfidence {
  if (signal === undefined || baseKind === "baseline") return "fallback";
  if (baseKind === "raw") return signal.confidence === "insufficient" ? "fallback" : "C";
  if (signal.confidence === "A" && signal.qualityAdjustedSampleSize >= 5) return "A";
  if ((signal.confidence === "A" || signal.confidence === "B") && signal.qualityAdjustedSampleSize >= 3) return "B";
  if (signal.confidence === "C" || signal.qualityAdjustedSampleSize >= 1) return "C";
  return "fallback";
}

function priorityMultiplier(priority: TargetDatePriority | null): number {
  if (priority === "S") return 1.2;
  if (priority === "A") return 1.1;
  if (priority === "B") return 1;
  if (priority === "C") return 0.92;
  return 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToUnit(value: number, unit: number): number {
  return Math.round(value / unit) * unit;
}

function stableRecommendationId(targetId: string, stayDate: string, sourceMarket: string): string {
  const digest = crypto.createHash("sha1").update(`${targetId}|${stayDate}|${sourceMarket}`).digest("hex").slice(0, 16);
  return `pricing_rec_${digest}`;
}
