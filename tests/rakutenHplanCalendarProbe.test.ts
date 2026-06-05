import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHplanCalendarUrl,
  classifyHplanCalendarEndpoint,
  decideRakutenHplanFeasibility,
  detectHplanResponseType,
  parseHplanCalendarResponse,
  parseHplanDaysFromHtml,
  RAKUTEN_HPLAN_CSV_HEADERS,
  renderRakutenHplanCsv,
  summarizeHplanDays,
  type RakutenHplanProbeRow
} from "../src/services/rakutenHplanCalendarProbe";

const jsonpPayload = (): string => {
  const base = {
    viewDate: "2026年06月",
    isEmpty: false,
    isTaxExclusive: false,
    vacantRoomCount: 1,
    hotelNo: 197787,
    roomCode: "",
    roomInfoDto: { chargeType: "PER_ROOM" },
    nextMonthCalendarUrl: "https://hotel.travel.rakuten.co.jp/hplan/calendar/?f_no=197787",
    dayList: [
      {
        viewDay: "1",
        day: 1748703600000,
        stock: 0,
        price: 0,
        priceWithoutTax: 0,
        discountedPrice: 0,
        link: null,
        vacantCondition: null,
        monthClass: "thisMonth",
        isPast: true,
        isFull: false,
        isVacant: false
      },
      {
        viewDay: "20",
        day: 1750345200000,
        stock: 2,
        price: 33000,
        priceWithoutTax: 30000,
        discountedPrice: 33000,
        link: "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?f_no=197787&f_hizuke=20260620",
        vacantCondition: "○",
        monthClass: "thisMonth",
        isPast: false,
        isFull: false,
        isVacant: true
      },
      {
        viewDay: "21",
        day: 1750431600000,
        stock: 0,
        price: 0,
        priceWithoutTax: 0,
        discountedPrice: 0,
        link: null,
        vacantCondition: "×",
        monthClass: "thisMonth",
        isPast: false,
        isFull: true,
        isVacant: false
      }
    ]
  };
  return `cb(${JSON.stringify(base)});`;
};

const allPastPayload = (): string =>
  `cb(${JSON.stringify({
    viewDate: "2026年06月",
    isEmpty: false,
    isTaxExclusive: false,
    vacantRoomCount: 1,
    hotelNo: 197787,
    roomInfoDto: { chargeType: "PER_ROOM" },
    dayList: [
      { viewDay: "1", day: 1, stock: 0, price: 0, link: null, vacantCondition: null, monthClass: "thisMonth", isPast: true, isFull: false, isVacant: false },
      { viewDay: "2", day: 2, stock: 0, price: 0, link: null, vacantCondition: null, monthClass: "thisMonth", isPast: true, isFull: false, isVacant: false }
    ]
  })});`;

const HTML_FRAGMENT = `
<table summary="宿泊プランの空室状況"><tbody>
  <tr>
    <td class=""><span class="thisMonth">1</span><span class="past">-</span></td>
    <td class=""><span class="thisMonth">20</span><a href="/hotelinfo/plan/?f_no=197787&amp;f_hizuke=20260620">○</a></td>
    <td class=""><span class="thisMonth">21</span><span class="full">×</span></td>
  </tr>
</tbody></table>`;

const row = (overrides: Partial<RakutenHplanProbeRow> = {}): RakutenHplanProbeRow => ({
  canonicalPropertyName: "ZAO BASE",
  hotelNo: "197787",
  fSyu: "zaobase",
  monthAnchor: "20260601",
  endpointUrl: "https://hotel.travel.rakuten.co.jp/hplan/calendar/?f_no=197787",
  reachable: true,
  responseType: "jsonp",
  availableDayLinksCount: 1,
  soldOutDayCount: 1,
  noPlanDayCount: 1,
  priceTextDetected: "33,000円",
  classification: "hplan_calendar_with_available_links",
  followedLinksCount: 1,
  bestFollowedClassification: "hplan_day_link_total_found",
  riskNote: "note",
  debugArtifactPath: ".data/debug/rakuten-hplan-calendar-probe/x/20260601",
  ...overrides
});

describe("buildHplanCalendarUrl", () => {
  const url = buildHplanCalendarUrl({ hotelNo: "197787", fSyu: "zaobase", monthAnchor: "20260601" });

  it("builds the hplan/calendar endpoint URL", () => {
    expect(url.startsWith("https://hotel.travel.rakuten.co.jp/hplan/calendar/")).toBe(true);
    expect(url).toContain("render=jsonp");
    expect(url).toContain("f_flg=PLAN");
    expect(url).toContain("f_calendar=20260601");
  });

  it("preserves f_no=197787", () => {
    expect(url).toContain("f_no=197787");
  });

  it("preserves f_syu=zaobase", () => {
    expect(url).toContain("f_syu=zaobase");
  });

  it("sets f_otona_su=2", () => {
    expect(url).toContain("f_otona_su=2");
  });

  it("sets f_heya_su=1", () => {
    expect(url).toContain("f_heya_su=1");
  });

  it("rejects a malformed month anchor", () => {
    expect(() => buildHplanCalendarUrl({ hotelNo: "197787", fSyu: "zaobase", monthAnchor: "2026-06" })).toThrow();
  });
});

describe("detectHplanResponseType", () => {
  it("detects jsonp", () => {
    expect(detectHplanResponseType(jsonpPayload(), 200)).toBe("jsonp");
  });
  it("detects empty", () => {
    expect(detectHplanResponseType("", 200)).toBe("empty");
  });
  it("detects blocked/error on HTTP 400", () => {
    expect(detectHplanResponseType("whatever", 400)).toBe("blocked_or_error");
  });
  it("detects html fragment", () => {
    expect(detectHplanResponseType(HTML_FRAGMENT, 200)).toBe("html_fragment");
  });
});

describe("parseHplanCalendarResponse (JSONP)", () => {
  const parsed = parseHplanCalendarResponse(jsonpPayload(), 200);

  it("parses the dayList and viewDate", () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.viewDate).toBe("2026年06月");
    expect(parsed.hotelNo).toBe("197787");
    expect(parsed.days.length).toBe(3);
  });

  it("treats price as tax-inclusive when isTaxExclusive=false", () => {
    expect(parsed.isTaxExclusive).toBe(false);
    const day20 = parsed.days.find((d) => d.viewDay === "20");
    expect(day20?.price).toBe(33000);
  });

  it("detects an available (bookable) day link", () => {
    const day20 = parsed.days.find((d) => d.viewDay === "20");
    expect(day20?.enabled).toBe(true);
    expect(day20?.link).toContain("f_hizuke=20260620");
  });

  it("marks past / full days as not enabled", () => {
    expect(parsed.days.find((d) => d.viewDay === "1")?.enabled).toBe(false);
    expect(parsed.days.find((d) => d.viewDay === "21")?.enabled).toBe(false);
  });
});

describe("parseHplanDaysFromHtml (fallback)", () => {
  it("parses HTML fragment day links", () => {
    const days = parseHplanDaysFromHtml(HTML_FRAGMENT);
    expect(days.map((d) => d.viewDay)).toEqual(["1", "20", "21"]);
    expect(days.find((d) => d.viewDay === "20")?.enabled).toBe(true);
    expect(days.find((d) => d.viewDay === "20")?.link).toContain("f_hizuke=20260620");
    expect(days.find((d) => d.viewDay === "21")?.enabled).toBe(false);
  });
});

describe("summarizeHplanDays", () => {
  it("counts available / sold-out / no-plan days and surfaces a price", () => {
    const summary = summarizeHplanDays(parseHplanCalendarResponse(jsonpPayload(), 200));
    expect(summary.availableCount).toBe(1);
    expect(summary.soldOutCount).toBe(1);
    expect(summary.noPlanCount).toBe(1);
    expect(summary.priceText).toBe("33,000円");
    expect(summary.enabledDays.length).toBe(1);
  });
});

describe("classifyHplanCalendarEndpoint", () => {
  it("classifies hplan_calendar_with_available_links", () => {
    const parsed = parseHplanCalendarResponse(jsonpPayload(), 200);
    expect(classifyHplanCalendarEndpoint({ reachable: true, parsed, availableLinkCount: 1 })).toBe(
      "hplan_calendar_with_available_links"
    );
  });

  it("classifies hplan_calendar_no_available_dates when all days are past/non-vacant", () => {
    const parsed = parseHplanCalendarResponse(allPastPayload(), 200);
    expect(classifyHplanCalendarEndpoint({ reachable: true, parsed, availableLinkCount: 0 })).toBe(
      "hplan_calendar_no_available_dates"
    );
  });

  it("classifies hplan_calendar_empty", () => {
    const parsed = parseHplanCalendarResponse("", 200);
    expect(classifyHplanCalendarEndpoint({ reachable: true, parsed, availableLinkCount: 0 })).toBe(
      "hplan_calendar_empty"
    );
  });

  it("classifies hplan_calendar_blocked_or_failed on HTTP 400", () => {
    const parsed = parseHplanCalendarResponse("nope", 400);
    expect(classifyHplanCalendarEndpoint({ reachable: true, parsed, availableLinkCount: 0 })).toBe(
      "hplan_calendar_blocked_or_failed"
    );
  });
});

describe("decideRakutenHplanFeasibility", () => {
  it("returns rakuten_hplan_ready when a followed link found a total", () => {
    expect(
      decideRakutenHplanFeasibility({
        endpointClassifications: ["hplan_calendar_with_available_links"],
        followedClassifications: ["hplan_day_link_total_found"]
      })
    ).toBe("rakuten_hplan_ready");
  });

  it("returns basis_mapping_needed when links are available but no total confirmed", () => {
    expect(
      decideRakutenHplanFeasibility({
        endpointClassifications: ["hplan_calendar_with_available_links"],
        followedClassifications: ["hplan_day_link_condition_page_reached"]
      })
    ).toBe("rakuten_hplan_basis_mapping_needed");
  });

  it("returns no_available_dates when reachable but every month is empty/sold out", () => {
    expect(
      decideRakutenHplanFeasibility({
        endpointClassifications: ["hplan_calendar_no_available_dates"],
        followedClassifications: []
      })
    ).toBe("rakuten_hplan_no_available_dates");
  });

  it("returns not_ready when the endpoint is blocked/empty", () => {
    expect(
      decideRakutenHplanFeasibility({
        endpointClassifications: ["hplan_calendar_blocked_or_failed"],
        followedClassifications: []
      })
    ).toBe("rakuten_hplan_not_ready");
  });
});

describe("renderRakutenHplanCsv", () => {
  it("emits the fixed 16-column header with no PMS/upload/inventory columns", () => {
    const csv = renderRakutenHplanCsv([row()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_HPLAN_CSV_HEADERS.join(","));
    expect(RAKUTEN_HPLAN_CSV_HEADERS.length).toBe(16);
    expect(header).not.toMatch(/roomid|inventory|multiplier|price[1-4]|beds24|airhost|upload|pms/iu);
  });
});

describe("probe script source", () => {
  it("does not perform any DB snapshot writes", () => {
    const source = readFileSync(resolve(__dirname, "../src/scripts/probeRakutenHplanCalendar.ts"), "utf-8");
    expect(source).not.toMatch(
      /INSERT INTO rate_snapshots|INSERT INTO inventory_snapshots|INSERT INTO collector_runs/iu
    );
  });
});
