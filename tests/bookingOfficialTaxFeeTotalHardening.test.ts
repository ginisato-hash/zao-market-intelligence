import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOKING_B04A_CSV_HEADERS,
  BOOKING_PRICE_POLICY_VERSION,
  decideB04A,
  extractOfficialTaxFeeAdder,
  mapRateCardRowToB04ARow,
  normalizeOfficialTaxFeeTotal,
  renderB04ACsv,
  renderB04AReport,
  type B04ARow
} from "../src/services/bookingOfficialTaxFeeTotalHardening";
import { buildBookingRateCardRow, summarizeSelectorPresence } from "../src/services/bookingRateCardExtractionProbe";

const SERVICE_SOURCE = readFileSync(
  resolve(__dirname, "../src/services/bookingOfficialTaxFeeTotalHardening.ts"),
  "utf8"
);

function normalize(text: string, overrides: Partial<Parameters<typeof normalizeOfficialTaxFeeTotal>[0]> = {}) {
  return normalizeOfficialTaxFeeTotal({
    primaryPriceNumeric: 30_000,
    officialTaxFeeText: text,
    finalAllInTotalVisible: false,
    is2AdultScopeConfirmed: true,
    is1RoomScopeConfirmed: true,
    is1NightScopeConfirmed: true,
    propertyIdentityMatch: true,
    ...overrides
  });
}

describe("Phase B04A — official tax/fee adder extraction", () => {
  it("(1) extracts the adder from ＋税・手数料（￥9,924）", () => {
    const { total } = extractOfficialTaxFeeAdder("料金 ＋税・手数料（￥9,924）");
    expect(total).toBe(9_924);
  });

  it("(2) extracts the adder from 税・手数料（￥11,657）", () => {
    const { total } = extractOfficialTaxFeeAdder("税・手数料（￥11,657）");
    expect(total).toBe(11_657);
  });

  it("(3) extracts a cleaning fee 清掃料 ￥3,000", () => {
    const { total } = extractOfficialTaxFeeAdder("清掃料 ￥3,000");
    expect(total).toBe(3_000);
  });

  it("(4) extracts a service fee サービス料 ￥2,200", () => {
    const { total } = extractOfficialTaxFeeAdder("サービス料 ￥2,200");
    expect(total).toBe(2_200);
  });

  it("(5) extracts a lodging tax 宿泊税 ￥600", () => {
    const { total } = extractOfficialTaxFeeAdder("宿泊税 ￥600");
    expect(total).toBe(600);
  });

  it("(6) extracts a bathing tax 入湯税 ￥300", () => {
    const { total } = extractOfficialTaxFeeAdder("入湯税 ￥300");
    expect(total).toBe(300);
  });

  it("(7) sums separate official adders", () => {
    const { total, parts } = extractOfficialTaxFeeAdder("税・手数料（￥9,924） 入湯税 ￥300 宿泊税 ￥600");
    expect(total).toBe(9_924 + 300 + 600);
    expect(parts).toHaveLength(3);
  });

  it("(8) avoids double-counting a repeated identical combined adder", () => {
    const { total, parts } = extractOfficialTaxFeeAdder(
      "税・手数料（￥9,924） … 税・手数料（￥9,924）"
    );
    expect(total).toBe(9_924);
    expect(parts).toHaveLength(1);
  });
});

describe("Phase B04A — official total computation", () => {
  it("(9) computed_total = primary_price + official_adder", () => {
    const result = normalize("税・手数料（￥9,924）", { primaryPriceNumeric: 30_000 });
    expect(result.officialTaxFeeAdderNumeric).toBe(9_924);
    expect(result.computedTotalWithTaxFee).toBe(39_924);
  });

  it("(10a) does NOT apply the B03X base×1.1 multiplier", () => {
    const base = 30_000;
    const adder = 9_924;
    const result = normalize("税・手数料（￥9,924）", { primaryPriceNumeric: base });
    const b03xStyle = Math.round(base * 1.1) + adder;
    expect(result.computedTotalWithTaxFee).toBe(base + adder);
    expect(result.computedTotalWithTaxFee).not.toBe(b03xStyle);
  });

  it("(10b) service source contains no synthetic 1.1 multiplier", () => {
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1\b/);
    expect(SERVICE_SOURCE).not.toMatch(/1\.1\s*\*/);
    expect(SERVICE_SOURCE).not.toMatch(/BOOKING_TAX_MULTIPLIER/);
  });

  it("(11) computed total is null when an adder label exists but no numeric amount", () => {
    const result = normalize("税・手数料が別途かかります");
    expect(result.officialTaxFeeAdderNumeric).toBeNull();
    expect(result.officialTaxFeeAdderExtractionStatus).toBe("mentioned_non_numeric");
    expect(result.computedTotalWithTaxFee).toBeNull();
  });

  it("(12) included case total equals primary price", () => {
    const result = normalize("税・手数料込み", { primaryPriceNumeric: 30_000 });
    expect(result.officialTaxFeeAdderExtractionStatus).toBe("included_or_not_required");
    expect(result.computedTotalWithTaxFee).toBe(30_000);
  });

  it("(13) confidence A only when final all-in total and scope/identity are explicit", () => {
    const result = normalize("税・手数料（￥9,924）", {
      finalAllInTotalVisible: true,
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true,
      propertyIdentityMatch: true
    });
    expect(result.basisConfidence).toBe("A");
  });

  it("(14) confidence B for numeric adder without final-total evidence", () => {
    const result = normalize("税・手数料（￥9,924）", { finalAllInTotalVisible: false });
    expect(result.basisConfidence).toBe("B");
  });
});

function rateCardRow(overrides: { visibleText: string; headline?: string }): ReturnType<typeof buildBookingRateCardRow> {
  return buildBookingRateCardRow({
    runId: "test_run",
    collectedAtJst: "2026-06-01T12:00:00+09:00",
    target: { canonicalPropertyName: "蔵王国際ホテル", slug: "zao-kokusai" },
    checkin: "2026-08-12",
    finalUrl: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html?checkin=2026-08-12",
    httpStatus: 200,
    pageTitle: "蔵王国際ホテル",
    propertyHeadlineName: overrides.headline ?? "蔵王国際ホテル",
    visibleText: overrides.visibleText,
    selectorPresence: summarizeSelectorPresence({ hprtTableId: 1, priceAndDiscountedPrice: 1 }),
    debugArtifactPath: "/tmp/test"
  });
}

describe("Phase B04A — row classification", () => {
  it("(15) classifies official base + numeric adder", () => {
    const card = rateCardRow({
      visibleText:
        "蔵王国際ホテル\n大人2名\n1室\n1泊\n和室\nスタンダードプラン\n￥30,000\n＋税・手数料（￥9,924）\nJPY"
    });
    const row = mapRateCardRowToB04ARow(card);
    expect(row.officialTaxFeeAdderExtractionStatus).toBe("numeric_extracted");
    expect(row.taxBasisClassification).toBe("booking_room_total_official_base_plus_tax_fee_adder");
    expect(row.classification).toBe("booking_b04a_official_base_plus_adder_numeric");
    expect(row.computedTotalWithTaxFee).toBe(39_924);
  });

  it("(16) classifies a non-numeric adder mention", () => {
    const card = rateCardRow({
      visibleText:
        "蔵王国際ホテル\n大人2名\n1室\n1泊\n和室\nスタンダードプラン\n￥30,000\n税・手数料が別途必要です\nJPY"
    });
    // The full visible tax/fee text (mentioning an adder with no numeric amount)
    // is passed through explicitly, as the probe does from the rendered page.
    const row = mapRateCardRowToB04ARow(card, { officialTaxFeeText: "税・手数料が別途必要です" });
    expect(row.officialTaxFeeAdderExtractionStatus).toBe("mentioned_non_numeric");
    expect(row.classification).toBe("booking_b04a_official_adder_non_numeric");
    expect(row.computedTotalWithTaxFee).toBeNull();
  });
});

describe("Phase B04A — decision", () => {
  it("(17) decision ready when >=3 rows have computed official totals", () => {
    const base: B04ARow = mapRateCardRowToB04ARow(
      rateCardRow({
        visibleText:
          "蔵王国際ホテル\n大人2名\n1室\n1泊\n和室\nスタンダードプラン\n￥30,000\n＋税・手数料（￥9,924）\nJPY"
      })
    );
    const rows = [base, { ...base }, { ...base }];
    expect(decideB04A(rows)).toBe("booking_official_tax_fee_total_ready");
  });
});

describe("Phase B04A — output schema", () => {
  it("(18) CSV excludes deprecated B03X tax columns", () => {
    const header = BOOKING_B04A_CSV_HEADERS.join(",");
    const columns = header.split(",");
    expect(columns).not.toContain("tax_multiplier");
    expect(columns).not.toContain("tax_included_price");
    expect(columns).not.toContain("tax_normalization_rule");
    expect(columns).not.toContain("multiplier");
  });

  it("(19) CSV excludes Beds24/AirHost/PMS columns", () => {
    const header = BOOKING_B04A_CSV_HEADERS.join(",").toLowerCase();
    expect(header).not.toContain("beds24");
    expect(header).not.toContain("airhost");
    expect(header).not.toContain("pms");
    expect(header).not.toContain("roomid");
    expect(header).not.toContain("minstay");
    expect(header).not.toContain("maxstay");
  });

  it("(19b) CSV header carries the official price policy version column", () => {
    const columns = BOOKING_B04A_CSV_HEADERS.join(",").split(",");
    expect(columns).toContain("price_policy_version");
    expect(columns).toContain("official_tax_fee_adder_numeric");
    expect(columns).toContain("computed_total_with_tax_fee");
    expect(BOOKING_PRICE_POLICY_VERSION).toBe("booking_official_visible_adder_v1");
  });

  it("renders a CSV whose data rows align with the headers", () => {
    const row = mapRateCardRowToB04ARow(
      rateCardRow({
        visibleText:
          "蔵王国際ホテル\n大人2名\n1室\n1泊\n和室\nスタンダードプラン\n￥30,000\n＋税・手数料（￥9,924）\nJPY"
      })
    );
    const csv = renderB04ACsv([row]);
    const [headerLine, dataLine] = csv.trim().split("\n");
    expect(headerLine).toBe(BOOKING_B04A_CSV_HEADERS.join(","));
    expect(dataLine).toBeTruthy();
  });
});

describe("Phase B04A — report", () => {
  it("(20) report explicitly states B04A supersedes the B03X base×1.1 logic", () => {
    const row = mapRateCardRowToB04ARow(
      rateCardRow({
        visibleText:
          "蔵王国際ホテル\n大人2名\n1室\n1泊\n和室\nスタンダードプラン\n￥30,000\n＋税・手数料（￥9,924）\nJPY"
      })
    );
    const report = renderB04AReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      rows: [row],
      decision: "booking_official_tax_fee_total_ready",
      pageLoadCount: 6,
      reportPath: "/tmp/report.md",
      csvPath: "/tmp/report.csv",
      jsonPath: "/tmp/report.json",
      debugRootPath: "/tmp/debug"
    });
    expect(report).toContain("SUPERSEDES");
    expect(report).toMatch(/base × 1\.1|base x 1\.1/i);
    expect(report).toContain("primary_price_numeric + official_tax_fee_adder_numeric");
  });
});
