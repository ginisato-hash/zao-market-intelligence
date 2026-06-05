import { AVAILABILITY_STATUSES } from "../domain/constants";
import type { AvailabilityStatus, RateSnapshot } from "../domain/types";
import { medianPriceExcludingConfidenceC } from "../utils/stats";

export function isAvailabilityStatus(value: string): value is AvailabilityStatus {
  return AVAILABILITY_STATUSES.includes(value as AvailabilityStatus);
}

export function assertAvailabilityStatus(value: string): AvailabilityStatus {
  if (!isAvailabilityStatus(value)) {
    throw new Error(`Invalid availability_status: ${value}`);
  }

  return value;
}

export function calculateMarketMedianPrice(snapshots: RateSnapshot[]): number | null {
  return medianPriceExcludingConfidenceC(
    snapshots.map((snapshot) => ({
      priceJpy: snapshot.priceJpy,
      confidence: snapshot.confidence
    }))
  );
}
