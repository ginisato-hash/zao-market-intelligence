import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyRakutenDayLink,
  decideRakutenDayLinkFeasibility,
  detectConditionPage,
  extractCalendarMonth,
  extractDayLinksFromCalendarHtml,
  isCalendarDayCellEnabled,
  RAKUTEN_DAY_LINK_CSV_HEADERS,
  renderRakutenDayLinkCsv,
  vacancyIndicatesAvailable,
  type RakutenDayLinkProbeRow,
  type RakutenIframeEvidence
} from "../src/services/rakutenDayLinkProbe";

const SAMPLE_CALENDAR_HTML = `
<div id="roomCalendar">
  <div class="calHeader"><ul id="calMonthPaging"><li class="targetMonth">2026年06月</li></ul></div>
  <table summary="宿泊プランの空室状況を表示しています。"><tbody>
    <tr><th scope="col" class="calHoliday">日</th><th>月</th></tr>
    <tr>
      <td class="calHoliday"><span class="lastMonth">5/31</span><span class="past">-</span></td>
      <td class=""><span class="thisMonth">1</span><span class="past">-</span></td>
      <td class=""><span class="thisMonth">20</span><a href="/hotelinfo/plan/?f_no=197787&amp;f_syu=zaobase&amp;f_hizuke=20260620&amp;f_otona_su=2&amp;f_heya_su=1&amp;TB_iframe=true&amp;f_thick=1">○</a></td>
      <td class=""><span class="thisMonth">21</span><span class="full">×</span></td>
      <td class=""><span class="thisMonth">22</span><a href="/hotelinfo/plan/?f_no=197787&amp;f_syu=zaobase&amp;f_hizuke=20260622&amp;f_otona_su=2">3</a></td>
    </tr>
  </tbody></table>
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

const row = (overrides: Partial<RakutenDayLinkProbeRow> = {}): RakutenDayLinkProbeRow => ({
  canonicalPropertyName: "ZAO BASE",
  hotelNo: "197787",
  liveFSyu: "zaobase",
  calendarMonth: "2026-06",
  day: "20",
  dayLinkVisibleText: "○",
  dayLinkHref: "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?f_no=197787",
  dayLinkOnclick: "",
  dayLinkEnabled: true,
  followedUrl: "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?f_no=197787",
  reachable: true,
  dateScopeDetected: true,
  roomCountDetected: true,
  adultCountDetected: true,
  nightCountDetected: true,
  taxIncludedTotalDetected: "33,000円",
  perPersonPriceDetected: "",
  availabilityStatus: "available",
  classification: "day_link_total_found",
  riskNote: "note",
  debugArtifactPath: ".data/debug/rakuten-day-link-probe/x/day_20",
  ...overrides
});

describe("extractDayLinksFromCalendarHtml", () => {
  const cells = extractDayLinksFromCalendarHtml(SAMPLE_CALENDAR_HTML);

  it("extracts one cell per in-month day (skips padding/header)", () => {
    expect(cells.map((c) => c.day)).toEqual(["1", "20", "21", "22"]);
  });

  it("captures the href on available day cells", () => {
    const day20 = cells.find((c) => c.day === "20");
    expect(day20?.href).toContain("f_hizuke=20260620");
    expect(day20?.href).toContain("f_syu=zaobase");
    expect(day20?.href.startsWith("https://hotel.travel.rakuten.co.jp")).toBe(true);
  });

  it("captures the visible vacancy marker", () => {
    expect(cells.find((c) => c.day === "1")?.visibleText).toBe("-");
    expect(cells.find((c) => c.day === "20")?.visibleText).toBe("○");
    expect(cells.find((c) => c.day === "21")?.visibleText).toBe("×");
    expect(cells.find((c) => c.day === "22")?.visibleText).toBe("3");
  });
});

describe("enabled / disabled day-cell detection", () => {
  const cells = extractDayLinksFromCalendarHtml(SAMPLE_CALENDAR_HTML);

  it("detects enabled (clickable + available) day links", () => {
    expect(cells.find((c) => c.day === "20")?.enabled).toBe(true);
    expect(cells.find((c) => c.day === "22")?.enabled).toBe(true);
  });

  it("detects disabled / unavailable cells (-, ×, no link)", () => {
    expect(cells.find((c) => c.day === "1")?.enabled).toBe(false);
    expect(cells.find((c) => c.day === "21")?.enabled).toBe(false);
  });

  it("vacancyIndicatesAvailable treats -/× as unavailable and ○/count as available", () => {
    expect(vacancyIndicatesAvailable("-")).toBe(false);
    expect(vacancyIndicatesAvailable("×")).toBe(false);
    expect(vacancyIndicatesAvailable("")).toBe(false);
    expect(vacancyIndicatesAvailable("○")).toBe(true);
    expect(vacancyIndicatesAvailable("3")).toBe(true);
  });

  it("requires a real click target", () => {
    expect(isCalendarDayCellEnabled({ visibleText: "○", href: "", onclick: "" })).toBe(false);
    expect(isCalendarDayCellEnabled({ visibleText: "○", href: "javascript:void(0);", onclick: "" })).toBe(false);
    expect(isCalendarDayCellEnabled({ visibleText: "○", href: "", onclick: "go();" })).toBe(true);
  });
});

describe("extractCalendarMonth", () => {
  it("parses the target month label", () => {
    expect(extractCalendarMonth("2026年06月 次の1ヶ月")).toBe("2026-06");
    expect(extractCalendarMonth("2026年6月")).toBe("2026-06");
  });
  it("returns empty when no month label present", () => {
    expect(extractCalendarMonth("no month here")).toBe("");
  });
});

describe("detectConditionPage", () => {
  it("detects reservation condition-setting page markers", () => {
    expect(detectConditionPage("ご利用人数 2名 チェックイン日 2026年6月20日")).toBe(true);
    expect(detectConditionPage("宿泊予約のお申し込み")).toBe(true);
  });
  it("returns false for unrelated text", () => {
    expect(detectConditionPage("補助メニュー 会社情報")).toBe(false);
  });
});

describe("classifyRakutenDayLink", () => {
  it("classifies disabled / unfollowed cells", () => {
    expect(
      classifyRakutenDayLink({
        enabled: false,
        followed: false,
        reachable: false,
        conditionPageReached: false,
        noMatchingRoomType: false,
        evidence: evidence()
      })
    ).toBe("day_link_disabled_or_unavailable");
  });

  it("classifies navigation failure", () => {
    expect(
      classifyRakutenDayLink({
        enabled: true,
        followed: true,
        reachable: false,
        conditionPageReached: false,
        noMatchingRoomType: false,
        evidence: evidence()
      })
    ).toBe("day_link_navigation_failed");
  });

  it("classifies day_link_total_found with full date-scoped basis", () => {
    expect(
      classifyRakutenDayLink({
        enabled: true,
        followed: true,
        reachable: true,
        conditionPageReached: true,
        noMatchingRoomType: false,
        evidence: evidence()
      })
    ).toBe("day_link_total_found");
  });

  it("classifies day_link_condition_page_reached when reached but no priced basis", () => {
    expect(
      classifyRakutenDayLink({
        enabled: true,
        followed: true,
        reachable: true,
        conditionPageReached: true,
        noMatchingRoomType: false,
        evidence: evidence({
          taxIncludedTotalDetected: false,
          taxIncludedTotalText: "",
          perPersonPriceDetected: false,
          perPersonPriceText: ""
        })
      })
    ).toBe("day_link_condition_page_reached");
  });

  it("classifies no-plan/sold-out result", () => {
    expect(
      classifyRakutenDayLink({
        enabled: true,
        followed: true,
        reachable: true,
        conditionPageReached: false,
        noMatchingRoomType: true,
        evidence: evidence({ taxIncludedTotalDetected: false, taxIncludedTotalText: "" })
      })
    ).toBe("day_link_no_plan_or_sold_out");
  });
});

describe("decideRakutenDayLinkFeasibility", () => {
  it("returns rakuten_day_link_ready when a total is found", () => {
    expect(
      decideRakutenDayLinkFeasibility({
        gridRendered: true,
        enabledLinkCount: 1,
        classifications: ["day_link_total_found"]
      })
    ).toBe("rakuten_day_link_ready");
  });

  it("returns basis_mapping_needed when the condition page is reached", () => {
    expect(
      decideRakutenDayLinkFeasibility({
        gridRendered: true,
        enabledLinkCount: 1,
        classifications: ["day_link_condition_page_reached"]
      })
    ).toBe("rakuten_day_link_basis_mapping_needed");
  });

  it("returns no_available_dates when grid rendered but no enabled links", () => {
    expect(
      decideRakutenDayLinkFeasibility({
        gridRendered: true,
        enabledLinkCount: 0,
        classifications: ["day_link_disabled_or_unavailable"]
      })
    ).toBe("rakuten_day_link_no_available_dates");
  });

  it("returns not_ready when the grid could not be parsed", () => {
    expect(
      decideRakutenDayLinkFeasibility({
        gridRendered: false,
        enabledLinkCount: 0,
        classifications: ["day_link_navigation_failed"]
      })
    ).toBe("rakuten_day_link_not_ready");
  });
});

describe("renderRakutenDayLinkCsv", () => {
  it("emits the fixed header and no PMS/upload/inventory columns", () => {
    const csv = renderRakutenDayLinkCsv([row()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_DAY_LINK_CSV_HEADERS.join(","));
    expect(header).not.toMatch(/roomid|inventory|multiplier|price[1-4]|beds24|airhost|upload/iu);
  });
});

describe("probe script source", () => {
  it("does not perform any DB snapshot writes", () => {
    const source = readFileSync(resolve(__dirname, "../src/scripts/probeRakutenDayLinks.ts"), "utf-8");
    expect(source).not.toMatch(
      /INSERT INTO rate_snapshots|INSERT INTO inventory_snapshots|INSERT INTO collector_runs/iu
    );
  });
});
