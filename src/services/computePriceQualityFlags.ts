import crypto from "node:crypto";
import type { LocalDatabase } from "../db/client";
import { upsertPriceQualityFlag } from "../db/repositories/priceQualityRepository";
import { assessJalanPriceQuality, type PriceQualityAssessment } from "./priceQuality";

export interface PriceQualityAssessmentRow {
  rateSnapshotId: string;
  source: "jalan";
  propertyId: string;
  propertyName: string;
  propertyType: string;
  stayDate: string;
  priceJpy: number;
  marketMedianJpy: number | null;
  marketSampleSize: number;
  assessment: PriceQualityAssessment;
}

export interface ComputePriceQualityFlagsSummary {
  assessedCount: number;
  flaggedCount: number;
  countBySeverity: Record<string, number>;
  countByFlag: Record<string, number>;
  sampleFlaggedRows: PriceQualityAssessmentRow[];
}

interface LatestAvailableSnapshotRow {
  rate_snapshot_id: string;
  property_id: string;
  property_name: string;
  property_type: string;
  stay_date: string;
  price_jpy: number;
  market_median_jpy: number | null;
  market_sample_size: number | null;
}

export function computePriceQualityFlags(
  db: LocalDatabase,
  input: { source?: "jalan"; postalCode?: "990-2301"; from?: string; to?: string; createdAt?: string } = {}
): ComputePriceQualityFlagsSummary {
  const source = input.source ?? "jalan";
  const postalCode = input.postalCode ?? "990-2301";
  const createdAt = input.createdAt ?? new Date().toISOString();
  const rows = loadLatestAvailableSnapshots(db, {
    source,
    postalCode,
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to })
  });

  const assessed = rows.map((row) => {
    const assessment = assessJalanPriceQuality({
      priceJpy: row.price_jpy,
      marketMedianJpy: row.market_median_jpy,
      marketSampleSize: row.market_sample_size ?? 0,
      knownLodgingProperty: row.property_type !== "unknown"
    });
    return {
      rateSnapshotId: row.rate_snapshot_id,
      source,
      propertyId: row.property_id,
      propertyName: row.property_name,
      propertyType: row.property_type,
      stayDate: row.stay_date,
      priceJpy: row.price_jpy,
      marketMedianJpy: row.market_median_jpy,
      marketSampleSize: row.market_sample_size ?? 0,
      assessment
    };
  });

  for (const row of assessed) {
    upsertPriceQualityFlag(db, {
      id: stableQualityFlagId(row.rateSnapshotId),
      rateSnapshotId: row.rateSnapshotId,
      source: row.source,
      propertyId: row.propertyId,
      stayDate: row.stayDate,
      assessment: row.assessment,
      createdAt
    });
  }

  const flaggedRows = assessed.filter((row) => row.assessment.severity !== "none");
  return {
    assessedCount: assessed.length,
    flaggedCount: flaggedRows.length,
    countBySeverity: countBy(assessed, (row) => row.assessment.severity),
    countByFlag: countFlags(assessed),
    sampleFlaggedRows: flaggedRows.slice(0, 10)
  };
}

function loadLatestAvailableSnapshots(
  db: LocalDatabase,
  input: { source: "jalan"; postalCode: "990-2301"; from?: string; to?: string }
): LatestAvailableSnapshotRow[] {
  const params: Record<string, string> = {
    source: input.source,
    postalCode: input.postalCode
  };
  const filters = [
    "rs.ota = @source",
    "p.postal_code = @postalCode",
    "rs.availability_status = 'available'",
    "rs.price_total_tax_included IS NOT NULL"
  ];
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
           p.name AS property_name,
           p.property_type,
           rs.stay_date,
           rs.price_total_tax_included AS price_jpy,
           ROW_NUMBER() OVER (
             PARTITION BY rs.property_id, rs.ota, rs.stay_date
             ORDER BY rs.checked_at_jst DESC, rs.created_at DESC, rs.id DESC
           ) AS row_rank
         FROM rate_snapshots rs
         JOIN properties p ON p.id = rs.property_id
         WHERE ${filters.join(" AND ")}
       )
       SELECT
         ranked.rate_snapshot_id,
         ranked.property_id,
         ranked.property_name,
         ranked.property_type,
         ranked.stay_date,
         ranked.price_jpy,
         mds.median_price_jpy AS market_median_jpy,
         mds.sample_size AS market_sample_size
       FROM ranked
       LEFT JOIN market_daily_signals mds
         ON mds.stay_date = ranked.stay_date
        AND mds.source = @source
        AND mds.postal_code = @postalCode
       WHERE ranked.row_rank = 1
       ORDER BY ranked.stay_date ASC, ranked.property_name ASC`
    )
    .all(params) as LatestAvailableSnapshotRow[];
}

function stableQualityFlagId(rateSnapshotId: string): string {
  const digest = crypto.createHash("sha1").update(rateSnapshotId).digest("hex").slice(0, 16);
  return `price_quality_${digest}`;
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function countFlags(rows: PriceQualityAssessmentRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const flag of row.assessment.flags) {
      counts[flag] = (counts[flag] ?? 0) + 1;
    }
  }
  return counts;
}
