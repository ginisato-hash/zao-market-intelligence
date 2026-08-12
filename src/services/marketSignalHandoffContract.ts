// Phase ZMI-MKT-OBS03 — Refine/RMS market-signal handoff contract (pure).
//
// The read-only contract ZMI publishes for Refine to consume. ZMI's
// responsibility ends at observation + normalization: this artifact carries
// RAW per-pair features and transitions ONLY. It deliberately contains no
// weighted/compressed score of any kind — the weights for price, depletion,
// sell-out, coverage and source quality are Refine's to validate in its own
// simulator, not ZMI's to hardcode.
//
// Terminology is load-bearing and enforced by tests: a numeric decline is
// OBSERVED_INVENTORY_DEPLETION, never "pickup" and never "inventory decline";
// ACTUAL_BOOKING_PICKUP is reserved for real reservation/PMS data and must
// never appear on a competitor OTA observation.
//
// No I/O, no network.

import type { MarketObservationRow } from "./marketObservationSchema";
import { comparabilityMismatch } from "./searchContextIdentity";
import {
  generateBinaryTransition,
  generateNumericInventoryTransition,
  generatePriceTransition,
  type TransitionPair
} from "./marketObservationTransitions";

export const MARKET_SIGNAL_HANDOFF_SCHEMA_VERSION = "zao_market_signal_handoff_v1";

// Fields a text-scraped OTA observation structurally cannot provide. Published
// explicitly so Refine never has to infer why something is absent, and never
// mistakes "not obtainable" for "zero".
export const HANDOFF_UNKNOWN_FIELDS = [
  "actual_booking_pickup",
  "property_level_inventory",
  "property_capacity_utilisation",
  "competitor_reservation_count",
  "competitor_channel_allocation",
  "rate_plan_source_id",
  "room_type_source_id"
] as const;

export type PriceDirection = "PRICE_UP" | "PRICE_DOWN" | "PRICE_UNCHANGED";

export interface HandoffIdentity {
  property: string;
  property_id: string;
  source: string;
  stay_date: string;
  room_product_key: string;
  rate_plan_key: string;
  adults: number;
  children: number;
  requested_rooms: number;
  length_of_stay: number;
  currency: string;
}

export interface HandoffPrice {
  competitor_price_t0: number | null;
  competitor_price_t1: number | null;
  price_change_yen: number | null;
  price_change_pct: number | null;
  price_direction: PriceDirection | null;
}

export interface HandoffAvailability {
  availability_t0: string;
  availability_t1: string;
  sellout_transition: boolean;
  reopen_transition: boolean;
}

export interface HandoffScarcity {
  inventory_count_t0: number | null;
  inventory_count_t1: number | null;
  observed_inventory_delta: number | null;
  // Explicit so a null delta is never read as "no change". Only true when BOTH
  // sides carry a comparable numeric count under identical semantics+scope.
  inventory_delta_known: boolean;
  // OBSERVED_INVENTORY_DEPLETION / INVENTORY_EXPANSION / INVENTORY_UNCHANGED,
  // or null when no numeric comparison was possible. Never "pickup".
  inventory_transition: string | null;
  inventory_semantics: string;
  inventory_scope: string;
}

export interface HandoffQuality {
  observation_quality: string;
  pair_comparable: boolean;
  pair_incomparable_reason: string | null;
  source_quality: string;
  parse_status: "OK" | "PARSE_FAILED" | "COLLECTION_FAILED" | "NOT_LISTED" | "UNKNOWN";
}

export interface MarketSignalHandoffRow {
  identity: HandoffIdentity;
  price: HandoffPrice;
  availability: HandoffAvailability;
  scarcity: HandoffScarcity;
  quality: HandoffQuality;
}

function parseStatusOf(row: MarketObservationRow): HandoffQuality["parse_status"] {
  switch (row.availabilityStatus) {
    case "AVAILABLE":
    case "SOLD_OUT":
      return "OK";
    case "PARSE_FAILED":
      return "PARSE_FAILED";
    case "COLLECTION_FAILED":
      return "COLLECTION_FAILED";
    case "NOT_LISTED":
      return "NOT_LISTED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Build one handoff row from a T0/T1 observation pair.
 *
 * §10 — "no movement" is a KNOWN signal, not UNKNOWN: a comparable pair whose
 * price did not move reports PRICE_UNCHANGED with a 0 yen change, and a pair
 * with comparable numeric counts that did not move reports delta 0. But a pair
 * that only ever had BINARY availability reports delta null with
 * inventory_delta_known=false — binary availability can never be back-solved
 * into a quantity.
 */
export function buildHandoffRow(pair: TransitionPair, observationQualityTier: string): MarketSignalHandoffRow {
  const { previous: t0, current: t1 } = pair;
  const incomparable = comparabilityMismatch(t0, t1);
  const comparable = incomparable === null;

  const priceTransition = comparable ? generatePriceTransition(pair) : null;
  const numeric = comparable ? generateNumericInventoryTransition(pair) : null;
  const binary = comparable ? generateBinaryTransition(pair) : null;

  return {
    identity: {
      property: t0.propertyName,
      property_id: t0.propertyId,
      source: t0.sourcePlatform,
      stay_date: t0.stayDate,
      room_product_key: t0.roomProductKey,
      rate_plan_key: t0.ratePlanKey,
      adults: t0.searchAdults,
      children: t0.searchChildren,
      requested_rooms: t0.searchRooms,
      length_of_stay: t0.lengthOfStay,
      currency: t0.currency
    },
    price: {
      competitor_price_t0: t0.observedPrice,
      competitor_price_t1: t1.observedPrice,
      price_change_yen: priceTransition?.absoluteDelta ?? null,
      price_change_pct: priceTransition === null ? null : Number(priceTransition.percentageDelta.toFixed(4)),
      price_direction: priceTransition?.type ?? null
    },
    availability: {
      availability_t0: t0.availabilityStatus,
      availability_t1: t1.availabilityStatus,
      sellout_transition: binary?.type === "SELL_OUT_TRANSITION",
      reopen_transition: binary?.type === "INVENTORY_REOPENED"
    },
    scarcity: {
      inventory_count_t0: t0.inventoryCount,
      inventory_count_t1: t1.inventoryCount,
      observed_inventory_delta: numeric === null ? null : numeric.currentCount - numeric.previousCount,
      inventory_delta_known: numeric !== null,
      inventory_transition: numeric?.type ?? null,
      // Scope is carried through untouched: a PUBLIC_SCARCITY_COUNT badge stays
      // PRODUCT/SEARCH_CONTEXT scoped and is never promoted to PROPERTY, so
      // Refine can never divide it by a property capacity (§5).
      inventory_semantics: t1.inventoryCountSemantics,
      inventory_scope: t1.inventoryScope
    },
    quality: {
      observation_quality: observationQualityTier,
      pair_comparable: comparable,
      pair_incomparable_reason: incomparable,
      source_quality: t1.sourceQuality,
      parse_status: parseStatusOf(t1)
    }
  };
}

export interface MarketSignalHandoffArtifact {
  schema_version: string;
  generated_at_jst: string;
  source_run_ids: { t0: string; t1: string };
  pair: {
    t0_first_observed_jst: string;
    t1_first_observed_jst: string;
    gap_minutes: number;
    is_same_instant_refetch: boolean;
  };
  competitors: string[];
  stay_dates: string[];
  quality_by_stay_date: Array<{ stay_date: string; tier: string; observation_count: number; comparison_pair_count: number }>;
  unknown_fields: string[];
  // Explicit statement of what ZMI deliberately does NOT provide, so a
  // consumer cannot mistake its absence for an oversight.
  weighting_policy: string;
  signals: MarketSignalHandoffRow[];
  totals: {
    signal_count: number;
    comparable_pairs: number;
    price_up: number;
    price_down: number;
    price_unchanged: number;
    observed_inventory_depletion: number;
    inventory_expansion: number;
    inventory_unchanged: number;
    sell_out_transition: number;
    inventory_reopened: number;
    numeric_inventory_pairs: number;
    parse_failures: number;
  };
}

export function summarizeHandoffRows(rows: readonly MarketSignalHandoffRow[]): MarketSignalHandoffArtifact["totals"] {
  return {
    signal_count: rows.length,
    comparable_pairs: rows.filter((r) => r.quality.pair_comparable).length,
    price_up: rows.filter((r) => r.price.price_direction === "PRICE_UP").length,
    price_down: rows.filter((r) => r.price.price_direction === "PRICE_DOWN").length,
    price_unchanged: rows.filter((r) => r.price.price_direction === "PRICE_UNCHANGED").length,
    observed_inventory_depletion: rows.filter((r) => r.scarcity.inventory_transition === "OBSERVED_INVENTORY_DEPLETION").length,
    inventory_expansion: rows.filter((r) => r.scarcity.inventory_transition === "INVENTORY_EXPANSION").length,
    inventory_unchanged: rows.filter((r) => r.scarcity.inventory_transition === "INVENTORY_UNCHANGED").length,
    sell_out_transition: rows.filter((r) => r.availability.sellout_transition).length,
    inventory_reopened: rows.filter((r) => r.availability.reopen_transition).length,
    numeric_inventory_pairs: rows.filter((r) => r.scarcity.inventory_delta_known).length,
    parse_failures: rows.filter((r) => r.quality.parse_status === "PARSE_FAILED").length
  };
}

export const HANDOFF_WEIGHTING_POLICY =
  "ZMI publishes RAW observations and transitions only. No weighted or compressed market score is produced here; " +
  "weights for price, depletion, sell-out, coverage and source quality are determined by Refine's own replay/simulator validation.";
