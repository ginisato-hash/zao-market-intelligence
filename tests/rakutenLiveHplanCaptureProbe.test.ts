import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHplanCalendarUrl,
  classifyLiveHplanCapture,
  computeParamDiff,
  decideRakutenLiveHplan,
  isHplanCalendarUrl,
  parseHplanCalendarResponse,
  RAKUTEN_LIVE_HPLAN_CSV_HEADERS,
  renderRakutenLiveHplanCsv,
  type RakutenLiveHplanRow
} from "../src/services/rakutenLiveHplanCaptureProbe";

const positiveJsonp = (): string =>
  `cb(${JSON.stringify({
    viewDate: "2026年08月",
    isEmpty: false,
    isTaxExclusive: false,
    hotelNo: 5723,
    roomInfoDto: { chargeType: "PER_ROOM" },
    dayList: [
      {
        viewDay: "15",
        day: 1755225600000,
        stock: 3,
        price: 42000,
        priceWithoutTax: 38000,
        discountedPrice: 42000,
        link: "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?f_no=5723&f_hizuke=20260815",
        vacantCondition: "○",
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
    roomInfoDto: { chargeType: "CHARGE_PER_HUMAN" },
    dayList: [
      { viewDay: "1", day: 1, stock: 0, price: 0, link: "", vacantCondition: null, monthClass: "thisMonth", isPast: false, isFull: true, isVacant: false },
      { viewDay: "2", day: 2, stock: 0, price: 0, link: "", vacantCondition: null, monthClass: "thisMonth", isPast: false, isFull: true, isVacant: false }
    ]
  })});`;

const row = (overrides: Partial<RakutenLiveHplanRow> = {}): RakutenLiveHplanRow => ({
  canonicalPropertyName: "蔵王国際ホテル",
  hotelNo: "5723",
  clickIndex: 0,
  calendarLinkText: "空室カレンダー",
  calendarLinkHref: "/hplan/calendar/?f_no=5723",
  capturedHplanUrl: "https://hotel.travel.rakuten.co.jp/hplan/calendar/?f_no=5723",
  capturedStatus: 200,
  capturedResponseType: "jsonp",
  liveAvailableDayCount: 1,
  livePricePositiveDayCount: 1,
  livePopulatedLinkCount: 1,
  phase62ParamGapCount: 3,
  classification: "live_hplan_response_positive",
  riskNote: "note",
  debugArtifactPath: ".data/debug/rakuten-live-hplan-capture/x/5723_click_0",
  ...overrides
});

describe("isHplanCalendarUrl", () => {
  it("detects /hplan/calendar/ URL", () => {
    expect(isHplanCalendarUrl("https://hotel.travel.rakuten.co.jp/hplan/calendar/?f_no=5723")).toBe(true);
    expect(isHplanCalendarUrl("https://hotel.travel.rakuten.co.jp/hotelinfo/plan/5723")).toBe(false);
  });
});

describe("parseHplanCalendarResponse (captured)", () => {
  it("parses a captured JSONP response", () => {
    const parsed = parseHplanCalendarResponse(positiveJsonp(), 200);
    expect(parsed.ok).toBe(true);
    expect(parsed.responseType).toBe("jsonp");
    expect(parsed.days[0]?.price).toBe(42000);
    expect(parsed.days[0]?.isVacant).toBe(true);
  });
});

describe("computeParamDiff", () => {
  it("computes param diff between live and reconstructed URL", () => {
    const live =
      "https://hotel.travel.rakuten.co.jp/hplan/calendar/?f_no=5723&f_syu=mitwin&f_calendar=20260601&f_kin=1&f_chiku=03&render=jsonp&callback=cbx&_=123";
    const reconstructed = buildHplanCalendarUrl({ hotelNo: "5723", fSyu: "mitwin", monthAnchor: "20260601" });
    const diff = computeParamDiff(live, reconstructed);
    // f_kin + f_chiku exist live but not in our reconstruction.
    const liveOnlyKeys = diff.onlyInLive.map((p) => p.key);
    expect(liveOnlyKeys).toEqual(expect.arrayContaining(["f_kin", "f_chiku"]));
    expect(diff.gapCount).toBeGreaterThanOrEqual(2);
    expect(diff.hostDiffers).toBe(false);
    expect(diff.pathDiffers).toBe(false);
  });

  it("reports zero gap when URLs share the same params", () => {
    const url = buildHplanCalendarUrl({ hotelNo: "5723", fSyu: "mitwin", monthAnchor: "20260601" });
    const diff = computeParamDiff(url, url);
    expect(diff.gapCount).toBe(0);
    expect(diff.onlyInLive).toEqual([]);
  });
});

describe("classifyLiveHplanCapture", () => {
  it("classifies live_hplan_response_positive", () => {
    expect(
      classifyLiveHplanCapture({
        requestCaptured: true,
        clickRegisteredEffect: true,
        parsed: parseHplanCalendarResponse(positiveJsonp(), 200)
      })
    ).toBe("live_hplan_response_positive");
  });

  it("classifies live_hplan_response_all_full", () => {
    expect(
      classifyLiveHplanCapture({
        requestCaptured: true,
        clickRegisteredEffect: true,
        parsed: parseHplanCalendarResponse(allFullJsonp(), 200)
      })
    ).toBe("live_hplan_response_all_full");
  });

  it("classifies live_hplan_request_not_emitted", () => {
    expect(
      classifyLiveHplanCapture({ requestCaptured: false, clickRegisteredEffect: true, parsed: null })
    ).toBe("live_hplan_request_not_emitted");
  });

  it("classifies calendar_click_no_effect", () => {
    expect(
      classifyLiveHplanCapture({ requestCaptured: false, clickRegisteredEffect: false, parsed: null })
    ).toBe("calendar_click_no_effect");
  });

  it("classifies blocked/empty responses", () => {
    expect(
      classifyLiveHplanCapture({
        requestCaptured: true,
        clickRegisteredEffect: true,
        parsed: parseHplanCalendarResponse("nope", 400)
      })
    ).toBe("live_hplan_response_blocked_or_failed");
    expect(
      classifyLiveHplanCapture({
        requestCaptured: true,
        clickRegisteredEffect: true,
        parsed: parseHplanCalendarResponse("", 200)
      })
    ).toBe("live_hplan_response_empty");
  });
});

describe("decideRakutenLiveHplan", () => {
  it("returns capture_ready with a positive captured response", () => {
    expect(
      decideRakutenLiveHplan({ classifications: ["live_hplan_response_positive"], anyParamGap: true })
    ).toBe("rakuten_live_hplan_capture_ready");
  });

  it("returns param_gap_identified when all-full but the live request differs", () => {
    expect(
      decideRakutenLiveHplan({ classifications: ["live_hplan_response_all_full"], anyParamGap: true })
    ).toBe("rakuten_live_hplan_param_gap_identified");
  });

  it("returns no_positive_inventory when all-full and no param gap", () => {
    expect(
      decideRakutenLiveHplan({ classifications: ["live_hplan_response_all_full"], anyParamGap: false })
    ).toBe("rakuten_live_hplan_no_positive_inventory");
  });

  it("returns not_ready when no request captured", () => {
    expect(
      decideRakutenLiveHplan({ classifications: ["calendar_click_no_effect"], anyParamGap: false })
    ).toBe("rakuten_live_hplan_not_ready");
  });
});

describe("renderRakutenLiveHplanCsv", () => {
  it("emits the fixed 15-column header with no PMS/upload/inventory columns", () => {
    const csv = renderRakutenLiveHplanCsv([row()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_LIVE_HPLAN_CSV_HEADERS.join(","));
    expect(RAKUTEN_LIVE_HPLAN_CSV_HEADERS.length).toBe(15);
    expect(header).not.toMatch(/roomid|inventory|multiplier|price[1-4]|beds24|airhost|upload|pms/iu);
  });
});

describe("probe script source", () => {
  it("does not perform any DB snapshot writes", () => {
    const source = readFileSync(resolve(__dirname, "../src/scripts/probeRakutenLiveHplanCapture.ts"), "utf-8");
    expect(source).not.toMatch(
      /INSERT INTO rate_snapshots|INSERT INTO inventory_snapshots|INSERT INTO collector_runs/iu
    );
  });
});
