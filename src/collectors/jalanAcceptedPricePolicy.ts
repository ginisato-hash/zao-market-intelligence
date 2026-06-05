import type { JalanPlanBlockCandidate } from "./jalanPlanBlockExtractor";

export type JalanAcceptedPricePolicy = "cheapest_total_tax_included_safe_plan" | "first_visible_safe_plan";

export interface JalanAcceptedPriceSelection {
  policy: JalanAcceptedPricePolicy;
  selectedCandidate?: JalanPlanBlockCandidate;
  selectedIndex?: number;
  safeCandidateCount: number;
  rejectedCandidateCount: number;
  reason: string;
}

export function selectAcceptedJalanPriceCandidate(
  candidates: JalanPlanBlockCandidate[],
  policy: JalanAcceptedPricePolicy
): JalanAcceptedPriceSelection {
  const safeCandidates = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => isSafePlanCandidate(candidate));

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
