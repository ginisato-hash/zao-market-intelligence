import { describe, expect, it } from "vitest";
import { buildPriceChanges, dedupeObservations, type PriceHistoryInputRow } from "../src/services/priceHistorySignals";
import {
  buildCrawlPriority,
  buildCrawlPriorityValidation,
  buildMarketBookingCurve,
  buildMarketCurveValidation
} from "../src/services/marketIntelligenceSignals";

function row(over: Partial<PriceHistoryInputRow> = {}): PriceHistoryInputRow {
  return {
    property_id: "p1",
    property_name: "P1",
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

function curveOf(rows: PriceHistoryInputRow[]) {
  const changes = buildPriceChanges(dedupeObservations(rows).rows);
  return buildMarketBookingCurve(rows, changes);
}

describe("MARKET-CURVE01 - booking curve", () => {
  it("aggregates per (checkin_date, observation day) with ratios, prices, lead time", () => {
    const curve = curveOf([
      row({ property_id: "p1", observed_at: "2026-06-10T10:00:00+09:00", availability_status_raw: "available", normalized_total_price: 20000 }),
      row({ property_id: "p2", observed_at: "2026-06-10T10:05:00+09:00", availability_status_raw: "sold_out", normalized_total_price: null }),
      row({ property_id: "p1", observed_at: "2026-06-11T10:00:00+09:00", availability_status_raw: "available", normalized_total_price: 22000 }),
      row({ property_id: "p2", observed_at: "2026-06-11T10:05:00+09:00", availability_status_raw: "available", normalized_total_price: 25000 })
    ]);
    expect(curve).toHaveLength(2);
    const d1 = curve.find((c) => c.observed_at === "2026-06-10")!;
    expect(d1.raw_observation_count).toBe(2);
    expect(d1.property_count).toBe(2);
    expect(d1.available_count).toBe(1);
    expect(d1.sold_out_count).toBe(1);
    expect(d1.available_ratio).toBe(0.5);
    expect(d1.lead_time_days).toBe(61); // 2026-06-10 -> 2026-08-10
    expect(d1.price_observation_count).toBe(1);
    expect(d1.median_available_price).toBe(20000);

    const d2 = curve.find((c) => c.observed_at === "2026-06-11")!;
    expect(d2.available_count).toBe(2);
    expect(d2.median_available_price).toBe(23500);
    expect(d2.min_available_price).toBe(22000);
    expect(d2.max_available_price).toBe(25000);
    // since previous observation: p1 price_up, p2 sold_out_to_available
    expect(d2.price_up_count_since_previous_observation).toBe(1);
    expect(d2.sold_out_to_available_count_since_previous_observation).toBe(1);
  });

  it("market_movement_level=high when >=3 available_to_sold_out since previous", () => {
    const props = ["p1", "p2", "p3"];
    const curve = curveOf([
      ...props.map((p) => row({ property_id: p, observed_at: "2026-06-10T10:00:00+09:00", availability_status_raw: "available", normalized_total_price: 20000 })),
      ...props.map((p) => row({ property_id: p, observed_at: "2026-06-11T10:00:00+09:00", availability_status_raw: "sold_out", normalized_total_price: null }))
    ]);
    const d2 = curve.find((c) => c.observed_at === "2026-06-11")!;
    expect(d2.available_to_sold_out_count_since_previous_observation).toBe(3);
    expect(d2.market_movement_level).toBe("high");
  });

  it("market_movement_level=insufficient_data when raw_observation_count < 3", () => {
    const curve = curveOf([row({ observed_at: "2026-06-10T10:00:00+09:00" })]);
    expect(curve[0]!.raw_observation_count).toBe(1);
    expect(curve[0]!.market_movement_level).toBe("insufficient_data");
    expect(curve[0]!.data_quality).toBe("insufficient");
  });

  it("data_quality scales with raw_observation_count", () => {
    const make = (n: number) => curveOf(Array.from({ length: n }, (_, i) => row({ property_id: `p${i}`, observed_at: "2026-06-10T10:00:00+09:00" })))[0]!;
    expect(make(10).data_quality).toBe("high");
    expect(make(5).data_quality).toBe("medium");
    expect(make(3).data_quality).toBe("low");
  });

  it("validation carries required keys and a ready decision", () => {
    const curve = curveOf([
      row({ property_id: "p1", observed_at: "2026-06-10T10:00:00+09:00" }),
      row({ property_id: "p1", observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 21000 })
    ]);
    const v = buildMarketCurveValidation({ runAt: "2026-06-18T12:00:00+09:00", inputHistoryRows: 2, curve });
    for (const k of ["run_at", "input_history_rows", "booking_curve_rows", "min_checkin_date", "max_checkin_date", "min_observed_at", "max_observed_at", "unique_checkin_dates", "unique_observed_ats", "decision", "warnings"]) {
      expect(v).toHaveProperty(k);
    }
    expect(["market_booking_curve_ready", "market_booking_curve_ready_with_warnings"]).toContain(v.decision);
    expect(buildMarketCurveValidation({ runAt: "x", inputHistoryRows: 0, curve: [] }).decision).toBe("market_booking_curve_insufficient_data");
  });
});

describe("CRAWL-PRIORITY01 - fetch prioritization", () => {
  function priorityOf(rows: PriceHistoryInputRow[], runDateIso: string) {
    const changes = buildPriceChanges(dedupeObservations(rows).rows);
    const curve = buildMarketBookingCurve(rows, changes);
    return buildCrawlPriority({ rows, curve, changes, runDateIso });
  }

  it("near sold-out stay scores high with reason codes", () => {
    const props = ["p1", "p2", "p3"];
    const rows = [
      ...props.map((p) => row({ property_id: p, checkin_date: "2026-06-12", observed_at: "2026-06-09T10:00:00+09:00", availability_status_raw: "available", normalized_total_price: 20000 })),
      ...props.map((p) => row({ property_id: p, checkin_date: "2026-06-12", observed_at: "2026-06-10T10:00:00+09:00", availability_status_raw: "sold_out", normalized_total_price: null }))
    ];
    const targets = priorityOf(rows, "2026-06-10");
    const t = targets.find((x) => x.target_checkin_date === "2026-06-12")!;
    expect(t.lead_time_days).toBe(2);
    expect(t.available_to_sold_out_count).toBe(3);
    expect(t.sold_out_ratio).toBe(1);
    expect(t.priority_level).toBe("high");
    expect(t.priority_score).toBeGreaterThanOrEqual(8);
    expect(t.reason_codes).toContain("NEAR_STAY_DATE");
    expect(t.reason_codes).toContain("HIGH_SOLD_OUT_RATIO");
    expect(t.reason_codes).toContain("SOLD_OUT_TRANSITION");
  });

  it("low-priority for far quiet stays; priority_level thresholds hold", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ property_id: `p${i}`, checkin_date: "2026-12-01", observed_at: "2026-06-10T10:00:00+09:00", availability_status_raw: "available", normalized_total_price: 20000 }));
    const t = priorityOf(rows, "2026-06-10").find((x) => x.target_checkin_date === "2026-12-01")!;
    expect(t.lead_time_days).toBeGreaterThan(30);
    expect(t.priority_level).toBe("low");
  });

  it("recommended_sources lists under-observed sources first", () => {
    const rows = [
      row({ property_id: "p1", source: "booking", checkin_date: "2026-07-01", observed_at: "2026-06-10T10:00:00+09:00" }),
      row({ property_id: "p1", source: "booking", checkin_date: "2026-07-01", observed_at: "2026-06-11T10:00:00+09:00" })
    ];
    const t = priorityOf(rows, "2026-06-10").find((x) => x.target_checkin_date === "2026-07-01")!;
    // booking is observed; jalan/rakuten are not -> they come first.
    expect(t.recommended_sources.split(",")).toEqual(["Jalan", "Rakuten", "Booking"]);
  });

  it("only future stays are crawl targets (past checkin excluded)", () => {
    const rows = [
      row({ checkin_date: "2026-06-01", observed_at: "2026-05-20T10:00:00+09:00" }),
      row({ checkin_date: "2026-09-01", observed_at: "2026-06-10T10:00:00+09:00" })
    ];
    const targets = priorityOf(rows, "2026-06-10");
    expect(targets.map((t) => t.target_checkin_date)).toEqual(["2026-09-01"]);
  });

  it("validation carries required keys and counts", () => {
    const rows = Array.from({ length: 4 }, (_, i) => row({ property_id: `p${i}`, checkin_date: "2026-06-12", observed_at: "2026-06-10T10:00:00+09:00", availability_status_raw: "sold_out", normalized_total_price: null }));
    const targets = priorityOf(rows, "2026-06-10");
    const v = buildCrawlPriorityValidation({ runAt: "2026-06-18T12:00:00+09:00", rows: targets, inputHistoryRows: rows.length });
    for (const k of ["run_at", "crawl_priority_rows", "high_priority_count", "medium_priority_count", "low_priority_count", "max_priority_score", "min_priority_score", "decision", "warnings"]) {
      expect(v).toHaveProperty(k);
    }
    expect(["crawl_priority_ready", "crawl_priority_ready_with_warnings"]).toContain(v.decision);
    expect(v.high_priority_count + v.medium_priority_count + v.low_priority_count).toBe(v.crawl_priority_rows);
  });
});
