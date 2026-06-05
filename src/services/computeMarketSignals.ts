import crypto from "node:crypto";
import type { LocalDatabase } from "../db/client";

export type MarketSignalConfidence = "A" | "B" | "C" | "insufficient";
export type QualityAdjustmentReason =
  | "no_high_severity_quality_flags"
  | "excluded_high_severity_quality_flags"
  | "all_available_rows_excluded_by_quality_flags"
  | "quality_flags_not_available";

export interface MarketDailySignalRecord {
  id: string;
  stayDate: string;
  source: "jalan";
  postalCode: "990-2301";
  medianPriceJpy: number | null;
  minPriceJpy: number | null;
  maxPriceJpy: number | null;
  qualityAdjustedMedianPriceJpy: number | null;
  qualityAdjustedMinPriceJpy: number | null;
  qualityAdjustedMaxPriceJpy: number | null;
  qualityAdjustedSampleSize: number;
  excludedQualityFlagCount: number;
  excludedHighSeverityCount: number;
  qualityAdjustmentReason: QualityAdjustmentReason;
  availableCount: number;
  failedCount: number;
  soldOutCount: number;
  notListedCount: number;
  sampleSize: number;
  confidence: MarketSignalConfidence;
  generatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComputeMarketSignalsInput {
  source?: "jalan";
  postalCode?: "990-2301";
  from?: string;
  to?: string;
  generatedAt?: string;
}

interface LatestSnapshotRow {
  rate_snapshot_id: string;
  property_id: string;
  stay_date: string;
  availability_status: "available" | "sold_out" | "not_listed" | "not_found" | "failed";
  price_total_tax_included: number | null;
  quality_severity: "none" | "low" | "medium" | "high" | null;
}

export function computeMarketSignalsFromSnapshots(
  db: LocalDatabase,
  input: ComputeMarketSignalsInput = {}
): MarketDailySignalRecord[] {
  const source = input.source ?? "jalan";
  const postalCode = input.postalCode ?? "990-2301";
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const rows = loadLatestSnapshotRows(db, {
    source,
    postalCode,
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to })
  });
  const grouped = groupBy(rows, (row) => row.stay_date);

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stayDate, dateRows]) => buildSignal({ stayDate, source, postalCode, generatedAt, rows: dateRows }));
}

export function buildSignal(input: {
  stayDate: string;
  source: "jalan";
  postalCode: "990-2301";
  generatedAt: string;
  rows: LatestSnapshotRow[];
}): MarketDailySignalRecord {
  const prices = input.rows
    .filter((row) => row.availability_status === "available" && row.price_total_tax_included !== null)
    .map((row) => row.price_total_tax_included as number)
    .sort((left, right) => left - right);
  const adjusted = buildAdjustedMetrics(input.rows, prices);
  const now = input.generatedAt;

  return {
    id: stableSignalId(input.stayDate, input.source, input.postalCode),
    stayDate: input.stayDate,
    source: input.source,
    postalCode: input.postalCode,
    medianPriceJpy: median(prices),
    minPriceJpy: prices[0] ?? null,
    maxPriceJpy: prices[prices.length - 1] ?? null,
    qualityAdjustedMedianPriceJpy: median(adjusted.prices),
    qualityAdjustedMinPriceJpy: adjusted.prices[0] ?? null,
    qualityAdjustedMaxPriceJpy: adjusted.prices[adjusted.prices.length - 1] ?? null,
    qualityAdjustedSampleSize: adjusted.prices.length,
    excludedQualityFlagCount: adjusted.excludedQualityFlagCount,
    excludedHighSeverityCount: adjusted.excludedHighSeverityCount,
    qualityAdjustmentReason: adjusted.reason,
    availableCount: prices.length,
    failedCount: countStatus(input.rows, "failed"),
    soldOutCount: countStatus(input.rows, "sold_out"),
    notListedCount: countStatus(input.rows, "not_listed"),
    sampleSize: prices.length,
    confidence: confidenceFor(prices.length, countStatus(input.rows, "failed")),
    generatedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

export function median(prices: number[]): number | null {
  if (prices.length === 0) return null;
  const midpoint = Math.floor(prices.length / 2);
  if (prices.length % 2 === 1) return prices[midpoint] ?? null;
  const lower = prices[midpoint - 1];
  const upper = prices[midpoint];
  if (lower === undefined || upper === undefined) return null;
  return Math.round((lower + upper) / 2);
}

export function confidenceFor(availableCount: number, failedCount: number): MarketSignalConfidence {
  if (availableCount >= 5 && failedCount <= availableCount) return "A";
  if (availableCount >= 3) return "B";
  if (availableCount >= 1) return "C";
  return "insufficient";
}

function buildAdjustedMetrics(
  rows: LatestSnapshotRow[],
  rawPrices: number[]
): {
  prices: number[];
  excludedQualityFlagCount: number;
  excludedHighSeverityCount: number;
  reason: QualityAdjustmentReason;
} {
  const availableRows = rows.filter(
    (row) => row.availability_status === "available" && row.price_total_tax_included !== null
  );
  const rowsWithQuality = availableRows.filter((row) => row.quality_severity !== null);
  if (availableRows.length > 0 && rowsWithQuality.length === 0) {
    return {
      prices: rawPrices,
      excludedQualityFlagCount: 0,
      excludedHighSeverityCount: 0,
      reason: "quality_flags_not_available"
    };
  }

  const excludedRows = availableRows.filter((row) => row.quality_severity === "high");
  const adjustedPrices = availableRows
    .filter((row) => row.quality_severity !== "high")
    .map((row) => row.price_total_tax_included as number)
    .sort((left, right) => left - right);

  if (excludedRows.length === 0) {
    return {
      prices: rawPrices,
      excludedQualityFlagCount: 0,
      excludedHighSeverityCount: 0,
      reason: "no_high_severity_quality_flags"
    };
  }

  return {
    prices: adjustedPrices,
    excludedQualityFlagCount: excludedRows.length,
    excludedHighSeverityCount: excludedRows.length,
    reason:
      adjustedPrices.length === 0
        ? "all_available_rows_excluded_by_quality_flags"
        : "excluded_high_severity_quality_flags"
  };
}

function loadLatestSnapshotRows(
  db: LocalDatabase,
  input: { source: "jalan"; postalCode: "990-2301"; from?: string; to?: string }
): LatestSnapshotRow[] {
  const params: Record<string, string> = {
    source: input.source,
    postalCode: input.postalCode
  };
  const filters = ["rs.ota = @source", "p.postal_code = @postalCode"];
  if (input.from !== undefined) {
    filters.push("rs.stay_date >= @from");
    params.from = input.from;
  }
  if (input.to !== undefined) {
    filters.push("rs.stay_date <= @to");
    params.to = input.to;
  }

  return db
    .prepare(
      `WITH ranked AS (
         SELECT
           rs.id AS rate_snapshot_id,
           rs.property_id,
           rs.stay_date,
           rs.availability_status,
           rs.price_total_tax_included,
           pqf.severity AS quality_severity,
           ROW_NUMBER() OVER (
             PARTITION BY rs.property_id, rs.ota, rs.stay_date
             ORDER BY rs.checked_at_jst DESC, rs.created_at DESC, rs.id DESC
           ) AS row_rank
         FROM rate_snapshots rs
         JOIN properties p ON p.id = rs.property_id
         LEFT JOIN price_quality_flags pqf ON pqf.rate_snapshot_id = rs.id
         WHERE ${filters.join(" AND ")}
       )
       SELECT rate_snapshot_id, property_id, stay_date, availability_status, price_total_tax_included, quality_severity
       FROM ranked
       WHERE row_rank = 1
       ORDER BY stay_date ASC, property_id ASC`
    )
    .all(params) as LatestSnapshotRow[];
}

function countStatus(rows: LatestSnapshotRow[], status: LatestSnapshotRow["availability_status"]): number {
  return rows.filter((row) => row.availability_status === status).length;
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function stableSignalId(stayDate: string, source: string, postalCode: string): string {
  const digest = crypto.createHash("sha1").update(`${stayDate}|${source}|${postalCode}`).digest("hex").slice(0, 16);
  return `market_signal_${digest}`;
}
