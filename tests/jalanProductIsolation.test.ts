// ZMI-MKT-OBS02 PART A — Jalan product isolation / false-pairing suite (J1-J5).
//
// Fixtures under tests/fixtures/jalan/ are REAL, minimal, PII-free captures
// from live Jalan plan pages for the three CORE competitors (2026-08-13
// snapshots, see .data/debug/core-competitor-repeated-observation/). Every
// expected value below was read off the real page, never invented.
//
// The defect these lock down: a Jalan plan section lists EVERY room type
// beneath it, so plan-level extraction could pair Room A's price with Room B's
// name and Room C's scarcity badge.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJalanProductKey,
  extractJalanProductRecords,
  parseJalanProductRow,
  splitJalanPlanBlocks,
  splitJalanProductRows,
  stripRelatedPropertySections,
  type JalanProductRecord
} from "../src/collectors/jalanProductBlockExtractor";

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, "fixtures", "jalan", `${name}.txt`), "utf8");
}

const OAKHILL = "oakhill_multi_room_plans";
const HAMMOND = "hammond_multi_plan";
const YOSHIDAYA = "yoshidaya_multi_room";

function keyOf(r: JalanProductRecord): string {
  return buildJalanProductKey({
    roomName: r.roomName,
    planName: r.planName,
    mealBasis: r.mealBasis,
    searchAdults: 2,
    searchChildren: 0,
    searchRooms: 1,
    lengthOfStay: 1
  });
}

describe("ZMI-MKT-OBS02 J1 — one plan block, multiple rooms: each keeps its OWN price and scarcity", () => {
  // Real OAKHILL 素泊まりプラン (room-only) block, four room types, from the
  // live page: デラックス和洋室 ¥38,000/あと2部屋, コーナー倶楽部トリプル
  // ¥36,000/あと3部屋, スタンダードツイン ¥26,000/あと1部屋, 倶楽部ルーム
  // ¥24,500/あと2部屋.
  const roomOnly = () =>
    extractJalanProductRecords(fixture(OAKHILL)).filter((r) => r.mealBasis === "confirmed_room_only");

  it("binds each room to its own total price with zero cross-binding", () => {
    const byRoom = new Map(roomOnly().map((r) => [r.roomName, r.totalPriceTaxIncluded]));
    expect(byRoom.get("デラックス和洋室")).toBe(38000);
    expect(byRoom.get("コーナー倶楽部トリプル")).toBe(36000);
    expect(byRoom.get("スタンダードツイン")).toBe(26000);
    expect(byRoom.get("倶楽部ルーム")).toBe(24500);
  });

  it("binds each room to its own scarcity count with zero cross-binding", () => {
    const byRoom = new Map(roomOnly().map((r) => [r.roomName, r.inventoryCount]));
    expect(byRoom.get("デラックス和洋室")).toBe(2);
    expect(byRoom.get("コーナー倶楽部トリプル")).toBe(3);
    expect(byRoom.get("スタンダードツイン")).toBe(1);
    expect(byRoom.get("倶楽部ルーム")).toBe(2);
  });

  it("never assigns the cheapest price in the block to every room (the old defect)", () => {
    const prices = roomOnly().map((r) => r.totalPriceTaxIncluded);
    expect(new Set(prices).size).toBe(prices.length);
    const cheapest = Math.min(...(prices as number[]));
    expect(prices.filter((p) => p === cheapest)).toHaveLength(1);
  });

  it("never names a room after its plan (the exact live OAKHILL symptom)", () => {
    for (const r of extractJalanProductRecords(fixture(OAKHILL))) {
      expect(r.roomName).not.toBe("朝食無料サービス");
      expect(r.roomName).not.toBe("素泊まりプラン");
      expect(r.roomName).not.toContain("ONSEN");
    }
  });

  it("every scarcity count is PRODUCT-scoped, never promoted to PROPERTY inventory (A4)", () => {
    for (const r of extractJalanProductRecords(fixture(OAKHILL))) {
      expect(r.inventoryScope).not.toBe("PROPERTY");
      if (r.inventoryCount !== null) {
        expect(r.inventoryScope).toBe("PRODUCT");
        expect(r.inventoryCountSemantics).toBe("PUBLIC_SCARCITY_COUNT");
      }
    }
  });
});

describe("ZMI-MKT-OBS02 J2 — a room with no scarcity badge must not inherit a sibling's", () => {
  // Real 吉田屋 rows: 和室12.5畳 shows "あと1部屋" (numeric) while its sibling
  // 和室6畳 shows only the qualitative "空室わずか" (no number) in the SAME plan.
  it("the qualitative-only sibling gets no invented count, and the numeric one keeps its own", () => {
    const roomOnly = extractJalanProductRecords(fixture(YOSHIDAYA)).filter((r) => r.mealBasis === "confirmed_room_only");
    const numeric = roomOnly.find((r) => r.roomName === "和室12.5畳");
    const qualitative = roomOnly.find((r) => r.roomName === "和室6畳");
    expect(numeric?.inventoryCount).toBe(1);
    expect(qualitative?.inventoryCount).toBeNull();
    expect(qualitative?.inventoryCountSemantics).toBe("UNKNOWN");
    expect(qualitative?.scarcityText).toContain("空室わずか");
  });

  it("a synthetic row with NO scarcity text at all stays BINARY_AVAILABILITY (no inheritance)", () => {
    const rows = splitJalanProductRows(
      [
        "【ルームA】ツイン 21㎡",
        "和室",
        "\t11,000円\t22,000円",
        "あと2部屋",
        "",
        "【ルームB】和室 30㎡",
        "和室",
        "\t12,000円\t24,000円"
      ].join("\n")
    );
    expect(rows).toHaveLength(2);
    const ctx = { planName: "【素泊まりプラン】", mealText: "食事なし", mealBasis: "confirmed_room_only" as const, planIndex: 0 };
    const a = parseJalanProductRow(rows[0]!, ctx, 0);
    const b = parseJalanProductRow(rows[1]!, ctx, 1);
    expect(a?.inventoryCount).toBe(2);
    expect(b?.inventoryCount).toBeNull();
    expect(b?.inventoryCountSemantics).toBe("BINARY_AVAILABILITY");
    expect(b?.totalPriceTaxIncluded).toBe(24000);
  });
});

describe("ZMI-MKT-OBS02 J3 — multiple rate plans must not merge product keys", () => {
  it("the same room under different plans yields distinct product keys and distinct prices", () => {
    const twin = extractJalanProductRecords(fixture(OAKHILL)).filter((r) => r.roomName === "スタンダードツイン");
    expect(twin.length).toBeGreaterThanOrEqual(3);
    const keys = twin.map(keyOf);
    expect(new Set(keys).size).toBe(twin.length);
    // Real live values: ¥26,000 (breakfast plan), ¥27,300 (Jalan-limited 10%
    // point breakfast plan), ¥26,000 (room-only plan).
    expect(twin.map((r) => r.totalPriceTaxIncluded)).toEqual(expect.arrayContaining([26000, 27300]));
  });

  it("two plans differing ONLY by a ≪...≫ prefix are still distinct products", () => {
    // Confirmed live: "【朝食無料サービス】～ONSEN＆STAY～…" and
    // "≪じゃらん限定ポイント10%≫【朝食無料サービス】…" are separate rate plans
    // priced ¥38,000 vs ¥39,900 for the SAME デラックス和洋室.
    const deluxe = extractJalanProductRecords(fixture(OAKHILL)).filter(
      (r) => r.roomName === "デラックス和洋室" && r.mealBasis === "meal_included"
    );
    expect(deluxe).toHaveLength(2);
    expect(new Set(deluxe.map(keyOf)).size).toBe(2);
    expect(deluxe.map((r) => r.totalPriceTaxIncluded).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([38000, 39900]);
  });

  it("every fixture yields 100% distinct product keys (no silent merges anywhere)", () => {
    for (const name of [OAKHILL, HAMMOND, YOSHIDAYA]) {
      const records = extractJalanProductRecords(fixture(name));
      expect(records.length).toBeGreaterThan(0);
      expect(new Set(records.map(keyOf)).size, `${name} had merged product keys`).toBe(records.length);
    }
  });

  it("normalizes trivial UI wording noise without merging different rooms (A3)", () => {
    const a = buildJalanProductKey({ roomName: "スタンダードツイン", planName: "【素泊まり】", mealBasis: "confirmed_room_only", searchAdults: 2, searchChildren: 0, searchRooms: 1, lengthOfStay: 1 });
    const b = buildJalanProductKey({ roomName: "  スタンダードツイン  ", planName: "【素泊まり】", mealBasis: "confirmed_room_only", searchAdults: 2, searchChildren: 0, searchRooms: 1, lengthOfStay: 1 });
    const c = buildJalanProductKey({ roomName: "デラックス和洋室", planName: "【素泊まり】", mealBasis: "confirmed_room_only", searchAdults: 2, searchChildren: 0, searchRooms: 1, lengthOfStay: 1 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("product key includes the search context, so a different occupancy is a different product", () => {
    const two = buildJalanProductKey({ roomName: "ツイン", planName: "【素泊まり】", mealBasis: "confirmed_room_only", searchAdults: 2, searchChildren: 0, searchRooms: 1, lengthOfStay: 1 });
    const one = buildJalanProductKey({ roomName: "ツイン", planName: "【素泊まり】", mealBasis: "confirmed_room_only", searchAdults: 1, searchChildren: 0, searchRooms: 1, lengthOfStay: 1 });
    const los2 = buildJalanProductKey({ roomName: "ツイン", planName: "【素泊まり】", mealBasis: "confirmed_room_only", searchAdults: 2, searchChildren: 0, searchRooms: 1, lengthOfStay: 2 });
    expect(new Set([two, one, los2]).size).toBe(3);
  });
});

describe("ZMI-MKT-OBS02 J4 — room-only and breakfast-included plans mixed on one page", () => {
  it("the room-only selection retains confirmed_room_only meal basis and its own prices", () => {
    const records = extractJalanProductRecords(fixture(OAKHILL));
    const roomOnly = records.filter((r) => r.mealBasis === "confirmed_room_only");
    const mealIncluded = records.filter((r) => r.mealBasis === "meal_included");
    expect(roomOnly.length).toBe(4);
    expect(mealIncluded.length).toBe(8);
    for (const r of roomOnly) {
      expect(r.mealText).toContain("食事なし");
      expect(r.planName).toContain("素泊まり");
    }
  });

  it("Jalan's controlled 食事 vocabulary maps precisely — 朝のみ / 朝・夕 are meal_included, not unknown", () => {
    const records = extractJalanProductRecords(fixture(YOSHIDAYA));
    const breakfast = records.filter((r) => r.mealText.includes("朝のみ"));
    const halfBoard = records.filter((r) => r.mealText.includes("朝・夕"));
    expect(breakfast.length).toBeGreaterThan(0);
    expect(halfBoard.length).toBeGreaterThan(0);
    for (const r of [...breakfast, ...halfBoard]) expect(r.mealBasis).toBe("meal_included");
    expect(records.some((r) => r.mealBasis === "unknown_meal_basis")).toBe(false);
  });

  it("a room-only row never inherits a breakfast plan's price (same room, different plan)", () => {
    const twin = extractJalanProductRecords(fixture(OAKHILL)).filter((r) => r.roomName === "スタンダードツイン");
    const ro = twin.find((r) => r.mealBasis === "confirmed_room_only");
    const jalanLimited = twin.find((r) => r.planName.includes("じゃらん限定"));
    expect(ro?.totalPriceTaxIncluded).toBe(26000);
    expect(jalanLimited?.totalPriceTaxIncluded).toBe(27300);
    expect(ro?.totalPriceTaxIncluded).not.toBe(jalanLimited?.totalPriceTaxIncluded);
  });
});

describe("ZMI-MKT-OBS02 J5 — DOM/text order changes must not pull another room's price", () => {
  it("reversing room order within a plan keeps every price/scarcity bound to its own room", () => {
    const roomList = [
      "【ルームA】ツイン 21㎡",
      "ツイン",
      "\t10,000円\t20,000円",
      "あと2部屋",
      "",
      "【ルームB】和室 30㎡",
      "和室",
      "\t12,000円\t24,000円",
      "あと5部屋"
    ].join("\n");
    const reversed = [
      "【ルームB】和室 30㎡",
      "和室",
      "\t12,000円\t24,000円",
      "あと5部屋",
      "",
      "【ルームA】ツイン 21㎡",
      "ツイン",
      "\t10,000円\t20,000円",
      "あと2部屋"
    ].join("\n");
    const ctx = { planName: "【素泊まりプラン】", mealText: "食事なし", mealBasis: "confirmed_room_only" as const, planIndex: 0 };

    const parse = (text: string) =>
      new Map(
        splitJalanProductRows(text)
          .map((row, i) => parseJalanProductRow(row, ctx, i))
          .filter((r): r is JalanProductRecord => r !== null)
          .map((r) => [r.roomName, { price: r.totalPriceTaxIncluded, inv: r.inventoryCount }])
      );

    const forward = parse(roomList);
    const backward = parse(reversed);
    expect(forward.get("ルームA")).toEqual({ price: 20000, inv: 2 });
    expect(forward.get("ルームB")).toEqual({ price: 24000, inv: 5 });
    expect(backward.get("ルームA")).toEqual({ price: 20000, inv: 2 });
    expect(backward.get("ルームB")).toEqual({ price: 24000, inv: 5 });
    expect(forward).toEqual(backward);
  });

  it("a coupon face value is never mistaken for the stay price", () => {
    const rows = splitJalanProductRows(
      ["【ルームA】ツイン", "2,000円クーポンを獲得してお得に泊まる", "クーポンGET", "ツイン", "\t10,000円\t20,000円", "あと2部屋"].join("\n")
    );
    const rec = parseJalanProductRow(rows[0]!, { planName: "p", mealText: "食事なし", mealBasis: "confirmed_room_only", planIndex: 0 }, 0);
    expect(rec?.totalPriceTaxIncluded).toBe(20000);
    expect(rec?.perPersonPriceTaxIncluded).toBe(10000);
  });
});

describe("ZMI-MKT-OBS02 — cross-PROPERTY contamination (the second structural trap)", () => {
  it("the 'この宿をみた人は他にこんな宿をみています' carousel of OTHER properties is cut before parsing", () => {
    // HAMMOND's real page lists ホテル喜らく ¥30,135 and 蔵王アストリアホテル
    // ¥22,000 in that carousel. Those are other properties' prices.
    const raw = fixture(HAMMOND);
    expect(raw).toContain("この宿をみた人は");
    expect(raw).toContain("30,135円");
    const stripped = stripRelatedPropertySections(raw);
    expect(stripped).not.toContain("30,135円");
    expect(extractJalanProductRecords(raw).map((r) => r.totalPriceTaxIncluded)).not.toContain(30135);
  });

  it("no extracted record carries another property's name as a room or plan", () => {
    for (const name of [OAKHILL, HAMMOND, YOSHIDAYA]) {
      for (const r of extractJalanProductRecords(fixture(name))) {
        for (const other of ["喜らく", "アストリア", "ぷうたろう", "ヴァルトベルク", "瑠璃倶楽リゾート", "MATSUKANEYA"]) {
          expect(r.roomName).not.toContain(other);
          expect(r.planName).not.toContain(other);
        }
      }
    }
  });
});

describe("ZMI-MKT-OBS02 — structural sanity of the plan/row split", () => {
  it("splits each fixture into the real number of plans, each with its own meal field", () => {
    expect(splitJalanPlanBlocks(fixture(OAKHILL))).toHaveLength(3);
    expect(splitJalanPlanBlocks(fixture(HAMMOND))).toHaveLength(2);
    expect(splitJalanPlanBlocks(fixture(YOSHIDAYA))).toHaveLength(6);
  });

  it("no plan title leaks into the room list as a phantom priceless room", () => {
    for (const name of [OAKHILL, HAMMOND, YOSHIDAYA]) {
      for (const r of extractJalanProductRecords(fixture(name))) {
        expect(r.totalPriceTaxIncluded).not.toBeNull();
        expect(r.totalPriceTaxIncluded!).toBeGreaterThan(0);
      }
    }
  });

  it("every record's plan name comes from its own plan, and rooms repeat across plans", () => {
    const records = extractJalanProductRecords(fixture(OAKHILL));
    const plans = new Set(records.map((r) => r.planName));
    expect(plans.size).toBe(3);
    // Same four rooms appear under each of the three plans = 12 products.
    expect(records).toHaveLength(12);
    expect(new Set(records.map((r) => r.roomName)).size).toBe(4);
  });

  it("empty / non-plan text yields no records rather than throwing", () => {
    expect(extractJalanProductRecords("")).toEqual([]);
    expect(extractJalanProductRecords("満室です。空室がありません。")).toEqual([]);
    expect(splitJalanProductRows("")).toEqual([]);
  });
});
