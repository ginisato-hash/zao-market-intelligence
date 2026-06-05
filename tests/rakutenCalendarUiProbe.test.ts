import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCalendarUiProbe,
  decideCalendarUiFeasibility,
  detectCalendarPresence,
  detectDateScopedTotalEvidence,
  detectSoldOutOrNoPlan,
  extractCalendarLinksOrButtons,
  normalizeRakutenRenderedPrice,
  RAKUTEN_CALENDAR_UI_CSV_HEADERS,
  renderRakutenCalendarUiCsv,
  renderRakutenCalendarUiReport,
  type RakutenCalendarUiProbeRow,
  type RakutenCalendarUiSignals
} from "../src/services/rakutenCalendarUiProbe";

const signals = (overrides: Partial<RakutenCalendarUiSignals> = {}): RakutenCalendarUiSignals => ({
  reachable: true,
  accessIssue: false,
  soldOutOrNoPlan: false,
  calendarVisible: true,
  calendarClicked: true,
  dateClickAttempted: true,
  dateClickSucceeded: true,
  dateScopeDetected: true,
  totalFound: false,
  perPersonFound: false,
  ...overrides
});

const probeRow = (overrides: Partial<RakutenCalendarUiProbeRow> = {}): RakutenCalendarUiProbeRow => ({
  canonicalPropertyName: "ZAO BASE",
  hotelNo: "197787",
  stayDate: "2026-08-10",
  startUrl: "https://travel.rakuten.co.jp/HOTEL/197787/",
  calendarVisible: true,
  calendarClicked: true,
  dateClickAttempted: true,
  dateScopeDetected: false,
  roomCountDetected: "",
  adultCountDetected: "",
  nightCountDetected: "",
  taxIncludedTotalDetected: "",
  availabilityStatus: "unknown",
  classification: "calendar_visible_but_date_click_failed",
  riskNote: "note",
  debugArtifactPath: ".data/debug/rakuten-calendar-ui-probe/x",
  ...overrides
});

describe("normalizeRakutenRenderedPrice", () => {
  it("parses comma-separated and full-width yen", () => {
    expect(normalizeRakutenRenderedPrice("合計（税込）12,000円")).toBe(12_000);
    expect(normalizeRakutenRenderedPrice("１２，０００円")).toBe(12_000);
  });
  it("returns null without an amount", () => {
    expect(normalizeRakutenRenderedPrice("満室")).toBeNull();
  });
});

describe("detectCalendarPresence", () => {
  it("detects the vacancy calendar widget from text", () => {
    expect(detectCalendarPresence("2名利用時 6,000円/人 空室カレンダー")).toBe(true);
  });
  it("returns false when absent", () => {
    expect(detectCalendarPresence("宿泊プラン一覧")).toBe(false);
  });
});

describe("extractCalendarLinksOrButtons", () => {
  it("extracts distinct calendar labels", () => {
    expect(extractCalendarLinksOrButtons("空室カレンダー 料金カレンダー 空室カレンダー")).toEqual([
      "空室カレンダー",
      "料金カレンダー"
    ]);
  });
});

describe("detectDateScopedTotalEvidence", () => {
  it("detects a date-scoped tax-included total with 2 adults / 1 room / 1 night", () => {
    const evidence = detectDateScopedTotalEvidence({
      text: "2026年8月10日 大人2名 1室 1泊 プランA 合計（税込）33,000円 予約する",
      stayDate: "2026-08-10"
    });
    expect(evidence.dateScopeFound).toBe(true);
    expect(evidence.adultsFound).toBe(true);
    expect(evidence.roomsFound).toBe(true);
    expect(evidence.nightsFound).toBe(true);
    expect(evidence.totalFound).toBe(true);
    expect(evidence.totalValue).toBe(33_000);
  });

  it("detects a per-person-only basis without a total", () => {
    const evidence = detectDateScopedTotalEvidence({
      text: "2名利用時 6,000円/人 (消費税込)",
      stayDate: "2026-08-10"
    });
    expect(evidence.totalFound).toBe(false);
    expect(evidence.perPersonFound).toBe(true);
  });
});

describe("detectSoldOutOrNoPlan", () => {
  it("detects sold-out / no-plan markers", () => {
    expect(detectSoldOutOrNoPlan("満室")).toBe(true);
    expect(detectSoldOutOrNoPlan("該当するプランがありません")).toBe(true);
    expect(detectSoldOutOrNoPlan("予約する")).toBe(false);
  });
});

describe("classifyCalendarUiProbe", () => {
  it("classifies date_scoped_total_found", () => {
    expect(classifyCalendarUiProbe(signals({ totalFound: true }))).toBe("date_scoped_total_found");
  });

  it("classifies date_scoped_per_person_found", () => {
    expect(classifyCalendarUiProbe(signals({ perPersonFound: true }))).toBe(
      "date_scoped_per_person_found"
    );
  });

  it("classifies calendar_visible_but_date_click_failed", () => {
    expect(
      classifyCalendarUiProbe(signals({ dateScopeDetected: false, dateClickSucceeded: false }))
    ).toBe("calendar_visible_but_date_click_failed");
  });

  it("classifies calendar_visible_no_price", () => {
    expect(
      classifyCalendarUiProbe(
        signals({ dateScopeDetected: false, dateClickSucceeded: true, totalFound: false, perPersonFound: false })
      )
    ).toBe("calendar_visible_no_price");
  });

  it("classifies calendar_not_found", () => {
    expect(classifyCalendarUiProbe(signals({ calendarVisible: false }))).toBe("calendar_not_found");
  });

  it("classifies sold_out_or_no_plan", () => {
    expect(classifyCalendarUiProbe(signals({ soldOutOrNoPlan: true }))).toBe("sold_out_or_no_plan");
  });

  it("classifies blocked_or_failed when unreachable", () => {
    expect(classifyCalendarUiProbe(signals({ reachable: false, accessIssue: true }))).toBe(
      "blocked_or_failed"
    );
  });
});

describe("decideCalendarUiFeasibility", () => {
  it("returns limited_rendered_collector_ready when a total is found", () => {
    expect(decideCalendarUiFeasibility(["calendar_not_found", "date_scoped_total_found"])).toBe(
      "limited_rendered_collector_ready"
    );
  });
  it("returns manual_selector_mapping_needed when calendar reached without a total", () => {
    expect(decideCalendarUiFeasibility(["calendar_visible_but_date_click_failed"])).toBe(
      "manual_selector_mapping_needed"
    );
  });
  it("returns not_ready when nothing reached the calendar", () => {
    expect(decideCalendarUiFeasibility(["blocked_or_failed", "calendar_not_found"])).toBe("not_ready");
  });
});

describe("renderRakutenCalendarUiCsv", () => {
  it("emits the fixed header and no PMS/upload/inventory columns", () => {
    const csv = renderRakutenCalendarUiCsv([probeRow()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_CALENDAR_UI_CSV_HEADERS.join(","));
    expect(header).not.toMatch(/roomid|inventory|multiplier|price[1-4]|beds24|airhost|upload/iu);
  });
});

describe("renderRakutenCalendarUiReport", () => {
  it("includes an explicit decision and no PMS columns", () => {
    const report = renderRakutenCalendarUiReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      csvPath: "a.csv",
      priorRenderedProbeReportPath: "p.md",
      debugRootPath: "d",
      rows: [probeRow()],
      decision: "manual_selector_mapping_needed",
      executionNote: "completed calendar UI probe"
    });
    expect(report).toContain("feasibility_decision=manual_selector_mapping_needed");
    expect(report).not.toMatch(/beds24|airhost|inventory_snapshots/iu);
  });
});

describe("probe script source", () => {
  it("does not perform any DB snapshot writes", () => {
    const source = readFileSync(
      resolve(__dirname, "../src/scripts/probeRakutenCalendarUi.ts"),
      "utf-8"
    );
    expect(source).not.toMatch(/rate_snapshots|inventory_snapshots|collector_runs|INSERT INTO/iu);
  });
});
