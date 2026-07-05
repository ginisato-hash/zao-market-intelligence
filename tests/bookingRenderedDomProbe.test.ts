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
  selectPrimaryBookingPriceCandidate,
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
    "ツインルーム", // room-card evidence: every real Booking room price sits
    "シングルベッド2台", // next to a room name/bed hint, never a bare number.
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
    const s = signals("蔵王国際ホテル 2026年8月10日 2026年8月11日 大人2名 1室 1泊 ツインルーム 料金 ￥404,800 税・手数料込み ".repeat(5));
    expect(s.notFoundDetected).toBe(false);
    expect(classifyBookingRenderedDom(s)).toBe("booking_rendered_price_basis_candidate_found");
  });

  it("HAMMOND regression: skips a stray low-value badge price and selects the real room-card price", () => {
    // Mirrors the real defect: a cashback/loyalty badge renders a ¥100 amount
    // BEFORE the actual room card in document order, with no room-name/bed-hint
    // text nearby. candidates[0] used to become the "primary" price (¥100, no
    // room name), which is exactly why HAMMOND rows showed empty room_name/
    // bed_hint and price=100.
    const text = [
      "HAMMOND / ハモンド",
      "今すぐ予約でキャッシュバック ￥100 相当のポイント還元",
      "2026年7月6日",
      "2026年7月7日",
      "大人2名",
      "1室",
      "1泊",
      "ツインルーム",
      "シングルベッド2台",
      "税・手数料込み",
      "￥14,245",
      "宿泊施設の説明と設備情報 ".repeat(20)
    ].join(" ");
    const s = analyzeBookingRenderedDomSignals({
      target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" },
      checkin: "2026-07-06",
      checkout: "2026-07-07",
      loaded: true,
      httpStatus: 200,
      finalUrl: "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html",
      pageTitle: "HAMMOND",
      bodyText: text
    });
    expect(s.priceCandidates.map((c) => c.numericValue)).toContain(100);
    expect(s.priceCandidates.map((c) => c.numericValue)).toContain(14245);
    expect(s.primaryPriceCandidate?.numericValue).toBe(14245);
    expect(s.primaryPriceCandidate?.numericValue).not.toBe(100);
    expect(s.primaryRoomName).not.toBe("");
    expect(s.primaryBedHint).not.toBe("");

    const row = buildBookingRenderedDomRow({
      target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" },
      checkin: "2026-07-06",
      checkout: "2026-07-07",
      probeUrl: "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html",
      signals: s,
      debugArtifactPath: "/tmp/x"
    });
    expect(row.firstPriceCandidateValue).toBe(14245);
    expect(row.roomBasis).toBe("confirmed_two_person_standard_room");
  });

  it("prefers the effective (現在の料金) sale price over the crossed-out original price, for the same room card", () => {
    // Matches the real HAMMOND page structure exactly: a bare was/now pair,
    // then the same two numbers again with explicit labels, then a standalone
    // tax line item that must not be mistaken for either price.
    const text = [
      "HAMMOND / ハモンド",
      "2026年7月6日", "2026年7月7日", "大人2名", "1室", "1泊",
      "エコノミー ツインルーム 当サイトでは残り1室 シングルベッド2台 18 平方メートル 人数: 2",
      "￥14,245 ￥11,019 元の料金 ￥14,245 現在の料金 ￥11,019 税・手数料込 23%OFF HOLIDAYセール 込 消費税/VAT10 %",
      "、 1泊につき¥150の入湯税 一部返金可",
      "宿泊施設の説明と設備情報 ".repeat(20)
    ].join(" ");
    const s = analyzeBookingRenderedDomSignals({
      target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" },
      checkin: "2026-07-06",
      checkout: "2026-07-07",
      loaded: true,
      httpStatus: 200,
      finalUrl: "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html",
      pageTitle: "HAMMOND",
      bodyText: text
    });
    expect(s.primaryPriceCandidate?.numericValue).toBe(11019);
    expect(s.originalPriceNumeric).toBe(14245);
    expect(s.priceDiscountDetected).toBe(true);
    expect(s.primaryRoomName).not.toBe("");
    expect(s.primaryBedHint).not.toBe("");
    // Neither the implausible badge-style ¥100 nor the ¥150 bathing tax must
    // ever be selectable as the primary/original price.
    expect(s.primaryPriceCandidate?.numericValue).not.toBe(150);
    expect(s.originalPriceNumeric).not.toBe(150);

    const row = buildBookingRenderedDomRow({
      target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" },
      checkin: "2026-07-06",
      checkout: "2026-07-07",
      probeUrl: "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html",
      signals: s,
      debugArtifactPath: "/tmp/x"
    });
    expect(row.firstPriceCandidateValue).toBe(11019);
    expect(row.roomBasis).toBe("confirmed_two_person_standard_room");
  });

  it("HAMMOND sold-out: excludes a related property's (OAKHILL) price from the carousel, never treats it as HAMMOND's own", () => {
    // Mirrors the real page captured live: HAMMOND has zero rooms for this
    // date, so Booking swaps in a "similar properties available" carousel of
    // OTHER hotels — each with its own plausible, room-context-adjacent price.
    // This is MORE dangerous than the ¥100 defect: a wrong price this
    // plausible would sail past every prior check.
    const text = [
      "HAMMOND",
      "蔵王温泉にあるHAMMONDは蔵王温泉スキー場から徒歩6分で、無料WiFiと無料専用駐車場を提供しています。",
      "現在当サイトでは、2026年7月11日～2026年7月12日の間にご提供できるこの宿泊施設の空室がありません。",
      "違う日程を選択してください。",
      "選択した日程で予約可能な類似施設",
      "ホテル",
      "Onsen & Stay OAKHILL",
      "8.6 すばらしい",
      "最安料金：",
      "￥22,550 ￥17,448 元の料金は￥22,550です。現在の料金は￥17,448です。",
      "ツインルーム",
      "シングルベッド2台",
      "旅館 名湯舎 創 8.3 とても良い 最安料金： ￥36,300 ￥28,314 元の料金は￥36,300です。現在の料金は￥28,314です。",
      "宿泊施設の説明と設備情報 ".repeat(10)
    ].join(" ");
    const s = analyzeBookingRenderedDomSignals({
      target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" },
      checkin: "2026-07-11",
      checkout: "2026-07-12",
      loaded: true,
      httpStatus: 200,
      finalUrl: "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html",
      pageTitle: "HAMMOND",
      bodyText: text
    });
    expect(s.primaryPriceCandidate).toBeNull();
    expect(s.primaryPriceCandidate?.numericValue).not.toBe(22550);
    expect(s.primaryPriceCandidate?.numericValue).not.toBe(17448);
    expect(s.primaryPriceCandidate?.numericValue).not.toBe(36300);
    expect(s.noUsableRoomPriceReason).toBe("related_property_price_excluded");
    expect(s.relatedPropertyPriceExcludedCount).toBeGreaterThan(0);
    expect(s.soldOutOrUnavailableDetected).toBe(true);

    const row = buildBookingRenderedDomRow({
      target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" },
      checkin: "2026-07-11",
      checkout: "2026-07-12",
      probeUrl: "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html",
      signals: s,
      debugArtifactPath: "/tmp/x"
    });
    expect(row.firstPriceCandidateValue).toBeNull();
    expect(row.roomBasis).toBe("unknown_room_basis");
    expect(row.classification).toBe("booking_rendered_sold_out_or_unavailable");
  });

  it("和室 (non-twin room name) with an explicit sale label is still selected as the primary price", () => {
    const text = ["HAMMOND", "2026年7月11日", "2026年7月12日", "大人2名", "1室", "1泊", "和室", "5組の布団", "現在の料金 ￥33,000"].join(" ");
    const s = analyzeBookingRenderedDomSignals({
      target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" },
      checkin: "2026-07-11",
      checkout: "2026-07-12",
      loaded: true,
      httpStatus: 200,
      finalUrl: "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html",
      pageTitle: "HAMMOND",
      bodyText: text
    });
    expect(s.primaryPriceCandidate?.numericValue).toBe(33000);
    expect(s.primaryRoomName).toBe("和室");
    const row = buildBookingRenderedDomRow({
      target: { canonicalPropertyName: "HAMMOND", slug: "hammond-takamiya" },
      checkin: "2026-07-11",
      checkout: "2026-07-12",
      probeUrl: "https://www.booking.com/hotel/jp/hammond-takamiya.ja.html",
      signals: s,
      debugArtifactPath: "/tmp/x"
    });
    expect(row.firstPriceCandidateValue).toBe(33000);
    expect(["confirmed_two_person_standard_room", "probable_two_person_standard_room"]).toContain(row.roomBasis);
  });

  it("no discount pairing on a regular page: primary is the normal price, original is null", () => {
    const s = signals(); // the existing single-price ￥64,790 fixture, no sale labels
    expect(s.primaryPriceCandidate?.numericValue).toBe(64790);
    expect(s.originalPriceNumeric).toBeNull();
    expect(s.priceDiscountDetected).toBe(false);
  });

  it("selectPrimaryBookingPriceCandidate returns no usable price when nothing is plausible (never invents evidence, no candidates[0] fallback)", () => {
    const text = "キャンペーン中 ￥50相当 ポイント ￥80相当 ポイント";
    const candidates = extractBookingPriceCandidates(text);
    const selection = selectPrimaryBookingPriceCandidate(text, candidates);
    expect(selection.selected).toBeNull();
    expect(selection.noUsableRoomPriceReason).toBe("no_main_room_card_price_candidate");
  });

  it("selectPrimaryBookingPriceCandidate returns null selection for zero candidates", () => {
    const selection = selectPrimaryBookingPriceCandidate("no prices here", []);
    expect(selection.selected).toBeNull();
    expect(selection.roomContext.primaryRoomName).toBe("");
    expect(selection.noUsableRoomPriceReason).toBe("no_main_room_card_price_candidate");
  });

  it("does not regress a normal single-price page (candidates[0] already correct)", () => {
    const s = signals();
    expect(s.primaryPriceCandidate?.numericValue).toBe(64790);
    expect(s.primaryPriceCandidate?.numericValue).toBe(s.priceCandidates[0]?.numericValue);
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
      bodyText: "Takamiya Ryokan Miyamaso 2026年8月10日 2026年8月11日 大人2名 1室 1泊 ツインルーム ￥68,000 税・手数料込み ".repeat(5)
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

describe("ROOM-LIVE - rendered DOM row extracts room context (A1)", () => {
  function rowFor(bodyText: string) {
    return buildBookingRenderedDomRow({
      target,
      checkin: "2026-08-10",
      checkout: "2026-08-11",
      probeUrl: "https://www.booking.com/hotel/jp/zao-kokusai.ja.html",
      signals: signals(bodyText),
      debugArtifactPath: "/tmp/x"
    });
  }

  it("twin room with two single beds classifies as confirmed two-person standard", () => {
    const body = [
      "蔵王国際ホテル", "2026年8月10日", "2026年8月11日", "1泊", "大人2名", "1室",
      "スタンダードツインルーム", "シングルベッド2台", "税・手数料込み", "￥24,000",
      "宿泊施設の説明 ".repeat(30)
    ].join(" ");
    const row = rowFor(body);
    expect(`${row.primaryRoomName} ${row.primaryRoomCardText} ${row.primaryBedHint}`).toMatch(/twin|ツイン|two beds|ベッド2台/u);
    expect(row.roomBasis).toBe("confirmed_two_person_standard_room");
  });

  it("single room classifies as excluded_single_room", () => {
    const body = ["蔵王国際ホテル", "2026年8月10日", "2026年8月11日", "1泊", "大人2名", "1室", "シングルルーム", "税・手数料込み", "￥12,000", "x ".repeat(200)].join(" ");
    expect(rowFor(body).roomBasis).toBe("excluded_single_room");
  });

  it("priced 2-adult page with NO room-type context anywhere is unknown_room_basis / no usable price (§related-property hardening)", () => {
    // A bare "available + priced + 2-adult" page with no room name/bed hint
    // near the price used to fall back to probable via the 2-adult default —
    // that exact "plausible price, no room evidence" fallback is the one this
    // task removes, because it's indistinguishable from a related-property
    // price landing on the page. No room evidence anywhere now means
    // no_usable_room_price, not a guessed probable classification.
    const body = ["蔵王国際ホテル", "2026年8月10日", "2026年8月11日", "1泊", "大人2名", "1室", "税・手数料込み", "￥64,790", "宿泊施設の説明と設備情報 ".repeat(30)].join(" ");
    const s = signals(body);
    expect(s.primaryPriceCandidate).toBeNull();
    expect(s.noUsableRoomPriceReason).toBe("room_context_missing");
    const row = rowFor(body);
    expect(row.firstPriceCandidateValue).toBeNull();
    expect(row.roomBasis).toBe("unknown_room_basis");
  });

  it("room name absent but bed hint 'シングルベッド2台' => confirmed via bed hint", () => {
    const body = [
      "蔵王国際ホテル", "2026年8月10日", "2026年8月11日", "1泊", "大人2名", "1室",
      "禁煙", "シングルベッド2台", "税・手数料込み", "￥24,000", "宿泊施設の説明 ".repeat(30)
    ].join(" ");
    const row = rowFor(body);
    expect(row.primaryBedHint).toMatch(/シングルベッド2台|ベッド2台|two beds/u);
    expect(row.roomBasis).toBe("confirmed_two_person_standard_room");
  });

  it("sold-out page with no price is not promoted to probable", () => {
    const body = ["蔵王国際ホテル", "2026年8月10日", "2026年8月11日", "1泊", "大人2名", "1室", "満室", "空室なし", "x ".repeat(200)].join(" ");
    const row = rowFor(body);
    expect(row.roomBasis).not.toBe("probable_two_person_standard_room");
    expect(row.roomBasis).not.toBe("confirmed_two_person_standard_room");
  });
});
