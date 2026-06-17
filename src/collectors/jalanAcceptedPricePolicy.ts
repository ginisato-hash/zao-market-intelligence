import type { JalanPlanBlockCandidate } from "./jalanPlanBlockExtractor";
import { classifyJalanMealBasis } from "../services/mealBasisClassification";

export type JalanAcceptedPricePolicy =
  | "cheapest_total_tax_included_safe_plan"
  | "first_visible_safe_plan"
  | "cheapest_confirmed_room_only_total_tax_included_safe_plan";

export interface JalanAcceptedPriceSelection {
  policy: JalanAcceptedPricePolicy;
  selectedCandidate?: JalanPlanBlockCandidate;
  selectedIndex?: number;
  safeCandidateCount: number;
  rejectedCandidateCount: number;
  // Room-only-policy diagnostics: how many safe candidates were excluded for not
  // being confirmed room-only, and why.
  roomOnlySafeCandidateCount?: number;
  mealExcludedCandidateCount?: number;
  unknownMealBasisCandidateCount?: number;
  reason: string;
}

export function selectAcceptedJalanPriceCandidate(
  candidates: JalanPlanBlockCandidate[],
  policy: JalanAcceptedPricePolicy
): JalanAcceptedPriceSelection {
  const safeCandidates = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => isSafePlanCandidate(candidate));

  if (policy === "cheapest_confirmed_room_only_total_tax_included_safe_plan") {
    return selectCheapestConfirmedRoomOnly(candidates, safeCandidates);
  }

  if (safeCandidates.length === 0) {
    return {
      policy,
      safeCandidateCount: 0,
      rejectedCandidateCount: candidates.length,
      reason: "no_safe_total_tax_included_plan_candidates"
    };
  }

  const selected =
    policy === "cheapest_total_tax_included_safe_plan"
      ? [...safeCandidates].sort((left, right) => (left.candidate.priceValue ?? Infinity) - (right.candidate.priceValue ?? Infinity) || left.index - right.index)[0]
      : safeCandidates[0];

  return {
    policy,
    selectedCandidate: selected!.candidate,
    selectedIndex: selected!.index,
    safeCandidateCount: safeCandidates.length,
    rejectedCandidateCount: candidates.length - safeCandidates.length,
    reason:
      policy === "cheapest_total_tax_included_safe_plan"
        ? "selected_lowest_total_tax_included_safe_plan"
        : "selected_first_visible_total_tax_included_safe_plan"
  };
}

function selectCheapestConfirmedRoomOnly(
  allCandidates: JalanPlanBlockCandidate[],
  safeCandidates: { candidate: JalanPlanBlockCandidate; index: number }[]
): JalanAcceptedPriceSelection {
  const policy = "cheapest_confirmed_room_only_total_tax_included_safe_plan" as const;
  let mealExcluded = 0;
  let unknownExcluded = 0;
  const roomOnly = safeCandidates.filter(({ candidate }) => {
    if (isConfirmedRoomOnlyJalanCandidate(candidate)) return true;
    const basis = mealBasisOf(candidate).mealBasis;
    if (basis === "meal_included") mealExcluded += 1;
    else unknownExcluded += 1;
    return false;
  });

  if (roomOnly.length === 0) {
    return {
      policy,
      safeCandidateCount: safeCandidates.length,
      roomOnlySafeCandidateCount: 0,
      mealExcludedCandidateCount: mealExcluded,
      unknownMealBasisCandidateCount: unknownExcluded,
      rejectedCandidateCount: allCandidates.length,
      reason: safeCandidates.length === 0
        ? "no_safe_total_tax_included_plan_candidates"
        : "no_confirmed_room_only_safe_plan_candidates"
    };
  }

  const selected = [...roomOnly].sort(
    (left, right) => (left.candidate.priceValue ?? Infinity) - (right.candidate.priceValue ?? Infinity) || left.index - right.index
  )[0]!;

  return {
    policy,
    selectedCandidate: selected.candidate,
    selectedIndex: selected.index,
    safeCandidateCount: safeCandidates.length,
    roomOnlySafeCandidateCount: roomOnly.length,
    mealExcludedCandidateCount: mealExcluded,
    unknownMealBasisCandidateCount: unknownExcluded,
    rejectedCandidateCount: allCandidates.length - roomOnly.length,
    reason: "selected_lowest_confirmed_room_only_total_tax_included_safe_plan"
  };
}

function mealBasisOf(candidate: JalanPlanBlockCandidate): { mealBasis: string } {
  const text = [candidate.blockText, candidate.planName, candidate.roomName, candidate.priceText]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" \n ");
  return classifyJalanMealBasis(text);
}

export function isConfirmedRoomOnlyJalanCandidate(candidate: JalanPlanBlockCandidate): boolean {
  return mealBasisOf(candidate).mealBasis === "confirmed_room_only";
}

export function isSafePlanCandidate(candidate: JalanPlanBlockCandidate): boolean {
  return (
    candidate.priceBasis === "total_tax_included" &&
    candidate.priceValue !== undefined &&
    (candidate.confidence === "medium" || candidate.confidence === "high") &&
    candidate.hasTotalTaxIncludedEvidence &&
    candidate.hasPlanOrRoomEvidence &&
    candidate.hasStayConditionEvidence &&
    candidate.rejectionReason === undefined
  );
}
