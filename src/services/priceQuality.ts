export type PriceQualityFlag =
  | "too_low_absolute"
  | "too_high_absolute"
  | "too_low_vs_market"
  | "too_high_vs_market"
  | "price_basis_suspicious"
  | "single_sample_low_confidence"
  | "none";

export type PriceQualitySeverity = "none" | "low" | "medium" | "high";

export type PriceQualityAssessment = {
  priceJpy: number | null;
  flags: PriceQualityFlag[];
  severity: PriceQualitySeverity;
  reason: string;
};

export const JALAN_LOW_ABSOLUTE_PRICE_JPY = 6000;
export const JALAN_HIGH_ABSOLUTE_PRICE_JPY = 150000;
export const LOW_MARKET_MULTIPLIER = 0.45;
export const HIGH_MARKET_MULTIPLIER = 2.5;

export interface AssessJalanPriceQualityInput {
  priceJpy: number | null;
  marketMedianJpy?: number | null;
  marketSampleSize?: number;
  knownLodgingProperty?: boolean;
  evidenceContextWeak?: boolean;
}

export function assessJalanPriceQuality(input: AssessJalanPriceQualityInput): PriceQualityAssessment {
  if (input.priceJpy === null) {
    return {
      priceJpy: null,
      flags: ["none"],
      severity: "none",
      reason: "no_available_price_to_assess"
    };
  }

  const flags: PriceQualityFlag[] = [];
  if (input.priceJpy < JALAN_LOW_ABSOLUTE_PRICE_JPY) {
    flags.push("too_low_absolute");
  }
  if (input.priceJpy > JALAN_HIGH_ABSOLUTE_PRICE_JPY) {
    flags.push("too_high_absolute");
  }

  const sampleSize = input.marketSampleSize ?? 0;
  if (input.marketMedianJpy !== null && input.marketMedianJpy !== undefined && sampleSize >= 3) {
    if (input.priceJpy < input.marketMedianJpy * LOW_MARKET_MULTIPLIER) {
      flags.push("too_low_vs_market");
    }
    if (input.priceJpy > input.marketMedianJpy * HIGH_MARKET_MULTIPLIER) {
      flags.push("too_high_vs_market");
    }
  }

  if (
    input.priceJpy < JALAN_LOW_ABSOLUTE_PRICE_JPY &&
    (input.knownLodgingProperty === true || input.evidenceContextWeak === true)
  ) {
    flags.push("price_basis_suspicious");
  }

  if (sampleSize === 1) {
    flags.push("single_sample_low_confidence");
  }

  const uniqueFlags = [...new Set(flags)];
  if (uniqueFlags.length === 0) {
    return {
      priceJpy: input.priceJpy,
      flags: ["none"],
      severity: "none",
      reason: "price_within_current_quality_thresholds"
    };
  }

  return {
    priceJpy: input.priceJpy,
    flags: uniqueFlags,
    severity: severityFor(uniqueFlags),
    reason: uniqueFlags.join(",")
  };
}

function severityFor(flags: PriceQualityFlag[]): PriceQualitySeverity {
  if (flags.includes("too_high_absolute") || flags.includes("price_basis_suspicious")) {
    return "high";
  }
  if (
    flags.includes("too_low_absolute") ||
    flags.includes("too_low_vs_market") ||
    flags.includes("too_high_vs_market")
  ) {
    return "medium";
  }
  if (flags.includes("single_sample_low_confidence")) {
    return "low";
  }
  return "none";
}
