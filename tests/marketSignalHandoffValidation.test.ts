// ZMI-MKT-OBS03 §11 — handoff artifact sanity validation.
//
// Each check is proven to FIRE on a corrupted artifact and stay SILENT on a
// clean one; a validator that cannot fail is not a validator.

import { describe, expect, it } from "vitest";
import {
  HANDOFF_FATAL_CODES,
  summarizeHandoffValidation,
  validateHandoffArtifact
} from "../src/services/marketSignalHandoffValidation";
import {
  HANDOFF_UNKNOWN_FIELDS,
  HANDOFF_WEIGHTING_POLICY,
  MARKET_SIGNAL_HANDOFF_SCHEMA_VERSION,
  summarizeHandoffRows,
  type MarketSignalHandoffArtifact,
  type MarketSignalHandoffRow
} from "../src/services/marketSignalHandoffContract";

const NOW = Date.parse("2026-08-12T18:00:00+09:00");

function signal(overrides: {
  room?: string;
  p0?: number | null;
  p1?: number | null;
  yen?: number | null;
  pct?: number | null;
  dir?: MarketSignalHandoffRow["price"]["price_direction"];
  i0?: number | null;
  i1?: number | null;
  delta?: number | null;
  known?: boolean;
  transition?: string | null;
  semantics?: string;
  scope?: string;
  comparable?: boolean;
} = {}): MarketSignalHandoffRow {
  const p0 = overrides.p0 === undefined ? 26000 : overrides.p0;
  const p1 = overrides.p1 === undefined ? 24000 : overrides.p1;
  const i0 = overrides.i0 === undefined ? 3 : overrides.i0;
  const i1 = overrides.i1 === undefined ? 1 : overrides.i1;
  const yen = overrides.yen === undefined ? (p0 !== null && p1 !== null ? p1 - p0 : null) : overrides.yen;
  return {
    identity: {
      property: "ONSEN & STAY OAKHILL",
      property_id: "oakhill",
      source: "jalan",
      stay_date: "2026-08-13",
      room_product_key: overrides.room ?? "room:standard twin|plan:room only",
      rate_plan_key: "text:room only",
      adults: 2,
      children: 0,
      requested_rooms: 1,
      length_of_stay: 1,
      currency: "JPY"
    },
    price: {
      competitor_price_t0: p0,
      competitor_price_t1: p1,
      price_change_yen: yen,
      price_change_pct: overrides.pct === undefined ? (p0 ? ((yen ?? 0) / p0) * 100 : null) : overrides.pct,
      price_direction:
        overrides.dir === undefined ? (yen === null ? null : yen > 0 ? "PRICE_UP" : yen < 0 ? "PRICE_DOWN" : "PRICE_UNCHANGED") : overrides.dir
    },
    availability: { availability_t0: "AVAILABLE", availability_t1: "AVAILABLE", sellout_transition: false, reopen_transition: false },
    scarcity: {
      inventory_count_t0: i0,
      inventory_count_t1: i1,
      observed_inventory_delta: overrides.delta === undefined ? (i0 !== null && i1 !== null ? i1 - i0 : null) : overrides.delta,
      inventory_delta_known: overrides.known === undefined ? i0 !== null && i1 !== null : overrides.known,
      inventory_transition:
        overrides.transition === undefined
          ? i0 !== null && i1 !== null
            ? i1 < i0
              ? "OBSERVED_INVENTORY_DEPLETION"
              : i1 > i0
                ? "INVENTORY_EXPANSION"
                : "INVENTORY_UNCHANGED"
            : null
          : overrides.transition,
      inventory_semantics: overrides.semantics ?? "PUBLIC_SCARCITY_COUNT",
      inventory_scope: overrides.scope ?? "PRODUCT"
    },
    quality: {
      observation_quality: "HIGH",
      pair_comparable: overrides.comparable === undefined ? true : overrides.comparable,
      pair_incomparable_reason: null,
      source_quality: "HIGH",
      parse_status: "OK"
    }
  };
}

function artifact(signals: MarketSignalHandoffRow[], pairOverrides: Partial<MarketSignalHandoffArtifact["pair"]> = {}): MarketSignalHandoffArtifact {
  return {
    schema_version: MARKET_SIGNAL_HANDOFF_SCHEMA_VERSION,
    generated_at_jst: "2026-08-12T17:10:00+09:00",
    source_run_ids: { t0: "core_competitor_obs_20260812_045007", t1: "core_competitor_obs_20260812_165002" },
    pair: {
      t0_first_observed_jst: "2026-08-12T04:50:14+09:00",
      t1_first_observed_jst: "2026-08-12T16:50:09+09:00",
      gap_minutes: 720,
      is_same_instant_refetch: false,
      ...pairOverrides
    },
    competitors: ["HAMMOND", "吉田屋", "ONSEN & STAY OAKHILL"],
    stay_dates: ["2026-08-13"],
    quality_by_stay_date: [{ stay_date: "2026-08-13", tier: "HIGH", observation_count: 2, comparison_pair_count: 1 }],
    unknown_fields: [...HANDOFF_UNKNOWN_FIELDS],
    weighting_policy: HANDOFF_WEIGHTING_POLICY,
    signals,
    totals: summarizeHandoffRows(signals)
  };
}

describe("§11 — a clean artifact produces zero findings", () => {
  it("passes a well-formed multi-product artifact", () => {
    const a = artifact([
      signal({ room: "room:twin", i0: 3, i1: 1 }),
      signal({ room: "room:deluxe", p0: 38000, p1: 38000, i0: 2, i1: 2 }),
      signal({ room: "room:binary", i0: null, i1: null, semantics: "BINARY_AVAILABILITY", scope: "UNKNOWN" })
    ]);
    expect(validateHandoffArtifact(a, NOW)).toEqual([]);
  });
});

describe("§11 — each check fires on the corruption it exists to catch", () => {
  it("duplicate_product_key: same comparison key twice", () => {
    const a = artifact([signal({ room: "room:twin" }), signal({ room: "room:twin" })]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("duplicate_product_key");
  });

  it("invalid_delta: delta disagrees with its own endpoints", () => {
    const a = artifact([signal({ i0: 5, i1: 3, delta: -9 })]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("invalid_delta");
  });

  it("numeric_pair_missing_delta: both counts numeric but delta null", () => {
    const a = artifact([signal({ i0: 5, i1: 3, delta: null, known: false })]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("numeric_pair_missing_delta");
  });

  it("binary_only_with_zero_delta: a quantity invented from an availability flag", () => {
    const a = artifact([signal({ i0: null, i1: null, semantics: "BINARY_AVAILABILITY", scope: "UNKNOWN", delta: 0, known: true })]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("binary_only_with_zero_delta");
  });

  it("t0_t1_reversal: T0 not before T1", () => {
    const a = artifact([signal()], { t0_first_observed_jst: "2026-08-12T16:50:09+09:00", t1_first_observed_jst: "2026-08-12T04:50:14+09:00" });
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("t0_t1_reversal");
  });

  it("future_timestamp: an observation dated after now", () => {
    const a = artifact([signal()], { t1_first_observed_jst: "2027-01-01T00:00:00+09:00" });
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("future_timestamp");
  });

  it("malformed_price: yen change disagrees with endpoints", () => {
    const a = artifact([signal({ p0: 20000, p1: 18000, yen: 5000, dir: "PRICE_UP" })]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("malformed_price");
  });

  it("malformed_price: direction disagrees with the sign of the change", () => {
    const a = artifact([signal({ p0: 20000, p1: 18000, yen: -2000, dir: "PRICE_UP" })]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("malformed_price");
  });

  it("malformed_price: non-positive price", () => {
    const a = artifact([signal({ p0: 0, p1: 0, yen: 0, dir: "PRICE_UNCHANGED" })]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("malformed_price");
  });

  it("property_scoped_scarcity: scarcity promoted to whole-property inventory", () => {
    const a = artifact([signal({ scope: "PROPERTY" })]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("property_scoped_scarcity");
  });

  it("forbidden_pickup_terminology: a pickup/decline transition value", () => {
    const a = artifact([signal({ transition: "ACTUAL_BOOKING_PICKUP" })]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("forbidden_pickup_terminology");
  });

  it("cross_product_binding: two rooms in the SAME plan sharing identical price+scarcity endpoints", () => {
    // The historical failure mode: one product's values copied across every
    // room listed under one rate plan.
    const a = artifact([
      signal({ room: "room:twin", p0: 26000, p1: 24000, i0: 3, i1: 1 }),
      signal({ room: "room:deluxe", p0: 26000, p1: 24000, i0: 3, i1: 1 })
    ]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).toContain("cross_product_binding");
  });

  it("REGRESSION: identical pricing across DIFFERENT rate plans is NOT flagged", () => {
    // Verified against the real 2026-08-12 12h pair: 吉田屋's 和室13畳 was priced
    // identically under a senior-discount and a student-discount plan, and
    // correctly shared that one room's remaining count. Two HAMMOND rooms also
    // simply cost the same. Grouping the check by rate plan removed all 65 such
    // false positives while still catching the real within-plan copying above.
    const a = artifact([
      { ...signal({ room: "room:和室13畳", p0: 25300, p1: 25300, i0: 2, i1: 2 }), identity: { ...signal().identity, room_product_key: "room:和室13畳", rate_plan_key: "text:senior" } },
      { ...signal({ room: "room:和室13畳", p0: 25300, p1: 25300, i0: 2, i1: 2 }), identity: { ...signal().identity, room_product_key: "room:和室13畳", rate_plan_key: "text:student" } }
    ]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).not.toContain("cross_product_binding");
  });

  it("price equality alone never accuses — a scarcity fingerprint is required", () => {
    const a = artifact([
      signal({ room: "room:twin", p0: 26000, p1: 24000, i0: null, i1: null, semantics: "BINARY_AVAILABILITY", scope: "UNKNOWN" }),
      signal({ room: "room:deluxe", p0: 26000, p1: 24000, i0: null, i1: null, semantics: "BINARY_AVAILABILITY", scope: "UNKNOWN" })
    ]);
    expect(validateHandoffArtifact(a, NOW).map((f) => f.code)).not.toContain("cross_product_binding");
  });
});

describe("§11 — fatal vs review classification", () => {
  it("classifies structural corruption as fatal and cross-product overlap as review-only", () => {
    expect(HANDOFF_FATAL_CODES).toContain("invalid_delta");
    expect(HANDOFF_FATAL_CODES).toContain("binary_only_with_zero_delta");
    expect(HANDOFF_FATAL_CODES).toContain("t0_t1_reversal");
    // Two rooms legitimately priced the same with equal remaining counts is
    // possible on a real page, so it is surfaced for review, not auto-failed.
    expect(HANDOFF_FATAL_CODES).not.toContain("cross_product_binding");
  });

  it("summarizes counts by code with a fatal/review split", () => {
    const s = summarizeHandoffValidation([
      { code: "invalid_delta", detail: "x" },
      { code: "cross_product_binding", detail: "y" },
      { code: "cross_product_binding", detail: "z" }
    ]);
    expect(s.total).toBe(3);
    expect(s.fatal).toBe(1);
    expect(s.review).toBe(2);
    expect(s.byCode).toEqual({ invalid_delta: 1, cross_product_binding: 2 });
  });

  it("an incomparable pair is not held to the arithmetic checks", () => {
    const a = artifact([signal({ comparable: false, yen: null, dir: null, delta: null, known: false })]);
    const codes = validateHandoffArtifact(a, NOW).map((f) => f.code);
    expect(codes).not.toContain("malformed_price");
    expect(codes).not.toContain("numeric_pair_missing_delta");
  });
});
