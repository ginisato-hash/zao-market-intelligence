export type PricingReviewDecision = "pending" | "approved" | "rejected" | "needs_change";

export type PricingReviewDecisionRow = {
  targetId: string;
  stayDate: string;
  recommendedPriceJpy: number | null;
  approvalStatus: string;
  reviewDecision: PricingReviewDecision;
  reviewerNote: string;
};

export const ALLOWED_REVIEW_DECISIONS: readonly PricingReviewDecision[] = [
  "pending",
  "approved",
  "rejected",
  "needs_change"
];

/** Blank → "pending". Recognized decision → itself. Anything else → undefined (invalid). */
export function normalizeReviewDecision(raw: string): PricingReviewDecision | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return "pending";
  return (ALLOWED_REVIEW_DECISIONS as readonly string[]).includes(trimmed)
    ? (trimmed as PricingReviewDecision)
    : undefined;
}

export interface RawReviewDecisionInput {
  targetId: string;
  stayDate: string;
  recommendedPriceRaw: string;
  approvalStatus: string;
  reviewDecisionRaw: string;
  reviewerNote: string;
}

export interface ReviewDecisionValidationResult {
  row?: PricingReviewDecisionRow;
  errors: string[];
}

/**
 * Validates a single raw review-decision record (string fields straight from the CSV).
 * Pure: performs no IO and applies no prices.
 *
 * Rules:
 * - target_id / stay_date required
 * - recommended_price_jpy: blank → null; otherwise must be a finite integer
 * - review_decision: blank → pending; must be one of the allowed values
 * - approved requires a non-null recommended_price_jpy
 * - rejected allows null or non-null price
 * - needs_change requires a non-empty reviewer_note (implementation choice: hard error)
 * - pending applies nothing
 */
export function buildPricingReviewDecisionRow(
  input: RawReviewDecisionInput
): ReviewDecisionValidationResult {
  const errors: string[] = [];

  const targetId = input.targetId.trim();
  const stayDate = input.stayDate.trim();
  if (targetId === "") errors.push("target_id is required");
  if (stayDate === "") errors.push("stay_date is required");

  const priceText = input.recommendedPriceRaw.trim();
  let recommendedPriceJpy: number | null = null;
  if (priceText !== "") {
    const parsed = Number(priceText);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      errors.push(`recommended_price_jpy must be an integer or blank (got "${input.recommendedPriceRaw}")`);
    } else {
      recommendedPriceJpy = parsed;
    }
  }

  const decision = normalizeReviewDecision(input.reviewDecisionRaw);
  if (decision === undefined) {
    errors.push(
      `review_decision must be one of pending/approved/rejected/needs_change (got "${input.reviewDecisionRaw}")`
    );
  }

  const reviewerNote = input.reviewerNote.trim();

  if (decision === "approved" && recommendedPriceJpy === null) {
    errors.push("approved decision requires a non-null recommended_price_jpy");
  }
  if (decision === "needs_change" && reviewerNote === "") {
    errors.push("needs_change decision requires a non-empty reviewer_note");
  }

  if (errors.length > 0 || decision === undefined) {
    return { errors };
  }

  return {
    errors,
    row: {
      targetId,
      stayDate,
      recommendedPriceJpy,
      approvalStatus: input.approvalStatus.trim(),
      reviewDecision: decision,
      reviewerNote: input.reviewerNote
    }
  };
}
