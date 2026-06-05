import type { Confidence } from "../domain/types";

export interface PriceSample {
  priceJpy: number | null;
  confidence: Confidence;
}

export function medianPriceExcludingConfidenceC(samples: PriceSample[]): number | null {
  const prices = samples
    .filter((sample) => sample.confidence !== "C" && sample.priceJpy !== null)
    .map((sample) => sample.priceJpy as number)
    .sort((left, right) => left - right);

  if (prices.length === 0) {
    return null;
  }

  const midpoint = Math.floor(prices.length / 2);
  if (prices.length % 2 === 1) {
    return prices[midpoint] ?? null;
  }

  const lower = prices[midpoint - 1];
  const upper = prices[midpoint];
  if (lower === undefined || upper === undefined) {
    return null;
  }

  return Math.round((lower + upper) / 2);
}
