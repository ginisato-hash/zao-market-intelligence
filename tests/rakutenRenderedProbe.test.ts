import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRakutenHotelUrl,
  classifyRakutenRenderedProbe,
  decideRakutenRenderedFeasibility,
  detectRakutenRenderedPriceBasis,
  extractRakutenHotelNo,
  normalizeRakutenPriceText,
  RAKUTEN_RENDERED_CSV_HEADERS,
  renderRakutenRenderedCsv,
  renderRakutenRenderedReport,
  type RakutenRenderedProbeRow,
  type RakutenRenderedSignals
} from "../src/services/rakutenRenderedProbe";

const signals = (overrides: Partial<RakutenRenderedSignals> = {}): RakutenRenderedSignals => ({
  reachable: true,
  accessIssue: false,
  noPlans: false,
  soldOut: false,
  dateScopeDetected: true,
  priceBasis: "none",
  ...overrides
});

const probeRow = (overrides: Partial<RakutenRenderedProbeRow> = {}): RakutenRenderedProbeRow => ({
  canonicalPropertyName: "ZAO BASE",
  hotelNo: "197787",
  stayDate: "2026-08-10",
  urlTested: "https://travel.rakuten.co.jp/HOTEL/197787/",
  reachable: true,
  renderedHotelName: "ＺＡＯ　ＢＡＳＥ",
  dateScopeDetected: true,
  roomCountDetected: "1",
  adultCountDetected: "2",
  nightCountDetected: "1",
  taxIncludedTotalDetected: "",
  perPersonPriceDetected: "6,000円",
  availabilityStatus: "available",
  classification: "rendered_per_person_only",
  riskNote: "note",
  debugArtifactPath: ".data/debug/rakuten-rendered-probe/x",
  ...overrides
});

describe("extractRakutenHotelNo", () => {
  it("extracts the hotelNo from a Rakuten HOTEL URL", () => {
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/5723/")).toBe("5723");
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/198027/")).toBe("198027");
  });

  it("rejects non-Rakuten URLs", () => {
    expect(extractRakutenHotelNo("https://www.jalan.net/yad328232/")).toBeNull();
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/abc/")).toBeNull();
  });
});

describe("buildRakutenHotelUrl", () => {
  it("builds the canonical first-party HOTEL URL", () => {
    expect(buildRakutenHotelUrl("5723")).toBe("https://travel.rakuten.co.jp/HOTEL/5723/");
  });

  it("rejects a non-numeric hotelNo", () => {
    expect(() => buildRakutenHotelUrl("abc")).toThrow(/invalid Rakuten hotelNo/u);
  });
});

describe("normalizeRakutenPriceText", () => {
  it("parses comma-separated yen amounts", () => {
    expect(normalizeRakutenPriceText("合計（税込）33,000円")).toBe(33_000);
    expect(normalizeRakutenPriceText("￥6,000")).toBe(6_000);
  });

  it("folds full-width digits and commas", () => {
    expect(normalizeRakutenPriceText("６，０００円")).toBe(6_000);
  });

  it("returns null when there is no amount", () => {
    expect(normalizeRakutenPriceText("空室なし")).toBeNull();
  });
});

describe("detectRakutenRenderedPriceBasis", () => {
  it("detects a date-scoped tax-included total", () => {
    const detection = detectRakutenRenderedPriceBasis(
      "2026年8月10日 プランA 合計（税込）33,000円 予約する"
    );
    expect(detection.basis).toBe("total_tax_included");
    expect(detection.taxIncludedTotalValue).toBe(33_000);
  });

  it("detects a per-person-only basis", () => {
    const detection = detectRakutenRenderedPriceBasis("2名利用時 6,000円/人 (消費税込)");
    expect(detection.basis).toBe("per_person_only");
    expect(detection.perPersonValue).toBe(6_000);
  });

  it("returns none when no price basis is present", () => {
    expect(detectRakutenRenderedPriceBasis("空室カレンダー 検索").basis).toBe("none");
  });
});

describe("classifyRakutenRenderedProbe", () => {
  it("classifies a date-scoped total", () => {
    expect(
      classifyRakutenRenderedProbe(signals({ priceBasis: "total_tax_included" }))
    ).toBe("rendered_date_scoped_total_found");
  });

  it("classifies a per-person-only page", () => {
    expect(
      classifyRakutenRenderedProbe(signals({ priceBasis: "per_person_only" }))
    ).toBe("rendered_per_person_only");
  });

  it("classifies a no-plans page", () => {
    expect(classifyRakutenRenderedProbe(signals({ noPlans: true }))).toBe("rendered_no_plans");
  });

  it("classifies a sold-out page", () => {
    expect(classifyRakutenRenderedProbe(signals({ soldOut: true }))).toBe("rendered_sold_out");
  });

  it("classifies date scope unverified", () => {
    expect(classifyRakutenRenderedProbe(signals({ dateScopeDetected: false }))).toBe(
      "date_scope_unverified"
    );
  });

  it("classifies basis unverified when reachable but no price basis", () => {
    expect(classifyRakutenRenderedProbe(signals({ priceBasis: "none" }))).toBe("basis_unverified");
  });

  it("classifies blocked/failed when unreachable", () => {
    expect(classifyRakutenRenderedProbe(signals({ reachable: false, accessIssue: true }))).toBe(
      "blocked_or_failed"
    );
  });
});

describe("decideRakutenRenderedFeasibility", () => {
  it("returns limited_rendered_collector_ready when a total is found", () => {
    expect(
      decideRakutenRenderedFeasibility(["blocked_or_failed", "rendered_date_scoped_total_found"])
    ).toBe("limited_rendered_collector_ready");
  });

  it("returns manual_browser_flow_needed when only per-person/unverified rows exist", () => {
    expect(decideRakutenRenderedFeasibility(["rendered_per_person_only", "date_scope_unverified"])).toBe(
      "manual_browser_flow_needed"
    );
  });

  it("returns not_ready when everything is blocked or no-plans", () => {
    expect(decideRakutenRenderedFeasibility(["blocked_or_failed", "rendered_no_plans"])).toBe(
      "not_ready"
    );
  });
});

describe("renderRakutenRenderedCsv", () => {
  it("emits the fixed header and no PMS/upload/inventory columns", () => {
    const csv = renderRakutenRenderedCsv([probeRow()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_RENDERED_CSV_HEADERS.join(","));
    expect(header).not.toMatch(/roomid|inventory|multiplier|price[1-4]|beds24|airhost|upload/iu);
  });
});

describe("renderRakutenRenderedReport", () => {
  it("includes an explicit decision and no PMS columns", () => {
    const report = renderRakutenRenderedReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      feasibilityCsvPath: "a.csv",
      validationCsvPath: "v.csv",
      priorFeasibilityReportPath: "p.md",
      debugRootPath: "d",
      rows: [probeRow()],
      decision: "manual_browser_flow_needed",
      executionNote: "completed rendered probe"
    });
    expect(report).toContain("feasibility_decision=manual_browser_flow_needed");
    expect(report).not.toMatch(/beds24|airhost|inventory_snapshots/iu);
  });
});

describe("probe script source", () => {
  it("does not perform any DB snapshot writes", () => {
    const source = readFileSync(
      resolve(__dirname, "../src/scripts/probeRakutenRenderedVacancy.ts"),
      "utf-8"
    );
    expect(source).not.toMatch(/rate_snapshots|inventory_snapshots|collector_runs|INSERT INTO/iu);
  });
});
