import { describe, expect, it } from "vitest";
import { detectPriceChanges } from "../src/services/priorityPriceChangeDetection";
import type { PriceHistoryInputRow } from "../src/services/priceHistorySignals";

function row(over: Partial<PriceHistoryInputRow> = {}): PriceHistoryInputRow {
  return {
    property_id: "hammond-takamiya",
    property_name: "HAMMOND",
    source: "booking",
    checkin_date: "2026-08-03",
    observed_at: "2026-07-03T13:35:00+09:00",
    occupancy_basis: "2_adults_1_rooms",
    availability_status_raw: "available",
    normalized_total_price: 14800,
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
const HAMMOND_REF = { canonical_property_key: "hammond", display_name: "HAMMOND / ハモンド", canonical_property_name: "HAMMOND" };
const MIURAYA_REF = { canonical_property_key: "miuraya", display_name: "三浦屋 / Miuraya", canonical_property_name: "三浦屋" };

describe("PRICING-CRITICAL01 - price change detection (§12.9)", () => {
  it("14800 -> 16800 => direction up, delta_amount, delta_rate", () => {
    const changes = detectPriceChanges({
      rows: [row({ observed_at: "2026-07-03T13:35:00+09:00", normalized_total_price: 14800 }), row({ observed_at: "2026-07-04T13:35:00+09:00", normalized_total_price: 16800 })],
      properties: [HAMMOND_REF],
      targetType: "competitor"
    });
    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    expect(c.direction).toBe("up");
    expect(c.previous_price).toBe(14800);
    expect(c.latest_price).toBe(16800);
    expect(c.delta_amount).toBe(2000);
    expect(c.delta_rate).toBeCloseTo(0.1351, 4);
    expect(c.target_type).toBe("competitor");
    expect(c.property).toBe("hammond");
  });

  it("16800 -> 14800 => direction down", () => {
    const changes = detectPriceChanges({
      rows: [row({ observed_at: "2026-07-03T13:35:00+09:00", normalized_total_price: 16800 }), row({ observed_at: "2026-07-04T13:35:00+09:00", normalized_total_price: 14800 })],
      properties: [HAMMOND_REF],
      targetType: "competitor"
    });
    expect(changes[0]!.direction).toBe("down");
    expect(changes[0]!.delta_amount).toBe(-2000);
  });

  it("same amount => skip_identical (no record emitted)", () => {
    const changes = detectPriceChanges({
      rows: [row({ observed_at: "2026-07-03T13:35:00+09:00", normalized_total_price: 14800 }), row({ observed_at: "2026-07-04T13:35:00+09:00", normalized_total_price: 14800 })],
      properties: [HAMMOND_REF],
      targetType: "competitor"
    });
    expect(changes).toHaveLength(0);
  });

  it("own property price change detected with target_type=own_property (self price monitoring)", () => {
    const changes = detectPriceChanges({
      rows: [
        row({ property_name: "三浦屋", observed_at: "2026-07-03T13:35:00+09:00", normalized_total_price: 17800 }),
        row({ property_name: "三浦屋", observed_at: "2026-07-04T13:35:00+09:00", normalized_total_price: 19800 })
      ],
      properties: [MIURAYA_REF],
      targetType: "own_property"
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.target_type).toBe("own_property");
    expect(changes[0]!.property).toBe("miuraya");
    expect(changes[0]!.direction).toBe("up");
  });

  it("only one observation => no comparison possible (no record)", () => {
    const changes = detectPriceChanges({ rows: [row()], properties: [HAMMOND_REF], targetType: "competitor" });
    expect(changes).toHaveLength(0);
  });

  it("different checkin dates are compared separately, not against each other", () => {
    const changes = detectPriceChanges({
      rows: [
        row({ checkin_date: "2026-08-03", observed_at: "2026-07-03T13:35:00+09:00", normalized_total_price: 14800 }),
        row({ checkin_date: "2026-08-03", observed_at: "2026-07-04T13:35:00+09:00", normalized_total_price: 16800 }),
        row({ checkin_date: "2026-08-04", observed_at: "2026-07-03T13:35:00+09:00", normalized_total_price: 20000 }),
        row({ checkin_date: "2026-08-04", observed_at: "2026-07-04T13:35:00+09:00", normalized_total_price: 18000 })
      ],
      properties: [HAMMOND_REF],
      targetType: "competitor"
    });
    expect(changes).toHaveLength(2);
    expect(changes.find((c) => c.checkin === "2026-08-03")!.direction).toBe("up");
    expect(changes.find((c) => c.checkin === "2026-08-04")!.direction).toBe("down");
  });
});
