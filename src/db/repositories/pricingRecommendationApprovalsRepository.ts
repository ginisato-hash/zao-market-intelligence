import type { LocalDatabase } from "../client";
import type { PricingRecommendationApprovalRecord } from "../../services/pricingRecommendationApproval";

export function upsertPricingRecommendationApproval(
  db: LocalDatabase,
  row: PricingRecommendationApprovalRecord
): void {
  db.prepare(
    `INSERT INTO pricing_recommendation_approvals (
       id,
       recommendation_id,
       target_id,
       stay_date,
       source_market,
       approval_status,
       reasons_json,
       audit_flags_json,
       created_at,
       updated_at
     )
     VALUES (
       @id,
       @recommendationId,
       @targetId,
       @stayDate,
       @sourceMarket,
       @approvalStatus,
       @reasonsJson,
       @auditFlagsJson,
       @createdAt,
       @updatedAt
     )
     ON CONFLICT(recommendation_id) DO UPDATE SET
       target_id = excluded.target_id,
       stay_date = excluded.stay_date,
       source_market = excluded.source_market,
       approval_status = excluded.approval_status,
       reasons_json = excluded.reasons_json,
       audit_flags_json = excluded.audit_flags_json,
       updated_at = excluded.updated_at`
  ).run({
    ...row,
    reasonsJson: JSON.stringify(row.reasons),
    auditFlagsJson: JSON.stringify(row.auditFlags)
  });
}

export function getPricingRecommendationApproval(
  db: LocalDatabase,
  recommendationId: string
): PricingRecommendationApprovalRecord | undefined {
  const row = db
    .prepare("SELECT * FROM pricing_recommendation_approvals WHERE recommendation_id = ?")
    .get(recommendationId) as PricingRecommendationApprovalRow | undefined;
  return row === undefined ? undefined : mapRow(row);
}

export function listPricingRecommendationApprovals(
  db: LocalDatabase,
  filters: { status?: string; targetId?: string; sourceMarket?: string; from?: string; to?: string } = {}
): PricingRecommendationApprovalRecord[] {
  const params: Record<string, string> = {};
  const where: string[] = [];
  if (filters.status !== undefined) {
    where.push("approval_status = @status");
    params.status = filters.status;
  }
  if (filters.targetId !== undefined) {
    where.push("target_id = @targetId");
    params.targetId = filters.targetId;
  }
  if (filters.sourceMarket !== undefined) {
    where.push("source_market = @sourceMarket");
    params.sourceMarket = filters.sourceMarket;
  }
  if (filters.from !== undefined) {
    where.push("stay_date >= @from");
    params.from = filters.from;
  }
  if (filters.to !== undefined) {
    where.push("stay_date <= @to");
    params.to = filters.to;
  }

  const sql = [
    "SELECT * FROM pricing_recommendation_approvals",
    where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`,
    "ORDER BY target_id ASC, stay_date ASC, source_market ASC"
  ].join(" ");
  return (db.prepare(sql).all(params) as PricingRecommendationApprovalRow[]).map(mapRow);
}

interface PricingRecommendationApprovalRow {
  id: string;
  recommendation_id: string;
  target_id: string;
  stay_date: string;
  source_market: string;
  approval_status: PricingRecommendationApprovalRecord["approvalStatus"];
  reasons_json: string;
  audit_flags_json: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: PricingRecommendationApprovalRow): PricingRecommendationApprovalRecord {
  return {
    id: row.id,
    recommendationId: row.recommendation_id,
    targetId: row.target_id,
    stayDate: row.stay_date,
    sourceMarket: row.source_market,
    approvalStatus: row.approval_status,
    reasons: JSON.parse(row.reasons_json) as PricingRecommendationApprovalRecord["reasons"],
    auditFlags: JSON.parse(row.audit_flags_json) as PricingRecommendationApprovalRecord["auditFlags"],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
