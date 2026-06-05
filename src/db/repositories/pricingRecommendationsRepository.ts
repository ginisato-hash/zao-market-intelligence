import type { LocalDatabase } from "../client";
import type { PricingRecommendationRecord } from "../../services/generatePricingRecommendations";

export function upsertPricingRecommendation(db: LocalDatabase, row: PricingRecommendationRecord): void {
  db.prepare(
    `INSERT INTO pricing_recommendations (
       id,
       target_id,
       stay_date,
       source_market,
       target_priority,
       raw_market_median_jpy,
       quality_adjusted_market_median_jpy,
       baseline_adr_jpy,
       recommended_price_jpy,
       min_price_jpy,
       max_price_jpy,
       confidence,
       recommendation_reason,
       market_signal_id,
       created_at,
       updated_at
     )
     VALUES (
       @id,
       @targetId,
       @stayDate,
       @sourceMarket,
       @targetPriority,
       @rawMarketMedianJpy,
       @qualityAdjustedMarketMedianJpy,
       @baselineAdrJpy,
       @recommendedPriceJpy,
       @minPriceJpy,
       @maxPriceJpy,
       @confidence,
       @recommendationReason,
       @marketSignalId,
       @createdAt,
       @updatedAt
     )
     ON CONFLICT(target_id, stay_date, source_market) DO UPDATE SET
       target_priority = excluded.target_priority,
       raw_market_median_jpy = excluded.raw_market_median_jpy,
       quality_adjusted_market_median_jpy = excluded.quality_adjusted_market_median_jpy,
       baseline_adr_jpy = excluded.baseline_adr_jpy,
       recommended_price_jpy = excluded.recommended_price_jpy,
       min_price_jpy = excluded.min_price_jpy,
       max_price_jpy = excluded.max_price_jpy,
       confidence = excluded.confidence,
       recommendation_reason = excluded.recommendation_reason,
       market_signal_id = excluded.market_signal_id,
       updated_at = excluded.updated_at`
  ).run(row);
}

export function getPricingRecommendation(
  db: LocalDatabase,
  targetId: string,
  stayDate: string,
  sourceMarket: string
): PricingRecommendationRecord | undefined {
  const row = db
    .prepare(
      `SELECT *
       FROM pricing_recommendations
       WHERE target_id = ? AND stay_date = ? AND source_market = ?`
    )
    .get(targetId, stayDate, sourceMarket) as PricingRecommendationRow | undefined;
  return row === undefined ? undefined : mapRow(row);
}

export function listPricingRecommendations(
  db: LocalDatabase,
  filters: { targetId?: string; sourceMarket?: string; from?: string; to?: string } = {}
): PricingRecommendationRecord[] {
  const params: Record<string, string> = {};
  const where: string[] = [];
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
    "SELECT * FROM pricing_recommendations",
    where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`,
    "ORDER BY target_id ASC, stay_date ASC, source_market ASC"
  ].join(" ");
  return (db.prepare(sql).all(params) as PricingRecommendationRow[]).map(mapRow);
}

interface PricingRecommendationRow {
  id: string;
  target_id: string;
  stay_date: string;
  source_market: "jalan";
  target_priority: "S" | "A" | "B" | "C" | null;
  raw_market_median_jpy: number | null;
  quality_adjusted_market_median_jpy: number | null;
  baseline_adr_jpy: number;
  recommended_price_jpy: number;
  min_price_jpy: number;
  max_price_jpy: number;
  confidence: PricingRecommendationRecord["confidence"];
  recommendation_reason: string;
  market_signal_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: PricingRecommendationRow): PricingRecommendationRecord {
  return {
    id: row.id,
    targetId: row.target_id,
    stayDate: row.stay_date,
    sourceMarket: row.source_market,
    targetPriority: row.target_priority,
    rawMarketMedianJpy: row.raw_market_median_jpy,
    qualityAdjustedMarketMedianJpy: row.quality_adjusted_market_median_jpy,
    baselineAdrJpy: row.baseline_adr_jpy,
    recommendedPriceJpy: row.recommended_price_jpy,
    minPriceJpy: row.min_price_jpy,
    maxPriceJpy: row.max_price_jpy,
    confidence: row.confidence,
    recommendationReason: row.recommendation_reason,
    marketSignalId: row.market_signal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
