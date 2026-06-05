import type { LocalDatabase } from "../db/client";
import { listMarketDailySignals } from "../db/repositories/marketSignalsRepository";
import {
  getPricingRecommendationApproval,
  listPricingRecommendationApprovals
} from "../db/repositories/pricingRecommendationApprovalsRepository";
import { listPricingRecommendations } from "../db/repositories/pricingRecommendationsRepository";
import { auditPricingRecommendationRow } from "./auditPricingRecommendations";
import type { PricingRecommendationRecord } from "./generatePricingRecommendations";
import {
  classifyPricingRecommendationApproval,
  type PricingApprovalStatus
} from "./pricingRecommendationApproval";

export type PricingReviewPacketRow = {
  targetId: string;
  stayDate: string;
  priority?: string | null;
  approvalStatus: PricingApprovalStatus;
  recommendedPriceJpy: number | null;
  confidence: string;
  rawMarketMedianJpy: number | null;
  qualityAdjustedMarketMedianJpy: number | null;
  baselineAdrJpy: number;
  auditFlags: string[];
  approvalReasons: string[];
  recommendationReason: string;
  reviewDecision: "pending";
  reviewerNote: "";
};

export interface PricingReviewPacket {
  generatedAt: string;
  sourceMarket: string;
  targetCount: number;
  recommendationCount: number;
  countByApprovalStatus: Record<string, number>;
  countByConfidence: Record<string, number>;
  rows: PricingReviewPacketRow[];
}

export function buildPricingReviewPacket(
  db: LocalDatabase,
  input: { sourceMarket?: string; generatedAt?: string } = {}
): PricingReviewPacket {
  const sourceMarket = input.sourceMarket ?? "jalan";
  const recommendations = listPricingRecommendations(db, { sourceMarket });
  const approvals = listPricingRecommendationApprovals(db, { sourceMarket });
  const approvalIds = new Set(approvals.map((approval) => approval.recommendationId));
  const targetDatePriorities = loadTargetDatePriorities(db);
  const marketSignalIds = new Set(listMarketDailySignals(db, { source: sourceMarket }).map((signal) => signal.id));

  const rows = recommendations.map((recommendation) => {
    const audit = auditPricingRecommendationRow(recommendation);
    const persistedApproval = approvalIds.has(recommendation.id)
      ? getPricingRecommendationApproval(db, recommendation.id)
      : undefined;
    const approval =
      persistedApproval ??
      classifyPricingRecommendationApproval({
        recommendation,
        audit
      });

    return toPacketRow(recommendation, {
      priority: recommendation.targetPriority ?? targetDatePriorities.get(recommendation.stayDate) ?? null,
      auditFlags: audit.flags,
      approvalStatus: approval.approvalStatus,
      approvalReasons: approval.reasons,
      marketSignalExists: recommendation.marketSignalId === null ? false : marketSignalIds.has(recommendation.marketSignalId)
    });
  });

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sourceMarket,
    targetCount: new Set(rows.map((row) => row.targetId)).size,
    recommendationCount: rows.length,
    countByApprovalStatus: countBy(rows, (row) => row.approvalStatus),
    countByConfidence: countBy(rows, (row) => row.confidence),
    rows
  };
}

function toPacketRow(
  recommendation: PricingRecommendationRecord,
  input: {
    priority: string | null;
    approvalStatus: PricingApprovalStatus;
    auditFlags: string[];
    approvalReasons: string[];
    marketSignalExists: boolean;
  }
): PricingReviewPacketRow {
  return {
    targetId: recommendation.targetId,
    stayDate: recommendation.stayDate,
    priority: input.priority,
    approvalStatus: input.approvalStatus,
    recommendedPriceJpy: recommendation.recommendedPriceJpy,
    confidence: recommendation.confidence,
    rawMarketMedianJpy: recommendation.rawMarketMedianJpy,
    qualityAdjustedMarketMedianJpy: recommendation.qualityAdjustedMarketMedianJpy,
    baselineAdrJpy: recommendation.baselineAdrJpy,
    auditFlags: input.marketSignalExists ? input.auditFlags : [...new Set([...input.auditFlags, "no_market_signal"])],
    approvalReasons: input.approvalReasons,
    recommendationReason: recommendation.recommendationReason,
    reviewDecision: "pending",
    reviewerNote: ""
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
