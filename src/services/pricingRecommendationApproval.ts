import crypto from "node:crypto";
import type { PricingRecommendationAuditFlag, PricingRecommendationAuditRow } from "./auditPricingRecommendations";
import type { PricingRecommendationRecord } from "./generatePricingRecommendations";

export type PricingApprovalStatus = "auto_approved" | "needs_review" | "rejected";

export type PricingApprovalReason =
  | "high_confidence_clean_recommendation"
  | "medium_confidence_clean_recommendation"
  | "fallback_requires_review"
  | "low_confidence_requires_review"
  | "large_gap_requires_review"
  | "clamped_requires_review"
  | "adjusted_median_unavailable_requires_review"
  | "raw_fallback_quality_excluded_requires_review"
  | "no_market_signal_rejected"
  | "invalid_recommendation_rejected";

export interface PricingRecommendationApprovalRecord {
  id: string;
  recommendationId: string;
  targetId: string;
  stayDate: string;
  sourceMarket: string;
  approvalStatus: PricingApprovalStatus;
  reasons: PricingApprovalReason[];
  auditFlags: PricingRecommendationAuditFlag[];
  createdAt: string;
  updatedAt: string;
}

export function classifyPricingRecommendationApproval(input: {
  recommendation: PricingRecommendationRecord;
  audit: PricingRecommendationAuditRow;
  createdAt?: string;
}): PricingRecommendationApprovalRecord {
  const now = input.createdAt ?? new Date().toISOString();
  const invalidReasons = invalidRecommendationReasons(input.recommendation, input.audit);
  if (invalidReasons.length > 0) {
    return buildApproval(input, "rejected", invalidReasons, now);
  }

  const reviewReasons = reviewReasonsFor(input.audit);
  if (reviewReasons.length > 0) {
    return buildApproval(input, "needs_review", reviewReasons, now);
  }

  if (
    (input.recommendation.confidence === "A" || input.recommendation.confidence === "B") &&
    input.audit.flags.length === 0 &&
    input.recommendation.qualityAdjustedMarketMedianJpy !== null &&
    input.recommendation.recommendedPriceJpy !== null
  ) {
    return buildApproval(
      input,
      "auto_approved",
      [
        input.recommendation.confidence === "A"
          ? "high_confidence_clean_recommendation"
          : "medium_confidence_clean_recommendation"
      ],
      now
    );
  }

  return buildApproval(input, "needs_review", ["low_confidence_requires_review"], now);
}

function invalidRecommendationReasons(
  recommendation: PricingRecommendationRecord,
  audit: PricingRecommendationAuditRow
): PricingApprovalReason[] {
  const reasons: PricingApprovalReason[] = [];
  if (recommendation.recommendedPriceJpy === null || !Number.isFinite(recommendation.recommendedPriceJpy)) {
    reasons.push("invalid_recommendation_rejected");
  }
  if (
    recommendation.minPriceJpy !== null &&
    recommendation.maxPriceJpy !== null &&
    recommendation.minPriceJpy > recommendation.maxPriceJpy
  ) {
    reasons.push("invalid_recommendation_rejected");
  }
  if (audit.flags.includes("no_market_signal") && !audit.flags.includes("fallback_recommendation")) {
    reasons.push("no_market_signal_rejected");
  }
  return [...new Set(reasons)];
}

function reviewReasonsFor(audit: PricingRecommendationAuditRow): PricingApprovalReason[] {
  const reasons: PricingApprovalReason[] = [];
  if (audit.flags.includes("fallback_recommendation")) reasons.push("fallback_requires_review");
  if (audit.flags.includes("low_confidence_recommendation")) reasons.push("low_confidence_requires_review");
  if (audit.flags.includes("large_gap_from_market_median")) reasons.push("large_gap_requires_review");
  if (audit.flags.includes("clamped_recommendation")) reasons.push("clamped_requires_review");
  if (audit.flags.includes("adjusted_median_unavailable")) {
    reasons.push("adjusted_median_unavailable_requires_review");
  }
  if (audit.flags.includes("raw_fallback_quality_excluded")) {
    reasons.push("raw_fallback_quality_excluded_requires_review");
  }
  return reasons;
}

function buildApproval(
  input: { recommendation: PricingRecommendationRecord; audit: PricingRecommendationAuditRow },
  status: PricingApprovalStatus,
  reasons: PricingApprovalReason[],
  now: string
): PricingRecommendationApprovalRecord {
  return {
    id: stableApprovalId(input.recommendation.id),
    recommendationId: input.recommendation.id,
    targetId: input.recommendation.targetId,
    stayDate: input.recommendation.stayDate,
    sourceMarket: input.recommendation.sourceMarket,
    approvalStatus: status,
    reasons,
    auditFlags: input.audit.flags,
    createdAt: now,
    updatedAt: now
  };
}

function stableApprovalId(recommendationId: string): string {
  const digest = crypto.createHash("sha1").update(recommendationId).digest("hex").slice(0, 16);
  return `pricing_approval_${digest}`;
}
