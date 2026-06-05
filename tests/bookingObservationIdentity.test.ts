import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMarketIdentityKey,
  buildMarketIdentityPlainKey,
  buildMarketValueHash,
  buildObservationHash,
  buildObservationId,
  buildObservationIdResult,
  classifyObservationConflict,
  decideObservationIdentity,
  reclassifyB10YConflict,
  summarizeReclassification,
  type B10YConflictRow,
  type BookingLikeHistoryRow,
  type ConflictPolicySummary
} from "../src/services/bookingObservationIdentity";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/bookingObservationIdentity.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildBookingObservationIdentityReport.ts"), "utf8");
const B10Y_ARTIFACT = resolve(__dirname, "../.data/reports/automation/booking_conflict_resolution_proposal_20260604_163851.json");

function baseRow(overrides: Partial<BookingLikeHistoryRow> = {}): BookingLikeHistoryRow {
  return {
    row_id: "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-14|2026-06-15|2_adults_1_room_1_night",
    row_hash: "hash_existing",
    source: "booking",
    canonical_property_name: "蔵王国際ホテル",
    source_slug_or_code: "zao-kokusai",
    source_property_id: "",
    checkin: "2026-06-14",
    checkout: "2026-06-15",
    stay_scope: "2_adults_1_room_1_night",
    group_adults: "2",
    no_rooms: "1",
    group_children: "0",
    currency: "JPY",
    language: "ja",
    collected_date_jst: "2026-06-04",
    collected_at_jst: "2026-06-04T14:24:35+09:00",
    normalized_at_jst: "2026-06-04T14:24:35+09:00",
    collected_run_id: "",
    generated_at_jst: "2026-06-04T14:30:00+09:00",
    run_id: "report_run_1",
    source_phase: "B05X",
    collector_stage: "prototype_read_only_b05x_broader_normalized",
    availability_status: "available",
    sold_out_status: "not_sold_out",
    normalized_total_price: "32157",
    normalized_total_price_source: "booking_official",
    normalized_total_price_basis: "official_base_plus_visible_adder",
    normalized_total_price_confidence: "B",
    basis_confidence: "B",
    basis_note: "",
    source_primary_price: "26573",
    source_secondary_price_or_adder: "5584",
    source_computed_total: "32157",
    source_tax_or_fee_classification: "booking_room_total_official_base_plus_tax_fee_adder",
    source_classification: "booking_b04a_official_base_plus_adder_numeric",
    is_price_usable_for_dp_direct: "false",
    is_price_usable_for_dp_directional: "true",
    is_price_excluded_from_dp: "false",
    dp_exclusion_reason: "",
    warning_flags: "",
    schema_version: "zao_local_history_v1",
    source_report_path: "/repo/.data/reports/x.json",
    source_csv_path: "/repo/.data/reports/x.csv",
    debug_artifact_path: "/repo/.data/debug/a",
    ...overrides
  };
}

function loadB10YConflicts(): B10YConflictRow[] {
  const json = JSON.parse(readFileSync(B10Y_ARTIFACT, "utf8")) as { conflict_comparison_rows: B10YConflictRow[] };
  return json.conflict_comparison_rows;
}

describe("market_identity_key", () => {
  it("1. is deterministic", () => {
    expect(buildMarketIdentityKey(baseRow())).toBe(buildMarketIdentityKey(baseRow()));
  });
  it("2. includes source", () => {
    expect(buildMarketIdentityKey(baseRow())).not.toBe(buildMarketIdentityKey(baseRow({ source: "rakuten" })));
  });
  it("3. includes canonical_property_name", () => {
    expect(buildMarketIdentityKey(baseRow())).not.toBe(buildMarketIdentityKey(baseRow({ canonical_property_name: "別ホテル" })));
  });
  it("4. includes source_slug_or_code", () => {
    expect(buildMarketIdentityKey(baseRow())).not.toBe(buildMarketIdentityKey(baseRow({ source_slug_or_code: "other-slug" })));
  });
  it("5. includes checkin/checkout/stay_scope", () => {
    expect(buildMarketIdentityKey(baseRow())).not.toBe(buildMarketIdentityKey(baseRow({ checkin: "2026-06-20" })));
    expect(buildMarketIdentityKey(baseRow())).not.toBe(buildMarketIdentityKey(baseRow({ checkout: "2026-06-21" })));
    expect(buildMarketIdentityKey(baseRow())).not.toBe(buildMarketIdentityKey(baseRow({ stay_scope: "2_adults_2_rooms_1_night" })));
  });
  it("6. excludes collected_at_jst", () => {
    expect(buildMarketIdentityKey(baseRow())).toBe(buildMarketIdentityKey(baseRow({ collected_at_jst: "2099-01-01T00:00:00+09:00" })));
  });
  it("7. excludes debug/report paths", () => {
    expect(buildMarketIdentityKey(baseRow())).toBe(
      buildMarketIdentityKey(baseRow({ debug_artifact_path: "/x", source_report_path: "/y", source_csv_path: "/z" }))
    );
  });
  it("8. excludes source_phase and collector_stage", () => {
    expect(buildMarketIdentityKey(baseRow())).toBe(buildMarketIdentityKey(baseRow({ source_phase: "B09X", collector_stage: "other" })));
  });
  it("plain key has the documented format", () => {
    expect(buildMarketIdentityPlainKey(baseRow())).toBe("booking|zao-kokusai|2026-06-14|2026-06-15|2_adults_1_room_1_night|2|1|0|JPY|ja");
  });
});

describe("observation_id", () => {
  it("9. is deterministic", () => {
    expect(buildObservationId(baseRow())).toBe(buildObservationId(baseRow()));
  });
  it("10. includes market_identity_key (changing identity changes id)", () => {
    expect(buildObservationId(baseRow())).not.toBe(buildObservationId(baseRow({ checkin: "2026-07-01" })));
  });
  it("11. prefers collected_run_id when available", () => {
    const a = baseRow({ collected_run_id: "run_A", collected_at_jst: "2026-06-04T10:00:00+09:00" });
    const b = baseRow({ collected_run_id: "run_A", collected_at_jst: "2099-12-31T23:59:59+09:00" });
    const c = baseRow({ collected_run_id: "run_B", collected_at_jst: "2026-06-04T10:00:00+09:00" });
    expect(buildObservationId(a)).toBe(buildObservationId(b)); // collected_at ignored when run_id present
    expect(buildObservationId(a)).not.toBe(buildObservationId(c));
    expect(buildObservationIdResult(a).identity_basis).toBe("collected_run_id");
  });
  it("12. falls back to collected_at_jst when collected_run_id is absent", () => {
    const a = baseRow({ collected_run_id: "", collected_at_jst: "2026-06-04T10:00:00+09:00" });
    const b = baseRow({ collected_run_id: "", collected_at_jst: "2026-06-05T10:00:00+09:00" });
    expect(buildObservationId(a)).not.toBe(buildObservationId(b));
    expect(buildObservationIdResult(a).identity_basis).toBe("collected_at_jst");
  });
  it("13. does not use Date.now or generated_at_jst", () => {
    // changing generated_at_jst / run_id must not change the id; repeated calls match
    expect(buildObservationId(baseRow())).toBe(buildObservationId(baseRow({ generated_at_jst: "2099-01-01T00:00:00+09:00", run_id: "other" })));
    expect(SERVICE_SOURCE).not.toMatch(/Date\.now\(\)/u);
    const degraded = buildObservationIdResult(baseRow({ collected_run_id: "", collected_at_jst: "" }));
    expect(degraded.degraded).toBe(true);
    expect(degraded.identity_basis).toBe("degraded");
  });
});

describe("market_value_hash", () => {
  it("14. is deterministic", () => {
    expect(buildMarketValueHash(baseRow())).toBe(buildMarketValueHash(baseRow()));
  });
  it("15. changes when normalized_total_price changes", () => {
    expect(buildMarketValueHash(baseRow())).not.toBe(buildMarketValueHash(baseRow({ normalized_total_price: "33300" })));
  });
  it("16. changes when basis_confidence changes", () => {
    expect(buildMarketValueHash(baseRow())).not.toBe(buildMarketValueHash(baseRow({ basis_confidence: "A" })));
  });
  it("17. changes when availability_status changes", () => {
    expect(buildMarketValueHash(baseRow())).not.toBe(buildMarketValueHash(baseRow({ availability_status: "sold_out" })));
  });
  it("18. excludes debug/report paths", () => {
    expect(buildMarketValueHash(baseRow())).toBe(
      buildMarketValueHash(baseRow({ debug_artifact_path: "/x", source_report_path: "/y", source_csv_path: "/z" }))
    );
  });
  it("19. excludes source_phase and collector_stage", () => {
    expect(buildMarketValueHash(baseRow())).toBe(buildMarketValueHash(baseRow({ source_phase: "B09X", collector_stage: "other" })));
  });
  it("20. excludes collected_at_jst and normalized_at_jst", () => {
    expect(buildMarketValueHash(baseRow())).toBe(
      buildMarketValueHash(baseRow({ collected_at_jst: "2099-01-01T00:00:00+09:00", normalized_at_jst: "2099-01-01T00:00:00+09:00" }))
    );
  });
});

describe("observation_hash", () => {
  it("21. is deterministic", () => {
    expect(buildObservationHash(baseRow())).toBe(buildObservationHash(baseRow()));
  });
  it("22. excludes debug/report paths", () => {
    expect(buildObservationHash(baseRow())).toBe(
      buildObservationHash(baseRow({ debug_artifact_path: "/x", source_report_path: "/y", source_csv_path: "/z" }))
    );
  });
});

describe("conflict classifier", () => {
  it("23. exact duplicate observation -> skip_identical", () => {
    const r = classifyObservationConflict(baseRow(), baseRow());
    expect(r.classification).toBe("exact_duplicate_observation");
    expect(r.recommended_action).toBe("skip_identical");
  });
  it("24. same observation_id different hash -> block_true_conflict", () => {
    // same timing/phase/stage/run_id => same observation_id; price differs => different observation_hash
    const existing = baseRow({ row_id: "", collected_run_id: "run_X" });
    const incoming = baseRow({ row_id: "", collected_run_id: "run_X", normalized_total_price: "40000", source_computed_total: "40000" });
    const r = classifyObservationConflict(existing, incoming);
    expect(r.same_observation_id).toBe(true);
    expect(r.classification).toBe("true_observation_id_conflict");
    expect(r.recommended_action).toBe("block_true_conflict");
  });
  it("25. same market identity, different observation, same value -> append_new_observation (different day) / skip_benign (same day)", () => {
    const existing = baseRow({ row_id: "" });
    const newDay = baseRow({ row_id: "", collected_date_jst: "2026-06-05", collected_at_jst: "2026-06-05T10:00:00+09:00" });
    const sameDay = baseRow({ row_id: "", collected_at_jst: "2026-06-04T18:00:00+09:00", source_phase: "B09X" });
    expect(classifyObservationConflict(existing, newDay).recommended_action).toBe("append_new_observation");
    expect(classifyObservationConflict(existing, sameDay).recommended_action).toBe("skip_benign_duplicate");
  });
  it("26. price changed -> append_new_observation_price_changed", () => {
    const existing = baseRow({ row_id: "" });
    const incoming = baseRow({
      row_id: "",
      collected_at_jst: "2026-06-05T10:00:00+09:00",
      normalized_total_price: "33300",
      source_primary_price: "33000",
      source_secondary_price_or_adder: "300",
      source_computed_total: "33300"
    });
    const r = classifyObservationConflict(existing, incoming);
    expect(r.classification).toBe("new_observation_price_changed");
    expect(r.recommended_action).toBe("append_new_observation_price_changed");
  });
  it("27. basis changed -> append_new_observation_basis_changed", () => {
    const existing = baseRow({ row_id: "" });
    const incoming = baseRow({ row_id: "", collected_at_jst: "2026-06-05T10:00:00+09:00", basis_confidence: "A" });
    const r = classifyObservationConflict(existing, incoming);
    expect(r.classification).toBe("new_observation_basis_changed");
    expect(r.recommended_action).toBe("append_new_observation_basis_changed");
  });
  it("28. availability changed -> append_new_observation_availability_changed", () => {
    const existing = baseRow({ row_id: "" });
    const incoming = baseRow({ row_id: "", collected_at_jst: "2026-06-05T10:00:00+09:00", availability_status: "sold_out", sold_out_status: "sold_out" });
    const r = classifyObservationConflict(existing, incoming);
    expect(r.classification).toBe("new_observation_availability_changed");
    expect(r.recommended_action).toBe("append_new_observation_availability_changed");
  });
  it("29. legacy row_id conflict metadata-only -> skip_benign_duplicate", () => {
    const existing = baseRow();
    const incoming = baseRow({ row_hash: "hash_new", source_phase: "B09X", collector_stage: "bounded_expanded_normalized_collection", collected_at_jst: "2026-06-04T16:16:23+09:00", debug_artifact_path: "/repo/.data/debug/b" });
    const r = classifyObservationConflict(existing, incoming);
    expect(r.classification).toBe("legacy_row_id_conflict_metadata_only");
    expect(r.recommended_action).toBe("skip_benign_duplicate");
  });
  it("30. legacy row_id conflict market-changed -> append_new_observation_after_identity_fix", () => {
    const existing = baseRow();
    const incoming = baseRow({ row_hash: "hash_new", source_phase: "B09X", normalized_total_price: "33300", source_computed_total: "33300" });
    const r = classifyObservationConflict(existing, incoming);
    expect(r.classification).toBe("legacy_row_id_conflict_market_changed");
    expect(r.recommended_action).toBe("append_new_observation_after_identity_fix");
  });
});

describe("B10Y reclassification", () => {
  const reclassified = loadB10YConflicts().map((c) => reclassifyB10YConflict(c));
  const summary: ConflictPolicySummary = summarizeReclassification(reclassified);

  it("31. has 15 rows", () => {
    expect(reclassified.length).toBe(15);
  });
  it("32. keeps 5 metadata-only as skip_benign_duplicate", () => {
    expect(summary.skip_benign_duplicate_count).toBe(5);
    expect(summary.metadata_only_conflicts).toBe(5);
  });
  it("33. marks 10 market-value rows as new observations after identity fix", () => {
    expect(summary.append_after_identity_fix_count).toBe(10);
    expect(summary.market_value_conflicts).toBe(10);
  });
  it("matches B10Y price/basis split and never blocks", () => {
    expect(summary.price_changed_conflicts).toBe(9);
    expect(summary.basis_changed_conflicts).toBe(1);
    expect(summary.availability_changed_conflicts).toBe(0);
    expect(summary.block_true_conflict_count).toBe(0);
    expect(summary.manual_review_count).toBe(0);
    expect(summary.b10z_can_proceed).toBe(true);
  });
});

describe("safety scans", () => {
  it("34. does not write history", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/history/u);
    }
  });
  it("35. does not write DB", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/better-sqlite3|openLocalDatabase|INSERT\s+INTO|\.prepare\(/iu);
    }
  });
  it("36. does not run migration", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/ALTER\s+TABLE|CREATE\s+TABLE|runMigration|migrate\(/iu);
    }
  });
  it("37. does not fetch Booking / no Playwright", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/fetch\(|Playwright|chromium|page\.goto/u);
    }
  });
  it("38. no PMS/Beds24/AirHost output", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/Beds24|AirHost|PMS upload|OTA upload/u);
    }
  });
  it("39. no base × 1.1", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\*\s*1\.1\b/u);
    }
  });
});

describe("decision", () => {
  const goodSummary = summarizeReclassification(loadB10YConflicts().map((c) => reclassifyB10YConflict(c)));
  it("40. ready / basis_caution / not_ready", () => {
    expect(
      decideObservationIdentity({ b10y_loaded: true, summary: goodSummary, any_observation_id_degraded: false, safety_all_clean: true })
    ).toBe("booking_observation_identity_ready");
    expect(
      decideObservationIdentity({ b10y_loaded: true, summary: goodSummary, any_observation_id_degraded: true, safety_all_clean: true })
    ).toBe("booking_observation_identity_basis_caution");
    expect(
      decideObservationIdentity({ b10y_loaded: false, summary: goodSummary, any_observation_id_degraded: false, safety_all_clean: true })
    ).toBe("booking_observation_identity_not_ready");
    const badSummary: ConflictPolicySummary = { ...goodSummary, skip_benign_duplicate_count: 4 };
    expect(
      decideObservationIdentity({ b10y_loaded: true, summary: badSummary, any_observation_id_degraded: false, safety_all_clean: true })
    ).toBe("booking_observation_identity_not_ready");
  });
});
