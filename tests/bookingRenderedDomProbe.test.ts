import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomRow,
  buildBookingRenderedDomUrl,
  checkoutForOneNight,
  classifyBookingRenderedDom,
  decideBookingRenderedDomFeasibility,
  extractBookingPriceCandidates,
  renderBookingRenderedDomCsv,
  renderBookingRenderedDomReport,
  sanitizeBookingUrl,
  type BookingRenderedDomTarget
} from "../src/services/bookingRenderedDomProbe";

const target: BookingRenderedDomTarget = {
  canonicalPropertyName: "蔵王国際ホテル",
  slug: "zao-kokusai"
};

function visibleText(): string {
  return [
    "蔵王国際ホテル",
    "2026年8月10日",
    "2026年8月11日",
    "1泊",
    "大人2名",
    "1室",
    "税・手数料込み",
    "￥64,790",
    "宿泊施設の説明と設備情報 ".repeat(30)
  ].join(" ");
}

function signals(text = visibleText()) {
  return analyzeBookingRenderedDomSignals({
    target,
    checkin: "2026-08-10",
    checkout: "2026-08-11",
    loaded: true,
    httpStatus: 200,
    finalUrl: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html?aid=secret&checkin=2026-08-10",
    pageTitle: "蔵王国際ホテル",
    bodyText: text
  });
}

describe("Booking URL helpers", () => {
  it("builds fixed date-scoped Booking URL with adults/rooms/currency/language", () => {
    const url = buildBookingRenderedDomUrl({ ...target, checkin: "2026-08-10" });
    expect(url).toContain("https://www.booking.com/hotel/jp/zao-kokusai.ja.html");
    expect(url).toContain("checkin=2026-08-10");
    expect(url).toContain("checkout=2026-08-11");
    expect(url).toContain("group_adults=2");
    expect(url).toContain("no_rooms=1");
    expect(url).toContain("group_children=0");
    expect(url).toContain("selected_currency=JPY");
    expect(url).toContain("lang=ja");
  });

  it("computes one-night checkout across month boundary", () => {
    expect(checkoutForOneNight("2026-08-31")).toBe("2026-09-01");
  });

  it("sanitizes tracking-like URL params", () => {
    const url = sanitizeBookingUrl("https://www.booking.com/hotel/jp/zao-kokusai.ja.html?aid=1&sid=abc&checkin=2026-08-10");
    expect(url).not.toContain("aid=");
    expect(url).not.toContain("sid=");
    expect(url).toContain("checkin=2026-08-10");
  });
});

describe("Booking rendered DOM extraction", () => {
  it("extracts JPY price candidates from Japanese text", () => {
    const candidates = extractBookingPriceCandidates("税・手数料込み ￥64,790 1泊 大人2名");
    expect(candidates[0]?.numericValue).toBe(64790);
    expect(candidates[0]?.candidateTypeGuess).toBe("total_tax_included");
  });

  it("detects date, people, room, night, currency, and price signals", () => {
    const s = signals();
    expect(s.propertyNameDetected).toBe(true);
    expect(s.checkinDetected).toBe(true);
    expect(s.checkoutDetected).toBe(true);
    expect(s.adultCountDetected).toBe(true);
    expect(s.roomCountDetected).toBe(true);
    expect(s.nightCountDetected).toBe(true);
    expect(s.jpyCurrencyDetected).toBe(true);
    expect(s.priceCandidates[0]?.numericValue).toBe(64790);
  });

  it("does not treat price values containing 404 as page-not-found", () => {
    const s = signals("蔵王国際ホテル 2026年8月10日 2026年8月11日 大人2名 1室 1泊 料金 ￥404,800 税・手数料込み ".repeat(5));
    expect(s.notFoundDetected).toBe(false);
    expect(classifyBookingRenderedDom(s)).toBe("booking_rendered_price_basis_candidate_found");
  });

  it("uses the first-party slug URL as a property identity signal when localized name differs", () => {
    const s = analyzeBookingRenderedDomSignals({
      target: { canonicalPropertyName: "深山荘 高見屋", slug: "shinzanso-takamiya" },
      checkin: "2026-08-10",
      checkout: "2026-08-11",
      loaded: true,
      httpStatus: 200,
      finalUrl: "https://www.booking.com/hotel/jp/shinzanso-takamiya.ja.html",
      pageTitle: "Takamiya Ryokan Miyamaso",
      bodyText: "Takamiya Ryokan Miyamaso 2026年8月10日 2026年8月11日 大人2名 1室 1泊 ￥68,000 税・手数料込み ".repeat(5)
    });
    expect(s.propertyNameDetected).toBe(true);
    expect(classifyBookingRenderedDom(s)).toBe("booking_rendered_price_basis_candidate_found");
  });
});

describe("classification and decision", () => {
  it("classifies complete rendered price basis candidates", () => {
    expect(classifyBookingRenderedDom(signals())).toBe("booking_rendered_price_basis_candidate_found");
  });

  it("classifies visible content without safe price as needs review", () => {
    expect(classifyBookingRenderedDom(signals("蔵王国際ホテル 2026年8月10日 コンテンツあり".repeat(30)))).toBe(
      "booking_rendered_content_visible_no_safe_price"
    );
  });

  it("classifies captcha/security and near-empty pages", () => {
    expect(classifyBookingRenderedDom(signals("Are you a robot? captcha ".repeat(30)))).toBe(
      "booking_rendered_captcha_or_security"
    );
    expect(classifyBookingRenderedDom(signals(""))).toBe("booking_rendered_empty_or_near_empty");
  });

  it("returns price_candidate_found decision when any row has candidate price basis", () => {
    const row = buildBookingRenderedDomRow({
      target,
      checkin: "2026-08-10",
      checkout: "2026-08-11",
      probeUrl: buildBookingRenderedDomUrl({ ...target, checkin: "2026-08-10" }),
      signals: signals(),
      debugArtifactPath: ".data/debug/booking-rendered-dom-probe/x"
    });
    expect(decideBookingRenderedDomFeasibility([row])).toBe("booking_rendered_dom_feasibility_price_candidate_found");
  });
});

describe("renderers and script safety", () => {
  const row = buildBookingRenderedDomRow({
    target,
    checkin: "2026-08-10",
    checkout: "2026-08-11",
    probeUrl: buildBookingRenderedDomUrl({ ...target, checkin: "2026-08-10" }),
    signals: signals(),
    debugArtifactPath: ".data/debug/booking-rendered-dom-probe/x"
  });

  it("renders CSV without upload/PMS columns", () => {
    const header = renderBookingRenderedDomCsv([row]).split("\n")[0] ?? "";
    for (const forbidden of ["roomid", "inventory", "minstay", "maxstay", "multiplier", "price1", "price2", "Beds24", "AirHost", "PMS"]) {
      expect(header).not.toContain(forbidden);
    }
    expect(header).toContain("price_candidate_count");
  });

  it("renders report with safety confirmation", () => {
    const report = renderBookingRenderedDomReport({
      generatedAt: "2026-06-01T00:00:00.000Z",
      rows: [row],
      decision: "booking_rendered_dom_feasibility_price_candidate_found",
      reportPath: ".data/reports/booking.md",
      csvPath: ".data/reports/booking.csv",
      debugRootPath: ".data/debug/booking"
    });
    expect(report).toContain("No DB writes");
    expect(report).toContain("no stealth");
  });

  it("script does not contain DB insert statements", () => {
    const source = readFileSync(resolve("src/scripts/probeBookingRenderedDom.ts"), "utf8");
    expect(source).not.toMatch(/INSERT\s+INTO\s+rate_snapshots/iu);
    expect(source).not.toMatch(/INSERT\s+INTO\s+inventory_snapshots/iu);
    expect(source).not.toMatch(/INSERT\s+INTO\s+collector_runs/iu);
  });
});
