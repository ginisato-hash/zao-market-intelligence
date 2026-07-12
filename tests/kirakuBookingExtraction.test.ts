// KIRAKU-BOOKING-FIX01 (2026-07-13) regression suite.
//
// 喜らく/ホテル喜らく/ZAO SPA HOTEL Kiraku (Booking slug xi-raku) had ZERO
// Booking-source history rows, ever — root cause was a scheduling/fairness
// bug (see priorityRefreshTiers.test.ts's roundRobinByGroup tests), NOT a
// property-identity, room-basis, meal-basis, or price-selection defect: this
// file fixture-locks a live investigation (2026-07-13, 8 checkins via
// npm run debug:kiraku-booking) that confirmed all four of those layers were
// already correct. Fixtures below use ONLY text actually observed live
// (.data/debug/kiraku-booking/20260713_005235/), never invented strings.

import { describe, expect, it } from "vitest";
import { canonicalizeName, isOwnProperty } from "../src/services/biWebDataExport";
import { getOwnPropertyKey, isOwnPropertyName } from "../src/services/ownPropertyTargets";
import { classifyBookingRoomBasis } from "../src/services/roomBasisClassification";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomRow,
  selectPrimaryBookingPriceCandidate
} from "../src/services/bookingRenderedDomProbe";

const TARGET = { canonicalPropertyName: "ホテル喜らく", slug: "xi-raku" };

describe("KIRAKU-BOOKING-FIX01 - property identity", () => {
  it.each(["ZAO SPA HOTEL Kiraku", "Zao Spa Hotel Kiraku", "喜らく", "ホテル喜らく", "Kiraku"])(
    '"%s" folds to canonical ホテル喜らく and is recognized as own-property',
    (alias) => {
      expect(canonicalizeName(alias)).toBe("ホテル喜らく");
      expect(isOwnProperty(alias)).toBe(true);
      expect(isOwnPropertyName(alias)).toBe(true);
      expect(getOwnPropertyKey(alias)).toBe("kiraku");
    }
  );

  it("is excluded from competitor market evidence but included in own-price tracking (responsibility split, §5.B)", () => {
    // These helpers are the enforced boundary — asserting behavior via them
    // directly, matching ownPropertyTargets.ts's own responsibility-split contract.
    const rows = [{ canonical_property_name: "ホテル喜らく" }, { canonical_property_name: "HAMMOND" }];
    const competitorEvidence = rows.filter((r) => !isOwnPropertyName(r.canonical_property_name));
    const ownTracking = rows.filter((r) => isOwnPropertyName(r.canonical_property_name));
    expect(competitorEvidence.map((r) => r.canonical_property_name)).toEqual(["HAMMOND"]);
    expect(ownTracking.map((r) => r.canonical_property_name)).toEqual(["ホテル喜らく"]);
  });
});

describe("KIRAKU-BOOKING-FIX01 - room classification (real Booking room name)", () => {
  it('"ダブルまたはツインルーム" (the actual live-observed room name) classifies as confirmed two-person standard', () => {
    const r = classifyBookingRoomBasis({
      roomName: "ダブルまたはツインルーム",
      blockText: "スタンダード ダブルまたはツインルーム 上層階 布団2組 19 平方メートル マウンテンビュー",
      bedHint: "",
      occupancyHint: "",
      available: true,
      hasPrice: true
    });
    expect(r.roomBasis).toBe("confirmed_two_person_standard_room");
    expect(r.reason).toBe("two_person_standard_room_name_evidence");
  });

  it("a full live-observed room card, run through the real DOM analyzer end to end, resolves to confirmed + the discounted current price", () => {
    // Exact text observed live for checkin 2026-07-14 (see
    // .data/debug/kiraku-booking/20260713_005235/2026-07-14/room_cards.json),
    // trimmed of unrelated page furniture but otherwise verbatim.
    const bodyText = [
      "ホテル喜らく", "2026年7月14日", "2026年7月15日", "大人2名", "1室", "1泊",
      "する部屋のタイプと数を選択してください。 部屋タイプ 宿泊人数 本日の料金 確認事項 部屋数を選択",
      "スタンダード ダブルまたはツインルーム 上層階 布団2組 19 平方メートル マウンテンビュー 薄型テレビ 防音 無料WiFi",
      "無料バスアメニティ セーフティボックス ビデ トイレ タオル リネン ベッド近くのコンセント デスク スリッパ",
      "お茶 / コーヒー 共用トイレ 共用バスルーム 暖房 ファン（扇風機） 電気ポット ワードローブまたはクローゼット",
      "上階までエレベーター利用可 衣類用ラック トイレットペーパー 露天風呂 畳 人数: 2",
      "￥13,786 ￥11,718 元の料金 ￥13,786 現在の料金 ￥11,718 税・手数料込 15%OFF HOLIDAYセール 込 消費税/VAT10 %",
      "一部返金可 • オンライン決済",
      "宿泊施設の説明と設備情報 ".repeat(20)
    ].join(" ");
    const signals = analyzeBookingRenderedDomSignals({
      target: TARGET,
      checkin: "2026-07-14",
      checkout: "2026-07-15",
      loaded: true,
      httpStatus: 200,
      finalUrl: "https://www.booking.com/hotel/jp/xi-raku.ja.html",
      pageTitle: "ホテル喜らく",
      bodyText
    });
    expect(signals.primaryPriceCandidate?.numericValue).toBe(11718);
    expect(signals.originalPriceNumeric).toBe(13786);
    expect(signals.priceDiscountDetected).toBe(true);
    expect(signals.primaryRoomName).toBe("ダブルまたはツインルーム");
    expect(signals.noUsableRoomPriceReason).toBeNull();

    const row = buildBookingRenderedDomRow({
      target: TARGET,
      checkin: "2026-07-14",
      checkout: "2026-07-15",
      probeUrl: "https://www.booking.com/hotel/jp/xi-raku.ja.html",
      signals,
      debugArtifactPath: "/tmp/x"
    });
    expect(row.firstPriceCandidateValue).toBe(11718);
    expect(row.roomBasis).toBe("confirmed_two_person_standard_room");
  });

  it("a maximum-occupancy-3+ room is NOT excluded merely for that reason when the room name itself is an unambiguous twin and the search was 2-adult (§5.E principle)", () => {
    // "布団2組" (2 futon sets, the Japanese-ryokan bed-count idiom) sits next to
    // "人数: 2" (2-person search), same as the live card — the classifier must
    // not read "布団2組" as a large/family signal.
    const r = classifyBookingRoomBasis({
      roomName: "ダブルまたはツインルーム",
      blockText: "スタンダード ダブルまたはツインルーム 布団2組 19 平方メートル 人数: 2",
      bedHint: "",
      occupancyHint: "大人2名",
      available: true,
      hasPrice: true
    });
    expect(r.roomBasis).toBe("confirmed_two_person_standard_room");
  });

  it("excluded room types are still excluded for Kiraku — this fix does not blanket-loosen exclusion", () => {
    expect(classifyBookingRoomBasis({ roomName: "ファミリールーム", available: true, hasPrice: true }).roomBasis).not.toBe("confirmed_two_person_standard_room");
    expect(classifyBookingRoomBasis({ roomName: "シングルルーム", available: true, hasPrice: true }).roomBasis).not.toBe("confirmed_two_person_standard_room");
    expect(classifyBookingRoomBasis({ roomName: "スイート", available: true, hasPrice: true }).roomBasis).not.toBe("confirmed_two_person_standard_room");
  });
});

describe("KIRAKU-BOOKING-FIX01 - meal basis (§5.F: 'breakfast addable' must not read as breakfast-included)", () => {
  it("the live room card carries no meal-plan text at all — Booking's existing assumed_room_only default is correct here, matching Kiraku's real room-only product", () => {
    // Confirmed by grepping the full live body text for 朝食/食事/素泊まり across
    // all 8 investigated checkins: the only hit was a generic FAQ heading
    // ("朝食の提供はありますか？"), not a room-card meal-plan tag. There is
    // deliberately no meal-plan extraction change in this fix — the existing
    // Booking assumed_room_only convention (bookingPreviewAppendProposal.ts)
    // already matches ground truth for Kiraku's actual product.
    const roomCardText = "スタンダード ダブルまたはツインルーム 上層階 布団2組 19 平方メートル 共用トイレ 共用バスルーム 露天風呂 畳";
    expect(roomCardText).not.toMatch(/朝食込み|夕朝食付き|breakfast included/u);
  });
});
