import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCorrectedHplanCalendarUrl,
  buildCorrectedHplanUrl,
  buildPhase63Comparison,
  classifyCorrectedHplan,
  decideRakutenCorrectedHplan,
  parseHplanCalendarResponse,
  RAKUTEN_CORRECTED_HPLAN_CSV_HEADERS,
  renderCorrectedHplanCsv,
  renderCorrectedHplanReport,
  sanitizeHplanUrl,
  type CorrectedHplanRow
} from "../src/services/rakutenCorrectedHplanUrlProbe";

const positiveJsonp = (): string =>
  `cb(${JSON.stringify({
    viewDate: "2026年06月",
    isEmpty: false,
    isTaxExclusive: false,
    hotelNo: 5723,
    roomCode: "00",
    roomInfoDto: { chargeType: "CHARGE_PER_HUMAN" },
    dayList: [
      {
        viewDay: "3",
        day: 1780412400000,
        stock: 2,
        price: 32395,
        priceWithoutTax: 29450,
        discountedPrice: 0,
        link: "https://rsvh.travel.rakuten.co.jp/rs/changeConditions/input/stay?f_hotel_no=5723",
        vacantCondition: "2室",
        monthClass: "thisMonth",
        isPast: false,
        isFull: false,
        isVacant: true
      }
    ]
  })});`;

const allFullJsonp = (): string =>
  `cb(${JSON.stringify({
    viewDate: "2026年06月",
    isEmpty: false,
    isTaxExclusive: false,
    hotelNo: 5723,
    roomCode: "00",
    roomInfoDto: { chargeType: "CHARGE_PER_HUMAN" },
    dayList: [
      {
        viewDay: "1",
        day: 1780239600000,
        stock: 0,
        price: 0,
        priceWithoutTax: 0,
        discountedPrice: 0,
        link: null,
        vacantCondition: null,
        monthClass: "thisMonth",
        isPast: false,
        isFull: true,
        isVacant: false
      }
    ]
  })});`;

const baseInput = {
  hotelNo: "5723",
  fSyu: "00",
  fCampId: "6468227",
  checkin: "2026-06-01",
  callback: "cb",
  cacheBust: 0
};

const row = (overrides: Partial<CorrectedHplanRow> = {}): CorrectedHplanRow => ({
  canonicalPropertyName: "蔵王国際ホテル",
  hotelNo: "5723",
  fSyu: "00",
  fCampId: "6468227",
  targetAnchor: "20260601",
  requestUrlSanitized: "https://hotel.travel.rakuten.co.jp/hplan/calendar/?f_no=5723",
  fetchMode: "direct",
  httpStatus: 200,
  responseType: "jsonp",
  viewDate: "2026年06月",
  isEmpty: false,
  isTaxExclusive: false,
  chargeType: "CHARGE_PER_HUMAN",
  dayListLength: 1,
  vacantDayCount: 1,
  pricePositiveCount: 1,
  linkPopulatedCount: 1,
  samplePrice: 32395,
  classification: "corrected_hplan_response_positive",
  riskNote: "note",
  debugArtifactPath: ".data/debug/rakuten-corrected-hplan-url/x",
  ...overrides
});

describe("buildCorrectedHplanCalendarUrl", () => {
  const url = buildCorrectedHplanCalendarUrl(baseInput);
  const params = new URL(url).searchParams;

  it("targets /hplan/calendar/ and omits the invented f_calendar param", () => {
    expect(url).toContain("https://hotel.travel.rakuten.co.jp/hplan/calendar/");
    expect(params.has("f_calendar")).toBe(false);
  });

  it("includes f_camp_id and the required 2-adult / 1-room basis", () => {
    expect(params.get("f_camp_id")).toBe("6468227");
    expect(params.get("f_otona_su")).toBe("2");
    expect(params.get("f_heya_su")).toBe("1");
  });

  it("keeps f_hak and date components blank in live-faithful mode", () => {
    expect(params.has("f_hak")).toBe(true);
    expect(params.get("f_hak")).toBe("");
    for (const key of ["f_nen1", "f_tuki1", "f_hi1", "f_nen2", "f_tuki2", "f_hi2"]) {
      expect(params.has(key)).toBe(true);
      expect(params.get(key)).toBe("");
    }
  });

  it("preserves child params as zero", () => {
    for (const key of ["f_s1", "f_s2", "f_y1", "f_y2", "f_y3", "f_y4"]) {
      expect(params.get(key)).toBe("0");
    }
  });

  it("supports explicit date-component mode for future experimentation", () => {
    const explicit = new URL(
      buildCorrectedHplanUrl({ ...baseInput, checkin: "2026-12-31", dateScopeMode: "explicit" })
    ).searchParams;
    expect(explicit.get("f_hak")).toBe("1");
    expect(explicit.get("f_nen1")).toBe("2026");
    expect(explicit.get("f_tuki1")).toBe("12");
    expect(explicit.get("f_hi1")).toBe("31");
    expect(explicit.get("f_nen2")).toBe("2027");
    expect(explicit.get("f_tuki2")).toBe("1");
    expect(explicit.get("f_hi2")).toBe("1");
  });

  it("handles normal date and month boundary in explicit mode", () => {
    const normal = new URL(buildCorrectedHplanUrl({ ...baseInput, dateScopeMode: "explicit" })).searchParams;
    expect(normal.get("f_nen2")).toBe("2026");
    expect(normal.get("f_tuki2")).toBe("6");
    expect(normal.get("f_hi2")).toBe("2");

    const month = new URL(
      buildCorrectedHplanUrl({ ...baseInput, checkin: "2026-06-30", dateScopeMode: "explicit" })
    ).searchParams;
    expect(month.get("f_nen2")).toBe("2026");
    expect(month.get("f_tuki2")).toBe("7");
    expect(month.get("f_hi2")).toBe("1");
  });
});

describe("JSONP parsing and classification", () => {
  it("extracts JSONP payload safely", () => {
    const parsed = parseHplanCalendarResponse(positiveJsonp(), 200);
    expect(parsed.ok).toBe(true);
    expect(parsed.isTaxExclusive).toBe(false);
    expect(parsed.chargeType).toBe("CHARGE_PER_HUMAN");
    expect(parsed.days[0]?.price).toBe(32395);
  });

  it("classifies positive vacancy when isVacant, price > 0, and link exists", () => {
    expect(classifyCorrectedHplan({ status: 200, parsed: parseHplanCalendarResponse(positiveJsonp(), 200) })).toBe(
      "corrected_hplan_response_positive"
    );
  });

  it("classifies all-full when no vacant/price/link exists", () => {
    expect(classifyCorrectedHplan({ status: 200, parsed: parseHplanCalendarResponse(allFullJsonp(), 200) })).toBe(
      "corrected_hplan_response_all_full"
    );
  });

  it("classifies HTTP and parse failures", () => {
    expect(classifyCorrectedHplan({ status: 400, parsed: null })).toBe("corrected_hplan_http_400");
    expect(classifyCorrectedHplan({ status: 200, parsed: null })).toBe("corrected_hplan_jsonp_parse_error");
  });
});

describe("decision rules", () => {
  it("returns reconstruction_ready when any response is positive", () => {
    expect(
      decideRakutenCorrectedHplan({
        classifications: ["corrected_hplan_response_positive"],
        directFetchReachable: true,
        browserFetchReachable: false,
        anyPriceWithoutBasis: false
      })
    ).toBe("rakuten_corrected_hplan_reconstruction_ready");
  });

  it("returns needs_browser_context when only browser context reaches the endpoint", () => {
    expect(
      decideRakutenCorrectedHplan({
        classifications: ["corrected_hplan_response_empty"],
        directFetchReachable: false,
        browserFetchReachable: true,
        anyPriceWithoutBasis: false
      })
    ).toBe("rakuten_corrected_hplan_needs_browser_context");
  });

  it("returns basis_mapping_needed when price basis is unclear", () => {
    expect(
      decideRakutenCorrectedHplan({
        classifications: ["corrected_hplan_response_all_full"],
        directFetchReachable: true,
        browserFetchReachable: false,
        anyPriceWithoutBasis: true
      })
    ).toBe("rakuten_corrected_hplan_basis_mapping_needed");
  });
});

describe("renderers and safety", () => {
  it("CSV excludes Beds24/AirHost/PMS upload columns", () => {
    const header = RAKUTEN_CORRECTED_HPLAN_CSV_HEADERS.join(",");
    expect(header).not.toMatch(/Beds24|AirHost|PMS|roomid|inventory|price1|price2|price3|price4|upload/iu);
    expect(renderCorrectedHplanCsv([row()])).toContain("corrected_hplan_response_positive");
  });

  it("report renderer excludes private cookies/tokens and includes the safety section", () => {
    const report = renderCorrectedHplanReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      csvPath: "/tmp/report.csv",
      debugRootPath: "/tmp/debug",
      rows: [row({ requestUrlSanitized: sanitizeHplanUrl(`${row().requestUrlSanitized}&callback=secret&_=${Date.now()}`) })],
      decision: "rakuten_corrected_hplan_reconstruction_ready",
      executionNote: "done",
      comparison: buildPhase63Comparison({
        phase63LiveUrl: "https://hotel.travel.rakuten.co.jp/hplan/calendar/?f_no=5723&f_camp_id=6468227",
        phase64CorrectedUrl: "https://hotel.travel.rakuten.co.jp/hplan/calendar/?f_no=5723&f_camp_id=6468227&callback=cb&_=1",
        positiveCountPhase63: 1,
        positiveCountPhase64: 1,
        isTaxExclusive: false,
        chargeType: "CHARGE_PER_HUMAN"
      })
    });
    expect(report).not.toContain("secret");
    expect(report).not.toContain("cookie=");
    expect(report).toContain("No DB writes");
  });

  it("script/source do not contain snapshot or collector-run inserts", () => {
    const service = readFileSync(resolve("src/services/rakutenCorrectedHplanUrlProbe.ts"), "utf8");
    const script = readFileSync(resolve("src/scripts/probeRakutenCorrectedHplanUrl.ts"), "utf8");
    for (const source of [service, script]) {
      expect(source).not.toContain("INSERT INTO rate_snapshots");
      expect(source).not.toContain("INSERT INTO inventory_snapshots");
      expect(source).not.toContain("INSERT INTO collector_runs");
    }
  });
});
