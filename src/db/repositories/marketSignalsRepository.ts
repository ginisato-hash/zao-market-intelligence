import type { LocalDatabase } from "../client";
import type { MarketDailySignalRecord } from "../../services/computeMarketSignals";

export function upsertMarketDailySignal(db: LocalDatabase, signal: MarketDailySignalRecord): void {
  db.prepare(
    `INSERT INTO market_daily_signals (
       id,
       stay_date,
       source,
       postal_code,
       median_price_jpy,
       min_price_jpy,
       max_price_jpy,
       quality_adjusted_median_price_jpy,
       quality_adjusted_min_price_jpy,
       quality_adjusted_max_price_jpy,
       quality_adjusted_sample_size,
       excluded_quality_flag_count,
       excluded_high_severity_count,
       quality_adjustment_reason,
       available_count,
       failed_count,
       sold_out_count,
       not_listed_count,
       sample_size,
       confidence,
       generated_at,
       created_at,
       updated_at
     )
     VALUES (
       @id,
       @stayDate,
       @source,
       @postalCode,
       @medianPriceJpy,
       @minPriceJpy,
       @maxPriceJpy,
       @qualityAdjustedMedianPriceJpy,
       @qualityAdjustedMinPriceJpy,
       @qualityAdjustedMaxPriceJpy,
       @qualityAdjustedSampleSize,
       @excludedQualityFlagCount,
       @excludedHighSeverityCount,
       @qualityAdjustmentReason,
       @availableCount,
       @failedCount,
       @soldOutCount,
       @notListedCount,
       @sampleSize,
       @confidence,
       @generatedAt,
       @createdAt,
       @updatedAt
     )
     ON CONFLICT(stay_date, source, postal_code) DO UPDATE SET
       median_price_jpy = excluded.median_price_jpy,
       min_price_jpy = excluded.min_price_jpy,
       max_price_jpy = excluded.max_price_jpy,
       quality_adjusted_median_price_jpy = excluded.quality_adjusted_median_price_jpy,
       quality_adjusted_min_price_jpy = excluded.quality_adjusted_min_price_jpy,
       quality_adjusted_max_price_jpy = excluded.quality_adjusted_max_price_jpy,
       quality_adjusted_sample_size = excluded.quality_adjusted_sample_size,
       excluded_quality_flag_count = excluded.excluded_quality_flag_count,
       excluded_high_severity_count = excluded.excluded_high_severity_count,
       quality_adjustment_reason = excluded.quality_adjustment_reason,
       available_count = excluded.available_count,
       failed_count = excluded.failed_count,
       sold_out_count = excluded.sold_out_count,
       not_listed_count = excluded.not_listed_count,
       sample_size = excluded.sample_size,
       confidence = excluded.confidence,
       generated_at = excluded.generated_at,
       updated_at = excluded.updated_at`
  ).run(signal);
}

export function getMarketDailySignal(
  db: LocalDatabase,
  stayDate: string,
  source: string,
  postalCode: string
): MarketDailySignalRecord | undefined {
  const row = db
    .prepare(
      `SELECT *
       FROM market_daily_signals
       WHERE stay_date = ? AND source = ? AND postal_code = ?`
    )
    .get(stayDate, source, postalCode) as MarketSignalRow | undefined;
  return row === undefined ? undefined : mapRow(row);
}

export function listMarketDailySignals(
  db: LocalDatabase,
  filters: { source?: string; postalCode?: string; from?: string; to?: string } = {}
): MarketDailySignalRecord[] {
  const params: Record<string, string> = {};
  const where: string[] = [];
  if (filters.source !== undefined) {
    where.push("source = @source");
    params.source = filters.source;
  }
  if (filters.postalCode !== undefined) {
    where.push("postal_code = @postalCode");
    params.postalCode = filters.postalCode;
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
    "SELECT * FROM market_daily_signals",
    where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`,
    "ORDER BY stay_date ASC, source ASC, postal_code ASC"
  ].join(" ");
  return (db.prepare(sql).all(params) as MarketSignalRow[]).map(mapRow);
}

interface MarketSignalRow {
  id: string;
  stay_date: string;
  source: "jalan";
  postal_code: "990-2301";
  median_price_jpy: number | null;
  min_price_jpy: number | null;
  max_price_jpy: number | null;
  quality_adjusted_median_price_jpy: number | null;
  quality_adjusted_min_price_jpy: number | null;
  quality_adjusted_max_price_jpy: number | null;
  quality_adjusted_sample_size: number;
  excluded_quality_flag_count: number;
  excluded_high_severity_count: number;
  quality_adjustment_reason: MarketDailySignalRecord["qualityAdjustmentReason"];
  available_count: number;
  failed_count: number;
  sold_out_count: number;
  not_listed_count: number;
  sample_size: number;
  confidence: MarketDailySignalRecord["confidence"];
  generated_at: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: MarketSignalRow): MarketDailySignalRecord {
  return {
    id: row.id,
    stayDate: row.stay_date,
    source: row.source,
    postalCode: row.postal_code,
    medianPriceJpy: row.median_price_jpy,
    minPriceJpy: row.min_price_jpy,
    maxPriceJpy: row.max_price_jpy,
    qualityAdjustedMedianPriceJpy: row.quality_adjusted_median_price_jpy,
    qualityAdjustedMinPriceJpy: row.quality_adjusted_min_price_jpy,
    qualityAdjustedMaxPriceJpy: row.quality_adjusted_max_price_jpy,
    qualityAdjustedSampleSize: row.quality_adjusted_sample_size,
    excludedQualityFlagCount: row.excluded_quality_flag_count,
    excludedHighSeverityCount: row.excluded_high_severity_count,
    qualityAdjustmentReason: row.quality_adjustment_reason,
    availableCount: row.available_count,
    failedCount: row.failed_count,
    soldOutCount: row.sold_out_count,
    notListedCount: row.not_listed_count,
    sampleSize: row.sample_size,
    confidence: row.confidence,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
