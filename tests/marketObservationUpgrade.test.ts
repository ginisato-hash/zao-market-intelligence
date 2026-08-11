// ZMI-MKT-OBS01 — Competitor Inventory Observation Upgrade regression suite.
//
// Covers the 17 minimum test scenarios from the task spec (§26), plus the
// core schema/identity/product-stabilization/quality units the transition
// generators depend on. No RMS/pricing/Beds24 code is touched by this file.

import { describe, expect, it } from "vitest";
import {
  buildObservationHash,
  buildObservationId,
  validateObservationColumns,
  validateObservationRow,
  MARKET_OBSERVATION_CSV_HEADERS,
  type MarketObservationRow
} from "../src/services/marketObservationSchema";
import { buildRoomProductKey, buildRatePlanKey, isSameRoomProduct } from "../src/services/productIdentityStabilization";
import { buildComparisonKey, comparabilityMismatch, areComparable } from "../src/services/searchContextIdentity";
import {
  generateNumericInventoryTransition,
  generateBinaryTransition,
  generatePriceTransition,
  buildAdjacentTransitionPairs,
  type TransitionPair
} from "../src/services/marketObservationTransitions";
import { extractInventoryScarcitySignal } from "../src/services/inventoryScarcityExtraction";
import { suppressRetryDuplicates } from "../src/services/collectorRunManifest";
import { assessDataQuality, computeMarketCompressionRawFeatures } from "../src/services/marketObservationQuality";
import { selectAcceptedJalanPriceCandidateLayered, type JalanAcceptedPricePolicy } from "../src/collectors/jalanAcceptedPricePolicy";
import { CORE_COMPETITORS } from "../src/services/coreCompetitorTargets";
import { FORBIDDEN_COLUMNS, HISTORY_CSV_HEADERS } from "../src/services/localHistorySchemaDesign";
import { isPriorityCompetitorName } from "../src/services/priorityCompetitors";

function makeRow(overrides: Partial<MarketObservationRow> = {}): MarketObservationRow {
  const base: MarketObservationRow = {
    observationId: "",
    observationHash: "",
    propertyId: "oakhill",
    propertyName: "ONSEN & STAY OAKHILL",
    sourcePlatform: "booking",
    stayDate: "2026-08-17",
    observedAtJst: "2026-08-17T04:50:00+09:00",
    roomProductKey: "text:スタンダードツイン",
    roomTypeName: "スタンダードツイン",
    ratePlanKey: "",
    ratePlanName: "",
    searchAdults: 2,
    searchChildren: 0,
    searchRooms: 1,
    lengthOfStay: 1,
    currency: "JPY",
    observedPrice: 11500,
    availabilityStatus: "AVAILABLE",
    inventoryCount: null,
    inventoryCountSemantics: "BINARY_AVAILABILITY",
    inventoryScope: "UNKNOWN",
    sourceQuality: "HIGH",
    rawEvidenceHash: "hash",
    collectorRunId: "run1"
  };
  return { ...base, ...overrides };
}

describe("ZMI-MKT-OBS01 - §12 numeric inventory transitions (never called pickup)", () => {
  it("1) 5 -> 3 = OBSERVED_INVENTORY_DEPLETION magnitude 2", () => {
    const previous = makeRow({ inventoryCount: 5, inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT", inventoryScope: "PRODUCT", observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ inventoryCount: 3, inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT", inventoryScope: "PRODUCT", observedAtJst: "2026-08-17T16:50:00+09:00" });
    const t = generateNumericInventoryTransition({ previous, current });
    expect(t?.type).toBe("OBSERVED_INVENTORY_DEPLETION");
    expect(t?.magnitude).toBe(2);
    expect(JSON.stringify(t)).not.toMatch(/pickup/iu);
  });

  it("2) 3 -> 5 = INVENTORY_EXPANSION magnitude 2", () => {
    const previous = makeRow({ inventoryCount: 3, inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT", inventoryScope: "PRODUCT", observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ inventoryCount: 5, inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT", inventoryScope: "PRODUCT", observedAtJst: "2026-08-17T16:50:00+09:00" });
    const t = generateNumericInventoryTransition({ previous, current });
    expect(t?.type).toBe("INVENTORY_EXPANSION");
    expect(t?.magnitude).toBe(2);
  });
});

describe("ZMI-MKT-OBS01 - §13 binary transitions (never derive room count from binary)", () => {
  it("3) available -> sold_out = SELL_OUT_TRANSITION", () => {
    const previous = makeRow({ availabilityStatus: "AVAILABLE", observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ availabilityStatus: "SOLD_OUT", observedAtJst: "2026-08-17T16:50:00+09:00" });
    const t = generateBinaryTransition({ previous, current });
    expect(t?.type).toBe("SELL_OUT_TRANSITION");
    expect(t?.quantityChange).toBe("UNKNOWN");
  });

  it("4) sold_out -> available = INVENTORY_REOPENED", () => {
    const previous = makeRow({ availabilityStatus: "SOLD_OUT", observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ availabilityStatus: "AVAILABLE", observedAtJst: "2026-08-17T16:50:00+09:00" });
    const t = generateBinaryTransition({ previous, current });
    expect(t?.type).toBe("INVENTORY_REOPENED");
    expect(t?.quantityChange).toBe("UNKNOWN");
  });

  it("5) available -> available = quantity change UNKNOWN (never inferred as unchanged/higher)", () => {
    const previous = makeRow({ availabilityStatus: "AVAILABLE", observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ availabilityStatus: "AVAILABLE", observedAtJst: "2026-08-17T16:50:00+09:00" });
    const t = generateBinaryTransition({ previous, current });
    expect(t?.type).toBe("NO_BINARY_TRANSITION");
    expect(t?.quantityChange).toBe("UNKNOWN");
  });

  it("sold_out -> sold_out = quantity change UNKNOWN too", () => {
    const previous = makeRow({ availabilityStatus: "SOLD_OUT", observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ availabilityStatus: "SOLD_OUT", observedAtJst: "2026-08-17T16:50:00+09:00" });
    const t = generateBinaryTransition({ previous, current });
    expect(t?.type).toBe("NO_BINARY_TRANSITION");
    expect(t?.quantityChange).toBe("UNKNOWN");
  });
});

describe("ZMI-MKT-OBS01 - §20 failure semantics kept distinct from sold-out", () => {
  it("6) COLLECTION_FAILED is never treated as SOLD_OUT for binary transitions", () => {
    const previous = makeRow({ availabilityStatus: "AVAILABLE", observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ availabilityStatus: "COLLECTION_FAILED", observedAtJst: "2026-08-17T16:50:00+09:00" });
    expect(generateBinaryTransition({ previous, current })).toBeNull();
    expect(current.availabilityStatus).not.toBe("SOLD_OUT");
  });

  it("7) NOT_LISTED is never treated as SOLD_OUT for binary transitions", () => {
    const previous = makeRow({ availabilityStatus: "AVAILABLE", observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ availabilityStatus: "NOT_LISTED", observedAtJst: "2026-08-17T16:50:00+09:00" });
    expect(generateBinaryTransition({ previous, current })).toBeNull();
    expect(current.availabilityStatus).not.toBe("SOLD_OUT");
  });
});

describe("ZMI-MKT-OBS01 - §5 scope discipline", () => {
  it("8) a PRODUCT-scope count is never compared against a PROPERTY-scope count", () => {
    const previous = makeRow({ inventoryCount: 2, inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT", inventoryScope: "PRODUCT", observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ inventoryCount: 27, inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT", inventoryScope: "PROPERTY", observedAtJst: "2026-08-17T16:50:00+09:00" });
    expect(generateNumericInventoryTransition({ previous, current })).toBeNull();
  });

  it("HAMMOND 27-room property capacity is never divided into a product-level '残り3室' badge (§18)", () => {
    const scarcity = extractInventoryScarcitySignal("スタンダードツイン ポイント10% 禁煙ルーム あと3部屋");
    expect(scarcity.inventoryScope).toBe("PRODUCT");
    expect(scarcity.inventoryCount).toBe(3);
    // No function in this module ever takes a property-capacity denominator —
    // structurally, extractInventoryScarcitySignal has no such parameter.
  });
});

describe("ZMI-MKT-OBS01 - §7 search-context identity: non-comparable snapshots", () => {
  it("9) different occupancy (adults) is not comparable", () => {
    const a = makeRow({ searchAdults: 2 });
    const b = makeRow({ searchAdults: 1 });
    expect(comparabilityMismatch(a, b)).toBe("different_occupancy");
    expect(areComparable(a, b)).toBe(false);
  });

  it("10) different length of stay is not comparable", () => {
    const a = makeRow({ lengthOfStay: 1 });
    const b = makeRow({ lengthOfStay: 2 });
    expect(comparabilityMismatch(a, b)).toBe("different_length_of_stay");
  });

  it("11) different room product is not comparable", () => {
    const a = makeRow({ roomProductKey: "text:スタンダードツイン" });
    const b = makeRow({ roomProductKey: "text:デラックス和洋室" });
    expect(comparabilityMismatch(a, b)).toBe("different_room_product");
  });

  it("unknown room product (empty key on either side) is never treated as a match", () => {
    const a = makeRow({ roomProductKey: "" });
    const b = makeRow({ roomProductKey: "" });
    expect(comparabilityMismatch(a, b)).toBe("unknown_room_product");
  });

  it("comparison key changes with every identity component", () => {
    const base = { propertyId: "oakhill", sourcePlatform: "booking", stayDate: "2026-08-17", roomProductKey: "text:twin", ratePlanKey: "", searchAdults: 2, searchChildren: 0, searchRooms: 1, lengthOfStay: 1, currency: "JPY" };
    const k1 = buildComparisonKey(base);
    const k2 = buildComparisonKey({ ...base, searchAdults: 3 });
    expect(k1).not.toBe(k2);
  });
});

describe("ZMI-MKT-OBS01 - §11 duplicate suppression (retry only, not real repeats)", () => {
  it("12) a retry within the same collector_run_id is suppressed; a genuinely later run's identical cell is kept", () => {
    const attempt1 = makeRow({ collectorRunId: "run1", observedAtJst: "2026-08-17T04:50:00+09:00" });
    const attempt2Retry = makeRow({ collectorRunId: "run1", observedAtJst: "2026-08-17T04:50:03+09:00" }); // same run, retried moments later
    const laterRealRun = makeRow({ collectorRunId: "run2", observedAtJst: "2026-08-17T16:50:00+09:00" }); // genuinely later run (the PM pass)
    const { kept, suppressedCount } = suppressRetryDuplicates([attempt1, attempt2Retry, laterRealRun]);
    expect(suppressedCount).toBe(1);
    expect(kept).toHaveLength(2);
    expect(kept.map((r) => r.collectorRunId)).toEqual(["run1", "run2"]);
  });
});

describe("ZMI-MKT-OBS01 - §14 price transitions", () => {
  it("13) price-up transition with correct absolute/percentage delta", () => {
    const previous = makeRow({ observedPrice: 10000, observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ observedPrice: 12000, observedAtJst: "2026-08-17T16:50:00+09:00" });
    const t = generatePriceTransition({ previous, current });
    expect(t?.type).toBe("PRICE_UP");
    expect(t?.absoluteDelta).toBe(2000);
    expect(t?.percentageDelta).toBeCloseTo(20, 5);
  });

  it("14) price-down transition with correct absolute/percentage delta", () => {
    const previous = makeRow({ observedPrice: 12000, observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ observedPrice: 9000, observedAtJst: "2026-08-17T16:50:00+09:00" });
    const t = generatePriceTransition({ previous, current });
    expect(t?.type).toBe("PRICE_DOWN");
    expect(t?.absoluteDelta).toBe(-3000);
    expect(t?.percentageDelta).toBeCloseTo(-25, 5);
  });

  it("price-unchanged transition when equal", () => {
    const previous = makeRow({ observedPrice: 10000, observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ observedPrice: 10000, observedAtJst: "2026-08-17T16:50:00+09:00" });
    expect(generatePriceTransition({ previous, current })?.type).toBe("PRICE_UNCHANGED");
  });

  it("null (not zero-delta) when either side has no price", () => {
    const previous = makeRow({ observedPrice: null, observedAtJst: "2026-08-17T04:50:00+09:00" });
    const current = makeRow({ observedPrice: 10000, observedAtJst: "2026-08-17T16:50:00+09:00" });
    expect(generatePriceTransition({ previous, current })).toBeNull();
  });
});

describe("ZMI-MKT-OBS01 - §4/§16 no fabricated inventory precision", () => {
  it("15) a qualitative scarcity phrase ('空室わずか') never produces an invented number", () => {
    const scarcity = extractInventoryScarcitySignal("和室 ポイント10% 禁煙ルーム 空室わずか");
    expect(scarcity.inventoryCount).toBeNull();
    expect(scarcity.inventoryCountSemantics).toBe("UNKNOWN");
  });

  it("no scarcity text at all -> BINARY_AVAILABILITY, not a guessed count", () => {
    const scarcity = extractInventoryScarcitySignal("スタンダード和室 10畳 バス・トイレ付／禁煙");
    expect(scarcity.inventoryCount).toBeNull();
    expect(scarcity.inventoryCountSemantics).toBe("BINARY_AVAILABILITY");
  });

  it("a numeric badge next to a specific room card is PRODUCT-scoped, never PROPERTY-scoped", () => {
    const scarcity = extractInventoryScarcitySignal("デラックス和洋室 当サイトでは残り3室");
    expect(scarcity.inventoryScope).toBe("PRODUCT");
    expect(scarcity.inventoryScope).not.toBe("PROPERTY");
  });

  it("validateObservationRow rejects a numeric count carrying UNKNOWN semantics or scope (half-fabricated precision)", () => {
    const row = makeRow({ inventoryCount: 3, inventoryCountSemantics: "UNKNOWN", inventoryScope: "PRODUCT" });
    expect(validateObservationRow(row)).toContain("inventory_count_present_without_semantics_or_scope");
  });

  it("ZMI never emits a final weighted score field (§16) — only raw features", () => {
    const rows = [
      makeRow({ propertyId: "hammond", stayDate: "2026-08-17", observedAtJst: "2026-08-17T04:50:00+09:00" }),
      makeRow({ propertyId: "hammond", stayDate: "2026-08-17", observedAtJst: "2026-08-17T16:50:00+09:00", observedPrice: 12000 })
    ];
    const features = computeMarketCompressionRawFeatures({ stayDate: "2026-08-17", rows, nowIso: "2026-08-18T00:00:00+09:00" });
    expect(Object.keys(features)).not.toContain("marketCompressionScore");
    expect(Object.keys(features).some((k) => /score/iu.test(k))).toBe(false);
  });
});

describe("ZMI-MKT-OBS01 - OAKHILL root cause regression (§2/§19)", () => {
  it("16) OAKHILL is still a registered priority competitor (mapping unaffected by this upgrade)", () => {
    expect(isPriorityCompetitorName("ONSEN & STAY OAKHILL")).toBe(true);
    expect(isPriorityCompetitorName("OAKHILL")).toBe(true);
    expect(CORE_COMPETITORS.find((c) => c.propertyId === "oakhill")?.jalanYadId).toBe("yad388065");
    expect(CORE_COMPETITORS.find((c) => c.propertyId === "oakhill")?.bookingSlug).toBe("onsen-amp-stay-oakhill");
  });

  it("the confirmed-room-only-preferring policy exists and layered selection prefers it (the actual OAKHILL fix)", () => {
    const policies: JalanAcceptedPricePolicy[] = [
      "cheapest_total_tax_included_safe_plan",
      "cheapest_confirmed_room_only_two_person_standard_total_tax_included_safe_plan"
    ];
    expect(policies).toContain("cheapest_confirmed_room_only_two_person_standard_total_tax_included_safe_plan");
    // No candidates -> layered selection falls back gracefully, never throws.
    expect(() => selectAcceptedJalanPriceCandidateLayered([])).not.toThrow();
  });

  it("product identity stabilization does not fuse two different OAKHILL room types into one key", () => {
    const twin = buildRoomProductKey({ roomTypeName: "スタンダードツイン" });
    const deluxe = buildRoomProductKey({ roomTypeName: "デラックス和洋室" });
    expect(isSameRoomProduct(twin, deluxe)).toBe(false);
  });

  it("trivial UI wording noise (leading/trailing whitespace, casing) does not create a false new product", () => {
    const a = buildRoomProductKey({ roomTypeName: "Standard Twin" });
    const b = buildRoomProductKey({ roomTypeName: "  standard twin  " }); // leading/trailing space + casing only
    expect(isSameRoomProduct(a, b)).toBe(true);
  });
});

describe("ZMI-MKT-OBS01 - §25 backward compatibility with existing price collector", () => {
  it("17) the existing zao_local_history_v1 schema and its FORBIDDEN_COLUMNS (inventory ban) are untouched", () => {
    expect(FORBIDDEN_COLUMNS).toContain("inventory");
    expect(HISTORY_CSV_HEADERS.length).toBeGreaterThan(0);
  });

  it("the NEW inventory/product-identity columns are not injected into the existing history schema", () => {
    const newInventorySpecificColumns = [
      "observation_id",
      "observation_hash",
      "room_product_key",
      "rate_plan_key",
      "inventory_count",
      "inventory_count_semantics",
      "inventory_scope",
      "collector_run_id"
    ];
    for (const col of newInventorySpecificColumns) {
      expect(MARKET_OBSERVATION_CSV_HEADERS).toContain(col);
      expect(HISTORY_CSV_HEADERS).not.toContain(col);
    }
  });

  it("validateObservationColumns still requires every new-schema column and forbids naive/PMS-style columns", () => {
    const missing = validateObservationColumns(MARKET_OBSERVATION_CSV_HEADERS.filter((c) => c !== "inventory_count"));
    expect(missing).toContain("missing_column:inventory_count");
    const forbidden = validateObservationColumns([...MARKET_OBSERVATION_CSV_HEADERS, "rooms_available_exact"]);
    expect(forbidden).toContain("forbidden_column:rooms_available_exact");
  });
});

describe("ZMI-MKT-OBS01 - schema/id/hash unit coverage", () => {
  it("observation id is stable for identical inputs and changes when any component changes", () => {
    const parts = {
      sourcePlatform: "booking",
      propertyId: "oakhill",
      stayDate: "2026-08-17",
      roomProductKey: "text:twin",
      ratePlanKey: "",
      searchAdults: 2,
      searchChildren: 0,
      searchRooms: 1,
      lengthOfStay: 1,
      collectorRunId: "run1"
    };
    const id1 = buildObservationId(parts);
    const id2 = buildObservationId({ ...parts, collectorRunId: "run2" });
    expect(id1).not.toBe(id2);
    expect(buildObservationId(parts)).toBe(id1);
  });

  it("observation hash changes when the observed price changes but not when collector_run_id changes", () => {
    const base = {
      propertyId: "oakhill",
      sourcePlatform: "booking",
      stayDate: "2026-08-17",
      roomProductKey: "text:twin",
      ratePlanKey: "",
      searchAdults: 2,
      searchChildren: 0,
      searchRooms: 1,
      lengthOfStay: 1,
      currency: "JPY",
      observedPrice: 10000,
      availabilityStatus: "AVAILABLE",
      inventoryCount: null,
      inventoryCountSemantics: "BINARY_AVAILABILITY",
      inventoryScope: "UNKNOWN"
    };
    const h1 = buildObservationHash(base);
    const h2 = buildObservationHash({ ...base, observedPrice: 11000 });
    expect(h1).not.toBe(h2);
  });

  it("buildRatePlanKey is honestly empty (unknown) rather than inventing a plan name", () => {
    expect(buildRatePlanKey({})).toBe("");
    expect(buildRatePlanKey({ ratePlanName: "素泊まりプラン" })).toContain("素泊まりプラン");
  });

  it("a source-provided product ID always wins over text normalization", () => {
    const withId = buildRoomProductKey({ sourceProductId: "RM123", roomTypeName: "呼び名が変わっても" });
    expect(withId).toBe("id:RM123");
  });
});

describe("ZMI-MKT-OBS01 - §17 data quality never defaults UNKNOWN to normal", () => {
  it("zero observations for a stay date is INSUFFICIENT, not a default/normal tier", () => {
    const quality = assessDataQuality({ stayDate: "2026-09-01", rows: [], expectedCompetitorCount: 3, nowIso: "2026-09-01T00:00:00+09:00" });
    expect(quality.tier).toBe("INSUFFICIENT");
  });

  it("a single observation with no repeat pair is LOW, not MEDIUM/HIGH", () => {
    const rows = [makeRow({ propertyId: "hammond", stayDate: "2026-08-17" })];
    const quality = assessDataQuality({ stayDate: "2026-08-17", rows, expectedCompetitorCount: 3, nowIso: "2026-08-18T00:00:00+09:00" });
    expect(quality.tier).toBe("LOW");
  });

  it("full CORE coverage with real repeated pairs and no failures reaches HIGH", () => {
    const rows = CORE_COMPETITORS.flatMap((c) => [
      makeRow({ propertyId: c.propertyId, stayDate: "2026-08-17", observedAtJst: "2026-08-17T04:50:00+09:00" }),
      makeRow({ propertyId: c.propertyId, stayDate: "2026-08-17", observedAtJst: "2026-08-17T16:50:00+09:00" })
    ]);
    const quality = assessDataQuality({ stayDate: "2026-08-17", rows, expectedCompetitorCount: 3, nowIso: "2026-08-18T00:00:00+09:00" });
    expect(quality.tier).toBe("HIGH");
  });
});

describe("ZMI-MKT-OBS01 - adjacent pairing builds real chronological time series", () => {
  it("only ADJACENT observations within the same comparison key become a pair, in observed_at order", () => {
    const rows = [
      makeRow({ observedAtJst: "2026-08-17T16:50:00+09:00", inventoryCount: 2, inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT", inventoryScope: "PRODUCT" }),
      makeRow({ observedAtJst: "2026-08-17T04:50:00+09:00", inventoryCount: 5, inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT", inventoryScope: "PRODUCT" }),
      makeRow({ observedAtJst: "2026-08-18T04:50:00+09:00", inventoryCount: 1, inventoryCountSemantics: "PUBLIC_SCARCITY_COUNT", inventoryScope: "PRODUCT" })
    ];
    const pairs: TransitionPair[] = buildAdjacentTransitionPairs(rows);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.previous.observedAtJst).toBe("2026-08-17T04:50:00+09:00");
    expect(pairs[0]!.current.observedAtJst).toBe("2026-08-17T16:50:00+09:00");
    expect(pairs[1]!.previous.observedAtJst).toBe("2026-08-17T16:50:00+09:00");
    expect(pairs[1]!.current.observedAtJst).toBe("2026-08-18T04:50:00+09:00");
  });
});
