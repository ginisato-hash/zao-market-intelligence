import { describe, expect, it } from "vitest";
import { selectAcceptedJalanPriceCandidate } from "../src/collectors/jalanAcceptedPricePolicy";
import type { JalanPlanBlockCandidate } from "../src/collectors/jalanPlanBlockExtractor";

describe("Jalan accepted price policy", () => {
  it("cheapest policy selects lower of two safe candidates", () => {
    const selection = selectAcceptedJalanPriceCandidate(
      [safeCandidate(37000, "first"), safeCandidate(25000, "second")],
      "cheapest_total_tax_included_safe_plan"
    );

    expect(selection.selectedCandidate?.priceValue).toBe(25000);
    expect(selection.selectedIndex).toBe(1);
    expect(selection.safeCandidateCount).toBe(2);
  });

  it("cheapest policy ignores unsafe lower price", () => {
    const selection = selectAcceptedJalanPriceCandidate(
      [safeCandidate(37000, "safe"), { ...safeCandidate(12000, "unsafe"), rejectionReason: "block_not_tightly_scoped" }],
      "cheapest_total_tax_included_safe_plan"
    );

    expect(selection.selectedCandidate?.priceValue).toBe(37000);
    expect(selection.rejectedCandidateCount).toBe(1);
  });

  it("cheapest policy tie preserves original order", () => {
    const selection = selectAcceptedJalanPriceCandidate(
      [safeCandidate(25000, "first"), safeCandidate(25000, "second")],
      "cheapest_total_tax_included_safe_plan"
    );

    expect(selection.selectedCandidate?.planName).toBe("first");
    expect(selection.selectedIndex).toBe(0);
  });

  it("first-visible policy selects first safe candidate", () => {
    const selection = selectAcceptedJalanPriceCandidate(
      [safeCandidate(37000, "first"), safeCandidate(25000, "second")],
      "first_visible_safe_plan"
    );

    expect(selection.selectedCandidate?.priceValue).toBe(37000);
    expect(selection.reason).toBe("selected_first_visible_total_tax_included_safe_plan");
  });

  it("returns no selected candidate when there are no safe candidates", () => {
    const selection = selectAcceptedJalanPriceCandidate(
      [{ ...safeCandidate(12000, "unsafe"), confidence: "low" }],
      "cheapest_total_tax_included_safe_plan"
    );

    expect(selection.selectedCandidate).toBeUndefined();
    expect(selection.safeCandidateCount).toBe(0);
    expect(selection.reason).toBe("no_safe_total_tax_included_plan_candidates");
  });
});

describe("Jalan accepted price policy — confirmed room-only (meal-basis hardening)", () => {
  const POLICY = "cheapest_confirmed_room_only_total_tax_included_safe_plan" as const;

  it("selects a safe confirmed room-only candidate", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeCandidate(30000, "【素泊まり】シンプルプラン")], POLICY);
    expect(sel.selectedCandidate?.priceValue).toBe(30000);
    expect(sel.reason).toBe("selected_lowest_confirmed_room_only_total_tax_included_safe_plan");
    expect(sel.roomOnlySafeCandidateCount).toBe(1);
  });

  it("rejects a safe breakfast-included candidate", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeCandidate(30000, "【朝食付き】お得プラン")], POLICY);
    expect(sel.selectedCandidate).toBeUndefined();
    expect(sel.reason).toBe("no_confirmed_room_only_safe_plan_candidates");
    expect(sel.mealExcludedCandidateCount).toBe(1);
  });

  it("rejects a safe 2-meal candidate", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeCandidate(30000, "【1泊2食付き】会席")], POLICY);
    expect(sel.selectedCandidate).toBeUndefined();
    expect(sel.mealExcludedCandidateCount).toBe(1);
  });

  it("picks the room-only candidate over a cheaper meal-included one", () => {
    const sel = selectAcceptedJalanPriceCandidate(
      [safeCandidate(20000, "【朝食付き】激安"), safeCandidate(28000, "【素泊まり】スタンダード")],
      POLICY
    );
    expect(sel.selectedCandidate?.priceValue).toBe(28000);
    expect(sel.mealExcludedCandidateCount).toBe(1);
    expect(sel.roomOnlySafeCandidateCount).toBe(1);
  });

  it("returns no candidate when only unknown meal basis exists", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeCandidate(30000, "シンプルステイ")], POLICY);
    expect(sel.selectedCandidate).toBeUndefined();
    expect(sel.reason).toBe("no_confirmed_room_only_safe_plan_candidates");
    expect(sel.unknownMealBasisCandidateCount).toBe(1);
  });

  it("cheapest of multiple room-only candidates wins", () => {
    const sel = selectAcceptedJalanPriceCandidate(
      [safeCandidate(31000, "【素泊まり】A"), safeCandidate(25000, "【食事なし】B")],
      POLICY
    );
    expect(sel.selectedCandidate?.priceValue).toBe(25000);
    expect(sel.roomOnlySafeCandidateCount).toBe(2);
  });
});

describe("Jalan accepted price policy — confirmed room-only + two-person standard room (room-basis hardening)", () => {
  const POLICY = "cheapest_confirmed_room_only_two_person_standard_total_tax_included_safe_plan" as const;

  it("selects room-only + twin", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeRoomCandidate(30000, "【素泊まり】シンプル", "禁煙ツイン")], POLICY);
    expect(sel.selectedCandidate?.priceValue).toBe(30000);
    expect(sel.reason).toBe("selected_lowest_confirmed_room_only_two_person_standard_total_tax_included_safe_plan");
    expect(sel.twoPersonStandardSafeCandidateCount).toBe(1);
  });

  it("selects room-only + double", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeRoomCandidate(28000, "【食事なし】お得", "ダブルルーム")], POLICY);
    expect(sel.selectedCandidate?.priceValue).toBe(28000);
    expect(sel.twoPersonStandardSafeCandidateCount).toBe(1);
  });

  it("rejects room-only + single", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeRoomCandidate(18000, "【素泊まり】一人旅", "シングル")], POLICY);
    expect(sel.selectedCandidate).toBeUndefined();
    expect(sel.reason).toBe("no_confirmed_two_person_room_only_safe_plan_candidates");
    expect(sel.roomTypeExcludedCandidateCount).toBe(1);
  });

  it("rejects room-only + semi-double", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeRoomCandidate(22000, "【素泊まり】", "セミダブル")], POLICY);
    expect(sel.selectedCandidate).toBeUndefined();
    expect(sel.roomTypeExcludedCandidateCount).toBe(1);
  });

  it("rejects room-only + triple", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeRoomCandidate(33000, "【素泊まり】", "トリプルルーム")], POLICY);
    expect(sel.selectedCandidate).toBeUndefined();
    expect(sel.roomTypeExcludedCandidateCount).toBe(1);
  });

  it("rejects room-only + family/suite", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeRoomCandidate(40000, "【素泊まり】", "スイートルーム")], POLICY);
    expect(sel.selectedCandidate).toBeUndefined();
    expect(sel.roomTypeExcludedCandidateCount).toBe(1);
  });

  it("counts unknown room basis separately and rejects", () => {
    const sel = selectAcceptedJalanPriceCandidate([safeRoomCandidate(26000, "【素泊まり】", "おまかせ")], POLICY);
    expect(sel.selectedCandidate).toBeUndefined();
    expect(sel.unknownRoomBasisCandidateCount).toBe(1);
    expect(sel.reason).toBe("no_confirmed_two_person_room_only_safe_plan_candidates");
  });

  it("cheapest eligible meal+room candidate is not the cheapest raw candidate but is selected", () => {
    const sel = selectAcceptedJalanPriceCandidate(
      [
        safeRoomCandidate(15000, "【朝食付き】激安", "禁煙ツイン"), // cheapest but meal-included
        safeRoomCandidate(18000, "【素泊まり】", "シングル"), // room-only but single
        safeRoomCandidate(27000, "【素泊まり】", "禁煙ツイン") // eligible
      ],
      POLICY
    );
    expect(sel.selectedCandidate?.priceValue).toBe(27000);
    expect(sel.mealExcludedCandidateCount).toBe(1);
    expect(sel.roomTypeExcludedCandidateCount).toBe(1);
    expect(sel.twoPersonStandardSafeCandidateCount).toBe(1);
  });

  it("no eligible two-person room-only candidate => no selected, reason no_confirmed_two_person_room_only_safe_plan_candidates", () => {
    const sel = selectAcceptedJalanPriceCandidate(
      [safeRoomCandidate(18000, "【素泊まり】", "シングル"), safeRoomCandidate(40000, "【素泊まり】", "スイート")],
      POLICY
    );
    expect(sel.selectedCandidate).toBeUndefined();
    expect(sel.reason).toBe("no_confirmed_two_person_room_only_safe_plan_candidates");
    expect(sel.roomOnlySafeCandidateCount).toBe(2);
    expect(sel.twoPersonStandardSafeCandidateCount).toBe(0);
  });
});

function safeCandidate(priceValue: number, planName: string): JalanPlanBlockCandidate {
  return {
    blockText: `${planName} 部屋タイプ・詳細 ◆ツイン◆禁煙 大人1名(税込) 合計(税込) 1泊 大人2名 ${priceValue / 2}円 ${priceValue.toLocaleString()}円 空室わずか`,
    planName,
    roomName: "◆ツイン◆禁煙",
    priceText: `${priceValue.toLocaleString()}円`,
    priceValue,
    priceBasis: "total_tax_included",
    hasTotalTaxIncludedEvidence: true,
    hasStayConditionEvidence: true,
    hasPlanOrRoomEvidence: true,
    confidence: "high"
  };
}

// Like safeCandidate but with an explicit room type and a neutral block text
// (no hard-coded ツイン) so the room-basis gate can be exercised per room type.
function safeRoomCandidate(priceValue: number, planName: string, roomName: string): JalanPlanBlockCandidate {
  return {
    blockText: `${planName} 部屋タイプ・詳細 ${roomName} 大人1名(税込) 合計(税込) 1泊 大人2名 ${priceValue / 2}円 ${priceValue.toLocaleString()}円 空室わずか`,
    planName,
    roomName,
    priceText: `${priceValue.toLocaleString()}円`,
    priceValue,
    priceBasis: "total_tax_included",
    hasTotalTaxIncludedEvidence: true,
    hasStayConditionEvidence: true,
    hasPlanOrRoomEvidence: true,
    confidence: "high"
  };
}
