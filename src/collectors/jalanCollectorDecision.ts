import type { AvailabilityStatus } from "../domain/types";
import type { JalanExtractionEvidence } from "./jalanEvidence";
import type { JalanStatusDetection } from "./jalanStatusDetection";

export interface JalanCollectorDecision {
  status: AvailabilityStatus;
  priceJpy: number | null;
  errorReason?: string;
}

export function decideJalanCollectorResult(
  evidence: JalanExtractionEvidence,
  statusDetection: JalanStatusDetection
): JalanCollectorDecision {
  if (statusDetection.status === "sold_out" || statusDetection.status === "not_listed") {
    return { status: statusDetection.status, priceJpy: null };
  }

  if (statusDetection.status === "failed" && statusDetection.errorReason?.includes("blocked")) {
    return { status: "failed", priceJpy: null, errorReason: statusDetection.errorReason };
  }

  if (
    evidence.selectedDateTextFound &&
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
    errorReason: evidence.rejectionReason ?? "price_basis_or_date_scope_unclear"
  };
}
