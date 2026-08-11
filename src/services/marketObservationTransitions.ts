// Phase ZMI-MKT-OBS01 — inventory/price transition generation (pure). §12/§13/§14.
//
// CORE PRINCIPLE (never violate): a numeric inventory decrease is
// OBSERVED_INVENTORY_DEPLETION, never "pickup" — a booking, an OTA
// allocation cut, a stop-sell, and a rate-plan closure all look identical
// from outside. magnitude is always a non-negative number; direction is
// carried by the transition TYPE, never by a signed delta (so nothing
// downstream can misread "pickup = -2").
//
// Binary transitions (available<->sold_out) NEVER let you back into a room
// count: available->available and sold_out->sold_out both report quantity
// change = UNKNOWN, even though intuition says "still available" implies
// "quantity unchanged or higher" — that intuition is exactly the fabricated
// precision this schema exists to avoid (§13).
//
// No I/O, no network.

import type { MarketObservationRow, ObservationAvailabilityStatus } from "./marketObservationSchema";
import { comparabilityMismatch, type ComparabilityMismatchReason } from "./searchContextIdentity";

export type InventoryTransitionType = "OBSERVED_INVENTORY_DEPLETION" | "INVENTORY_EXPANSION" | "INVENTORY_UNCHANGED";
export type BinaryTransitionType = "SELL_OUT_TRANSITION" | "INVENTORY_REOPENED" | "NO_BINARY_TRANSITION";
export type PriceTransitionType = "PRICE_UP" | "PRICE_DOWN" | "PRICE_UNCHANGED";

export interface NumericInventoryTransition {
  type: InventoryTransitionType;
  magnitude: number; // always >= 0
  previousCount: number;
  currentCount: number;
}

export interface BinaryTransition {
  type: BinaryTransitionType;
  previousStatus: ObservationAvailabilityStatus;
  currentStatus: ObservationAvailabilityStatus;
  quantityChange: "UNKNOWN"; // structurally cannot be anything else — see module doc
}

export interface PriceTransition {
  type: PriceTransitionType;
  previousPrice: number;
  currentPrice: number;
  absoluteDelta: number; // current - previous, signed (this is a PRICE, not an inventory magnitude)
  percentageDelta: number; // (current - previous) / previous * 100
  observedInterval: { fromIso: string; toIso: string };
}

export interface TransitionPair {
  previous: MarketObservationRow;
  current: MarketObservationRow;
}

// §7 guard, reused: refuse to generate ANY transition across incomparable
// snapshots. Returns the mismatch reason instead of throwing so callers can
// report/count it (never a silent drop).
export function checkPairComparable(pair: TransitionPair): ComparabilityMismatchReason | null {
  return comparabilityMismatch(pair.previous, pair.current);
}

// §12 — numeric inventory transition. Only meaningful when BOTH sides carry
// an actual count under a semantics/scope that supports magnitude comparison
// (PUBLIC_SCARCITY_COUNT, ROOM_TYPE_UNITS_AVAILABLE, PRODUCT_UNITS_AVAILABLE
// — never BINARY_AVAILABILITY or UNKNOWN, and never mixed semantics/scope
// between the two sides, since a scarcity badge and a room-type total are
// not the same kind of number).
export function generateNumericInventoryTransition(pair: TransitionPair): NumericInventoryTransition | null {
  if (checkPairComparable(pair) !== null) return null;
  const { previous, current } = pair;
  if (previous.inventoryCount === null || current.inventoryCount === null) return null;
  if (previous.inventoryCountSemantics === "BINARY_AVAILABILITY" || previous.inventoryCountSemantics === "UNKNOWN") return null;
  if (current.inventoryCountSemantics === "BINARY_AVAILABILITY" || current.inventoryCountSemantics === "UNKNOWN") return null;
  if (previous.inventoryCountSemantics !== current.inventoryCountSemantics) return null;
  if (previous.inventoryScope !== current.inventoryScope) return null;

  const delta = current.inventoryCount - previous.inventoryCount;
  if (delta < 0) {
    return { type: "OBSERVED_INVENTORY_DEPLETION", magnitude: Math.abs(delta), previousCount: previous.inventoryCount, currentCount: current.inventoryCount };
  }
  if (delta > 0) {
    return { type: "INVENTORY_EXPANSION", magnitude: delta, previousCount: previous.inventoryCount, currentCount: current.inventoryCount };
  }
  return { type: "INVENTORY_UNCHANGED", magnitude: 0, previousCount: previous.inventoryCount, currentCount: current.inventoryCount };
}

const BINARY_STATUSES: ReadonlySet<ObservationAvailabilityStatus> = new Set(["AVAILABLE", "SOLD_OUT"]);

// §13 — binary availability transition. Deliberately restricted to the two
// genuinely binary statuses; NOT_LISTED/COLLECTION_FAILED/PARSE_FAILED/UNKNOWN
// never participate (§20: a failure is not a sold-out, and must not silently
// generate a fabricated sell-out/reopen transition).
export function generateBinaryTransition(pair: TransitionPair): BinaryTransition | null {
  if (checkPairComparable(pair) !== null) return null;
  const { previous, current } = pair;
  if (!BINARY_STATUSES.has(previous.availabilityStatus) || !BINARY_STATUSES.has(current.availabilityStatus)) return null;

  let type: BinaryTransitionType = "NO_BINARY_TRANSITION";
  if (previous.availabilityStatus === "AVAILABLE" && current.availabilityStatus === "SOLD_OUT") type = "SELL_OUT_TRANSITION";
  else if (previous.availabilityStatus === "SOLD_OUT" && current.availabilityStatus === "AVAILABLE") type = "INVENTORY_REOPENED";

  return { type, previousStatus: previous.availabilityStatus, currentStatus: current.availabilityStatus, quantityChange: "UNKNOWN" };
}

// §14 — price transition. Requires both sides to actually carry a price;
// null (not zero/unchanged) when either side has no price to compare.
export function generatePriceTransition(pair: TransitionPair): PriceTransition | null {
  if (checkPairComparable(pair) !== null) return null;
  const { previous, current } = pair;
  if (previous.observedPrice === null || current.observedPrice === null) return null;
  if (previous.observedPrice <= 0) return null;

  const absoluteDelta = current.observedPrice - previous.observedPrice;
  const percentageDelta = (absoluteDelta / previous.observedPrice) * 100;
  const type: PriceTransitionType = absoluteDelta > 0 ? "PRICE_UP" : absoluteDelta < 0 ? "PRICE_DOWN" : "PRICE_UNCHANGED";

  return {
    type,
    previousPrice: previous.observedPrice,
    currentPrice: current.observedPrice,
    absoluteDelta,
    percentageDelta,
    observedInterval: { fromIso: previous.observedAtJst, toIso: current.observedAtJst }
  };
}

// §7 — group a flat observation list into per-comparison-key chronological
// series, then emit ADJACENT pairs only (each observation compared to the
// one immediately before it in real observed_at order, never to an
// arbitrary earlier one) — the natural input shape for the three generators
// above.
export function buildAdjacentTransitionPairs(rows: readonly MarketObservationRow[]): TransitionPair[] {
  const byKey = new Map<string, MarketObservationRow[]>();
  for (const row of rows) {
    const key = [
      row.propertyId,
      row.sourcePlatform,
      row.stayDate,
      row.roomProductKey,
      row.ratePlanKey,
      row.searchAdults,
      row.searchChildren,
      row.searchRooms,
      row.lengthOfStay,
      row.currency
    ].join("|");
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [row]);
    else bucket.push(row);
  }
  const pairs: TransitionPair[] = [];
  for (const bucket of byKey.values()) {
    const sorted = [...bucket].sort((a, b) => a.observedAtJst.localeCompare(b.observedAtJst));
    for (let i = 1; i < sorted.length; i += 1) {
      pairs.push({ previous: sorted[i - 1]!, current: sorted[i]! });
    }
  }
  return pairs;
}
