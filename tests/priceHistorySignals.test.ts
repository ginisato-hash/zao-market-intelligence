import { describe, expect, it } from "vitest";
import {
  buildPriceHistorySignals,
  comparisonKey,
  dedupeObservations,
  normalizeStatus,
  type PriceHistoryInputRow
} from "../src/services/priceHistorySignals";

// Booking + the confirmed two-person marker in basis_note => comparable.
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
    basis_note: "room_basis=confirmed_two_person_standard_room",
    room_type_key: "",
    ...over
  };
}

describe("PRICE-HISTORY01 — probable does not break the comparison key", () => {
  it("probable_two_person_standard_room collapses to unknown for key stability", () => {
    const r = row();
    const probable = comparisonKey(r, "assumed_room_only", "probable_two_person_standard_room");
    const unknown = comparisonKey(r, "assumed_room_only", "unknown_room_basis");
    // probable must NOT fragment a stay timeline: same key as unknown.
    expect(probable.key).toBe(unknown.key);
  });
  it("confirmed keeps a distinct comparison key", () => {
    const r = row();
    const confirmed = comparisonKey(r, "assumed_room_only", "confirmed_two_person_standard_room");
    const probable = comparisonKey(r, "assumed_room_only", "probable_two_person_standard_room");
    expect(confirmed.key).not.toBe(probable.key);
  });
});

const OPTS = {
  runAt: "2026-06-18T12:00:00+09:00",
  inputSources: ["test"],
  totalRawRows: 0,
  observedAtColumnUsed: "collected_at_jst",
  observedAtConfidence: "high"
};

function build(rows: PriceHistoryInputRow[]) {
  return buildPriceHistorySignals(rows, { ...OPTS, totalRawRows: rows.length });
}

describe("PRICE-HISTORY01 - normalization", () => {
  it("normalizes availability vocabulary", () => {
    expect(normalizeStatus("available")).toBe("available");
    expect(normalizeStatus("満室")).toBe("sold_out");
    expect(normalizeStatus("not_found")).toBe("not_listed");
    expect(normalizeStatus("failed")).toBe("unavailable");
    expect(normalizeStatus("")).toBe("unknown");
  });
});

describe("PRICE-HISTORY01 - change detection", () => {
  it("1. detects price_up (positive demand)", () => {
    const { changes } = build([
      row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 22000 })
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.change_type).toBe("price_up");
    expect(changes[0]!.price_delta).toBe(2000);
    expect(changes[0]!.price_delta_pct).toBe(10);
    expect(changes[0]!.signal_direction).toBe("positive_demand");
    expect(changes[0]!.signal_strength).toBe("high");
    expect(changes[0]!.is_comparable).toBe(true);
  });

  it("2. detects price_down (negative demand)", () => {
    const { changes } = build([
      row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 22000 }),
      row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 20000 })
    ]);
    expect(changes[0]!.change_type).toBe("price_down");
    expect(changes[0]!.signal_direction).toBe("negative_demand");
  });

  it("3. detects available_to_sold_out and keeps last available price", () => {
    const { changes } = build([
      row({ observed_at: "2026-06-10T10:00:00+09:00", availability_status_raw: "available", normalized_total_price: 38000 }),
      row({ observed_at: "2026-06-11T10:00:00+09:00", availability_status_raw: "sold_out", normalized_total_price: null })
    ]);
    expect(changes[0]!.change_type).toBe("available_to_sold_out");
    expect(changes[0]!.signal_direction).toBe("positive_demand");
    expect(changes[0]!.signal_strength).toBe("high");
    expect(changes[0]!.last_available_price_before_sold_out).toBe(38000);
    expect(changes[0]!.current_price).toBeNull();
  });

  it("4. detects sold_out_to_available", () => {
    const { changes } = build([
      row({ observed_at: "2026-06-10T10:00:00+09:00", availability_status_raw: "sold_out", normalized_total_price: null }),
      row({ observed_at: "2026-06-11T10:00:00+09:00", availability_status_raw: "available", normalized_total_price: 24000 })
    ]);
    expect(changes[0]!.change_type).toBe("sold_out_to_available");
  });
});

describe("PRICE-HISTORY01 - comparability", () => {
  it("5. meal_basis mismatch is not comparable (unmarked Jalan)", () => {
    const { changes } = build([
      row({ source: "jalan", basis_note: "", observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ source: "jalan", basis_note: "", observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 22000 })
    ]);
    expect(changes[0]!.is_comparable).toBe(false);
    expect(changes[0]!.non_comparable_reason).toMatch(/^meal_basis_excluded/u);
  });

  it("6. room_basis mismatch is not comparable (single room)", () => {
    const single = { basis_note: "", dp_exclusion_reason: "excluded_room_type_single" };
    const { changes } = build([
      row({ ...single, observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 12000 }),
      row({ ...single, observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 13000 })
    ]);
    expect(changes[0]!.is_comparable).toBe(false);
    expect(changes[0]!.non_comparable_reason).toMatch(/^room_basis_mismatch/u);
  });

  it("7. duplicate (same key + observed_at) collapses to one representative", () => {
    const deduped = dedupeObservations([
      row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000, basis_confidence: "C" }),
      row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 21000, basis_confidence: "A" })
    ]);
    expect(deduped.rows).toHaveLength(1);
    expect(deduped.duplicateGroupCount).toBe(1);
    expect(deduped.duplicateRowsRemoved).toBe(1);
    expect(deduped.rows[0]!.row.basis_confidence).toBe("A"); // higher confidence wins
  });
});

describe("PRICE-HISTORY01 - daily aggregation", () => {
  it("8. aggregates per checkin_date", () => {
    const { dailySignals } = build([
      row({ checkin_date: "2026-08-10", observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ checkin_date: "2026-08-10", observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 22000 }),
      row({ checkin_date: "2026-08-15", observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ checkin_date: "2026-08-15", observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 19000 })
    ]);
    expect(dailySignals.map((d) => d.checkin_date)).toEqual(["2026-08-10", "2026-08-15"]);
    expect(dailySignals[0]!.price_up_count).toBe(1);
    expect(dailySignals[1]!.price_down_count).toBe(1);
  });

  it("9. comparable_pair_count < 3 => insufficient_data; >= 3 strong => not insufficient", () => {
    const fewer = build([
      row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 22000 })
    ]);
    expect(fewer.dailySignals[0]!.comparable_pair_count).toBe(1);
    expect(fewer.dailySignals[0]!.market_pressure_level).toBe("insufficient_data");
    expect(fewer.dailySignals[0]!.recommended_pricing_posture).toBe("insufficient_data");

    // 3 distinct competitors, each price_up on the same checkin date => 3 comparable pairs.
    const props = ["zao-kokusai", "zao-shiki-no", "shinzanso-takamiya"];
    const many = build(
      props.flatMap((p) => [
        row({ property_id: p, observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
        row({ property_id: p, observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 23000 })
      ])
    );
    expect(many.dailySignals[0]!.comparable_pair_count).toBe(3);
    expect(many.dailySignals[0]!.market_pressure_level).not.toBe("insufficient_data");
    expect(many.dailySignals[0]!.market_pressure_score).toBeGreaterThan(0);
    expect(many.dailySignals[0]!.recommended_pricing_posture).toBe("raise_or_hold_strong");
  });
});

describe("PRICE-HISTORY01 - validation", () => {
  it("10. validation JSON carries all required keys and a ready decision", () => {
    const { validation } = build([
      row({ observed_at: "2026-06-10T10:00:00+09:00", normalized_total_price: 20000 }),
      row({ observed_at: "2026-06-11T10:00:00+09:00", normalized_total_price: 22000 })
    ]);
    const requiredKeys = [
      "run_at", "input_sources", "total_raw_rows", "normalized_rows", "comparable_rows", "non_comparable_rows",
      "comparison_pair_count", "change_type_counts", "signal_direction_counts", "excluded_meal_basis_count",
      "excluded_room_basis_count", "duplicate_group_count", "duplicate_rows_removed_count", "observed_at_column_used",
      "observed_at_confidence", "min_checkin_date", "max_checkin_date", "min_observed_at", "max_observed_at",
      "daily_signal_rows", "insufficient_data_days", "decision", "warnings"
    ];
    for (const k of requiredKeys) expect(validation).toHaveProperty(k);
    expect(["price_history_ready", "price_history_ready_with_warnings"]).toContain(validation.decision);
    expect(validation.comparison_pair_count).toBe(1);
  });

  it("treats empty input as insufficient_data, never crashes", () => {
    const { validation, changes } = build([]);
    expect(changes).toHaveLength(0);
    expect(validation.decision).toBe("price_history_insufficient_data");
  });
});
