import { describe, expect, it } from "vitest";
import {
  BOOKING_MEAL_BASIS,
  classifyJalanMealBasis,
  classifyMealBasis,
  isConfirmedRoomOnly,
  isRoomOnlyDpEligible
} from "../src/services/mealBasisClassification";

describe("meal basis — Jalan room-only positives", () => {
  for (const t of ["素泊まりプラン", "食事なしプラン", "お食事なし", "朝食なし", "夕食なし", "room only plan"]) {
    it(`"${t}" => confirmed_room_only`, () => {
      const r = classifyJalanMealBasis(t);
      expect(r.mealBasis).toBe("confirmed_room_only");
      expect(r.mealBasisConfidence).toBe("high");
      expect(isConfirmedRoomOnly(r)).toBe(true);
    });
  }
});

describe("meal basis — Jalan meal-included exclusions", () => {
  for (const t of ["朝食付きプラン", "夕食付き", "2食付きプラン", "一泊二食", "会席料理付き", "ビュッフェ朝食", "with breakfast"]) {
    it(`"${t}" => meal_included`, () => {
      const r = classifyJalanMealBasis(t);
      expect(r.mealBasis).toBe("meal_included");
      expect(isConfirmedRoomOnly(r)).toBe(false);
      expect(isRoomOnlyDpEligible(r)).toBe(false);
    });
  }
});

describe("meal basis — unknown / ambiguous", () => {
  it('"シンプルステイ" => unknown_meal_basis', () => {
    const r = classifyJalanMealBasis("シンプルステイ");
    expect(r.mealBasis).toBe("unknown_meal_basis");
    expect(r.mealBasisConfidence).toBe("low");
    expect(isRoomOnlyDpEligible(r)).toBe(false);
  });

  it('"素泊まり 朝食付き" => ambiguous, never DP-usable (not confirmed_room_only)', () => {
    const r = classifyJalanMealBasis("素泊まり 朝食付き");
    expect(r.mealBasis === "unknown_meal_basis" || r.mealBasis === "meal_included").toBe(true);
    expect(isConfirmedRoomOnly(r)).toBe(false);
    expect(isRoomOnlyDpEligible(r)).toBe(false);
  });
});

describe("meal basis — source dispatch", () => {
  it("booking is assumed_room_only by policy and room-only DP-eligible", () => {
    const r = classifyMealBasis({ source: "booking", planName: "スタンダード", roomName: "ツイン" });
    expect(r).toEqual(BOOKING_MEAL_BASIS);
    expect(r.mealBasis).toBe("assumed_room_only");
    expect(isRoomOnlyDpEligible(r)).toBe(true);
  });

  it("jalan combines plan/room/block/meal_condition text", () => {
    const r = classifyMealBasis({ source: "jalan", planName: "【素泊まり】", roomName: "和室", blockText: "1泊 大人2名" });
    expect(r.mealBasis).toBe("confirmed_room_only");
  });

  it("jalan meal-included plan name overrides to meal_included", () => {
    const r = classifyMealBasis({ source: "jalan", planName: "【1泊2食付き】会席", roomName: "和室" });
    expect(r.mealBasis).toBe("meal_included");
  });

  it("rakuten/other defaults to unknown_meal_basis (not room-only eligible)", () => {
    const r = classifyMealBasis({ source: "rakuten", planName: "プラン" });
    expect(r.mealBasis).toBe("unknown_meal_basis");
    expect(isRoomOnlyDpEligible(r)).toBe(false);
  });
});
