import crypto from "node:crypto";
import type { LocalDatabase } from "../client";

export interface PropertySourceCoverageRecord {
  id: string;
  propertyId: string;
  source: string;
  sourcePropertyId: string | null;
  propertyUrl: string | null;
  coverageStatus: string;
  accessStatus: string | null;
  lastVerifiedAt: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PropertySourceCoverageUpsert {
  propertyId: string;
  source: string;
  sourcePropertyId?: string | null;
  propertyUrl?: string | null;
  coverageStatus: string;
  accessStatus?: string | null;
  lastVerifiedAt?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface PropertySourceCoverageFilters {
  source?: string;
  coverageStatus?: string;
  active?: boolean;
}

export interface PropertySourceCoverageSummary {
  totalCoverageRows: number;
  countBySource: Record<string, number>;
  countByCoverageStatus: Record<string, number>;
}

export function propertySourceCoverageId(propertyId: string, source: string): string {
  const digest = crypto.createHash("sha1").update(`${propertyId}|${source}`).digest("hex").slice(0, 16);
  return `property_source_coverage_${digest}`;
}

export function upsertPropertySourceCoverage(
  db: LocalDatabase,
  row: PropertySourceCoverageUpsert
): { inserted: boolean; updated: boolean } {
  const existing = getPropertySourceCoverage(db, row.propertyId, row.source);
  const params = {
    id: propertySourceCoverageId(row.propertyId, row.source),
    propertyId: row.propertyId,
    source: row.source,
    sourcePropertyId: row.sourcePropertyId ?? null,
    propertyUrl: row.propertyUrl ?? null,
    coverageStatus: row.coverageStatus,
    accessStatus: row.accessStatus ?? null,
    lastVerifiedAt: row.lastVerifiedAt ?? null,
    notes: row.notes ?? null,
    active: (row.active ?? true) ? 1 : 0
  };

  if (existing === null) {
    db.prepare(
      `INSERT INTO property_source_coverage (
         id, property_id, source, source_property_id, property_url,
         coverage_status, access_status, last_verified_at, notes, active
       )
       VALUES (
         @id, @propertyId, @source, @sourcePropertyId, @propertyUrl,
         @coverageStatus, @accessStatus, @lastVerifiedAt, @notes, @active
       )`
    ).run(params);
    return { inserted: true, updated: false };
  }

  // Preserve id and created_at; refresh mutable fields and updated_at.
  db.prepare(
    `UPDATE property_source_coverage
     SET source_property_id = @sourcePropertyId,
         property_url = @propertyUrl,
         coverage_status = @coverageStatus,
         access_status = @accessStatus,
         last_verified_at = @lastVerifiedAt,
         notes = @notes,
         active = @active,
         updated_at = datetime('now')
     WHERE property_id = @propertyId AND source = @source`
  ).run(params);
  return { inserted: false, updated: true };
}

export function getPropertySourceCoverage(
  db: LocalDatabase,
  propertyId: string,
  source: string
): PropertySourceCoverageRecord | null {
  const row = db
    .prepare("SELECT * FROM property_source_coverage WHERE property_id = ? AND source = ?")
    .get(propertyId, source) as PropertySourceCoverageDbRow | undefined;
  return row === undefined ? null : mapRow(row);
}

export function listPropertySourceCoverage(
  db: LocalDatabase,
  filters: PropertySourceCoverageFilters = {}
): PropertySourceCoverageRecord[] {
  const params: Record<string, string | number> = {};
  const where: string[] = [];
  if (filters.source !== undefined) {
    where.push("source = @source");
    params.source = filters.source;
  }
  if (filters.coverageStatus !== undefined) {
    where.push("coverage_status = @coverageStatus");
    params.coverageStatus = filters.coverageStatus;
  }
  if (filters.active !== undefined) {
    where.push("active = @active");
    params.active = filters.active ? 1 : 0;
  }

  const sql = [
    "SELECT * FROM property_source_coverage",
    where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`,
    "ORDER BY source ASC, property_id ASC"
  ].join(" ");
  return (db.prepare(sql).all(params) as PropertySourceCoverageDbRow[]).map(mapRow);
}

export function summarizePropertySourceCoverage(db: LocalDatabase): PropertySourceCoverageSummary {
  const totalCoverageRows = (
    db.prepare("SELECT COUNT(*) AS count FROM property_source_coverage").get() as { count: number }
  ).count;
  return {
    totalCoverageRows,
    countBySource: groupCount(
      db,
      "SELECT source AS key, COUNT(*) AS count FROM property_source_coverage GROUP BY source ORDER BY source"
    ),
    countByCoverageStatus: groupCount(
      db,
      "SELECT coverage_status AS key, COUNT(*) AS count FROM property_source_coverage GROUP BY coverage_status ORDER BY coverage_status"
    )
  };
}

interface PropertySourceCoverageDbRow {
  id: string;
  property_id: string;
  source: string;
  source_property_id: string | null;
  property_url: string | null;
  coverage_status: string;
  access_status: string | null;
  last_verified_at: string | null;
  notes: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: PropertySourceCoverageDbRow): PropertySourceCoverageRecord {
  return {
    id: row.id,
    propertyId: row.property_id,
    source: row.source,
    sourcePropertyId: row.source_property_id,
    propertyUrl: row.property_url,
    coverageStatus: row.coverage_status,
    accessStatus: row.access_status,
    lastVerifiedAt: row.last_verified_at,
    notes: row.notes,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function groupCount(db: LocalDatabase, sql: string): Record<string, number> {
  return Object.fromEntries(
    db
      .prepare(sql)
      .all()
      .map((row) => {
        const typed = row as { key: string; count: number };
        return [typed.key, typed.count];
      })
  );
}
