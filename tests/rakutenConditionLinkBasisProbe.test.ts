import { describe, expect, it } from "vitest";
import {
  buildAbsoluteRakutenConditionUrl,
  classifyConditionBasis,
  compareConditionBasis,
  decideConditionBasis,
  extractConditionPageSignals,
  extractYenPriceCandidates,
  RAKUTEN_CONDITION_BASIS_CSV_HEADERS,
  renderConditionBasisCsv,
  renderConditionBasisReport,
  sanitizeRakutenConditionUrl,
  selectFirstAvailableDay,
  type ConditionPageSignals,
  type RakutenConditionBasisRow
} from "../src/services/rakutenConditionLinkBasisProbe";
import type { HplanCalendarParsed, HplanDay } from "../src/services/rakutenCorrectedHplanUrlProbe";

const day = (overrides: Partial<HplanDay> = {}): HplanDay => ({
  viewDay: "3",
  epoch: Date.UTC(2026, 5, 3),
  stock: 2,
  price: 32395,
  priceWithoutTax: 29450,
  discountedPrice: 0,
  link: "https://rsvh.travel.rakuten.co.jp/rs/changeConditions/input/stay?f_hotel_no=5723&f_syu=00&f_camp_id=6468227&track=long",
  vacantCondition: "2室",
  monthClass: "thisMonth",
  isPast: false,
  isFull: false,
  isVacant: true,
  enabled: true,
  ...overrides
});

const parsed = (days: HplanDay[]): HplanCalendarParsed => ({
  ok: true,
  responseType: "jsonp",
  viewDate: "2026年06月",
  isEmpty: false,
  isTaxExclusive: false,
  vacantRoomCount: 1,
  hotelNo: "5723",
  roomCode: "00",
  chargeType: "CHARGE_PER_HUMAN",
  nextMonthCalendarUrl: "",
  days
});

const signals = (overrides: Partial<ConditionPageSignals> = {}): ConditionPageSignals => ({
  pageTitle: "蔵王国際ホテル",
  propertyNameVisible: true,
  roomOrPlanNameVisible: true,
  checkinDateVisible: true,
  checkoutDateVisible: true,
  nightsVisible: true,
  adultCountVisible: true,
  roomCountVisible: true,
  taxIncludedTextPresent: true,
  couponOrDiscountTextPresent: false,
  serviceFeeOrTaxNotes: "",
  onsenTaxOrBathTaxNotes: "",
  availabilityOrRemainingRoomText: "残り2室",
  buttonOrBookingStateText: "予約へ",
  totalPriceCandidates: [
    {
      rawText: "合計（税込）64,790円",
      numericValue: 64790,
      contextBeforeAfter: "大人2名 1室 1泊 合計（税込）64,790円",
      candidateTypeGuess: "total_2_adult_tax_included"
    }
  ],
  perPersonPriceCandidates: [],
  currency: "JPY",
  ...overrides
});

const row = (overrides: Partial<RakutenConditionBasisRow> = {}): RakutenConditionBasisRow => ({
  canonicalPropertyName: "蔵王国際ホテル",
  hotelNo: "5723",
  fSyu: "00",
  fCampId: "6468227",
  sourceViewDate: "2026年06月",
  selectedViewDay: "3",
  selectedEpoch: Date.UTC(2026, 5, 3),
  dayListPrice: 32395,
  expectedTwoAdultTotal: 64790,
  destinationHttpStatus: 200,
  destinationFinalUrlSanitized: "https://rsvh.travel.rakuten.co.jp/rs/changeConditions/input/stay?f_hotel_no=5723",
  fetchMode: "static",
  pageTitle: "蔵王国際ホテル",
  dateScopeDetected: true,
  adultCountDetected: true,
  roomCountDetected: true,
  nightCountDetected: true,
  taxIncludedTextPresent: true,
  totalMatchDetected: true,
  perPersonMatchDetected: false,
  classification: "condition_link_basis_confirmed_total_matches_price_times_adults",
  decision: "rakuten_price_basis_confirmed",
  riskNote: "ok",
  debugArtifactPath: ".data/debug/rakuten-condition-link-basis/x",
  ...overrides
});

describe("condition link selection and URL safety", () => {
  it("selects the first available day with isVacant, price > 0, and link", () => {
    const selected = selectFirstAvailableDay(
      parsed([
        day({ isVacant: false, price: 0, link: "" }),
        day({ viewDay: "4", price: 25000, link: "" }),
        day({ viewDay: "5", price: 30000, link: "https://example.com/5" })
      ])
    );
    expect(selected?.viewDay).toBe("5");
  });

  it("builds absolute URL from a relative condition link", () => {
    expect(buildAbsoluteRakutenConditionUrl("/rs/changeConditions/input/stay?f_hotel_no=5723")).toBe(
      "https://rsvh.travel.rakuten.co.jp/rs/changeConditions/input/stay?f_hotel_no=5723"
    );
  });

  it("sanitizes long tracking-heavy URLs", () => {
    const sanitized = sanitizeRakutenConditionUrl(
      "https://rsvh.travel.rakuten.co.jp/rs/changeConditions/input/stay?f_hotel_no=5723&f_syu=00&f_camp_id=6468227&track=abc&session=secret"
    );
    expect(sanitized).toContain("f_hotel_no=5723");
    expect(sanitized).toContain("f_syu=00");
    expect(sanitized).not.toContain("track=");
    expect(sanitized).not.toContain("session=");
  });
});

describe("destination extraction", () => {
  it("extracts numeric yen prices from Japanese text", () => {
    const prices = extractYenPriceCandidates("大人2名 1室 1泊 合計（税込）64,790円 お一人様 32,395円");
    expect(prices.map((p) => p.numericValue)).toEqual(expect.arrayContaining([64790, 32395]));
  });

  it("extracts visible scope signals", () => {
    const out = extractConditionPageSignals({
      text: "蔵王国際ホテル 2026年06月03日 大人2名 1室 1泊 合計（税込）64,790円 入湯税別",
      title: "蔵王国際ホテル",
      canonicalPropertyName: "蔵王国際ホテル",
      roomCode: "00",
      selectedDay: day()
    });
    expect(out.propertyNameVisible).toBe(true);
    expect(out.checkinDateVisible).toBe(true);
    expect(out.adultCountVisible).toBe(true);
    expect(out.roomCountVisible).toBe(true);
    expect(out.nightsVisible).toBe(true);
    expect(out.taxIncludedTextPresent).toBe(true);
    expect(out.onsenTaxOrBathTaxNotes).toContain("入湯税");
  });
});

describe("basis classification", () => {
  it("classifies exact total match against price * adults", () => {
    const comparison = compareConditionBasis({ day: day(), adultCount: 2, signals: signals() });
    expect(comparison.anyVisiblePriceEqualsPriceTimesAdults).toBe(true);
    expect(classifyConditionBasis({ reachable: true, renderedBlocked: false, comparison })).toBe(
      "condition_link_basis_confirmed_total_matches_price_times_adults"
    );
  });

  it("classifies per-person-only match", () => {
    const comparison = compareConditionBasis({
      day: day(),
      adultCount: 2,
      signals: signals({
        totalPriceCandidates: [],
        perPersonPriceCandidates: [
          {
            rawText: "お一人様（税込）32,395円",
            numericValue: 32395,
            contextBeforeAfter: "お一人様（税込）32,395円",
            candidateTypeGuess: "per_person_tax_included"
          }
        ]
      })
    });
    expect(classifyConditionBasis({ reachable: true, renderedBlocked: false, comparison })).toBe(
      "condition_link_basis_confirmed_per_person_only"
    );
  });

  it("classifies mismatch", () => {
    const comparison = compareConditionBasis({
      day: day(),
      adultCount: 2,
      signals: signals({
        totalPriceCandidates: [
          {
            rawText: "合計（税込）70,000円",
            numericValue: 70000,
            contextBeforeAfter: "合計（税込）70,000円",
            candidateTypeGuess: "total_2_adult_tax_included"
          }
        ]
      })
    });
    expect(classifyConditionBasis({ reachable: true, renderedBlocked: false, comparison })).toBe(
      "condition_link_basis_price_mismatch"
    );
  });

  it("classifies date and people-scope mismatch", () => {
    expect(
      classifyConditionBasis({
        reachable: true,
        renderedBlocked: false,
        comparison: compareConditionBasis({ day: day(), adultCount: 2, signals: signals({ checkinDateVisible: false }) })
      })
    ).toBe("condition_link_basis_date_scope_mismatch");

    expect(
      classifyConditionBasis({
        reachable: true,
        renderedBlocked: false,
        comparison: compareConditionBasis({ day: day(), adultCount: 2, signals: signals({ adultCountVisible: false }) })
      })
    ).toBe("condition_link_basis_people_scope_mismatch");
  });

  it("decision function follows rules", () => {
    expect(decideConditionBasis("condition_link_basis_confirmed_total_matches_price_times_adults")).toBe(
      "rakuten_price_basis_confirmed"
    );
    expect(decideConditionBasis("condition_link_basis_confirmed_per_person_only")).toBe(
      "rakuten_price_basis_needs_manual_review"
    );
    expect(decideConditionBasis("condition_link_basis_destination_unreachable")).toBe("rakuten_price_basis_not_ready");
  });
});

describe("renderers", () => {
  it("report renderer does not include full tracking-heavy URL", () => {
    const report = renderConditionBasisReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      csvPath: "/tmp/out.csv",
      debugRootPath: "/tmp/debug",
      rows: [row()],
      selectedDay: day(),
      comparison: compareConditionBasis({ day: day(), adultCount: 2, signals: signals() }),
      priceCandidates: signals().totalPriceCandidates,
      destinationUrlSanitized: sanitizeRakutenConditionUrl(
        "https://rsvh.travel.rakuten.co.jp/rs/changeConditions/input/stay?f_hotel_no=5723&track=secret"
      )
    });
    expect(report).not.toContain("track=secret");
    expect(report).toContain("No DB writes");
  });

  it("CSV renderer excludes Beds24/AirHost/PMS upload columns", () => {
    const header = RAKUTEN_CONDITION_BASIS_CSV_HEADERS.join(",");
    expect(header).not.toMatch(/Beds24|AirHost|PMS|roomid|inventory|price1|price2|price3|price4|upload/iu);
    expect(renderConditionBasisCsv([row()])).toContain("rakuten_price_basis_confirmed");
  });
});
