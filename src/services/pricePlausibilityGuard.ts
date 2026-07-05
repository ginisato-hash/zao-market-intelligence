// Phase ZMI PRICE-PLAUSIBILITY01 — guards against implausible OTA-displayed
// prices (e.g. Booking DOM extraction landing on a stray small number instead
// of the real room price) entering append candidates, price-change detection,
// or market price-pressure/DP-pressure signals.
//
// Root cause this addresses: HAMMOND/Booking repeatedly surfaced
// primary_price_numeric=100 (a real Zao-onsen room is never ¥100/night; the
// surrounding confirmed observations for the same property are ¥11k-24k). The
// existing conflict-safe append gate already blocks NEW rows from clobbering a
// differently-priced existing rowId, but it does nothing about (a) an
// implausible price that happens to be a fresh rowId (no prior conflict to
// catch it), or (b) implausible rows already committed to append-only history
// still being read as legitimate price evidence downstream. This module is the
// single, reusable plausibility check both concerns route through.

export const MIN_PLAUSIBLE_BOOKING_PRICE_JPY = 1000;

export type PricePlausibilityReason =
  | "no_price"
  | "implausible_booking_price_under_1000"
  | "plausible";

export interface PricePlausibilityResult {
  usable: boolean;
  reason: PricePlausibilityReason;
  data_quality_suspect: boolean;
}

// source=booking prices below MIN_PLAUSIBLE_BOOKING_PRICE_JPY are treated as a
// data-quality defect (not a real price), never a genuine ¥100 room. Other
// sources are not (yet) known to exhibit this failure mode, so this guard is
// intentionally scoped to booking only until evidence says otherwise.
export function validatePrimaryPriceNumeric(args: {
  source: string;
  propertyKey?: string | undefined;
  propertyName?: string | undefined;
  price: number | null | undefined;
  roomBasis?: string | null | undefined;
  roomName?: string | null | undefined;
  bedHint?: string | null | undefined;
}): PricePlausibilityResult {
  if (args.price === null || args.price === undefined || !Number.isFinite(args.price)) {
    return { usable: false, reason: "no_price", data_quality_suspect: false };
  }
  if (args.source === "booking" && args.price < MIN_PLAUSIBLE_BOOKING_PRICE_JPY) {
    return { usable: false, reason: "implausible_booking_price_under_1000", data_quality_suspect: true };
  }
  return { usable: true, reason: "plausible", data_quality_suspect: false };
}
