import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UNIFIED_CSV_HEADERS,
  buildCrossSourceDateSummary,
  buildSourceDateSummary,
  decideM01X,
  normalizeBookingToUnified,
  normalizeJalanToUnified,
  normalizeRakutenToUnified,
  reconcileDpFlags,
  renderCrossSourceReport,
  renderUnifiedCsv,
  summarizeDpGateBySource,
  type JalanDpSafeInput,
  type RakutenDayInput,
  type SourceArtifactPaths,
  type UnifiedMarketSignalRow
} from "../src/services/crossSourceMarketSignalNormalization";
import { type NormalizedMarketSignalRow as BookingB04XRow } from "../src/services/bookingMarketSignalNormalization";

const PATHS: SourceArtifactPaths = { reportPath: "/abs/report.md", csvPath: "/abs/report.csv" };

const SERVICE_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/crossSourceMarketSignalNormalization.ts"),
  "utf8"
);
const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/buildCrossSourceMarketSignalReport.ts"),
  "utf8"
);

function makeBooking(overrides: Partial<BookingB04XRow> = {}): BookingB04XRow {
  return {
    runId: "booking_b04x_test",
    normalizedAtJst: "2026-06-01T23:00:00+09:00",
    source: "booking",
    sourcePhase: "B04A",
    collectorStage: "local_normalization_only",
    pricePolicyVersion: "booking_official_visible_adder_v1",
    canonicalPropertyName: "蔵王国際ホテル",
    sourcePropertyName: "蔵王国際ホテル",
    propertyIdentityMatch: true,
    sourcePropertyId: "zao-kokusai",
    sourceSlugOrCode: "zao-kokusai",
    checkin: "2026-08-12",
    checkout: "2026-08-13",
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: "2_adults_1_room_1_night",
    availabilityStatus: "available",
    soldOutStatus: "available",
    normalizedTotalPrice: 60_360,
    normalizedTotalPriceSource: "booking_official_base_plus_visible_tax_fee_adder",
    normalizedTotalPriceConfidence: "B",
    normalizedTotalPriceBasis: "room_total_official_visible_tax_fee_2_adults_1_room_1_night",
    basisConfidence: "B",
    basisNote: "Computed total = base + official adder; no 1.1 multiplier.",
    sourcePrimaryPrice: 60_060,
    sourceOfficialTaxFeeAdder: 300,
    sourceComputedTotalWithTaxFee: 60_360,
    sourceTaxBasisClassification: "booking_room_total_official_base_plus_tax_fee_adder",
    sourceClassification: "booking_b04a_official_base_plus_adder_numeric",
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: true,
    isPriceExcludedFromDp: false,
    dpExclusionReason: null,
    debugArtifactPath: "/tmp/debug/zao-kokusai_2026-08-12",
    sourceReportPath: "/abs/b04x.md",
    sourceCsvPath: "/abs/b04x.csv",
    ...overrides
  };
}

function makeRakuten(overrides: Partial<RakutenDayInput> = {}): RakutenDayInput {
  return {
    runId: "rakuten_test",
    collectedAtJst: "2026-06-01T20:58:30+09:00",
    propertyName: "蔵王国際ホテル",
    hotelNo: "5723",
    dateIso: "2026-08-12",
    isPast: false,
    isFull: false,
    isVacant: true,
    rawPrice: 32_395,
    computed2AdultTotal: 64_790,
    chargeType: "CHARGE_PER_HUMAN",
    sourcePriceBasis: "per_person_tax_included_unconfirmed_total",
    basisConfidence: "B",
    basisNote: "per-person price × 2",
    linkPresent: true,
    classification: "rakuten_day_available_price_link",
    debugArtifactPath: "/tmp/debug/rakuten/5723_20260812",
    ...overrides
  };
}

function makeJalan(overrides: Partial<JalanDpSafeInput> = {}): JalanDpSafeInput {
  return {
    runId: "jalan_dp_safe_test",
    normalizedAtJst: "2026-06-01T23:00:00+09:00",
    stayDate: "2026-08-12",
    confidence: "A",
    rawMedianJpy: 45_100,
    qualityAdjustedMedianJpy: 45_100,
    dpSafeMedianJpy: 45_100,
    useClass: "use_directly",
    availableCount: 7,
    failedCount: 1,
    excludedQualityRowsCount: 0,
    reason: "confidence_a_clean_dp_safe_median",
    warningFlags: "",
    ...overrides
  };
}

describe("Phase M01X — Booking → unified", () => {
  it("(1) maps a numeric Booking B04X row into the unified schema", () => {
    const row = normalizeBookingToUnified(makeBooking(), PATHS);
    expect(row.source).toBe("booking");
    expect(row.sourcePhase).toBe("B04X");
    expect(row.normalizedTotalPrice).toBe(60_360);
    expect(row.normalizedTotalPriceSource).toBe("booking_official_base_plus_visible_tax_fee_adder");
    expect(row.stayScope).toBe("2_adults_1_room_1_night");
    expect(row.sourceReportPath).toBe(PATHS.reportPath);
  });

  it("(2) Booking row already excluded for missing adder stays excluded", () => {
    const row = normalizeBookingToUnified(
      makeBooking({
        normalizedTotalPrice: null,
        normalizedTotalPriceSource: null,
        basisConfidence: "C",
        isPriceUsableForDpDirect: false,
        isPriceUsableForDpDirectional: false,
        isPriceExcludedFromDp: true,
        dpExclusionReason: "official_tax_fee_adder_missing"
      }),
      PATHS
    );
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.isPriceUsableForDpDirectional).toBe(false);
    expect(row.dpExclusionReason).toBe("official_tax_fee_adder_missing");
  });

  it("(3) Booking B-confidence row is directional, never direct", () => {
    const row = normalizeBookingToUnified(makeBooking(), PATHS);
    expect(row.basisConfidence).toBe("B");
    expect(row.isPriceUsableForDpDirect).toBe(false);
    expect(row.isPriceUsableForDpDirectional).toBe(true);
  });

  it("(4) service never reintroduces a synthetic base × 1.1 rule", () => {
    expect(SERVICE_SOURCE).not.toMatch(/tax_multiplier/u);
    expect(SERVICE_SOURCE).not.toMatch(/tax_included_price/u);
    expect(SERVICE_SOURCE).not.toMatch(/tax_normalization_rule/u);
    // No synthetic multiplier in any calculation (× 1.1 appears only in the prohibition text).
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1/u);
  });
});

describe("Phase M01X — Rakuten → unified", () => {
  it("(5) available day uses computed 2-adult total (raw × 2)", () => {
    const row = normalizeRakutenToUnified(makeRakuten(), PATHS);
    expect(row.source).toBe("rakuten");
    expect(row.availabilityStatus).toBe("available");
    expect(row.normalizedTotalPrice).toBe(64_790);
    expect(row.normalizedTotalPriceSource).toBe("rakuten_dayList_price_times_2");
    expect(row.sourcePrimaryPrice).toBe(32_395);
  });

  it("(6) Rakuten priced row is directional B, never direct/A", () => {
    const row = normalizeRakutenToUnified(makeRakuten(), PATHS);
    expect(row.basisConfidence).toBe("B");
    expect(row.isPriceUsableForDpDirect).toBe(false);
    expect(row.isPriceUsableForDpDirectional).toBe(true);
  });

  it("(7) full day is a directional sold-out pressure signal with no price", () => {
    const row = normalizeRakutenToUnified(
      makeRakuten({ classification: "rakuten_day_full", isFull: true, isVacant: false, computed2AdultTotal: null, rawPrice: 0 }),
      PATHS
    );
    expect(row.soldOutStatus).toBe("sold_out");
    expect(row.normalizedTotalPrice).toBeNull();
    expect(row.isPriceUsableForDpDirectional).toBe(true);
    expect(row.isPriceExcludedFromDp).toBe(false);
    expect(row.warningFlags).toBe("sold_out_pressure_signal");
  });

  it("(8) past day is excluded", () => {
    const row = normalizeRakutenToUnified(
      makeRakuten({ classification: "rakuten_day_past", isPast: true, computed2AdultTotal: null }),
      PATHS
    );
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.dpExclusionReason).toBe("past_row");
    expect(row.isPriceUsableForDpDirectional).toBe(false);
  });
});

describe("Phase M01X — Jalan → unified", () => {
  it("(9) use_directly (A) is a direct usable date-level signal", () => {
    const row = normalizeJalanToUnified(makeJalan(), PATHS);
    expect(row.source).toBe("jalan");
    expect(row.normalizedTotalPrice).toBe(45_100);
    expect(row.isPriceUsableForDpDirect).toBe(true);
    expect(row.isPriceUsableForDpDirectional).toBe(true);
    expect(row.isPriceExcludedFromDp).toBe(false);
  });

  it("(10) use_directionally (B) is directional, not direct", () => {
    const row = normalizeJalanToUnified(
      makeJalan({ confidence: "B", useClass: "use_directionally", dpSafeMedianJpy: 13_500, rawMedianJpy: 13_500, qualityAdjustedMedianJpy: 13_500 }),
      PATHS
    );
    expect(row.basisConfidence).toBe("B");
    expect(row.isPriceUsableForDpDirect).toBe(false);
    expect(row.isPriceUsableForDpDirectional).toBe(true);
  });

  it("(11) exclude (insufficient, no median) is excluded", () => {
    const row = normalizeJalanToUnified(
      makeJalan({
        confidence: "insufficient",
        useClass: "exclude",
        rawMedianJpy: null,
        qualityAdjustedMedianJpy: null,
        dpSafeMedianJpy: null,
        reason: "insufficient_sample_not_dp_safe",
        warningFlags: "low_confidence_not_dp_usable"
      }),
      PATHS
    );
    expect(row.normalizedTotalPrice).toBeNull();
    expect(row.isPriceExcludedFromDp).toBe(true);
  });

  it("(12) coupon / price_basis_suspicious warning forces exclusion even with a median", () => {
    const row = normalizeJalanToUnified(
      makeJalan({ useClass: "use_directly", warningFlags: "price_basis_suspicious" }),
      PATHS
    );
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.dpExclusionReason).toBe("coupon_or_price_basis_suspicious");
    expect(row.isPriceUsableForDpDirect).toBe(false);
  });

  it("(13) premium-high-outlier warning is preserved but not excluded when usable", () => {
    const row = normalizeJalanToUnified(
      makeJalan({ warningFlags: "premium_high_market_outlier_present_review_before_mid_tier_dp" }),
      PATHS
    );
    expect(row.warningFlags).toBe("premium_high_market_outlier_present_review_before_mid_tier_dp");
    expect(row.isPriceExcludedFromDp).toBe(false);
    expect(row.isPriceUsableForDpDirect).toBe(true);
  });

  it("(24) aggregate Jalan rows never invent property names", () => {
    const row = normalizeJalanToUnified(makeJalan(), PATHS);
    expect(row.canonicalPropertyName).toBe("market_aggregate");
    expect(row.sourcePropertyName).toBe("market_aggregate");
    expect(row.sourcePropertyId).toBe("");
    expect(row.sourceSlugOrCode).toBe("");
  });
});

describe("Phase M01X — DP gate invariants", () => {
  it("(14) reconcileDpFlags never marks a row both direct and excluded", () => {
    const excluded = reconcileDpFlags({ direct: true, directional: true, excluded: true, reason: "blocked" });
    expect(excluded.isPriceUsableForDpDirect).toBe(false);
    expect(excluded.isPriceExcludedFromDp).toBe(true);

    const direct = reconcileDpFlags({ direct: true, directional: false, excluded: false, reason: null });
    expect(direct.isPriceUsableForDpDirect).toBe(true);
    expect(direct.isPriceUsableForDpDirectional).toBe(true); // direct implies directional
    expect(direct.isPriceExcludedFromDp).toBe(false);
  });

  it("(15) a directional sold-out row with no price is allowed", () => {
    const row = normalizeRakutenToUnified(
      makeRakuten({ classification: "rakuten_day_full", isFull: true, computed2AdultTotal: null, rawPrice: 0 }),
      PATHS
    );
    expect(row.normalizedTotalPrice).toBeNull();
    expect(row.isPriceUsableForDpDirectional).toBe(true);
    expect(row.isPriceExcludedFromDp).toBe(false);
  });
});

describe("Phase M01X — summaries & decision", () => {
  const rows: UnifiedMarketSignalRow[] = [
    normalizeBookingToUnified(makeBooking(), PATHS),
    normalizeRakutenToUnified(makeRakuten(), PATHS),
    normalizeJalanToUnified(makeJalan(), PATHS)
  ];

  it("(16) source/date summary counts rows per (date, source)", () => {
    const summary = buildSourceDateSummary(rows);
    expect(summary).toHaveLength(3);
    for (const s of summary) {
      expect(s.checkin).toBe("2026-08-12");
      expect(s.rowCount).toBe(1);
    }
    const booking = summary.find((s) => s.source === "booking");
    expect(booking?.directionalCount).toBe(1);
  });

  it("(17) cross-source date median uses only numeric directional/direct rows", () => {
    const summary = buildCrossSourceDateSummary(rows);
    expect(summary).toHaveLength(1);
    const day = summary[0]!;
    expect(day.sourcesPresent.sort()).toEqual(["booking", "jalan", "rakuten"]);
    // directional prices: booking 60360, rakuten 64790, jalan 45100 → median 60360
    expect(day.medianPriceAllDirectional).toBe(60_360);
    // direct-only: jalan 45100
    expect(day.medianPriceDirectOnly).toBe(45_100);
    expect(day.notes).toBe("multi_source");
  });

  it("(23) DP gate summary reports direct/directional/excluded per source", () => {
    const gate = summarizeDpGateBySource(rows);
    expect(gate.booking).toEqual({ direct: 0, directional: 1, excluded: 0 });
    expect(gate.rakuten).toEqual({ direct: 0, directional: 1, excluded: 0 });
    expect(gate.jalan).toEqual({ direct: 1, directional: 1, excluded: 0 });
  });

  it("decision is ready with all three sources, caution with two, not_ready below", () => {
    expect(decideM01X(rows)).toBe("cross_source_market_signal_schema_ready");
    expect(decideM01X(rows.slice(0, 2))).toBe("cross_source_market_signal_schema_basis_caution");
    expect(decideM01X(rows.slice(0, 1))).toBe("cross_source_market_signal_schema_not_ready");
  });
});

describe("Phase M01X — CSV & report shape", () => {
  const rows: UnifiedMarketSignalRow[] = [
    normalizeBookingToUnified(makeBooking(), PATHS),
    normalizeRakutenToUnified(makeRakuten(), PATHS),
    normalizeJalanToUnified(makeJalan(), PATHS)
  ];
  const csv = renderUnifiedCsv(rows);
  const header = csv.trim().split("\n")[0] ?? "";

  it("(19) CSV header is exactly the unified schema", () => {
    expect(header).toBe(UNIFIED_CSV_HEADERS.join(","));
    expect(csv.trim().split("\n")).toHaveLength(rows.length + 1);
  });

  it("(20) CSV excludes deprecated tax-rule columns", () => {
    expect(header).not.toMatch(/tax_multiplier/u);
    expect(header).not.toMatch(/tax_included_price/u);
    expect(header).not.toMatch(/tax_normalization_rule/u);
  });

  it("(21) CSV excludes Beds24 / AirHost / PMS / inventory columns", () => {
    for (const forbidden of [/beds24/iu, /airhost/iu, /\bpms\b/iu, /roomid/iu, /inventory/iu, /minstay/iu, /maxstay/iu, /multiplier/iu, /price[1-5]/iu]) {
      expect(header).not.toMatch(forbidden);
    }
  });

  it("(22) report includes source artifact paths and the DB-write prohibition", () => {
    const report = renderCrossSourceReport({
      generatedAt: "2026-06-01T14:00:00.000Z",
      rows,
      decision: decideM01X(rows),
      dpGate: summarizeDpGateBySource(rows),
      sourceDateSummary: buildSourceDateSummary(rows),
      crossSourceDateSummary: buildCrossSourceDateSummary(rows),
      artifacts: {
        booking: { reportPath: "/b.md", csvPath: "/b.csv", jsonPath: "/b.json" },
        rakuten: { reportPath: "/r.md", csvPath: "/r.csv", jsonPath: "/r.json" },
        jalan: { reportPath: "/j.md", csvPath: "/j.csv" }
      },
      reportPath: "/out.md",
      csvPath: "/out.csv",
      jsonPath: "/out.json",
      debugRootPath: "/debug"
    });
    expect(report).toMatch(/booking_json=\/b\.json/u);
    expect(report).toMatch(/rakuten_csv=\/r\.csv/u);
    expect(report).toMatch(/jalan_report=\/j\.md/u);
    expect(report).toMatch(/NO DB writes/u);
    expect(report).toMatch(/no synthetic base × 1\.1/u);
  });

  it("(18) report builder stops with a clear error on missing artifacts and never re-runs collectors", () => {
    expect(SCRIPT_SOURCE).toMatch(/Stop and report the missing artifact path/u);
    expect(SCRIPT_SOURCE).toMatch(/Do not re-run collectors/u);
    expect(SCRIPT_SOURCE).not.toMatch(/runRakutenPrototype|runJalan|probeBooking/u);
  });
});
