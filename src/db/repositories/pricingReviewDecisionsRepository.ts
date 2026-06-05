import crypto from "node:crypto";
import type { LocalDatabase } from "../client";
import type { PricingReviewDecision } from "../../services/pricingReviewDecision";

export interface PricingReviewDecisionStoredRecord {
  id: string;
  targetId: string;
  stayDate: string;
  sourceMarket: string;
  recommendedPriceJpy: number | null;
  approvalStatus: string;
  reviewDecision: PricingReviewDecision;
  reviewerNote: string | null;
  importedFromPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export function pricingReviewDecisionId(targetId: string, stayDate: string, sourceMarket: string): string {
  const digest = crypto.createHash("sha1").update(`${targetId}|${stayDate}|${sourceMarket}`).digest("hex").slice(0, 16);
  return `pricing_review_decision_${digest}`;
}

export function upsertPricingReviewDecision(db: LocalDatabase, row: PricingReviewDecisionStoredRecord): void {
  db.prepare(
    `INSERT INTO pricing_review_decisions (
       id,
       target_id,
       stay_date,
       source_market,
       recommended_price_jpy,
       approval_status,
       review_decision,
       reviewer_note,
       imported_from_path,
       created_at,
       updated_at
     )
     VALUES (
       @id,
       @targetId,
       @stayDate,
       @sourceMarket,
       @recommendedPriceJpy,
       @approvalStatus,
       @reviewDecision,
       @reviewerNote,
       @importedFromPath,
       @createdAt,
       @updatedAt
     )
     ON CONFLICT(target_id, stay_date, source_market) DO UPDATE SET
       recommended_price_jpy = excluded.recommended_price_jpy,
       approval_status = excluded.approval_status,
       review_decision = excluded.review_decision,
       reviewer_note = excluded.reviewer_note,
       imported_from_path = excluded.imported_from_path,
       updated_at = excluded.updated_at`
  ).run(row);
}

export function getPricingReviewDecision(
  db: LocalDatabase,
  targetId: string,
  stayDate: string,
  sourceMarket: string
): PricingReviewDecisionStoredRecord | undefined {
  const row = db
    .prepare(
      `SELECT * FROM pricing_review_decisions
       WHERE target_id = ? AND stay_date = ? AND source_market = ?`
    )
    .get(targetId, stayDate, sourceMarket) as PricingReviewDecisionDbRow | undefined;
  return row === undefined ? undefined : mapRow(row);
}

export function listPricingReviewDecisions(
  db: LocalDatabase,
  filters: { reviewDecision?: string; targetId?: string; sourceMarket?: string; from?: string; to?: string } = {}
): PricingReviewDecisionStoredRecord[] {
  const params: Record<string, string> = {};
  const where: string[] = [];
  if (filters.reviewDecision !== undefined) {
    where.push("review_decision = @reviewDecision");
    params.reviewDecision = filters.reviewDecision;
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
    "SELECT * FROM pricing_review_decisions",
    where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`,
    "ORDER BY target_id ASC, stay_date ASC, source_market ASC"
  ].join(" ");
  return (db.prepare(sql).all(params) as PricingReviewDecisionDbRow[]).map(mapRow);
}

interface PricingReviewDecisionDbRow {
  id: string;
  target_id: string;
  stay_date: string;
  source_market: string;
  recommended_price_jpy: number | null;
  approval_status: string;
  review_decision: PricingReviewDecision;
  reviewer_note: string | null;
  imported_from_path: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: PricingReviewDecisionDbRow): PricingReviewDecisionStoredRecord {
  return {
    id: row.id,
    targetId: row.target_id,
    stayDate: row.stay_date,
    sourceMarket: row.source_market,
    recommendedPriceJpy: row.recommended_price_jpy,
    approvalStatus: row.approval_status,
    reviewDecision: row.review_decision,
    reviewerNote: row.reviewer_note,
    importedFromPath: row.imported_from_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
