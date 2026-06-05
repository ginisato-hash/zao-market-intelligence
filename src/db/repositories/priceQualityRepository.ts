import type { LocalDatabase } from "../client";
import type { PriceQualityAssessment } from "../../services/priceQuality";

export interface PriceQualityFlagRecord {
  id: string;
  rateSnapshotId: string;
  source: string;
  propertyId: string | null;
  stayDate: string;
  priceJpy: number | null;
  flags: string[];
  severity: PriceQualityAssessment["severity"];
  reason: string;
  createdAt: string;
}

export interface UpsertPriceQualityFlagInput {
  id: string;
  rateSnapshotId: string;
  source: string;
  propertyId?: string | null;
  stayDate: string;
  assessment: PriceQualityAssessment;
  createdAt: string;
}

export function upsertPriceQualityFlag(db: LocalDatabase, input: UpsertPriceQualityFlagInput): void {
  db.prepare(
    `INSERT INTO price_quality_flags (
       id,
       rate_snapshot_id,
       source,
       property_id,
       stay_date,
       price_jpy,
       flags_json,
       severity,
       reason,
       created_at
     )
     VALUES (
       @id,
       @rateSnapshotId,
       @source,
       @propertyId,
       @stayDate,
       @priceJpy,
       @flagsJson,
       @severity,
       @reason,
       @createdAt
     )
     ON CONFLICT(rate_snapshot_id) DO UPDATE SET
       source = excluded.source,
       property_id = excluded.property_id,
       stay_date = excluded.stay_date,
       price_jpy = excluded.price_jpy,
       flags_json = excluded.flags_json,
       severity = excluded.severity,
       reason = excluded.reason`
  ).run({
    id: input.id,
    rateSnapshotId: input.rateSnapshotId,
    source: input.source,
    propertyId: input.propertyId ?? null,
    stayDate: input.stayDate,
    priceJpy: input.assessment.priceJpy,
    flagsJson: JSON.stringify(input.assessment.flags),
    severity: input.assessment.severity,
    reason: input.assessment.reason,
    createdAt: input.createdAt
  });
}

export function getPriceQualityFlagForSnapshot(
  db: LocalDatabase,
  rateSnapshotId: string
): PriceQualityFlagRecord | undefined {
  const row = db
    .prepare("SELECT * FROM price_quality_flags WHERE rate_snapshot_id = ?")
    .get(rateSnapshotId) as PriceQualityFlagRow | undefined;
  return row === undefined ? undefined : mapRow(row);
}

export function listPriceQualityFlags(
  db: LocalDatabase,
  filters: { source?: string; from?: string; to?: string; flaggedOnly?: boolean } = {}
): PriceQualityFlagRecord[] {
  const params: Record<string, string> = {};
  const where: string[] = [];
  if (filters.source !== undefined) {
    where.push("source = @source");
    params.source = filters.source;
  }
  if (filters.from !== undefined) {
    where.push("stay_date >= @from");
    params.from = filters.from;
  }
  if (filters.to !== undefined) {
    where.push("stay_date <= @to");
    params.to = filters.to;
  }
  if (filters.flaggedOnly === true) {
    where.push("severity <> 'none'");
  }

  const sql = [
    "SELECT * FROM price_quality_flags",
    where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`,
    "ORDER BY stay_date ASC, severity DESC, price_jpy ASC"
  ].join(" ");
  return (db.prepare(sql).all(params) as PriceQualityFlagRow[]).map(mapRow);
}

interface PriceQualityFlagRow {
  id: string;
  rate_snapshot_id: string;
  source: string;
  property_id: string | null;
  stay_date: string;
  price_jpy: number | null;
  flags_json: string;
  severity: PriceQualityAssessment["severity"];
  reason: string;
  created_at: string;
}

function mapRow(row: PriceQualityFlagRow): PriceQualityFlagRecord {
  return {
    id: row.id,
    rateSnapshotId: row.rate_snapshot_id,
    source: row.source,
    propertyId: row.property_id,
    stayDate: row.stay_date,
    priceJpy: row.price_jpy,
    flags: JSON.parse(row.flags_json) as string[],
    severity: row.severity,
    reason: row.reason,
    createdAt: row.created_at
  };
}
