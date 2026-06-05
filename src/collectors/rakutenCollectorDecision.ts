import type { AvailabilityStatus } from "../domain/types";
import type { RakutenExtractionEvidence } from "./rakutenEvidence";
import type { RakutenStatusDetection } from "./rakutenStatusDetection";

export interface RakutenCollectorDecision {
  status: AvailabilityStatus;
  priceJpy: number | null;
  errorReason?: string;
}

export function decideRakutenCollectorResult(
  evidence: RakutenExtractionEvidence,
  statusDetection: RakutenStatusDetection
): RakutenCollectorDecision {
  if (statusDetection.status === "sold_out" || statusDetection.status === "not_listed") {
    return { status: statusDetection.status, priceJpy: null };
  }

  if (
    statusDetection.status === "failed" &&
    (statusDetection.errorReason === "rakuten_access_blocked_or_captcha" ||
      statusDetection.errorReason === "rakuten_plan_url_404_not_found")
  ) {
    return { status: "failed", priceJpy: null, errorReason: statusDetection.errorReason };
  }

  if (
    evidence.selectedDateEvidenceFound &&
    evidence.availabilityMarkerFound &&
    evidence.priceFound &&
    evidence.priceBasis === "total_tax_included" &&
    (evidence.confidence === "medium" || evidence.confidence === "high") &&
    evidence.priceValue !== undefined
  ) {
    return { status: "available", priceJpy: evidence.priceValue };
  }

  return {
    status: "failed",
    priceJpy: null,
    errorReason: evidence.rejectionReason ?? statusDetection.errorReason ?? "rakuten_price_or_status_unclear"
  };
}
