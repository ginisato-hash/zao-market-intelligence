// KIRAKU-BOOKING-FIX01 (2026-07-13) regression suite.
//
// 喜らく/ホテル喜らく/ZAO SPA HOTEL Kiraku (Booking slug xi-raku) had ZERO
// Booking-source history rows, ever. THREE independent root causes:
//   1. A scheduling/fairness bug (see priorityRefreshTiers.test.ts's
//      roundRobinByGroup tests) — property-identity, room-basis, meal-basis,
//      and price-selection were already correct in an isolated investigation.
//   2. A room-context extraction bug, only exposed once (1) was fixed and
//      live batch collection actually reached Kiraku: bookingRoomContextExtraction.ts's
//      extractBookingRoomContextAroundPrice used non-global regex .exec(),
//      which returns the FIRST match in the price-adjacent text window — but
//      Kiraku's real page has an earlier, unrelated "人気施設・設備" amenity
//      badge mentioning "ファミリールーム" ~280 chars before the actual,
//      correct room card ("ダブルまたはツインルーム"). Fixed by taking the
//      LAST match in the window (closest to the price) instead of the first;
//      see the "REGRESSION" test below and the lastMatch() helper.
//   3. A classification gate bug, only exposed once (1) AND (2) were fixed and
//      a real production append run reached Kiraku: bookingRenderedDomProbe.ts's
//      classifyBookingRenderedDom required a literal "1泊" ("1 night") text
//      match (nightCountDetected) before accepting ANY price — but Kiraku's
//      real page never renders that label at all (only the bare date range
//      "7月14日(火) — 7月15日(水)"), so a fully-correct, room-confirmed,
//      correctly-priced observation was discarded as "no safe price" and its
//      price nulled out downstream in toPreviewRow. Fixed by dropping
//      nightCountDetected from the required gate — checkinDetected +
//      checkoutDetected (both specific target dates present) already imply a
//      1-night stay, a strictly stronger check. See the "REGRESSION" test
//      below using the real captured page (no "1泊" anywhere in ~11KB of text).
// Fixtures below use ONLY text actually observed live
// (.data/debug/kiraku-booking/20260713_005235/ and .../20260713_012607/, and
// live re-fetches on 2026-07-13 that reproduced each bug), never invented
// strings.

import { describe, expect, it } from "vitest";
import { canonicalizeName, isOwnProperty } from "../src/services/biWebDataExport";
import { getOwnPropertyKey, isOwnPropertyName } from "../src/services/ownPropertyTargets";
import { classifyBookingRoomBasis } from "../src/services/roomBasisClassification";
import { extractBookingRoomContextAroundPrice } from "../src/services/bookingRoomContextExtraction";
import {
  analyzeBookingRenderedDomSignals,
  buildBookingRenderedDomRow,
  classifyBookingRenderedDom,
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

  it("REGRESSION (unit level): extractBookingRoomContextAroundPrice picks the room name closest to the price, not the first match in the window", () => {
    const bodyText = [
      "ホテル喜らく", "2026年7月14日", "2026年7月15日", "大人2名", "1室", "1泊",
      "人気施設・設備", "禁煙ルーム", "無料駐車場", "スパ＆ウェルネスセンター", "無料Wi-Fi", "ファミリールーム",
      "特徴： マウンテンビュー 静かな通り向き ホテルの敷地内に無料専用駐車場あり",
      "空室状況 プライスマッチ 7月14日(火) - 7月15日(水) 大人2名 · 子供0名 · 1部屋 再検索",
      "する部屋のタイプと数を選択してください。 部屋タイプ 宿泊人数 本日の料金 確認事項 部屋数を選択",
      "スタンダード ダブルまたはツインルーム 上層階 布団2組 19 平方メートル マウンテンビュー 薄型テレビ 防音 無料WiFi",
      "人数: 2",
      "￥13,786 ￥11,718 元の料金 ￥13,786 現在の料金 ￥11,718 税・手数料込 15%OFF HOLIDAYセール 込 消費税/VAT10 %",
      "一部返金可 • オンライン決済"
    ].join(" ");
    const ctx = extractBookingRoomContextAroundPrice({ bodyText, priceValue: 11718, priceRawText: "￥11,718" });
    expect(ctx.primaryRoomName).toBe("ダブルまたはツインルーム");
    expect(ctx.primaryRoomName).not.toBe("ファミリールーム");
  });

  it("REGRESSION: an earlier, unrelated amenity-badge 'ファミリールーム' mention must not win over the real, price-adjacent room name (the exact batch-interleaving bug)", () => {
    // Verbatim structure of the real live page (.data/debug/kiraku-booking,
    // checkin 2026-07-14): the "人気施設・設備" (popular facilities) badge list
    // near the top of the page happens to include "ファミリールーム" as a generic
    // "this hotel has family rooms too" tag — unrelated to any price — sitting
    // ~280 chars before the actual room-price card. Before KIRAKU-BOOKING-FIX01,
    // extractBookingRoomContextAroundPrice's non-global regex .exec() picked
    // this earlier, wrong match instead of the correct "ダブルまたはツインルーム"
    // sitting immediately before the price — misclassifying a valid, in-stock
    // twin-room price as excluded_family_or_suite_room.
    const bodyText = [
      "ホテル喜らく", "2026年7月14日", "2026年7月15日", "大人2名", "1室", "1泊",
      "人気施設・設備", "禁煙ルーム", "無料駐車場", "スパ＆ウェルネスセンター", "無料Wi-Fi", "ファミリールーム",
      "特徴： マウンテンビュー 静かな通り向き ホテルの敷地内に無料専用駐車場あり",
      "空室状況 プライスマッチ 7月14日(火) - 7月15日(水) 大人2名 · 子供0名 · 1部屋 再検索",
      "する部屋のタイプと数を選択してください。 部屋タイプ 宿泊人数 本日の料金 確認事項 部屋数を選択",
      "スタンダード ダブルまたはツインルーム 上層階 布団2組 19 平方メートル マウンテンビュー 薄型テレビ 防音 無料WiFi",
      "人数: 2",
      "￥13,786 ￥11,718 元の料金 ￥13,786 現在の料金 ￥11,718 税・手数料込 15%OFF HOLIDAYセール 込 消費税/VAT10 %",
      "一部返金可 • オンライン決済"
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
    expect(signals.primaryRoomName).toBe("ダブルまたはツインルーム");
    expect(signals.primaryRoomName).not.toBe("ファミリールーム");

    const row = buildBookingRenderedDomRow({
      target: TARGET,
      checkin: "2026-07-14",
      checkout: "2026-07-15",
      probeUrl: "https://www.booking.com/hotel/jp/xi-raku.ja.html",
      signals,
      debugArtifactPath: "/tmp/x"
    });
    expect(row.roomBasis).toBe("confirmed_two_person_standard_room");
    expect(row.firstPriceCandidateValue).toBe(11718);
  });

  it("REGRESSION: a real captured full page with NO '1泊' text anywhere must still classify as a usable price basis (nightCountDetected is not a hard gate)", () => {
    // Verbatim capture (.data/debug/kiraku-booking/20260713_012607/2026-07-14/
    // body_text.txt), live re-fetched 2026-07-13 — the ENTIRE ~11KB page never
    // renders a literal "1泊"/"１泊" label anywhere (the search widget shows
    // only the bare date range "7月14日(火) — 7月15日(水)"). Before this fix,
    // classifyBookingRenderedDom required nightCountDetected as a hard AND-gate,
    // so this fully room-confirmed, correctly-priced observation was
    // discarded as "content_visible_no_safe_price" and toPreviewRow nulled
    // its price out — even though the screenshot taken in the same live run
    // showed the correct room/price rendered on screen.
    const bodyText = `メインコンテンツにスキップ
JPY
宿泊施設を掲載する
登録
ログイン
目的地を入力
日付を選択
7月14日(火) — 7月15日(水)
宿泊人数の変更
大人2名 · 子供0名 · 1部屋
検索
ホーム
ホテル
日本
山形県
蔵王温泉
ZAO SPA HOTEL Kiraku (ホテル)（日本）のセール
概要
詳細＆料金
施設・設備
規則
重要情報＆法的情報
予約へ進む
プライスマッチ
ZAO SPA HOTEL Kiraku
〒9902301 山形県, 蔵王温泉, 蔵王温泉935－25
宿泊施設の電話番号や住所等の情報は、ご予約完了後に予約確認書およびアカウントページに記載されます。
–地図を表示
+18枚の写真
まだクチコミがありません
クチコミスコアが表示されるのは1件以上のクチコミ投稿がある宿泊施設です。ZAO SPA HOTEL Kirakuを予約＆宿泊して、クチコミを投稿しましょう。
とてもすばらしいロケーション
地図で見る
宿泊施設のサービス / 特徴
無料の専用駐車場
キッチン設備
電気ポット
ウェルネス
スパ＆ウェルネスセンター, ホットタブ / ジャグジー
眺望
マウンテンビュー
すべて見る
蔵王温泉にあるZAO SPA HOTEL Kirakuは蔵王温泉スキー場から徒歩5分で、無料WiFiと無料専用駐車場を提供しています。ホットタブとスパセンターがあり、山の景色が望めます。
ZAO SPA HOTEL Kirakuのお部屋にはデスク、薄型テレビ、専用バスルーム、ベッドリネン、タオルが備わります。それぞれのお部屋にセーフティボックスが備わります。
山形空港まで34kmです。
人気施設・設備
禁煙ルーム
無料駐車場
スパ＆ウェルネスセンター
無料Wi-Fi
ファミリールーム
特徴：
静かな通り向き
マウンテンビュー
ホテルの敷地内に無料専用駐車場あり
予約へ進む
空室状況
プライスマッチ
7月14日(火) - 7月15日(水)
大人2名 · 子供0名 · 1部屋
再検索
予約する部屋のタイプと数を選択してください。
部屋タイプ	宿泊人数	本日の料金	確認事項	部屋数を選択

スタンダード　ダブルまたはツインルーム
 上層階
布団2組
19 平方メートル
マウンテンビュー
薄型テレビ
防音
無料WiFi

人数: 2

￥13,786
￥11,718
元の料金 ￥13,786 現在の料金 ￥11,718
税・手数料込
15%OFF
HOLIDAYセール
込 消費税/VAT10 %

一部返金可
•
オンライン決済

部屋数を選択
0
1          (￥11,718)
2          (￥23,436)
他のユーザーからの質問
朝食の提供はありますか？
専用バスルームがあるお部屋はありますか？
チェックイン / チェックアウトは何時ですか？
規則
チェックイン
15:00～20:00
チェックアウト
8:00～10:00
ZAO SPA HOTEL Kirakuの宿泊料金はいくらですか？
JPY
Copyright © 1996–2026 Booking.com™. All rights reserved.`;
    expect(bodyText).not.toMatch(/1泊|１泊/u);

    const signals = analyzeBookingRenderedDomSignals({
      target: TARGET,
      checkin: "2026-07-14",
      checkout: "2026-07-15",
      loaded: true,
      httpStatus: 200,
      finalUrl: "https://www.booking.com/hotel/jp/xi-raku.ja.html",
      pageTitle: "ZAO SPA HOTEL Kiraku",
      bodyText
    });
    expect(signals.nightCountDetected).toBe(false);
    expect(signals.primaryPriceCandidate?.numericValue).toBe(11718);
    expect(classifyBookingRenderedDom(signals)).toBe("booking_rendered_price_basis_candidate_found");

    const row = buildBookingRenderedDomRow({
      target: TARGET,
      checkin: "2026-07-14",
      checkout: "2026-07-15",
      probeUrl: "https://www.booking.com/hotel/jp/xi-raku.ja.html",
      signals,
      debugArtifactPath: "/tmp/x"
    });
    expect(row.firstPriceCandidateValue).toBe(11718);
    expect(row.classification).toBe("booking_rendered_price_basis_candidate_found");
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
