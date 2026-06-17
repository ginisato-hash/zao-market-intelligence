import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOKING_MARKET_SIGNAL_CSV_HEADERS,
  CANONICAL_NAME_BY_SLUG,
  decideB04X,
  normalizeBookingMarketSignalRow,
  renderBookingMarketSignalCsv,
  renderBookingMarketSignalReport,
  summarizeDpGate,
  type NormalizedMarketSignalRow
} from "../src/services/bookingMarketSignalNormalization";
import { type B04ARow } from "../src/services/bookingOfficialTaxFeeTotalHardening";

const SERVICE_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/bookingMarketSignalNormalization.ts"),
  "utf8"
);

const CONTEXT = {
  normalizedAtJst: "2026-06-01T23:00:00+09:00",
  sourceReportPath: "/abs/report.md",
  sourceCsvPath: "/abs/report.csv"
};

function makeB04ARow(overrides: Partial<B04ARow> = {}): B04ARow {
  return {
    runId: "booking_b04a_test",
    collectedAtJst: "2026-06-01T22:43:31+09:00",
    source: "booking",
    collectorStage: "prototype_read_only_b04a",
    pricePolicyVersion: "booking_official_visible_adder_v1",
    propertyNameExpected: "蔵王国際ホテル",
    propertyNameDetected: "蔵王国際ホテル",
    propertyIdentityMatch: true,
    bookingSlug: "zao-kokusai",
    checkin: "2026-08-12",
    checkout: "2026-08-13",
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    selectedCurrency: "JPY",
    lang: "ja",
    urlSanitized: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html",
    finalUrlSanitized: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html",
    pageTitle: "Zao Kokusai Hotel",
    rateCardPresent: true,
    hprtTablePresent: true,
    availabilityAlertPresent: false,
    soldOutTextPresent: false,
    primaryRoomName: "スタンダードツインルーム",
    primaryRateName: "食事なし",
    primaryRoomCardText: "スタンダードツインルーム ツインベッド 人数: 2 食事なし ￥60,060",
    primaryOccupancyHint: "人数: 2",
    primaryBedHint: "ツインベッド",
    primaryPriceRaw: "￥60,060",
    primaryPriceNumeric: 60_060,
    officialTaxFeeTextRaw: "＋税・手数料（￥300）",
    officialTaxFeeAdderNumeric: 300,
    officialTaxFeeAdderExtractionStatus: "numeric_extracted",
    computedTotalWithTaxFee: 60_360,
    taxBasisClassification: "booking_room_total_official_base_plus_tax_fee_adder",
    basisConfidence: "B",
    basisNote: "Computed total = base + official adder; no 1.1 multiplier.",
    isRoomTotalCandidate: true,
    is2AdultScopeConfirmed: true,
    is1RoomScopeConfirmed: true,
    is1NightScopeConfirmed: true,
    currencyDetected: true,
    languageDetected: true,
    blockingOrModalState: "none",
    classification: "booking_b04a_official_base_plus_adder_numeric",
    debugArtifactPath: "/tmp/debug/zao-kokusai_2026-08-12",
    ...overrides
  };
}

function normalize(overrides: Partial<B04ARow> = {}): NormalizedMarketSignalRow {
  return normalizeBookingMarketSignalRow(makeB04ARow(overrides), CONTEXT);
}

describe("Phase B04X — row normalization", () => {
  it("(1) maps a B04A row with a numeric official total to a normalized row", () => {
    const row = normalize();
    expect(row.normalizedTotalPrice).toBe(60_360);
    expect(row.normalizedTotalPriceSource).toBe("booking_official_base_plus_visible_tax_fee_adder");
    expect(row.normalizedTotalPriceBasis).toBe("room_total_official_visible_tax_fee_2_adults_1_room_1_night");
    expect(row.source).toBe("booking");
    expect(row.collectorStage).toBe("local_normalization_only");
    expect(row.stayScope).toBe("2_adults_1_room_1_night");
  });

  it("(2) maps a B04A row with a missing official adder to an excluded normalized row", () => {
    const row = normalize({
      officialTaxFeeAdderNumeric: null,
      computedTotalWithTaxFee: null,
      basisConfidence: "C",
      taxBasisClassification: "booking_room_total_tax_fee_basis_unclear",
      classification: "booking_b04a_price_basis_unclear",
      primaryPriceNumeric: 88_000
    });
    expect(row.normalizedTotalPrice).toBeNull();
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.dpExclusionReason).toBe("official_tax_fee_adder_missing");
  });

  it("(3) preserves price_policy_version = booking_official_visible_adder_v1", () => {
    expect(normalize().pricePolicyVersion).toBe("booking_official_visible_adder_v1");
  });

  it("(4) contains no base × 1.1 computation in the normalization service", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1\b/);
    expect(SERVICE_SOURCE).not.toMatch(/1\.1\s*\*/);
    expect(SERVICE_SOURCE).not.toMatch(/BOOKING_TAX_MULTIPLIER/);
  });

  it("(5) sets normalized_total_price from source computed_total_with_tax_fee", () => {
    const row = normalize({ computedTotalWithTaxFee: 75_937, primaryPriceNumeric: 62_756, officialTaxFeeAdderNumeric: 13_181 });
    expect(row.normalizedTotalPrice).toBe(75_937);
    expect(row.sourceComputedTotalWithTaxFee).toBe(75_937);
  });

  it("(6) sets normalized_total_price = null when the official total is null", () => {
    const row = normalize({ computedTotalWithTaxFee: null, officialTaxFeeAdderNumeric: null });
    expect(row.normalizedTotalPrice).toBeNull();
    expect(row.normalizedTotalPriceSource).toBeNull();
  });
});

describe("Phase B04X — availability mapping", () => {
  it("(7) maps an available row", () => {
    const row = normalize();
    expect(row.availabilityStatus).toBe("available");
    expect(row.soldOutStatus).toBe("available");
  });

  it("(8) maps a sold_out row", () => {
    const row = normalize({
      classification: "booking_b04a_sold_out",
      primaryPriceNumeric: null,
      computedTotalWithTaxFee: null,
      soldOutTextPresent: true
    });
    expect(row.availabilityStatus).toBe("sold_out");
    expect(row.soldOutStatus).toBe("sold_out");
  });

  it("(9) maps a blocked row", () => {
    const row = normalize({
      classification: "booking_b04a_blocked",
      blockingOrModalState: "consent_modal",
      primaryPriceNumeric: null,
      computedTotalWithTaxFee: null
    });
    expect(row.availabilityStatus).toBe("blocked");
    expect(row.soldOutStatus).toBe("unknown");
  });
});

describe("Phase B04X — DP usage gate", () => {
  it("(10) direct usability is false for a B-confidence row", () => {
    const row = normalize();
    expect(row.basisConfidence).toBe("B");
    expect(row.isPriceUsableForDpDirect).toBe(false);
  });

  it("(11) directional usability is true for a B-confidence numeric-total row", () => {
    const row = normalize();
    expect(row.isPriceUsableForDpDirectional).toBe(true);
    expect(row.isPriceExcludedFromDp).toBe(false);
  });

  it("(11b) direct usability is true only for an A-confidence numeric-total row", () => {
    const row = normalize({ basisConfidence: "A" });
    expect(row.normalizedTotalPriceConfidence).toBe("A");
    expect(row.isPriceUsableForDpDirect).toBe(true);
    expect(row.isPriceUsableForDpDirectional).toBe(true);
  });

  it("(12) excluded is true for a C-confidence / null-total row", () => {
    const row = normalize({
      computedTotalWithTaxFee: null,
      officialTaxFeeAdderNumeric: null,
      basisConfidence: "C",
      primaryPriceNumeric: 88_000,
      classification: "booking_b04a_price_basis_unclear"
    });
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.isPriceUsableForDpDirectional).toBe(false);
    expect(row.isPriceUsableForDpDirect).toBe(false);
  });
});

describe("Phase B04X — room-basis (two-person standard room) gate", () => {
  it("(R1) twin/double + strong A price stays DP usable", () => {
    const row = normalize({ basisConfidence: "A", primaryRoomName: "禁煙ダブルルーム" });
    expect(row.isPriceUsableForDpDirect).toBe(true);
    expect(row.isPriceExcludedFromDp).toBe(false);
    expect(row.basisNote).toContain("room_basis=confirmed_two_person_standard_room");
    expect(row.sourceClassification).toContain("booking_assumed_room_only_two_person_standard");
  });

  it("(R1b) room-card context can confirm two-person standard even when room_name is empty", () => {
    const row = normalize({
      basisConfidence: "A",
      primaryRoomName: "",
      primaryRateName: "",
      primaryRoomCardText: "Standard Queen Room 1 queen bed Sleeps 2 ￥60,060",
      primaryOccupancyHint: "Sleeps 2",
      primaryBedHint: "1 queen"
    });
    expect(row.isPriceUsableForDpDirect).toBe(true);
    expect(row.isPriceExcludedFromDp).toBe(false);
    expect(row.basisNote).toContain("room_basis=confirmed_two_person_standard_room");
  });

  it("(R2) unknown room is excluded from DP", () => {
    const row = normalize({
      primaryRoomName: "おまかせ",
      primaryRateName: "",
      primaryRoomCardText: "おまかせ 人数: 2 ￥60,060",
      primaryOccupancyHint: "人数: 2",
      primaryBedHint: ""
    });
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.isPriceUsableForDpDirect).toBe(false);
    expect(row.isPriceUsableForDpDirectional).toBe(false);
    expect(row.dpExclusionReason).toBe("unknown_room_basis_excluded");
    expect(row.sourceClassification).toBe("booking_room_type_excluded");
  });

  it("(R3) single room is excluded from DP", () => {
    const row = normalize({ basisConfidence: "A", primaryRoomName: "シングルルーム" });
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.dpExclusionReason).toBe("excluded_room_type_single");
  });

  it("(R4) semi-double room is excluded from DP", () => {
    const row = normalize({ basisConfidence: "A", primaryRoomName: "セミダブル" });
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.dpExclusionReason).toBe("excluded_room_type_semi_double");
  });

  it("(R5) triple room is excluded from DP", () => {
    const row = normalize({ basisConfidence: "A", primaryRoomName: "トリプルルーム" });
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.dpExclusionReason).toBe("excluded_room_type_large");
  });

  it("(R6) family/suite room is excluded from DP", () => {
    const row = normalize({ basisConfidence: "A", primaryRoomName: "スイートルーム" });
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.dpExclusionReason).toBe("excluded_room_type_family_or_suite");
  });

  it("(R6b) suite in room-card context wins over otherwise usable price", () => {
    const row = normalize({
      basisConfidence: "A",
      primaryRoomName: "",
      primaryRoomCardText: "Family Suite 2 beds Sleeps 2 ￥60,060",
      primaryOccupancyHint: "Sleeps 2",
      primaryBedHint: "2 beds"
    });
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.dpExclusionReason).toBe("excluded_room_type_family_or_suite");
    expect(row.sourceClassification).toBe("booking_room_type_excluded");
  });

  it("(R7) room gate does not override a non-priced sold_out row", () => {
    const row = normalize({
      classification: "booking_b04a_sold_out",
      primaryPriceNumeric: null,
      computedTotalWithTaxFee: null,
      soldOutTextPresent: true,
      primaryRoomName: "シングルルーム"
    });
    expect(row.availabilityStatus).toBe("sold_out");
    expect(row.sourceClassification).toBe("booking_b04a_sold_out");
    expect(row.dpExclusionReason).not.toBe("excluded_room_type_single");
  });
});

describe("Phase B04X — canonical mapping & identity", () => {
  it("(13) maps the three Booking slugs to canonical names", () => {
    expect(CANONICAL_NAME_BY_SLUG["zao-kokusai"]).toBe("蔵王国際ホテル");
    expect(CANONICAL_NAME_BY_SLUG["zao-shiki-no"]).toBe("蔵王四季のホテル");
    expect(CANONICAL_NAME_BY_SLUG["shinzanso-takamiya"]).toBe("深山荘 高見屋");
    expect(normalize({ bookingSlug: "shinzanso-takamiya" }).canonicalPropertyName).toBe("深山荘 高見屋");
  });

  it("(14) identity mismatch excludes the row", () => {
    const row = normalize({ propertyIdentityMatch: false });
    expect(row.propertyIdentityMatch).toBe(false);
    expect(row.isPriceExcludedFromDp).toBe(true);
    expect(row.dpExclusionReason).toBe("property_identity_mismatch");
    expect(row.isPriceUsableForDpDirectional).toBe(false);
  });
});

describe("Phase B04X — output schema", () => {
  it("(15) CSV renderer includes the normalized schema headers", () => {
    const columns = BOOKING_MARKET_SIGNAL_CSV_HEADERS as readonly string[];
    for (const required of [
      "normalized_total_price",
      "normalized_total_price_source",
      "normalized_total_price_confidence",
      "normalized_total_price_basis",
      "is_price_usable_for_dp_direct",
      "is_price_usable_for_dp_directional",
      "is_price_excluded_from_dp",
      "dp_exclusion_reason",
      "price_policy_version"
    ]) {
      expect(columns).toContain(required);
    }
  });

  it("(16) CSV renderer excludes deprecated B03X fields", () => {
    const columns = BOOKING_MARKET_SIGNAL_CSV_HEADERS as readonly string[];
    expect(columns).not.toContain("tax_multiplier");
    expect(columns).not.toContain("tax_included_price");
    expect(columns).not.toContain("tax_normalization_rule");
    expect(columns).not.toContain("multiplier");
  });

  it("(17) CSV renderer excludes Beds24/AirHost/PMS fields", () => {
    const columns = BOOKING_MARKET_SIGNAL_CSV_HEADERS as readonly string[];
    for (const forbidden of [
      "roomid",
      "inventory",
      "minstay",
      "maxstay",
      "multiplier",
      "price1",
      "price2",
      "price3",
      "price4",
      "price5"
    ]) {
      expect(columns).not.toContain(forbidden);
    }
    const headerLower = BOOKING_MARKET_SIGNAL_CSV_HEADERS.join(",").toLowerCase();
    expect(headerLower).not.toContain("beds24");
    expect(headerLower).not.toContain("airhost");
    expect(headerLower).not.toContain("pms");
  });

  it("renders a CSV whose data row aligns with the headers", () => {
    const csv = renderBookingMarketSignalCsv([normalize()]);
    const lines = csv.trim().split("\n");
    const headerLine = lines[0];
    const dataLine = lines[1] ?? "";
    expect(headerLine).toBe(BOOKING_MARKET_SIGNAL_CSV_HEADERS.join(","));
    expect(dataLine.split(",").length).toBeGreaterThanOrEqual(BOOKING_MARKET_SIGNAL_CSV_HEADERS.length);
  });
});

describe("Phase B04X — report, summary, decision", () => {
  function sixRows(): NormalizedMarketSignalRow[] {
    return [
      normalize({ bookingSlug: "zao-kokusai", checkin: "2026-08-12", computedTotalWithTaxFee: 60_360 }),
      normalize({ bookingSlug: "zao-kokusai", checkin: "2026-10-10", computedTotalWithTaxFee: 69_600, primaryPriceNumeric: 69_300, officialTaxFeeAdderNumeric: 300 }),
      normalize({ bookingSlug: "zao-shiki-no", checkin: "2026-08-12", computedTotalWithTaxFee: 63_660, primaryPriceNumeric: 63_360, officialTaxFeeAdderNumeric: 300 }),
      normalize({
        bookingSlug: "zao-shiki-no",
        checkin: "2026-10-10",
        computedTotalWithTaxFee: null,
        officialTaxFeeAdderNumeric: null,
        basisConfidence: "C",
        primaryPriceNumeric: 88_000,
        classification: "booking_b04a_price_basis_unclear",
        taxBasisClassification: "booking_room_total_tax_fee_basis_unclear"
      }),
      normalize({ bookingSlug: "shinzanso-takamiya", checkin: "2026-08-12", computedTotalWithTaxFee: 83_069, primaryPriceNumeric: 68_651, officialTaxFeeAdderNumeric: 14_418 }),
      normalize({ bookingSlug: "shinzanso-takamiya", checkin: "2026-10-10", computedTotalWithTaxFee: 75_937, primaryPriceNumeric: 62_756, officialTaxFeeAdderNumeric: 13_181 })
    ];
  }

  it("(18) report includes source artifacts and DP gate summary", () => {
    const rows = sixRows();
    const dpGate = summarizeDpGate(rows);
    const report = renderBookingMarketSignalReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      rows,
      decision: decideB04X(rows),
      dpGate,
      reportPath: "/tmp/r.md",
      csvPath: "/tmp/r.csv",
      jsonPath: "/tmp/r.json",
      debugRootPath: "/tmp/debug",
      sourceReportPath: "/abs/source.md",
      sourceCsvPath: "/abs/source.csv",
      sourceJsonPath: "/abs/source.json"
    });
    expect(report).toContain("/abs/source.md");
    expect(report).toContain("/abs/source.csv");
    expect(report).toContain("/abs/source.json");
    expect(report).toContain("DP usage gate");
    expect(report).toContain("directional_usable=");
  });

  it("(19) DP gate summary includes direct/directional/excluded counts", () => {
    const rows = sixRows();
    const dpGate = summarizeDpGate(rows);
    expect(dpGate.direct).toBe(0);
    expect(dpGate.directional).toBe(5);
    expect(dpGate.excluded).toBe(1);
    expect(decideB04X(rows)).toBe("booking_market_signal_normalization_ready");
  });

  it("(20) normalization handles a missing optional debug path safely", () => {
    const row = normalize({ debugArtifactPath: "" });
    expect(row.debugArtifactPath).toBe("");
    expect(() => renderBookingMarketSignalCsv([row])).not.toThrow();
  });
});
