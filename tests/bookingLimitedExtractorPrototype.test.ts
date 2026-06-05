import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBookingRateCardRow,
  summarizeSelectorPresence,
  type BookingRateCardRow,
  type SelectorPresence
} from "../src/services/bookingRateCardExtractionProbe";
import {
  BOOKING_LIMITED_CSV_HEADERS,
  classifyBookingLimitedRow,
  decideBookingLimited,
  extractFeeAdderNumeric,
  mapRateCardRowToLimitedRow,
  normalizeBookingTaxFee,
  renderBookingLimitedCsv,
  renderBookingLimitedReport,
  type BookingLimitedRow
} from "../src/services/bookingLimitedExtractorPrototype";

const presence: SelectorPresence = summarizeSelectorPresence({
  propertyHeadlineName: 1,
  hprtTableId: 1,
  priceAndDiscountedPrice: 3,
  priceChargesAndTaxes: 3
});

const target = { canonicalPropertyName: "蔵王国際ホテル", slug: "zao-kokusai" };

function text(overrides = ""): string {
  return [
    "蔵王国際ホテル",
    "8月12日(水) — 8月13日(木)",
    "大人2名 · 子供0名 · 1部屋",
    "空室状況",
    "1泊に最適！",
    "部屋タイプ 宿泊人数 本日の料金 確認事項 部屋数を選択",
    "デラックス ツインルーム 禁煙",
    "人数: 2",
    "￥60,060",
    "料金 ￥60,060",
    "＋税・手数料（￥6,006）",
    "食事なし",
    "部屋数を選択 0 1 (￥60,060)",
    overrides
  ].join(" ");
}

function rateCardRow(visible: string = text(), overrides: Partial<BookingRateCardRow> = {}): BookingRateCardRow {
  return {
    ...buildBookingRateCardRow({
      runId: "run1",
      collectedAtJst: "2026-06-01T21:00:00+09:00",
      target,
      checkin: "2026-08-12",
      finalUrl: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html?checkin=2026-08-12&sid=secret",
      httpStatus: 200,
      pageTitle: "Zao Kokusai Hotel（蔵王温泉）",
      propertyHeadlineName: "蔵王国際ホテル",
      visibleText: visible,
      selectorPresence: presence,
      debugArtifactPath: ".data/debug/booking-limited-extractor-prototype/x"
    }),
    ...overrides
  };
}

function limitedRow(overrides: Partial<BookingLimitedRow> = {}): BookingLimitedRow {
  return { ...mapRateCardRowToLimitedRow(rateCardRow()), ...overrides };
}

describe("1. map B02X rate-card row into B03X prototype schema", () => {
  it("produces a normalized prototype row", () => {
    const row = mapRateCardRowToLimitedRow(rateCardRow());
    expect(row.source).toBe("booking");
    expect(row.collectorStage).toBe("prototype_read_only");
    expect(row.stayNights).toBe(1);
    expect(row.primaryPriceNumeric).toBe(60060);
    expect(row.taxNormalizationRule).toContain("1.1");
  });
});

describe("2. primary price extraction", () => {
  it("extracts numeric price from Japanese Booking text", () => {
    expect(mapRateCardRowToLimitedRow(rateCardRow()).primaryPriceNumeric).toBe(60060);
  });
});

describe("3. apply 1.1 tax multiplier", () => {
  it("computes tax_included_price = round(primary * 1.1)", () => {
    const n = normalizeBookingTaxFee({
      primaryPriceNumeric: 60060,
      taxFeeText: "＋税・手数料",
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true,
      propertyIdentityMatch: true
    });
    expect(n.taxIncludedPrice).toBe(Math.round(60060 * 1.1));
    expect(n.taxIncludedPrice).toBe(66066);
  });
});

describe("4. detect separate tax/fee text", () => {
  it("treats ＋税・手数料 as separate non-numeric adder", () => {
    const n = normalizeBookingTaxFee({
      primaryPriceNumeric: 42000,
      taxFeeText: "＋税・手数料",
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true,
      propertyIdentityMatch: true
    });
    expect(n.taxBasisClassification).toBe("booking_room_total_tax_excluded_requires_adder");
    expect(n.feeAdderExtractionStatus).toBe("mentioned_non_numeric");
  });
});

describe("5. detect cleaning fee text", () => {
  it("extracts numeric cleaning fee", () => {
    expect(extractFeeAdderNumeric("清掃料金 ￥3,000")?.value).toBe(3000);
    expect(extractFeeAdderNumeric("清掃費 ￥1,500")?.value).toBe(1500);
  });
});

describe("6. detect service fee text", () => {
  it("extracts numeric service fee", () => {
    expect(extractFeeAdderNumeric("サービス料 ￥2,200")?.value).toBe(2200);
  });
});

describe("7. extract numeric tax/fee/cleaning/service adder when visible", () => {
  it("extracts ＋税・手数料（￥X）", () => {
    expect(extractFeeAdderNumeric("＋税・手数料（￥6,006）")?.value).toBe(6006);
    expect(extractFeeAdderNumeric("＋税・手数料（￥14,790）")?.value).toBe(14790);
    expect(extractFeeAdderNumeric("宿泊税 ￥200")?.value).toBe(200);
  });
});

describe("8. leave fee_adder_numeric null when only ＋税・手数料 visible", () => {
  it("returns null with no numeric amount", () => {
    expect(extractFeeAdderNumeric("＋税・手数料")).toBeNull();
    const n = normalizeBookingTaxFee({
      primaryPriceNumeric: 42000,
      taxFeeText: "＋税・手数料",
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true,
      propertyIdentityMatch: true
    });
    expect(n.feeAdderNumeric).toBeNull();
  });
});

describe("9. compute computed_total_with_tax_fee when both numbers exist", () => {
  it("adds tax_included_price + numeric fee adder", () => {
    const n = normalizeBookingTaxFee({
      primaryPriceNumeric: 60060,
      taxFeeText: "＋税・手数料（￥6,006）",
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true,
      propertyIdentityMatch: true
    });
    expect(n.taxIncludedPrice).toBe(66066);
    expect(n.feeAdderNumeric).toBe(6006);
    expect(n.computedTotalWithTaxFee).toBe(66066 + 6006);
  });
});

describe("10. leave computed total null when required adder is non-numeric", () => {
  it("keeps computed_total null for non-numeric adder", () => {
    const n = normalizeBookingTaxFee({
      primaryPriceNumeric: 60060,
      taxFeeText: "＋税・手数料 別途",
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true,
      propertyIdentityMatch: true
    });
    expect(n.computedTotalWithTaxFee).toBeNull();
    expect(n.feeAdderExtractionStatus).toBe("mentioned_non_numeric");
  });
});

describe("11. basis_confidence A only when included/all-in explicit and scope explicit", () => {
  it("assigns A when tax/fees included and 2 adults / 1 room / 1 night explicit", () => {
    const n = normalizeBookingTaxFee({
      primaryPriceNumeric: 60060,
      taxFeeText: "税・手数料込み",
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true,
      propertyIdentityMatch: true
    });
    expect(n.taxBasisClassification).toBe("booking_room_total_tax_included_confirmed");
    expect(n.basisConfidence).toBe("A");
    expect(n.taxMultiplier).toBe(1);
    expect(n.computedTotalWithTaxFee).toBe(60060);
  });

  it("does not assign A when scope is incomplete", () => {
    const n = normalizeBookingTaxFee({
      primaryPriceNumeric: 60060,
      taxFeeText: "税・手数料込み",
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: false,
      is1NightScopeConfirmed: true,
      propertyIdentityMatch: true
    });
    expect(n.basisConfidence).not.toBe("A");
  });
});

describe("12. basis_confidence B for 1.1 normalization with non-numeric adder", () => {
  it("assigns B", () => {
    const n = normalizeBookingTaxFee({
      primaryPriceNumeric: 60060,
      taxFeeText: "＋税・手数料",
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true,
      propertyIdentityMatch: true
    });
    expect(n.basisConfidence).toBe("B");
    expect(n.taxIncludedPrice).toBe(66066);
  });
});

describe("13. basis_confidence C for ambiguous basis", () => {
  it("assigns C when scope weak", () => {
    const n = normalizeBookingTaxFee({
      primaryPriceNumeric: 60060,
      taxFeeText: "料金",
      is2AdultScopeConfirmed: false,
      is1RoomScopeConfirmed: false,
      is1NightScopeConfirmed: false,
      propertyIdentityMatch: true
    });
    expect(n.basisConfidence).toBe("C");
    expect(n.taxBasisClassification).toBe("booking_room_total_tax_and_charges_unclear");
  });
});

describe("14. row classification for tax-included confirmed total", () => {
  it("classifies tax included confirmed", () => {
    expect(
      classifyBookingLimitedRow({
        propertyIdentityMatch: true,
        rateCardPresent: true,
        soldOutTextPresent: false,
        blockingOrModalState: "none",
        primaryPriceNumeric: 60060,
        taxBasisClassification: "booking_room_total_tax_included_confirmed",
        feeAdderExtractionStatus: "included_or_not_required"
      })
    ).toBe("booking_limited_row_tax_included_total_confirmed");
  });
});

describe("15. row classification for price plus numeric tax/fee", () => {
  it("classifies numeric adder", () => {
    expect(
      classifyBookingLimitedRow({
        propertyIdentityMatch: true,
        rateCardPresent: true,
        soldOutTextPresent: false,
        blockingOrModalState: "none",
        primaryPriceNumeric: 60060,
        taxBasisClassification: "booking_room_total_tax_excluded_requires_adder",
        feeAdderExtractionStatus: "numeric_extracted"
      })
    ).toBe("booking_limited_row_price_plus_tax_fee_numeric");
  });
});

describe("16. row classification for price plus non-numeric tax/fee", () => {
  it("classifies non-numeric adder", () => {
    expect(
      classifyBookingLimitedRow({
        propertyIdentityMatch: true,
        rateCardPresent: true,
        soldOutTextPresent: false,
        blockingOrModalState: "none",
        primaryPriceNumeric: 60060,
        taxBasisClassification: "booking_room_total_tax_excluded_requires_adder",
        feeAdderExtractionStatus: "mentioned_non_numeric"
      })
    ).toBe("booking_limited_row_price_plus_tax_fee_non_numeric");
  });
});

describe("17. final decision ready when >=3 rows A/B", () => {
  it("returns ready", () => {
    expect(decideBookingLimited([limitedRow(), limitedRow(), limitedRow()])).toBe(
      "booking_limited_extractor_prototype_ready"
    );
  });
});

describe("18. final decision caution when usable prices exist but mostly C/unusable", () => {
  it("returns caution", () => {
    expect(
      decideBookingLimited([limitedRow({ basisConfidence: "C" }), limitedRow({ basisConfidence: "C" })])
    ).toBe("booking_limited_extractor_basis_caution");
  });

  it("returns not_ready when no usable price", () => {
    expect(decideBookingLimited([limitedRow({ basisConfidence: "none", primaryPriceNumeric: null })])).toBe(
      "booking_limited_extractor_not_ready"
    );
  });
});

describe("19. CSV renderer excludes Beds24/AirHost/PMS columns", () => {
  it("has no forbidden columns and keeps prototype columns", () => {
    const header = renderBookingLimitedCsv([limitedRow()]).split("\n")[0] ?? "";
    expect(header).toBe(BOOKING_LIMITED_CSV_HEADERS.join(","));
    const columns = header.split(",");
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
    for (const forbidden of ["beds24", "airhost", "pms"]) {
      expect(header.toLowerCase()).not.toContain(forbidden);
    }
    expect(columns).toContain("tax_included_price");
    expect(columns).toContain("computed_total_with_tax_fee");
  });
});

describe("20. report renderer sanitizes URLs and excludes session identifiers", () => {
  it("does not include session identifiers", () => {
    const report = renderBookingLimitedReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      rows: [limitedRow()],
      decision: "booking_limited_extractor_prototype_ready",
      pageLoadCount: 6,
      reportPath: ".data/reports/booking_limited.md",
      csvPath: ".data/reports/booking_limited.csv",
      jsonPath: ".data/reports/booking_limited.json",
      debugRootPath: ".data/debug/booking-limited-extractor-prototype/x"
    });
    expect(report).toContain("No DB writes");
    expect(report).not.toContain("sid=");
    expect(limitedRow().urlSanitized).not.toContain("sid=");
    expect(limitedRow().finalUrlSanitized).not.toContain("sid=");
  });

  it("script does not contain DB insert statements", () => {
    const source = readFileSync(resolve("src/scripts/probeBookingLimitedExtractorPrototype.ts"), "utf8");
    expect(source).not.toMatch(/INSERT\s+INTO\s+rate_snapshots/iu);
    expect(source).not.toMatch(/INSERT\s+INTO\s+inventory_snapshots/iu);
    expect(source).not.toMatch(/INSERT\s+INTO\s+collector_runs/iu);
  });
});
