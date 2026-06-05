import type { LocalDatabase } from "../db/client";
import { getPricingRecommendationApproval } from "../db/repositories/pricingRecommendationApprovalsRepository";
import { getPricingRecommendation } from "../db/repositories/pricingRecommendationsRepository";
import { listPricingReviewDecisions } from "../db/repositories/pricingReviewDecisionsRepository";

/**
 * Preview-only projection of manually approved review decisions.
 *
 * NOT an upload format. Carries no roomid / inventory / multiplier / priceN /
 * Beds24 / AirHost columns. Building it performs no DB writes and applies no prices.
 */
export type ApprovedRecommendationPreviewRow = {
  targetId: string;
  stayDate: string;
  priority?: string | null;
  recommendedPriceJpy: number;
  approvalStatus: string;
  reviewDecision: "approved";
  confidence: string;
  recommendationReason: string;
  reviewerNote: string;
  sourceMarket: string;
};

export interface ApprovedRecommendationPreview {
  generatedAt: string;
  sourceMarket: string;
  approvedRowsCount: number;
  skippedNonApprovedCount: number;
  skippedNullPriceCount: number;
  countByPriority: Record<string, number>;
  countByConfidence: Record<string, number>;
  rows: ApprovedRecommendationPreviewRow[];
}

/**
 * Reads only manually approved decisions from pricing_review_decisions and joins the
 * recommendation (confidence, reason), the approval row (status), and target-date
 * priority. Read-only: mutates no rows and applies no prices.
 *
 * - includes only review_decision = "approved"
 * - excludes pending / rejected / needs_change
 * - skips approved rows that carry a null price (counted, never silently dropped)
 */
export function buildApprovedRecommendationPreview(
  db: LocalDatabase,
  input: { sourceMarket?: string; generatedAt?: string } = {}
): ApprovedRecommendationPreview {
  const sourceMarket = input.sourceMarket ?? "jalan";
  const allDecisions = listPricingReviewDecisions(db, { sourceMarket });
  const approvedDecisions = allDecisions.filter((decision) => decision.reviewDecision === "approved");
  const priorities = loadTargetDatePriorities(db);

  const rows: ApprovedRecommendationPreviewRow[] = [];
  let skippedNullPriceCount = 0;

  for (const decision of approvedDecisions) {
    if (decision.recommendedPriceJpy === null) {
      skippedNullPriceCount += 1;
      continue;
    }

    const recommendation = getPricingRecommendation(db, decision.targetId, decision.stayDate, decision.sourceMarket);
    const approval =
      recommendation === undefined ? undefined : getPricingRecommendationApproval(db, recommendation.id);

    rows.push({
      targetId: decision.targetId,
      stayDate: decision.stayDate,
      priority: recommendation?.targetPriority ?? priorities.get(decision.stayDate) ?? null,
      recommendedPriceJpy: decision.recommendedPriceJpy,
      approvalStatus: approval?.approvalStatus ?? decision.approvalStatus,
      reviewDecision: "approved",
      confidence: recommendation?.confidence ?? "unknown",
      recommendationReason: recommendation?.recommendationReason ?? "",
      reviewerNote: decision.reviewerNote ?? "",
      sourceMarket: decision.sourceMarket
    });
  }

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sourceMarket,
    approvedRowsCount: rows.length,
    skippedNonApprovedCount: allDecisions.length - approvedDecisions.length,
    skippedNullPriceCount,
    countByPriority: countBy(rows, (row) => row.priority ?? "none"),
    countByConfidence: countBy(rows, (row) => row.confidence),
    rows
  };
}

function loadTargetDatePriorities(db: LocalDatabase): Map<string, string> {
  const rows = db.prepare("SELECT stay_date, priority FROM target_dates").all() as Array<{
    stay_date: string;
    priority: string;
  }>;
  return new Map(rows.map((row) => [row.stay_date, row.priority]));
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
