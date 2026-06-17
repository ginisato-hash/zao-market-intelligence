import type { JalanPlanBlockCandidate } from "./jalanPlanBlockExtractor";
import { classifyJalanMealBasis } from "../services/mealBasisClassification";
import { classifyRoomBasisFromParts } from "../services/roomBasisClassification";

export type JalanAcceptedPricePolicy =
  | "cheapest_total_tax_included_safe_plan"
  | "first_visible_safe_plan"
  | "cheapest_confirmed_room_only_total_tax_included_safe_plan"
  | "cheapest_confirmed_room_only_two_person_standard_total_tax_included_safe_plan";

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
  // Room-basis diagnostics (two-person standard room gate): among confirmed
  // room-only safe candidates, how many were the right room type vs excluded.
  twoPersonStandardSafeCandidateCount?: number;
  roomTypeExcludedCandidateCount?: number;
  unknownRoomBasisCandidateCount?: number;
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

  if (policy === "cheapest_confirmed_room_only_two_person_standard_total_tax_included_safe_plan") {
    return selectCheapestConfirmedRoomOnlyTwoPersonStandard(candidates, safeCandidates);
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

// Two-person standard room gate layered on top of the confirmed-room-only gate.
// 1. safe total-tax-included candidates only, 2. confirmed room-only meal basis,
// 3. confirmed two-person standard room basis, 4. cheapest of those.
function selectCheapestConfirmedRoomOnlyTwoPersonStandard(
  allCandidates: JalanPlanBlockCandidate[],
  safeCandidates: { candidate: JalanPlanBlockCandidate; index: number }[]
): JalanAcceptedPriceSelection {
  const policy = "cheapest_confirmed_room_only_two_person_standard_total_tax_included_safe_plan" as const;

  // First apply the existing meal gate.
  let mealExcluded = 0;
  let unknownMealExcluded = 0;
  const roomOnly = safeCandidates.filter(({ candidate }) => {
    if (isConfirmedRoomOnlyJalanCandidate(candidate)) return true;
    const basis = mealBasisOf(candidate).mealBasis;
    if (basis === "meal_included") mealExcluded += 1;
    else unknownMealExcluded += 1;
    return false;
  });

  // Then apply the room-basis (two-person standard room) gate.
  let roomTypeExcluded = 0;
  let unknownRoomBasis = 0;
  const twoPersonStandard = roomOnly.filter(({ candidate }) => {
    const room = roomBasisOf(candidate).roomBasis;
    if (room === "confirmed_two_person_standard_room") return true;
    if (room === "unknown_room_basis") unknownRoomBasis += 1;
    else roomTypeExcluded += 1;
    return false;
  });

  const diagnostics = {
    safeCandidateCount: safeCandidates.length,
    roomOnlySafeCandidateCount: roomOnly.length,
    mealExcludedCandidateCount: mealExcluded,
    unknownMealBasisCandidateCount: unknownMealExcluded,
    twoPersonStandardSafeCandidateCount: twoPersonStandard.length,
    roomTypeExcludedCandidateCount: roomTypeExcluded,
    unknownRoomBasisCandidateCount: unknownRoomBasis
  };

  if (twoPersonStandard.length === 0) {
    return {
      policy,
      ...diagnostics,
      rejectedCandidateCount: allCandidates.length,
      reason: safeCandidates.length === 0
        ? "no_safe_total_tax_included_plan_candidates"
        : roomOnly.length === 0
          ? "no_confirmed_room_only_safe_plan_candidates"
          : "no_confirmed_two_person_room_only_safe_plan_candidates"
    };
  }

  const selected = [...twoPersonStandard].sort(
    (left, right) => (left.candidate.priceValue ?? Infinity) - (right.candidate.priceValue ?? Infinity) || left.index - right.index
  )[0]!;

  return {
    policy,
    selectedCandidate: selected.candidate,
    selectedIndex: selected.index,
    ...diagnostics,
    rejectedCandidateCount: allCandidates.length - twoPersonStandard.length,
    reason: "selected_lowest_confirmed_room_only_two_person_standard_total_tax_included_safe_plan"
  };
}

function mealBasisOf(candidate: JalanPlanBlockCandidate): { mealBasis: string } {
  const text = [candidate.blockText, candidate.planName, candidate.roomName, candidate.priceText]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" \n ");
  return classifyJalanMealBasis(text);
}

function roomBasisOf(candidate: JalanPlanBlockCandidate): { roomBasis: string } {
  return classifyRoomBasisFromParts({
    roomName: candidate.roomName,
    planName: candidate.planName,
    blockText: candidate.blockText,
    priceText: candidate.priceText
  });
}

export function isConfirmedRoomOnlyJalanCandidate(candidate: JalanPlanBlockCandidate): boolean {
  return mealBasisOf(candidate).mealBasis === "confirmed_room_only";
}

export function isTwoPersonStandardJalanCandidate(candidate: JalanPlanBlockCandidate): boolean {
  return roomBasisOf(candidate).roomBasis === "confirmed_two_person_standard_room";
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
