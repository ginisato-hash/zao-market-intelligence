// Phase ZMI-MKT-OBS01 — search context identity / comparison key (pure). §7.
//
// Two observations are comparable (usable as a before/after time-series
// pair) ONLY when every one of these matches exactly: property, source,
// stay_date, room product, rate plan, adults, children, requested rooms,
// LOS, currency. A snapshot taken under different search conditions (e.g. a
// different occupancy, a different room product) is never compared as an
// inventory/price change — it is simply a different, unrelated observation.
//
// No I/O, no network.

import type { MarketObservationRow } from "./marketObservationSchema";

export interface ComparisonKeyParts {
  propertyId: string;
  sourcePlatform: string;
  stayDate: string;
  roomProductKey: string;
  ratePlanKey: string;
  searchAdults: number;
  searchChildren: number;
  searchRooms: number;
  lengthOfStay: number;
  currency: string;
}

export function buildComparisonKey(parts: ComparisonKeyParts): string {
  return [
    parts.propertyId,
    parts.sourcePlatform,
    parts.stayDate,
    parts.roomProductKey,
    parts.ratePlanKey,
    parts.searchAdults,
    parts.searchChildren,
    parts.searchRooms,
    parts.lengthOfStay,
    parts.currency
  ].join("|");
}

export function comparisonKeyOf(row: MarketObservationRow): string {
  return buildComparisonKey({
    propertyId: row.propertyId,
    sourcePlatform: row.sourcePlatform,
    stayDate: row.stayDate,
    roomProductKey: row.roomProductKey,
    ratePlanKey: row.ratePlanKey,
    searchAdults: row.searchAdults,
    searchChildren: row.searchChildren,
    searchRooms: row.searchRooms,
    lengthOfStay: row.lengthOfStay,
    currency: row.currency
  });
}

// §7 explicit non-comparability checks — used by tests and by the transition
// generator's own guard, spelling out exactly WHY two rows are not a pair,
// for diagnostics (never silently drop a mismatch without a reason).
export type ComparabilityMismatchReason =
  | "different_property"
  | "different_source"
  | "different_stay_date"
  | "different_room_product"
  | "different_rate_plan"
  | "different_occupancy"
  | "different_length_of_stay"
  | "different_currency"
  | "unknown_room_product"; // room_product_key === "" on either side — never treat as a match

export function comparabilityMismatch(a: MarketObservationRow, b: MarketObservationRow): ComparabilityMismatchReason | null {
  if (a.propertyId !== b.propertyId) return "different_property";
  if (a.sourcePlatform !== b.sourcePlatform) return "different_source";
  if (a.stayDate !== b.stayDate) return "different_stay_date";
  if (a.roomProductKey === "" || b.roomProductKey === "") return "unknown_room_product";
  if (a.roomProductKey !== b.roomProductKey) return "different_room_product";
  if (a.ratePlanKey !== b.ratePlanKey) return "different_rate_plan";
  if (a.searchAdults !== b.searchAdults || a.searchChildren !== b.searchChildren || a.searchRooms !== b.searchRooms) {
    return "different_occupancy";
  }
  if (a.lengthOfStay !== b.lengthOfStay) return "different_length_of_stay";
  if (a.currency !== b.currency) return "different_currency";
  return null;
}

export function areComparable(a: MarketObservationRow, b: MarketObservationRow): boolean {
  return comparabilityMismatch(a, b) === null;
}
