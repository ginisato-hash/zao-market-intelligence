import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRakutenHotelPlanUrl,
  buildRakutenIframeUrlForDate,
  classifyRakutenIframeProbe,
  decideRakutenIframeFeasibility,
  detectIframeDateScopedTotalEvidence,
  detectIframePerPersonEvidence,
  detectIframeSoldOutOrNoPlan,
  extractRakutenHotelNo,
  extractTwoPersonCalendarHref,
  normalizeRakutenPriceText,
  parseRakutenIframeParams,
  RAKUTEN_IFRAME_CSV_HEADERS,
  renderRakutenIframeProbeCsv,
  type RakutenIframeEvidence,
  type RakutenIframeProbeRow
} from "../src/services/rakutenIframeProbe";

const sampleHref =
  "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?TB_iframe=true&f_no=197787&f_otona_su=2&f_heya_su=1&f_hizuke=20260426&f_hak=&f_syu=zaobase3&f_thick=1&width=1024&height=768";

function evidence(overrides: Partial<RakutenIframeEvidence> = {}): RakutenIframeEvidence {
  return {
    propertyDetected: true,
    dateScopeDetected: true,
    adultCountDetected: true,
    roomCountDetected: true,
    nightCountDetected: true,
    taxIncludedTotalDetected: false,
    taxIncludedTotalText: "",
    perPersonPriceDetected: false,
    perPersonPriceText: "",
    soldOutOrNoPlanDetected: false,
    availabilityStatus: "available",
    ...overrides
  };
}

function row(overrides: Partial<RakutenIframeProbeRow> = {}): RakutenIframeProbeRow {
  return {
    canonicalPropertyName: "ZAO BASE",
    hotelNo: "197787",
    stayDate: "2026-08-10",
    planUrl: "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/197787",
    extractedCalendarHref: sampleHref,
    generatedIframeUrl: sampleHref,
    iframeReachable: true,
    dateScopeDetected: true,
    roomCountDetected: true,
    adultCountDetected: true,
    nightCountDetected: true,
    taxIncludedTotalDetected: "33,000円",
    perPersonPriceDetected: "",
    availabilityStatus: "available",
    classification: "iframe_date_scoped_total_found",
    riskNote: "note",
    debugArtifactPath: ".data/debug/rakuten-iframe-probe/x",
    ...overrides
  };
}

describe("Rakuten iframe URL helpers", () => {
  it("extracts Rakuten hotelNo values", () => {
    expect(extractRakutenHotelNo("https://travel.rakuten.co.jp/HOTEL/197787/")).toBe("197787");
    expect(extractRakutenHotelNo("https://hotel.travel.rakuten.co.jp/hotelinfo/plan/5723")).toBe("5723");
    expect(extractRakutenHotelNo("https://www.jalan.net/yad123456/")).toBeNull();
  });

  it("builds Rakuten plan URL", () => {
    expect(buildRakutenHotelPlanUrl("197787")).toBe(
      "https://hotel.travel.rakuten.co.jp/hotelinfo/plan/197787"
    );
    expect(() => buildRakutenHotelPlanUrl("abc")).toThrow(/invalid Rakuten hotelNo/u);
  });

  it("extracts a 2名利用時 calendar href from sample HTML", () => {
    const html = `
      <section>
        <p>1名利用時 8,000円/人 <a href="/hotelinfo/plan/?f_no=197787&f_syu=single&TB_iframe=true&f_thick=1">空室カレンダー</a></p>
        <p>2名利用時 7,000円/人 <a href="${sampleHref.replace(/&/gu, "&amp;")}">空室カレンダー</a></p>
      </section>
    `;
    expect(extractTwoPersonCalendarHref(html)).toBe(sampleHref);
  });

  it("parses iframe params", () => {
    expect(parseRakutenIframeParams(sampleHref)).toEqual({
      fNo: "197787",
      fOtonaSu: "2",
      fHeyaSu: "1",
      fSyu: "zaobase3",
      fHizuke: "20260426",
      fHak: "",
      tbIframe: "true",
      fThick: "1"
    });
  });

  it("rebuilds iframe URL for target date while preserving f_syu and setting f_hak=1", () => {
    const rebuilt = buildRakutenIframeUrlForDate(sampleHref, "2026-08-10");
    const params = parseRakutenIframeParams(rebuilt);
    expect(params.fHizuke).toBe("20260810");
    expect(params.fHak).toBe("1");
    expect(params.fSyu).toBe("zaobase3");
    expect(params.fOtonaSu).toBe("2");
    expect(params.fHeyaSu).toBe("1");
    expect(params.tbIframe).toBe("true");
    expect(params.fThick).toBe("1");
  });

  it("refuses to guess f_syu", () => {
    expect(() =>
      buildRakutenIframeUrlForDate("https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?f_no=197787", "2026-08-10")
    ).toThrow(/missing f_syu/u);
  });
});

describe("Rakuten iframe evidence and classification", () => {
  it("detects date-scoped total evidence", () => {
    const detected = detectIframeDateScopedTotalEvidence({
      canonicalPropertyName: "ZAO BASE",
      stayDate: "2026-08-10",
      text: "ＺＡＯ　ＢＡＳＥ 2026年8月10日 大人2名 1室 1泊 合計（税込）33,000円 予約する"
    });
    expect(detected.propertyDetected).toBe(true);
    expect(detected.dateScopeDetected).toBe(true);
    expect(detected.adultCountDetected).toBe(true);
    expect(detected.roomCountDetected).toBe(true);
    expect(detected.nightCountDetected).toBe(true);
    expect(detected.taxIncludedTotalDetected).toBe(true);
    expect(normalizeRakutenPriceText(detected.taxIncludedTotalText)).toBe(33_000);
  });

  it("detects per-person-only evidence", () => {
    expect(detectIframePerPersonEvidence("2026年8月10日 2名利用時 12,000円/人")).toEqual({
      detected: true,
      text: "12,000円"
    });
  });

  it("classifies no-plan/sold-out iframe", () => {
    expect(detectIframeSoldOutOrNoPlan("該当するプランがありません")).toBe(true);
    expect(
      classifyRakutenIframeProbe({
        iframeReachable: true,
        evidence: evidence({ soldOutOrNoPlanDetected: true, availabilityStatus: "sold_out_or_no_plan" })
      })
    ).toBe("iframe_no_plan_or_sold_out");
  });

  it("classifies iframe URL failure", () => {
    expect(classifyRakutenIframeProbe({ iframeReachable: false, evidence: evidence() })).toBe(
      "iframe_url_failed"
    );
  });

  it("classifies date-scoped total and per-person-only rows", () => {
    expect(
      classifyRakutenIframeProbe({
        iframeReachable: true,
        evidence: evidence({ taxIncludedTotalDetected: true, taxIncludedTotalText: "33,000円" })
      })
    ).toBe("iframe_date_scoped_total_found");
    expect(
      classifyRakutenIframeProbe({
        iframeReachable: true,
        evidence: evidence({ taxIncludedTotalDetected: false, perPersonPriceDetected: true, perPersonPriceText: "12,000円" })
      })
    ).toBe("iframe_date_scoped_per_person_found");
  });

  it("decides feasibility from classifications", () => {
    expect(decideRakutenIframeFeasibility(["iframe_date_scoped_total_found"])).toBe(
      "limited_iframe_collector_ready"
    );
    expect(decideRakutenIframeFeasibility(["iframe_date_scoped_per_person_found"])).toBe(
      "iframe_basis_mapping_needed"
    );
    expect(decideRakutenIframeFeasibility(["iframe_url_failed", "iframe_date_scope_unverified"])).toBe(
      "not_ready"
    );
  });
});

describe("Rakuten iframe CSV and safety", () => {
  it("renders CSV without upload/PMS columns", () => {
    const csv = renderRakutenIframeProbeCsv([row()]);
    const header = csv.split("\n")[0] ?? "";
    expect(header).toBe(RAKUTEN_IFRAME_CSV_HEADERS.join(","));
    expect(header).not.toMatch(/roomid|inventory|multiplier|price1|price2|price3|price4|Beds24|AirHost|upload|PMS/iu);
  });

  it("script/source does not contain DB snapshot inserts", () => {
    const service = readFileSync(resolve("src/services/rakutenIframeProbe.ts"), "utf-8");
    const script = readFileSync(resolve("src/scripts/probeRakutenIframeUrl.ts"), "utf-8");
    const combined = `${service}\n${script}`;
    expect(combined).not.toContain("INSERT INTO rate_snapshots");
    expect(combined).not.toContain("INSERT INTO inventory_snapshots");
    expect(combined).not.toContain("INSERT INTO collector_runs");
  });
});
