import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBookingRateCardRow,
  classifyBookingRateCardRow,
  classifyBookingTaxBasis,
  decideBookingRateCardExtraction,
  detectBlockingOrModalState,
  detectSoldOutText,
  extractPrimaryRateCardCandidate,
  matchBookingPropertyIdentity,
  renderBookingRateCardCsv,
  renderBookingRateCardReport,
  summarizeSelectorPresence,
  type BookingRateCardRow,
  type SelectorPresence
} from "../src/services/bookingRateCardExtractionProbe";

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
    "＋税・手数料（￥300）",
    "込 消費税/VAT10 %",
    "食事なし",
    "部屋数を選択 0 1 (￥60,060)",
    overrides
  ].join(" ");
}

function row(overrides: Partial<BookingRateCardRow> = {}): BookingRateCardRow {
  return {
    ...buildBookingRateCardRow({
      runId: "run1",
      collectedAtJst: "2026-06-01T21:00:00+09:00",
      target,
      checkin: "2026-08-12",
      finalUrl: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html?checkin=2026-08-12",
      httpStatus: 200,
      pageTitle: "Zao Kokusai Hotel（蔵王温泉）",
      propertyHeadlineName: "蔵王国際ホテル",
      visibleText: text(),
      selectorPresence: presence,
      debugArtifactPath: ".data/debug/booking-rate-card-extraction/x"
    }),
    ...overrides
  };
}

describe("property identity and selectors", () => {
  it("matches Japanese headline variants", () => {
    expect(matchBookingPropertyIdentity("深山荘 高見屋", "深山荘高見屋", "Takamiya Ryokan Miyamaso", "https://x", "slug")).toBe(true);
  });

  it("detects property mismatch", () => {
    expect(matchBookingPropertyIdentity("蔵王国際ホテル", "別のホテル", "Other Hotel", "https://www.booking.com/hotel/jp/other.ja.html", "zao-kokusai")).toBe(false);
  });

  it("summarizes missing selector counts as zero", () => {
    expect(summarizeSelectorPresence({ hprtTableId: 2 }).priceChargesAndTaxes).toBe(0);
    expect(summarizeSelectorPresence({ hprtTableId: 2 }).hprtTableId).toBe(2);
  });
});

describe("rate-card and basis extraction", () => {
  it("extracts primary Booking-style yen price", () => {
    const candidate = extractPrimaryRateCardCandidate(text());
    expect(candidate?.priceNumeric).toBe(60060);
    expect(candidate?.taxChargeText).toContain("税・手数料");
  });

  it.each([
    ["Standard Twin Room", "Twin"],
    ["Double Room", "Double"],
    ["Queen Room 1 queen bed", "Queen"],
    ["King Room 1 king bed", "King"],
    ["デラックス ツインルーム 禁煙", "ツイン"],
    ["ダブルルーム", "ダブル"]
  ])("extracts two-person standard room context: %s", (roomText, expectedToken) => {
    const candidate = extractPrimaryRateCardCandidate(text(`${roomText} 2 beds 人数: 2 ￥61,000 ＋税・手数料（￥300）`));
    expect(`${candidate?.roomName} ${candidate?.roomCardText} ${candidate?.bedHint}`).toContain(expectedToken);
    expect(candidate?.occupancyHint).toMatch(/人数:\s*2|大人2名/u);
  });

  it.each([
    "Single Room",
    "Small Double Room",
    "Semi-double Room",
    "Triple Room",
    "Family Room",
    "Suite",
    "Dormitory Room",
    "Capsule Room"
  ])("extracts excluded room context: %s", (roomText) => {
    const candidate = extractPrimaryRateCardCandidate(text(`${roomText} 人数: 2 ￥61,000 ＋税・手数料（￥300）`));
    expect(`${candidate?.roomName} ${candidate?.roomCardText}`).toContain(roomText.split(" ")[0]!);
  });

  it("detects explicit tax-included basis with confidence A only when scope is explicit", () => {
    const basis = classifyBookingTaxBasis({
      candidate: {
        roomName: "room",
        rateName: "",
        roomCardText: "room",
        occupancyHint: "",
        bedHint: "",
        priceRaw: "￥60,060",
        priceNumeric: 60060,
        taxChargeText: "税・手数料込み",
        context: "大人2名 1部屋 1泊 税・手数料込み ￥60,060"
      },
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true
    });
    expect(basis.taxBasisClassification).toBe("booking_room_total_tax_included_confirmed");
    expect(basis.basisConfidence).toBe("A");
  });

  it("detects separate tax/charges as confidence B", () => {
    const candidate = extractPrimaryRateCardCandidate(text());
    const basis = classifyBookingTaxBasis({
      candidate,
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true
    });
    expect(basis.taxBasisClassification).toBe("booking_room_total_tax_excluded_requires_adder");
    expect(basis.basisConfidence).toBe("B");
  });

  it("uses confidence B for likely room total with partially unclear tax basis", () => {
    const basis = classifyBookingTaxBasis({
      candidate: {
        roomName: "room",
        rateName: "",
        roomCardText: "room",
        occupancyHint: "",
        bedHint: "",
        priceRaw: "￥60,060",
        priceNumeric: 60060,
        taxChargeText: "込 消費税/VAT10 %",
        context: "人数: 2 1部屋 1泊 ￥60,060 込 消費税/VAT10 %"
      },
      is2AdultScopeConfirmed: true,
      is1RoomScopeConfirmed: true,
      is1NightScopeConfirmed: true
    });
    expect(basis.basisConfidence).toBe("B");
  });
});

describe("state detection and classification", () => {
  it("detects sold-out and blocking/modal states", () => {
    expect(detectSoldOutText("この日程は満室です")).toBe(true);
    expect(detectBlockingOrModalState("captcha security check", 200)).toBe("captcha_or_security");
    expect(detectBlockingOrModalState("Genius割引が利用可能か確認するには、ログインしてください。料金 ￥60,060", 200)).toBe("none");
    expect(detectBlockingOrModalState("ログインが必要です", 200)).toBe("login_required");
  });

  it("classifies confirmed, likely, unclear, and blocked rows", () => {
    expect(
      classifyBookingRateCardRow({
        propertyIdentityMatch: true,
        rateCardPresent: true,
        soldOutTextPresent: false,
        blockingOrModalState: "none",
        candidate: extractPrimaryRateCardCandidate("大人2名 1部屋 1泊 税・手数料込み ￥60,060"),
        basisConfidence: "A"
      })
    ).toBe("booking_rate_card_price_basis_confirmed");
    expect(row().classification).toBe("booking_rate_card_price_basis_likely");
    expect(row({ basisConfidence: "C", classification: "booking_rate_card_price_basis_unclear" }).classification).toBe(
      "booking_rate_card_price_basis_unclear"
    );
    expect(
      classifyBookingRateCardRow({
        propertyIdentityMatch: true,
        rateCardPresent: true,
        soldOutTextPresent: false,
        blockingOrModalState: "captcha_or_security",
        candidate: null,
        basisConfidence: "none"
      })
    ).toBe("booking_rate_card_blocked");
  });
});

describe("decision and renderers", () => {
  it("returns ready when at least three rows are A/B", () => {
    expect(decideBookingRateCardExtraction([row(), row(), row()])).toBe("booking_rate_card_extraction_ready");
  });

  it("returns basis_hardening_needed when at least one weak usable price exists", () => {
    expect(decideBookingRateCardExtraction([row({ basisConfidence: "C" })])).toBe(
      "booking_rate_card_basis_hardening_needed"
    );
  });

  it("renders CSV without upload/PMS columns", () => {
    const header = renderBookingRateCardCsv([row()]).split("\n")[0] ?? "";
    for (const forbidden of ["roomid", "inventory", "minstay", "maxstay", "multiplier", "price1", "price2", "Beds24", "AirHost", "PMS"]) {
      expect(header).not.toContain(forbidden);
    }
    expect(header).toContain("primary_price_numeric");
  });

  it("renders report with sanitized output paths and no session identifiers", () => {
    const report = renderBookingRateCardReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      rows: [row()],
      selectorPresenceByRow: [{ rowKey: "x", selectorPresence: presence }],
      decision: "booking_rate_card_extraction_ready",
      reportPath: ".data/reports/booking.md",
      csvPath: ".data/reports/booking.csv",
      jsonPath: ".data/reports/booking.json",
      debugRootPath: ".data/debug/booking"
    });
    expect(report).toContain("No DB writes");
    expect(report).not.toContain("sid=");
  });

  it("script does not contain DB insert statements", () => {
    const source = readFileSync(resolve("src/scripts/probeBookingRateCardExtraction.ts"), "utf8");
    expect(source).not.toMatch(/INSERT\s+INTO\s+rate_snapshots/iu);
    expect(source).not.toMatch(/INSERT\s+INTO\s+inventory_snapshots/iu);
    expect(source).not.toMatch(/INSERT\s+INTO\s+collector_runs/iu);
  });
});
