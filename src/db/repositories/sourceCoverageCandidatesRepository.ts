import crypto from "node:crypto";
import type { LocalDatabase } from "../client";

export interface SourceCoverageCandidateRecordRow {
  id: string;
  propertyId: string | null;
  propertyName: string;
  source: string;
  candidatePropertyUrl: string | null;
  candidateSourcePropertyId: string | null;
  candidateLabel: string | null;
  evidenceNote: string;
  verificationStatus: string;
  reviewerNote: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SourceCoverageCandidateUpsert {
  propertyId?: string | null;
  propertyName: string;
  source: string;
  candidatePropertyUrl?: string | null;
  candidateSourcePropertyId?: string | null;
  candidateLabel?: string | null;
  evidenceNote: string;
  verificationStatus: string;
  reviewerNote?: string | null;
  active?: boolean;
}

export interface SourceCoverageCandidateFilters {
  source?: string;
  verificationStatus?: string;
}

export interface SourceCoverageCandidateSummary {
  totalCandidates: number;
  countBySource: Record<string, number>;
  countByVerificationStatus: Record<string, number>;
  candidateCountBySource: Record<string, number>;
  needsReviewCountBySource: Record<string, number>;
  confirmedCountBySource: Record<string, number>;
  rejectedCountBySource: Record<string, number>;
}

/**
 * Deterministic id over the natural key. We key the upsert on this id rather
 * than relying on the SQL UNIQUE constraint because SQLite treats NULLs as
 * distinct, which would otherwise allow duplicate (name, source, NULL, NULL)
 * rows and break idempotency.
 */
export function sourceCoverageCandidateId(
  propertyName: string,
  source: string,
  candidatePropertyUrl: string | null,
  candidateSourcePropertyId: string | null
): string {
  const key = [propertyName, source, candidatePropertyUrl ?? "", candidateSourcePropertyId ?? ""].join("|");
  const digest = crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
  return `source_coverage_candidate_${digest}`;
}

export function upsertSourceCoverageCandidate(
  db: LocalDatabase,
  row: SourceCoverageCandidateUpsert
): { inserted: boolean; updated: boolean } {
  const candidatePropertyUrl = row.candidatePropertyUrl ?? null;
  const candidateSourcePropertyId = row.candidateSourcePropertyId ?? null;
  const id = sourceCoverageCandidateId(row.propertyName, row.source, candidatePropertyUrl, candidateSourcePropertyId);
  const params = {
    id,
    propertyId: row.propertyId ?? null,
    propertyName: row.propertyName,
    source: row.source,
    candidatePropertyUrl,
    candidateSourcePropertyId,
    candidateLabel: row.candidateLabel ?? null,
    evidenceNote: row.evidenceNote,
    verificationStatus: row.verificationStatus,
    reviewerNote: row.reviewerNote ?? null,
    active: (row.active ?? true) ? 1 : 0
  };

  const existing = db.prepare("SELECT id FROM source_coverage_candidates WHERE id = ?").get(id) as
    | { id: string }
    | undefined;

  if (existing === undefined) {
    db.prepare(
      `INSERT INTO source_coverage_candidates (
         id, property_id, property_name, source, candidate_property_url,
         candidate_source_property_id, candidate_label, evidence_note,
         verification_status, reviewer_note, active
       )
       VALUES (
         @id, @propertyId, @propertyName, @source, @candidatePropertyUrl,
         @candidateSourcePropertyId, @candidateLabel, @evidenceNote,
         @verificationStatus, @reviewerNote, @active
       )`
    ).run(params);
    return { inserted: true, updated: false };
  }

  db.prepare(
    `UPDATE source_coverage_candidates
     SET property_id = @propertyId,
         candidate_label = @candidateLabel,
         evidence_note = @evidenceNote,
         verification_status = @verificationStatus,
         reviewer_note = @reviewerNote,
         active = @active,
         updated_at = datetime('now')
     WHERE id = @id`
  ).run(params);
  return { inserted: false, updated: true };
}

export function listSourceCoverageCandidates(
  db: LocalDatabase,
  filters: SourceCoverageCandidateFilters = {}
): SourceCoverageCandidateRecordRow[] {
  const params: Record<string, string> = {};
  const where: string[] = [];
  if (filters.source !== undefined) {
    where.push("source = @source");
    params.source = filters.source;
  }
  if (filters.verificationStatus !== undefined) {
    where.push("verification_status = @verificationStatus");
    params.verificationStatus = filters.verificationStatus;
  }
  const sql = [
    "SELECT * FROM source_coverage_candidates",
    where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`,
    "ORDER BY source ASC, property_name ASC"
  ].join(" ");
  return (db.prepare(sql).all(params) as CandidateDbRow[]).map(mapRow);
}

export function summarizeSourceCoverageCandidates(db: LocalDatabase): SourceCoverageCandidateSummary {
  const totalCandidates = (
    db.prepare("SELECT COUNT(*) AS count FROM source_coverage_candidates").get() as { count: number }
  ).count;
  return {
    totalCandidates,
    countBySource: groupCount(
      db,
      "SELECT source AS key, COUNT(*) AS count FROM source_coverage_candidates GROUP BY source ORDER BY source"
    ),
    countByVerificationStatus: groupCount(
      db,
      "SELECT verification_status AS key, COUNT(*) AS count FROM source_coverage_candidates GROUP BY verification_status ORDER BY verification_status"
    ),
    candidateCountBySource: groupCountByStatus(db, "candidate"),
    needsReviewCountBySource: groupCountByStatus(db, "needs_review"),
    confirmedCountBySource: groupCountByStatus(db, "confirmed"),
    rejectedCountBySource: groupCountByStatus(db, "rejected")
  };
}

export function sourceCoverageCandidatesTableExists(db: LocalDatabase): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_coverage_candidates'")
    .get() as { name: string } | undefined;
  return row !== undefined;
}

interface CandidateDbRow {
  id: string;
  property_id: string | null;
  property_name: string;
  source: string;
  candidate_property_url: string | null;
  candidate_source_property_id: string | null;
  candidate_label: string | null;
  evidence_note: string;
  verification_status: string;
  reviewer_note: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: CandidateDbRow): SourceCoverageCandidateRecordRow {
  return {
    id: row.id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    source: row.source,
    candidatePropertyUrl: row.candidate_property_url,
    candidateSourcePropertyId: row.candidate_source_property_id,
    candidateLabel: row.candidate_label,
    evidenceNote: row.evidence_note,
    verificationStatus: row.verification_status,
    reviewerNote: row.reviewer_note,
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

function groupCountByStatus(db: LocalDatabase, status: string): Record<string, number> {
  return Object.fromEntries(
    (
      db
        .prepare(
          "SELECT source AS key, COUNT(*) AS count FROM source_coverage_candidates WHERE verification_status = ? GROUP BY source ORDER BY source"
        )
        .all(status) as Array<{ key: string; count: number }>
    ).map((row) => [row.key, row.count])
  );
}
