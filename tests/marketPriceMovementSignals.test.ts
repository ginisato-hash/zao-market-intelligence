import { describe, expect, it } from "vitest";
import type { PriceHistoryInputRow } from "../src/services/priceHistorySignals";
import {
  buildDpPressureByCheckin,
  buildMarketPriceMovements
} from "../src/services/marketPriceMovementSignals";

// Default = a competitor Booking available priced row (probable two-person).
function row(over: Partial<PriceHistoryInputRow> = {}): PriceHistoryInputRow {
  return {
    property_id: "zao-kokusai",
    property_name: "蔵王国際ホテル",
    source: "booking",
    checkin_date: "2026-08-10",
    observed_at: "2026-06-10T10:00:00+09:00",
    occupancy_basis: "2_adults_1_rooms",
    availability_status_raw: "available",
    normalized_total_price: 20000,
    basis_confidence: "B",
    warning_flags: "",
    source_classification: "",
    dp_exclusion_reason: "",
    is_price_excluded_from_dp: false,
    is_price_usable_for_dp_directional: true,
    basis_note: "",
    room_type_key: "",
    ...over
  };
}
const CONFIRMED = "room_basis=confirmed_two_person_standard_room";
const soldOut = (over: Partial<PriceHistoryInputRow>) => row({ availability_status_raw: "sold_out", normalized_total_price: null, is_price_usable_for_dp_directional: false, ...over });

function one(rows: PriceHistoryInputRow[]) {
  return buildMarketPriceMovements(rows).movements[0]!;
}

describe("MARKET-PRICE-MOVEMENT01 - movement classification", () => {
  it("price up while available => price_up_available", () => {
    const m = one([row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }), row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000 })]);
    expect(m.movement_type).toBe("price_up_available");
    expect(m.price_delta_abs).toBe(4000);
  });

  it("price down while available => price_down_available", () => {
    const m = one([row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 24000 }), row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 20000 })]);
    expect(m.movement_type).toBe("price_down_available");
  });

  it("tiny change => noise", () => {
    const m = one([row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }), row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 20100 })]);
    expect(m.movement_type).toBe("noise");
  });

  it("available -> sold_out after price up => sold_out_after_price_up", () => {
    const m = one([
      row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000 }),
      soldOut({ observed_at: "2026-06-12T10:00:00+09:00" })
    ]);
    expect(m.movement_type).toBe("sold_out_after_price_up");
    expect(m.latest_availability_status).toBe("sold_out");
  });

  it("available -> sold_out with same price => sold_out_after_same_price", () => {
    const m = one([
      row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 20000 }),
      soldOut({ observed_at: "2026-06-12T10:00:00+09:00" })
    ]);
    expect(m.movement_type).toBe("sold_out_after_same_price");
  });

  it("sold_out -> available => newly_available", () => {
    const m = one([soldOut({ observed_at: "2026-06-10T10:00:00+09:00" }), row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000 })]);
    expect(m.movement_type).toBe("newly_available");
  });
});

describe("MARKET-PRICE-MOVEMENT01 - exclusions", () => {
  it("own property is excluded from market evidence", () => {
    const res = buildMarketPriceMovements([
      row({ property_name: "三浦屋", observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ property_name: "三浦屋", observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000 })
    ]);
    expect(res.ownPropertyRows).toBeGreaterThan(0);
    expect(res.movements).toHaveLength(0);
  });

  it("own property alias (Kiraku) is excluded", () => {
    const res = buildMarketPriceMovements([row({ property_name: "ZAO SPA HOTEL Kiraku", observed_at: "2026-06-10T10:00:00+09:00" })]);
    expect(res.movements).toHaveLength(0);
  });

  it("low/unknown room basis is not used (not_comparable)", () => {
    // Jalan unmarked => unknown meal basis => not eligible-priced.
    const m = one([
      row({ source: "jalan", observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ source: "jalan", observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000 })
    ]);
    expect(m.movement_type).toBe("not_comparable");
  });

  it("meal-included row is not used", () => {
    const m = one([
      row({ source: "jalan", observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000, is_price_excluded_from_dp: true, source_classification: "jalan_meal_included_excluded" }),
      row({ source: "jalan", observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000, is_price_excluded_from_dp: true, source_classification: "jalan_meal_included_excluded" })
    ]);
    expect(m.movement_type).toBe("not_comparable");
  });

  it("excluded room type is not used", () => {
    const m = one([
      row({ observed_at: "2026-06-10T10:00:00+09:00", dp_exclusion_reason: "excluded_room_type_single", is_price_excluded_from_dp: true }),
      row({ observed_at: "2026-06-11T10:00:00+09:00", dp_exclusion_reason: "excluded_room_type_single", is_price_excluded_from_dp: true })
    ]);
    expect(m.movement_type).toBe("not_comparable");
  });
});

describe("MARKET-PRICE-MOVEMENT01 - comparison scope", () => {
  it("different sources are compared separately (not cross-source)", () => {
    const { movements } = buildMarketPriceMovements([
      row({ source: "booking", observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ source: "booking", observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000 }),
      row({ source: "jalan", observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 30000, warning_flags: "meal_basis=confirmed_room_only", basis_note: CONFIRMED }),
      row({ source: "jalan", observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 30000, warning_flags: "meal_basis=confirmed_room_only", basis_note: CONFIRMED })
    ]);
    expect(movements).toHaveLength(2);
    const booking = movements.find((m) => m.source === "booking")!;
    expect(booking.movement_type).toBe("price_up_available");
  });

  it("different checkins are not compared", () => {
    const { movements } = buildMarketPriceMovements([
      row({ checkin_date: "2026-08-10", observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ checkin_date: "2026-08-11", observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000 })
    ]);
    expect(movements).toHaveLength(2);
    expect(movements.every((m) => m.movement_type === "unknown")).toBe(true); // single obs per checkin
  });

  it("probable rows are weighted lower than confirmed rows", () => {
    const probable = one([row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }), row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000 })]);
    const confirmed = one([row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000, basis_note: CONFIRMED }), row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000, basis_note: CONFIRMED })]);
    expect(confirmed.row_weight).toBe(1);
    expect(probable.row_weight).toBeLessThan(confirmed.row_weight);
    expect(probable.row_weight).toBeCloseTo(0.36, 5);
  });
});

describe("MARKET-PRICE-MOVEMENT01 - checkin DP pressure", () => {
  it("aggregates competitor movement into a normalized score and level", () => {
    const { movements } = buildMarketPriceMovements([
      // property A: confirmed price up
      row({ property_id: "a", property_name: "HAMMOND", basis_note: CONFIRMED, observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ property_id: "a", property_name: "HAMMOND", basis_note: CONFIRMED, observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 24000 }),
      // property B: confirmed price up
      row({ property_id: "b", property_name: "JURIN", basis_note: CONFIRMED, observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 18000 }),
      row({ property_id: "b", property_name: "JURIN", basis_note: CONFIRMED, observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 21000 })
    ]);
    const dp = buildDpPressureByCheckin(movements);
    expect(dp).toHaveLength(1);
    expect(dp[0]!.checkin).toBe("2026-08-10");
    expect(dp[0]!.price_up_count).toBe(2);
    expect(dp[0]!.dp_pressure_score_normalized).toBeGreaterThan(0);
    expect(dp[0]!.dp_pressure_level).toBe("high_upward_pressure"); // all up, confirmed weight 1 => normalized 1
  });

  it("price-down checkin yields downward pressure", () => {
    const { movements } = buildMarketPriceMovements([
      row({ property_name: "HAMMOND", basis_note: CONFIRMED, observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 24000 }),
      row({ property_name: "HAMMOND", basis_note: CONFIRMED, observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 20000 })
    ]);
    const dp = buildDpPressureByCheckin(movements);
    expect(dp[0]!.dp_pressure_score_normalized).toBeLessThan(0);
    expect(["downward_pressure", "strong_downward_pressure"]).toContain(dp[0]!.dp_pressure_level);
  });
});
