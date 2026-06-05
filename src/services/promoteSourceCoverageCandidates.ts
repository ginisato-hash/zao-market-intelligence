import { createHash } from "node:crypto";
import type { LocalDatabase } from "../db/client";
import {
  listSourceCoverageCandidates,
  type SourceCoverageCandidateRecordRow
} from "../db/repositories/sourceCoverageCandidatesRepository";
import { upsertPropertySourceCoverage } from "../db/repositories/propertySourceCoverageRepository";
import { isCanonicalSource } from "./sourceVocabulary";
import { resolveCanonicalPropertyNameDetailed } from "./propertyAliasResolver";
import { readPropertyAliasSeed } from "../seeds/importPropertyAliases";
import { runInTransaction } from "../db/client";

/**
 * Phase 43X: controlled promotion from source_coverage_candidates to
 * property_source_coverage. Only `confirmed` and `needs_review` candidates are
 * eligible. Plain `candidate` and `rejected` rows are permanently skipped.
 * Candidate rows are kept as audit history; promotion is idempotent.
 * No price collection or network access is performed.
 */
export type CandidatePromotionDecision =
  | "promoted_confirmed"
  | "promoted_needs_review"
  | "skipped_candidate"
  | "skipped_rejected"
  | "skipped_missing_url_or_id"
  | "skipped_invalid_source"
  | "skipped_missing_evidence";

export interface CandidatePromotionResult {
  candidateId: string;
  propertyName: string;
  source: string;
  decision: CandidatePromotionDecision;
  coverageStatus?: "confirmed" | "needs_review";
  reason: string;
}

export interface PromotionSummary {
  totalCandidates: number;
  results: CandidatePromotionResult[];
  promotedConfirmed: number;
  promotedNeedsReview: number;
  skippedCandidate: number;
  skippedRejected: number;
  skippedMissingUrlOrId: number;
  skippedInvalidSource: number;
  skippedMissingEvidence: number;
  countBySource: Record<string, number>;
  countByDecision: Record<string, number>;
}

export interface PromotionOptions {
  aliasSeedPath?: string;
}

export function promoteEligibleCandidates(
  db: LocalDatabase,
  options: PromotionOptions = {}
): PromotionSummary {
  const aliases = readPropertyAliasSeed(options.aliasSeedPath);
  const candidates = listSourceCoverageCandidates(db);

  return runInTransaction(db, () => {
    const results: CandidatePromotionResult[] = [];

    for (const candidate of candidates) {
      const result = processCandidate(db, candidate, aliases);
      results.push(result);
    }

    const countBySource: Record<string, number> = {};
    const countByDecision: Record<string, number> = {};
    for (const r of results) {
      countBySource[r.source] = (countBySource[r.source] ?? 0) + 1;
      countByDecision[r.decision] = (countByDecision[r.decision] ?? 0) + 1;
    }

    return {
      totalCandidates: candidates.length,
      results,
      promotedConfirmed: results.filter((r) => r.decision === "promoted_confirmed").length,
      promotedNeedsReview: results.filter((r) => r.decision === "promoted_needs_review").length,
      skippedCandidate: results.filter((r) => r.decision === "skipped_candidate").length,
      skippedRejected: results.filter((r) => r.decision === "skipped_rejected").length,
      skippedMissingUrlOrId: results.filter((r) => r.decision === "skipped_missing_url_or_id").length,
      skippedInvalidSource: results.filter((r) => r.decision === "skipped_invalid_source").length,
      skippedMissingEvidence: results.filter((r) => r.decision === "skipped_missing_evidence").length,
      countBySource,
      countByDecision
    };
  });
}

function processCandidate(
  db: LocalDatabase,
  candidate: SourceCoverageCandidateRecordRow,
  aliases: ReturnType<typeof readPropertyAliasSeed>
): CandidatePromotionResult {
  const base = {
    candidateId: candidate.id,
    propertyName: candidate.propertyName,
    source: candidate.source
  };

  if (candidate.verificationStatus === "candidate") {
    return { ...base, decision: "skipped_candidate", reason: "verification_status is candidate; manual review required" };
  }
  if (candidate.verificationStatus === "rejected") {
    return { ...base, decision: "skipped_rejected", reason: "verification_status is rejected" };
  }
  if (!isCanonicalSource(candidate.source)) {
    return { ...base, decision: "skipped_invalid_source", reason: `source "${candidate.source}" is not canonical` };
  }
  if (candidate.candidatePropertyUrl === null && candidate.candidateSourcePropertyId === null) {
    return { ...base, decision: "skipped_missing_url_or_id", reason: "both candidate_property_url and candidate_source_property_id are null" };
  }
  if (candidate.evidenceNote.trim().length === 0) {
    return { ...base, decision: "skipped_missing_evidence", reason: "evidence_note is blank" };
  }

  const isConfirmed = candidate.verificationStatus === "confirmed";
  const propertyId = resolveOrInsertPropertyId(db, candidate, aliases);
  const { coverageStatus, accessStatus } = determineCoverageAttributes(candidate.source, isConfirmed);
  const propertyUrl = resolvePropertyUrl(candidate);

  upsertPropertySourceCoverage(db, {
    propertyId,
    source: candidate.source,
    sourcePropertyId: candidate.candidateSourcePropertyId,
    propertyUrl,
    coverageStatus,
    accessStatus,
    notes: candidate.evidenceNote,
    active: true
  });

  const decision: CandidatePromotionDecision =
    coverageStatus === "confirmed" ? "promoted_confirmed" : "promoted_needs_review";

  return {
    ...base,
    decision,
    coverageStatus,
    reason: `promoted to coverage as ${coverageStatus} (access_status: ${accessStatus})`
  };
}

/**
 * Source-specific coverage and access status mapping.
 *
 * Booking: even a verified slug stays needs_review — Booking can still be
 * blocked or inconsistent. Only explicit stable-content evidence warrants
 * confirmed, and this workflow does not carry that evidence.
 *
 * Google Hotels: never confirmed via free/direct access per hard constraint.
 * Stays needs_review so future probes can still target it.
 *
 * Rakuten confirmed: confirmed with needs_feasibility_probe — the URL is
 * verified but a probe has not yet confirmed plan-level extraction.
 *
 * Jalan confirmed: confirmed with collector_working — Jalan has a working
 * collector and these IDs come from prior verified batches.
 */
function determineCoverageAttributes(
  source: string,
  isConfirmed: boolean
): { coverageStatus: "confirmed" | "needs_review"; accessStatus: string } {
  if (source === "booking") {
    return { coverageStatus: "needs_review", accessStatus: "content_visibility_unverified" };
  }
  if (source === "google_hotels") {
    return { coverageStatus: "needs_review", accessStatus: "free_direct_feasibility_unresolved" };
  }
  if (!isConfirmed) {
    return { coverageStatus: "needs_review", accessStatus: "needs_manual_verification" };
  }
  if (source === "rakuten") {
    return { coverageStatus: "confirmed", accessStatus: "needs_feasibility_probe" };
  }
  if (source === "jalan") {
    return { coverageStatus: "confirmed", accessStatus: "collector_working" };
  }
  // Other canonical sources confirmed (yahoo_travel, ikyu, etc.)
  return { coverageStatus: "confirmed", accessStatus: "needs_manual_verification" };
}

/** Build property URL from candidate data, inferring from source+id if needed. */
function resolvePropertyUrl(candidate: SourceCoverageCandidateRecordRow): string | null {
  if (candidate.candidatePropertyUrl !== null) {
    return candidate.candidatePropertyUrl;
  }
  const id = candidate.candidateSourcePropertyId;
  if (id === null) return null;
  switch (candidate.source) {
    case "rakuten":
      return `https://travel.rakuten.co.jp/HOTEL/${id}/`;
    case "booking":
      return `https://www.booking.com/hotel/jp/${id}.ja.html`;
    case "google_hotels":
      return `https://www.google.com/travel/hotels/entity/${id}`;
    case "jalan":
      return `https://www.jalan.net/${id}/`;
    default:
      return null;
  }
}

// ── Property resolution ────────────────────────────────────────────────────

interface RowWithId {
  id: string;
}

function resolveOrInsertPropertyId(
  db: LocalDatabase,
  candidate: SourceCoverageCandidateRecordRow,
  aliases: ReturnType<typeof readPropertyAliasSeed>
): string {
  // 1. Use stored propertyId if the row still exists
  if (candidate.propertyId !== null) {
    const existing = db
      .prepare("SELECT id FROM properties WHERE id = ?")
      .get(candidate.propertyId) as RowWithId | undefined;
    if (existing !== undefined) return existing.id;
  }

  // 2. Exact canonical-name match
  const exact = findPropertyByName(db, candidate.propertyName);
  if (exact !== undefined) return exact.id;

  // 3. Alias-resolved match
  const resolution = resolveCanonicalPropertyNameDetailed(candidate.propertyName, aliases);
  const canonicalName =
    resolution.status === "ambiguous" ? candidate.propertyName : resolution.canonicalName;
  const canonical = findPropertyByName(db, canonicalName);
  if (canonical !== undefined) return canonical.id;

  // 4. Insert a minimal placeholder (same pattern as importPropertySourceCoverage)
  const propertyId = deterministicPropertyId(canonicalName);
  db.prepare(
    `INSERT INTO properties (
       id, name, postal_code, area_name, property_type, price_segment,
       meal_style, has_onsen, ski_access, active, notes
     )
     VALUES (
       @id, @name, '990-2301', 'Zao Onsen', 'unknown', 'unknown',
       'unknown', NULL, 'unknown', 1, @notes
     )`
  ).run({
    id: propertyId,
    name: canonicalName,
    notes: "Inserted during candidate promotion; property metadata requires manual verification."
  });
  return propertyId;
}

function findPropertyByName(db: LocalDatabase, propertyName: string): RowWithId | undefined {
  return db
    .prepare("SELECT id FROM properties WHERE name = ? AND postal_code = '990-2301'")
    .get(propertyName) as RowWithId | undefined;
}

function deterministicPropertyId(propertyName: string): string {
  return `property_9902301_${createHash("sha1").update(propertyName).digest("hex").slice(0, 12)}`;
}
