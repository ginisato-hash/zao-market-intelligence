// ZMI-MKT-OBS03 — Refine/RMS market-signal handoff contract.
//
// This artifact is what Refine consumes, so its semantics are load-bearing:
// raw features only (no weighted score), strict transition vocabulary, and a
// hard distinction between "measured no movement" and "not measurable".

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HANDOFF_UNKNOWN_FIELDS,
  HANDOFF_WEIGHTING_POLICY,
  MARKET_SIGNAL_HANDOFF_SCHEMA_VERSION,
  buildHandoffRow,
  summarizeHandoffRows
} from "../src/services/marketSignalHandoffContract";
import type { MarketObservationRow } from "../src/services/marketObservationSchema";

const SCRIPT = readFileSync(resolve(__dirname, "../src/scripts/buildMarketSignalHandoff.ts"), "utf8");
const CONTRACT = readFileSync(resolve(__dirname, "../src/services/marketSignalHandoffContract.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function obs(overrides: Partial<MarketObservationRow> = {}): MarketObservationRow {
  return {
    observationId: "",
    observationHash: "",
    propertyId: "oakhill",
    propertyName: "ONSEN & STAY OAKHILL",
    sourcePlatform: "jalan",
    stayDate: "2026-08-13",
    observedAtJst: "2026-08-12T04:50:00+09:00",
    roomProductKey: "room:スタンダードツイン|plan:素泊まり|meal:confirmed_room_only|occ:2a0c1r|los:1",
    roomTypeName: "スタンダードツイン",
    ratePlanKey: "text:素泊まりプラン",
    ratePlanName: "【素泊まりプラン】",
    searchAdults: 2,
    searchChildren: 0,
    searchRooms: 1,
    lengthOfStay: 1,
    currency: "JPY",
    observedPrice: 26000,
    availabilityStatus: "AVAILABLE",
    inventoryCount: 3,
    inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT",
    inventoryScope: "PRODUCT",
    sourceQuality: "HIGH",
    rawEvidenceHash: "h",
    collectorRunId: "t0",
    ...overrides
  };
}
const pm = (t0: Partial<MarketObservationRow>, t1: Partial<MarketObservationRow>) => ({
  previous: obs({ ...t0, observedAtJst: "2026-08-12T04:50:00+09:00", collectorRunId: "t0" }),
  current: obs({ ...t1, observedAtJst: "2026-08-12T16:50:00+09:00", collectorRunId: "t1" })
});

describe("ZMI-MKT-OBS03 — §7 raw feature contract completeness", () => {
  const row = buildHandoffRow(pm({}, { observedPrice: 28000, inventoryCount: 1 }), "HIGH");

  it("carries every required Market Price field", () => {
    expect(Object.keys(row.price).sort()).toEqual(
      ["competitor_price_t0", "competitor_price_t1", "price_change_pct", "price_change_yen", "price_direction"].sort()
    );
  });

  it("carries every required Availability field", () => {
    expect(Object.keys(row.availability).sort()).toEqual(
      ["availability_t0", "availability_t1", "reopen_transition", "sellout_transition"].sort()
    );
  });

  it("carries every required Scarcity field", () => {
    for (const k of ["inventory_count_t0", "inventory_count_t1", "observed_inventory_delta", "inventory_semantics", "inventory_scope"]) {
      expect(Object.keys(row.scarcity)).toContain(k);
    }
  });

  it("carries every required Identity field", () => {
    expect(Object.keys(row.identity).sort()).toEqual(
      ["adults", "children", "currency", "length_of_stay", "property", "property_id", "rate_plan_key", "requested_rooms", "room_product_key", "source", "stay_date"].sort()
    );
  });

  it("carries every required Quality field", () => {
    for (const k of ["observation_quality", "pair_comparable", "source_quality", "parse_status"]) {
      expect(Object.keys(row.quality)).toContain(k);
    }
  });
});

describe("ZMI-MKT-OBS03 — §6 price transitions", () => {
  it("reports absolute yen, percent, and direction for an increase", () => {
    const r = buildHandoffRow(pm({ observedPrice: 20000 }, { observedPrice: 24000 }), "HIGH");
    expect(r.price.price_change_yen).toBe(4000);
    expect(r.price.price_change_pct).toBeCloseTo(20, 4);
    expect(r.price.price_direction).toBe("PRICE_UP");
  });

  it("reports a decrease as a negative yen change with PRICE_DOWN", () => {
    const r = buildHandoffRow(pm({ observedPrice: 20000 }, { observedPrice: 18000 }), "HIGH");
    expect(r.price.price_change_yen).toBe(-2000);
    expect(r.price.price_change_pct).toBeCloseTo(-10, 4);
    expect(r.price.price_direction).toBe("PRICE_DOWN");
  });
});

describe("ZMI-MKT-OBS03 — §10 no-movement is a KNOWN signal, not UNKNOWN", () => {
  it("an unchanged price on a comparable pair is PRICE_UNCHANGED with a 0 yen change", () => {
    const r = buildHandoffRow(pm({ observedPrice: 26000 }, { observedPrice: 26000 }), "HIGH");
    expect(r.price.price_direction).toBe("PRICE_UNCHANGED");
    expect(r.price.price_change_yen).toBe(0);
    expect(r.price.price_change_pct).toBe(0);
  });

  it("unchanged NUMERIC inventory is delta 0 and explicitly known", () => {
    const r = buildHandoffRow(pm({ inventoryCount: 3 }, { inventoryCount: 3 }), "HIGH");
    expect(r.scarcity.observed_inventory_delta).toBe(0);
    expect(r.scarcity.inventory_delta_known).toBe(true);
    expect(r.scarcity.inventory_transition).toBe("INVENTORY_UNCHANGED");
  });

  it("BINARY-only availability must NOT produce a 0 delta — quantity stays unknown", () => {
    const r = buildHandoffRow(
      pm(
        { inventoryCount: null, inventoryCountSemantics: "BINARY_AVAILABILITY", inventoryScope: "UNKNOWN" },
        { inventoryCount: null, inventoryCountSemantics: "BINARY_AVAILABILITY", inventoryScope: "UNKNOWN" }
      ),
      "HIGH"
    );
    expect(r.scarcity.observed_inventory_delta).toBeNull();
    expect(r.scarcity.inventory_delta_known).toBe(false);
    expect(r.scarcity.inventory_transition).toBeNull();
  });

  it("a one-sided numeric count (present at T0, absent at T1) is also not a 0 delta", () => {
    const r = buildHandoffRow(
      pm({ inventoryCount: 2 }, { inventoryCount: null, inventoryCountSemantics: "BINARY_AVAILABILITY", inventoryScope: "UNKNOWN" }),
      "HIGH"
    );
    expect(r.scarcity.observed_inventory_delta).toBeNull();
    expect(r.scarcity.inventory_delta_known).toBe(false);
  });
});

describe("ZMI-MKT-OBS03 — §4 transition vocabulary is enforced", () => {
  it("a numeric decline is OBSERVED_INVENTORY_DEPLETION", () => {
    const r = buildHandoffRow(pm({ inventoryCount: 5 }, { inventoryCount: 3 }), "HIGH");
    expect(r.scarcity.inventory_transition).toBe("OBSERVED_INVENTORY_DEPLETION");
    expect(r.scarcity.observed_inventory_delta).toBe(-2);
  });

  it("a numeric increase is INVENTORY_EXPANSION", () => {
    const r = buildHandoffRow(pm({ inventoryCount: 3 }, { inventoryCount: 5 }), "HIGH");
    expect(r.scarcity.inventory_transition).toBe("INVENTORY_EXPANSION");
    expect(r.scarcity.observed_inventory_delta).toBe(2);
  });

  it("available -> sold_out is SELL_OUT_TRANSITION, sold_out -> available is INVENTORY_REOPENED", () => {
    const sellOut = buildHandoffRow(pm({ availabilityStatus: "AVAILABLE" }, { availabilityStatus: "SOLD_OUT" }), "HIGH");
    expect(sellOut.availability.sellout_transition).toBe(true);
    expect(sellOut.availability.reopen_transition).toBe(false);
    const reopen = buildHandoffRow(pm({ availabilityStatus: "SOLD_OUT" }, { availabilityStatus: "AVAILABLE" }), "HIGH");
    expect(reopen.availability.reopen_transition).toBe(true);
    expect(reopen.availability.sellout_transition).toBe(false);
  });

  it("ACTUAL_BOOKING_PICKUP is never a transition value — only an explicitly-unavailable field", () => {
    // The ONE legitimate mention is inside HANDOFF_UNKNOWN_FIELDS, which tells
    // Refine the field is not obtainable from a competitor OTA observation.
    // Everywhere else the term (and "inventory decline") must not exist.
    const stripComments = (src: string): string =>
      src
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
        .join("\n");
    const contractSansUnknownFields = stripComments(CONTRACT).replace(
      /export const HANDOFF_UNKNOWN_FIELDS[\s\S]*?\] as const;/u,
      ""
    );
    for (const emitted of [contractSansUnknownFields, stripComments(SCRIPT)]) {
      expect(emitted.toLowerCase()).not.toContain("booking_pickup");
      expect(emitted.toLowerCase()).not.toContain("inventory_decline");
      expect(emitted.toLowerCase()).not.toContain("pickup");
    }
    expect(HANDOFF_UNKNOWN_FIELDS).toContain("actual_booking_pickup");
    // And no emitted transition value is ever a pickup.
    const r = buildHandoffRow(pm({ inventoryCount: 5 }, { inventoryCount: 3 }), "HIGH");
    expect(r.scarcity.inventory_transition).toBe("OBSERVED_INVENTORY_DEPLETION");
  });
});

describe("ZMI-MKT-OBS03 — §5 scarcity scope is never promoted", () => {
  it("a PRODUCT-scoped scarcity count stays PRODUCT-scoped in the handoff", () => {
    const r = buildHandoffRow(pm({}, {}), "HIGH");
    expect(r.scarcity.inventory_scope).toBe("PRODUCT");
    expect(r.scarcity.inventory_scope).not.toBe("PROPERTY");
  });

  it("property capacity is published as an explicitly unavailable field, never a divisor", () => {
    expect(HANDOFF_UNKNOWN_FIELDS).toContain("property_level_inventory");
    expect(HANDOFF_UNKNOWN_FIELDS).toContain("property_capacity_utilisation");
    // No capacity constant or division against one anywhere.
    expect(CONTRACT).not.toMatch(/\b27\b/u);
    expect(SCRIPT).not.toMatch(/capacity\s*[/*]/u);
  });
});

describe("ZMI-MKT-OBS03 — §8 no weighted score is produced by ZMI", () => {
  it("the contract exposes no score/weight field", () => {
    const row = buildHandoffRow(pm({}, {}), "HIGH");
    const keys = [
      ...Object.keys(row),
      ...Object.keys(row.price),
      ...Object.keys(row.availability),
      ...Object.keys(row.scarcity),
      ...Object.keys(row.quality)
    ];
    for (const k of keys) expect(k).not.toMatch(/score|weight|compression/iu);
  });

  it("states the weighting policy explicitly so its absence is not read as an oversight", () => {
    expect(HANDOFF_WEIGHTING_POLICY).toMatch(/RAW observations and transitions only/u);
    expect(HANDOFF_WEIGHTING_POLICY).toMatch(/Refine/u);
  });

  it("the generator never emits a MARKET_COMPRESSION_SCORE-style value", () => {
    expect(SCRIPT).not.toMatch(/MARKET_COMPRESSION_SCORE|compression_score/iu);
  });
});

describe("ZMI-MKT-OBS03 — §11 artifact and §12 read-only safety", () => {
  it("is wired as an npm script and versions its schema", () => {
    expect(PACKAGE_JSON).toContain('"market-observation:handoff"');
    expect(MARKET_SIGNAL_HANDOFF_SCHEMA_VERSION).toBe("zao_market_signal_handoff_v1");
  });

  it("refuses to emit an artifact without two distinct runs", () => {
    expect(SCRIPT).toContain("market_signal_handoff_insufficient_runs");
    expect(SCRIPT).toMatch(/t0Id === ""\s*\|\|\s*t1Id === ""\s*\|\|\s*t0Id === t1Id/u);
  });

  it("reports the real gap in minutes and never rounds it to 'about 12 hours'", () => {
    expect(SCRIPT).toContain("gap_minutes");
    expect(SCRIPT).toContain("is_same_instant_refetch");
    expect(SCRIPT).not.toMatch(/about 12|~12h|approximately 12/iu);
  });

  it("never mutates the observation store, history, pricing, or Beds24", () => {
    // The ONLY write is the handoff artifact into its own output directory.
    const writes = SCRIPT.match(/writeFileSync\([^)]*/gu) ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("outPath");
    expect(SCRIPT).toContain('const OUT_DIR = ".data/market-observation-handoff"');
    for (const forbidden of ["appendMarketObservations", ".data/history", "beds24", "spawnSync", '"push"']) {
      expect(SCRIPT, `handoff must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("summarizes totals without inventing any aggregate score", () => {
    const rows = [
      buildHandoffRow(pm({ observedPrice: 100 }, { observedPrice: 200 }), "HIGH"),
      buildHandoffRow(pm({ inventoryCount: 5 }, { inventoryCount: 3 }), "HIGH")
    ];
    const totals = summarizeHandoffRows(rows);
    expect(totals.signal_count).toBe(2);
    expect(totals.price_up).toBe(1);
    expect(totals.observed_inventory_depletion).toBe(1);
    for (const k of Object.keys(totals)) expect(k).not.toMatch(/score|weight/iu);
  });
});

describe("ZMI-MKT-OBS03 — incomparable pairs are marked, not silently paired", () => {
  it("a different-occupancy pair is flagged incomparable with a reason and no transitions", () => {
    const r = buildHandoffRow(pm({ searchAdults: 2 }, { searchAdults: 1 }), "HIGH");
    expect(r.quality.pair_comparable).toBe(false);
    expect(r.quality.pair_incomparable_reason).toBe("different_occupancy");
    expect(r.price.price_direction).toBeNull();
    expect(r.scarcity.inventory_transition).toBeNull();
    expect(r.availability.sellout_transition).toBe(false);
  });

  it("a parse failure at T1 is surfaced in parse_status", () => {
    const r = buildHandoffRow(pm({}, { availabilityStatus: "PARSE_FAILED" }), "LOW");
    expect(r.quality.parse_status).toBe("PARSE_FAILED");
  });
});
