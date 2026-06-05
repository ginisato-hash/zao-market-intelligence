import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import {
  listSourceCoverageCandidates,
  summarizeSourceCoverageCandidates
} from "../db/repositories/sourceCoverageCandidatesRepository";

const SAMPLE_ROW_LIMIT = 40;

export interface SourceCoverageCandidatesInspection {
  totalCandidates: number;
  countBySource: Record<string, number>;
  countByVerificationStatus: Record<string, number>;
  candidateCountBySource: Record<string, number>;
  needsReviewCountBySource: Record<string, number>;
  confirmedCountBySource: Record<string, number>;
  rejectedCountBySource: Record<string, number>;
  sampleRows: SourceCoverageCandidateSampleRow[];
}

export interface SourceCoverageCandidateSampleRow {
  source: string;
  propertyName: string;
  verificationStatus: string;
  candidatePropertyUrl: string | null;
  candidateSourcePropertyId: string | null;
  evidenceNoteExcerpt: string;
  reviewerNoteExcerpt: string | null;
}

export function buildSourceCoverageCandidatesInspection(
  db: LocalDatabase
): SourceCoverageCandidatesInspection {
  const summary = summarizeSourceCoverageCandidates(db);
  const all = listSourceCoverageCandidates(db);

  const EXCERPT_LEN = 60;
  const excerpt = (s: string | null): string | null =>
    s === null ? null : s.length <= EXCERPT_LEN ? s : `${s.slice(0, EXCERPT_LEN)}…`;

  const sampleRows: SourceCoverageCandidateSampleRow[] = all.slice(0, SAMPLE_ROW_LIMIT).map((row) => ({
    source: row.source,
    propertyName: row.propertyName,
    verificationStatus: row.verificationStatus,
    candidatePropertyUrl: row.candidatePropertyUrl,
    candidateSourcePropertyId: row.candidateSourcePropertyId,
    evidenceNoteExcerpt: excerpt(row.evidenceNote) ?? row.evidenceNote,
    reviewerNoteExcerpt: excerpt(row.reviewerNote)
  }));

  return {
    totalCandidates: summary.totalCandidates,
    countBySource: summary.countBySource,
    countByVerificationStatus: summary.countByVerificationStatus,
    candidateCountBySource: summary.candidateCountBySource,
    needsReviewCountBySource: summary.needsReviewCountBySource,
    confirmedCountBySource: summary.confirmedCountBySource,
    rejectedCountBySource: summary.rejectedCountBySource,
    sampleRows
  };
}

export function formatSourceCoverageCandidatesInspection(
  inspection: SourceCoverageCandidatesInspection
): string {
  const lines = [
    `total_candidates=${inspection.totalCandidates}`,
    `count_by_source=${JSON.stringify(inspection.countBySource)}`,
    `count_by_verification_status=${JSON.stringify(inspection.countByVerificationStatus)}`,
    `candidate_count_by_source=${JSON.stringify(inspection.candidateCountBySource)}`,
    `needs_review_count_by_source=${JSON.stringify(inspection.needsReviewCountBySource)}`,
    `confirmed_count_by_source=${JSON.stringify(inspection.confirmedCountBySource)}`,
    `rejected_count_by_source=${JSON.stringify(inspection.rejectedCountBySource)}`,
    "---",
    "source | property_name | verification_status | candidate_source_property_id | evidence_note_excerpt | reviewer_note_excerpt"
  ];

  for (const row of inspection.sampleRows) {
    lines.push(
      [
        row.source,
        row.propertyName,
        row.verificationStatus,
        row.candidateSourcePropertyId ?? "",
        row.evidenceNoteExcerpt,
        row.reviewerNoteExcerpt ?? ""
      ].join(" | ")
    );
  }
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("inspectSourceCoverageCandidates.ts")) {
  const db = openLocalDatabase();
  try {
    executeMigration(db);
    console.log(
      formatSourceCoverageCandidatesInspection(buildSourceCoverageCandidatesInspection(db))
    );
  } finally {
    closeDatabase(db);
  }
}
