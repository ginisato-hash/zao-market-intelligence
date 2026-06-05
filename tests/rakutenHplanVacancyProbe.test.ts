import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHplanCalendarUrl,
  classifyHplanFollowedLink,
  classifyHplanVacancyEndpoint,
  decideRakutenHplanVacancy,
  extractRoomCodesFromPlanPage,
  limitRoomCodes,
  parseHplanCalendarResponse,
  RAKUTEN_HPLAN_VACANCY_CSV_HEADERS,
  renderRakutenHplanVacancyCsv,
  summarizeVacancyDays,
  type RakutenHplanVacancyRow,
  type RakutenIframeEvidence
} from "../src/services/rakutenHplanVacancyProbe";

const PLAN_PAGE_HTML = `
<div class="planList">
  <div class="roomBlock">
    <h3>スタンダード和室 大人2名利用時</h3>
    <a href="/hplan/calendar/?f_no=5723&amp;f_syu=standardA&amp;f_otona_su=2">空室カレンダー</a>
  </div>
  <div class="roomBlock">
    <h3>露天風呂付き客室 2名</h3>
    <a href="https://hotel.travel.rakuten.co.jp/hplan/calendar/?f_no=5723&amp;f_syu=onsenSuite&amp;f_otona_su=2">空室カレンダー</a>
  </div>
  <div class="roomBlock">
    <h3>大部屋 1名専用</h3>
    <a href="/hplan/calendar/?f_no=5723&amp;f_syu=soloRoom">空室カレンダー</a>
  </div>
  <div class="roomBlock">
    <h3>もう一つの和室 2名</h3>
    <a href="/hplan/calendar/?f_no=5723&amp;f_syu=standardB&amp;f_otona_su=2">空室カレンダー</a>
  </div>
  <a href="/hotelinfo/access/5723">アクセス</a>
</div>`;

const evidence = (overrides: Partial<RakutenIframeEvidence> = {}): RakutenIframeEvidence => ({
  propertyDetected: true,
  dateScopeDetected: true,
  adultCountDetected: true,
  roomCountDetected: true,
  nightCountDetected: true,
  taxIncludedTotalDetected: true,
  taxIncludedTotalText: "33,000円",
  perPersonPriceDetected: false,
  perPersonPriceText: "",
  soldOutOrNoPlanDetected: false,
  availabilityStatus: "available",
  ...overrides
});

const dayListPayload = (
  days: { viewDay: string; price: number; link: string | null; isVacant: boolean; isFull?: boolean; isPast?: boolean }[]
): string =>
  `cb(${JSON.stringify({
    viewDate: "2026年06月",
    isEmpty: false,
    isTaxExclusive: false,
    vacantRoomCount: 1,
    hotelNo: 5723,
    roomCode: "standardA",
    roomInfoDto: { chargeType: "PER_ROOM" },
    dayList: days.map((d, i) => ({
      viewDay: d.viewDay,
      day: 1750000000000 + i * 86400000,
      stock: d.isVacant ? 2 : 0,
      price: d.price,
      priceWithoutTax: Math.round(d.price / 1.1),
      discountedPrice: d.price,
      link: d.link,
      vacantCondition: d.isVacant ? "○" : null,
      monthClass: "thisMonth",
      isPast: d.isPast ?? false,
      isFull: d.isFull ?? false,
      isVacant: d.isVacant
    }))
  })});`;

const row = (overrides: Partial<RakutenHplanVacancyRow> = {}): RakutenHplanVacancyRow => ({
  canonicalPropertyName: "蔵王国際ホテル",
  hotelNo: "5723",
  fSyu: "standardA",
  monthAnchor: "20260601",
  endpointUrl: "https://hotel.travel.rakuten.co.jp/hplan/calendar/?f_no=5723",
  reachable: true,
  responseType: "jsonp",
  isTaxExclusive: false,
  chargeType: "PER_ROOM",
  availableDayCount: 2,
  pricePositiveDayCount: 2,
  populatedLinkCount: 1,
  sampleAvailableDate: "20",
  samplePrice: 33000,
  sampleLink: "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?f_no=5723&f_hizuke=20260620",
  classification: "hplan_vacancy_positive",
  followedLinksCount: 1,
  bestFollowedClassification: "hplan_followed_total_found",
  riskNote: "note",
  debugArtifactPath: ".data/debug/rakuten-hplan-vacancy-positive-probe/x/5723_standardA_20260601",
  ...overrides
});

describe("extractRoomCodesFromPlanPage", () => {
  const codes = extractRoomCodesFromPlanPage(PLAN_PAGE_HTML);

  it("extracts multiple f_syu room codes from plan page calendar hrefs", () => {
    expect(codes.map((c) => c.fSyu)).toEqual(
      expect.arrayContaining(["standardA", "onsenSuite", "soloRoom", "standardB"])
    );
    expect(codes.length).toBe(4);
  });

  it("ignores non-calendar hrefs", () => {
    expect(codes.map((c) => c.fSyu)).not.toContain("access");
  });

  it("prioritizes room codes whose context mentions 2 adults", () => {
    // soloRoom (1名専用) must not be ranked ahead of the 2名 rooms.
    const soloIndex = codes.findIndex((c) => c.fSyu === "soloRoom");
    const twoAdultIndices = ["standardA", "onsenSuite", "standardB"].map((f) =>
      codes.findIndex((c) => c.fSyu === f)
    );
    for (const idx of twoAdultIndices) expect(idx).toBeLessThan(soloIndex);
  });
});

describe("limitRoomCodes", () => {
  it("limits room codes per property to 3", () => {
    expect(limitRoomCodes(["a", "b", "c", "d", "e"])).toEqual(["a", "b", "c"]);
  });
  it("dedupes while preserving order", () => {
    expect(limitRoomCodes(["a", "a", "b", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("buildHplanCalendarUrl", () => {
  it("builds hplan/calendar JSONP URL with f_calendar and render=jsonp", () => {
    const url = buildHplanCalendarUrl({ hotelNo: "5723", fSyu: "standardA", monthAnchor: "20260601" });
    expect(url).toContain("/hplan/calendar/");
    expect(url).toContain("f_calendar=20260601");
    expect(url).toContain("render=jsonp");
    expect(url).toContain("f_no=5723");
    expect(url).toContain("f_syu=standardA");
    expect(url).toContain("f_otona_su=2");
    expect(url).toContain("f_heya_su=1");
  });
});

describe("parseHplanCalendarResponse + summarizeVacancyDays", () => {
  it("parses the JSONP dayList", () => {
    const parsed = parseHplanCalendarResponse(
      dayListPayload([{ viewDay: "20", price: 33000, link: "https://x/plan?f_hizuke=20260620", isVacant: true }]),
      200
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.isTaxExclusive).toBe(false);
    expect(parsed.days.length).toBe(1);
    expect(parsed.days[0]?.price).toBe(33000);
  });

  it("summarizes available / price-positive / populated-link counts", () => {
    const parsed = parseHplanCalendarResponse(
      dayListPayload([
        { viewDay: "1", price: 0, link: null, isVacant: false, isPast: true },
        { viewDay: "20", price: 33000, link: "https://x/plan?f_hizuke=20260620", isVacant: true },
        { viewDay: "21", price: 28000, link: null, isVacant: true }
      ]),
      200
    );
    const summary = summarizeVacancyDays(parsed);
    expect(summary.availableDayCount).toBe(2);
    expect(summary.pricePositiveDayCount).toBe(2);
    expect(summary.populatedLinkCount).toBe(1);
    expect(summary.vacancyPositiveDays.length).toBe(1);
    expect(summary.samplePrice).toBe(33000);
    expect(summary.sampleAvailableDate).toBe("20");
  });
});

describe("classifyHplanVacancyEndpoint", () => {
  it("detects hplan_vacancy_positive when isVacant=true, price>0, link populated", () => {
    const parsed = parseHplanCalendarResponse(
      dayListPayload([{ viewDay: "20", price: 33000, link: "https://x/plan?f_hizuke=20260620", isVacant: true }]),
      200
    );
    expect(classifyHplanVacancyEndpoint({ reachable: true, parsed })).toBe("hplan_vacancy_positive");
  });

  it("detects hplan_price_positive_no_link", () => {
    const parsed = parseHplanCalendarResponse(
      dayListPayload([{ viewDay: "20", price: 33000, link: null, isVacant: true }]),
      200
    );
    expect(classifyHplanVacancyEndpoint({ reachable: true, parsed })).toBe("hplan_price_positive_no_link");
  });

  it("detects hplan_no_available_dates when all days are past/non-vacant", () => {
    const parsed = parseHplanCalendarResponse(
      dayListPayload([
        { viewDay: "1", price: 0, link: null, isVacant: false, isPast: true },
        { viewDay: "2", price: 0, link: null, isVacant: false, isPast: true }
      ]),
      200
    );
    expect(classifyHplanVacancyEndpoint({ reachable: true, parsed })).toBe("hplan_no_available_dates");
  });

  it("detects hplan_sold_out_or_no_plan when days are full", () => {
    const parsed = parseHplanCalendarResponse(
      dayListPayload([
        { viewDay: "1", price: 0, link: null, isVacant: false, isFull: true },
        { viewDay: "2", price: 0, link: null, isVacant: false, isFull: true }
      ]),
      200
    );
    expect(classifyHplanVacancyEndpoint({ reachable: true, parsed })).toBe("hplan_sold_out_or_no_plan");
  });

  it("detects hplan_empty / hplan_blocked_or_failed", () => {
    expect(
      classifyHplanVacancyEndpoint({ reachable: true, parsed: parseHplanCalendarResponse("", 200) })
    ).toBe("hplan_empty");
    expect(
      classifyHplanVacancyEndpoint({ reachable: true, parsed: parseHplanCalendarResponse("nope", 400) })
    ).toBe("hplan_blocked_or_failed");
    expect(
      classifyHplanVacancyEndpoint({ reachable: false, parsed: parseHplanCalendarResponse("", 0) })
    ).toBe("hplan_blocked_or_failed");
  });
});

describe("classifyHplanFollowedLink", () => {
  it("classifies followed total found", () => {
    expect(
      classifyHplanFollowedLink({
        reachable: true,
        conditionPageReached: true,
        noMatchingRoomType: false,
        evidence: evidence()
      })
    ).toBe("hplan_followed_total_found");
  });

  it("classifies condition page reached when no priced basis", () => {
    expect(
      classifyHplanFollowedLink({
        reachable: true,
        conditionPageReached: true,
        noMatchingRoomType: false,
        evidence: evidence({ taxIncludedTotalDetected: false, taxIncludedTotalText: "", perPersonPriceDetected: false })
      })
    ).toBe("hplan_followed_condition_page_reached");
  });

  it("classifies navigation failure", () => {
    expect(
      classifyHplanFollowedLink({
        reachable: false,
        conditionPageReached: false,
        noMatchingRoomType: false,
        evidence: evidence()
      })
    ).toBe("hplan_followed_navigation_failed");
  });
});

describe("decideRakutenHplanVacancy", () => {
  it("returns vacancy_ready with positive vacancy + a followed total", () => {
    expect(
      decideRakutenHplanVacancy({
        endpointClassifications: ["hplan_vacancy_positive"],
        followedClassifications: ["hplan_followed_total_found"]
      })
    ).toBe("rakuten_hplan_vacancy_ready");
  });

  it("returns basis_mapping_needed with positive data but unclear follow", () => {
    expect(
      decideRakutenHplanVacancy({
        endpointClassifications: ["hplan_vacancy_positive"],
        followedClassifications: ["hplan_followed_condition_page_reached"]
      })
    ).toBe("rakuten_hplan_vacancy_basis_mapping_needed");
  });

  it("returns not_found when endpoints work but no vacancy", () => {
    expect(
      decideRakutenHplanVacancy({
        endpointClassifications: ["hplan_no_available_dates", "hplan_sold_out_or_no_plan"],
        followedClassifications: []
      })
    ).toBe("rakuten_hplan_vacancy_not_found");
  });

  it("returns not_ready when every endpoint is blocked/failed", () => {
    expect(
      decideRakutenHplanVacancy({
        endpointClassifications: ["hplan_blocked_or_failed", "hplan_blocked_or_failed"],
        followedClassifications: []
      })
    ).toBe("rakuten_hplan_vacancy_not_ready");
  });
});

describe("renderRakutenHplanVacancyCsv", () => {
  it("emits the fixed 20-column header with no PMS/upload/inventory columns", () => {
    const csv = renderRakutenHplanVacancyCsv([row()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_HPLAN_VACANCY_CSV_HEADERS.join(","));
    expect(RAKUTEN_HPLAN_VACANCY_CSV_HEADERS.length).toBe(20);
    expect(header).not.toMatch(/roomid|inventory|multiplier|price[1-4]|beds24|airhost|upload|pms/iu);
  });
});

describe("probe script source", () => {
  it("does not perform any DB snapshot writes", () => {
    const source = readFileSync(resolve(__dirname, "../src/scripts/probeRakutenHplanVacancyPositive.ts"), "utf-8");
    expect(source).not.toMatch(
      /INSERT INTO rate_snapshots|INSERT INTO inventory_snapshots|INSERT INTO collector_runs/iu
    );
  });
});
