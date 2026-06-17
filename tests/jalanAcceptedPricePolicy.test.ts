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
