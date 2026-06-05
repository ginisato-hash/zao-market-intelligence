import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  closeDatabase,
  executeMigration,
  openLocalDatabase,
  runInTransaction,
  type LocalDatabase
} from "../db/client";
import {
  upsertSourceCoverageCandidate
} from "../db/repositories/sourceCoverageCandidatesRepository";
import { readPropertyAliasSeed } from "./importPropertyAliases";
import { resolveCanonicalPropertyNameDetailed } from "../services/propertyAliasResolver";
import {
  sourceCoverageCandidateRecordSchema,
  type SourceCoverageCandidateRecord
} from "./sourceCoverageCandidateSchema";

export const DEFAULT_CANDIDATE_SEED_PATH =
  "data/seeds/source_coverage_candidates.990-2301.sample.json";

export interface ImportSourceCoverageCandidatesOptions {
  db?: LocalDatabase;
  seedPath?: string;
  aliasSeedPath?: string;
}

export interface ImportSourceCoverageCandidatesSummary {
  candidatesInserted: number;
  candidatesUpdated: number;
  skippedRecords: number;
  skipped: Array<{ reason: string }>;
  countBySource: Record<string, number>;
  countByVerificationStatus: Record<string, number>;
  propertyResolvedCount: number;
}

interface ExistingIdRow {
  id: string;
}

export function importSourceCoverageCandidates(
  options: ImportSourceCoverageCandidatesOptions = {}
): ImportSourceCoverageCandidatesSummary {
  const ownsDb = options.db === undefined;
  const db = options.db ?? openLocalDatabase();
  try {
    executeMigration(db);
    const seedPath =
      options.seedPath ??
      process.env.SOURCE_COVERAGE_CANDIDATES_FILE ??
      process.env.SOURCE_COVERAGE_CANDIDATES_SEED ??
      DEFAULT_CANDIDATE_SEED_PATH;
    const rawRecords = readRawCandidateSeed(seedPath);
    const aliases = readPropertyAliasSeed(options.aliasSeedPath);

    return runInTransaction(db, () => {
      const summary: ImportSourceCoverageCandidatesSummary = {
        candidatesInserted: 0,
        candidatesUpdated: 0,
        skippedRecords: 0,
        skipped: [],
        countBySource: {},
        countByVerificationStatus: {},
        propertyResolvedCount: 0
      };

      rawRecords.forEach((raw, index) => {
        const parsed = sourceCoverageCandidateRecordSchema.safeParse(raw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const reason =
            issue === undefined
              ? "invalid record"
              : `${issue.path.join(".") || "record"}: ${issue.message}`;
          summary.skippedRecords += 1;
          summary.skipped.push({ reason: `record[${index}] ${reason}` });
          return;
        }
        const seed: SourceCoverageCandidateRecord = parsed.data;

        // Best-effort property resolution. Candidates do NOT create new
        // property rows — that is reserved for confirmed coverage only.
        const resolution = resolveCanonicalPropertyNameDetailed(seed.property_name, aliases);
        const canonicalName =
          resolution.status === "ambiguous" ? seed.property_name : resolution.canonicalName;
        const existingProperty = findPropertyByName(db, canonicalName);
        const propertyId = existingProperty?.id ?? null;
        if (propertyId !== null) {
          summary.propertyResolvedCount += 1;
        }

        const outcome = upsertSourceCoverageCandidate(db, {
          propertyId,
          propertyName: seed.property_name,
          source: seed.source,
          candidatePropertyUrl: seed.candidate_property_url,
          candidateSourcePropertyId: seed.candidate_source_property_id,
          candidateLabel: seed.candidate_label,
          evidenceNote: seed.evidence_note,
          verificationStatus: seed.verification_status,
          reviewerNote: seed.reviewer_note
        });

        if (outcome.inserted) {
          summary.candidatesInserted += 1;
        } else {
          summary.candidatesUpdated += 1;
        }
        summary.countBySource[seed.source] = (summary.countBySource[seed.source] ?? 0) + 1;
        summary.countByVerificationStatus[seed.verification_status] =
          (summary.countByVerificationStatus[seed.verification_status] ?? 0) + 1;
      });

      return summary;
    });
  } finally {
    if (ownsDb) {
      closeDatabase(db);
    }
  }
}

export function readRawCandidateSeed(path: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid candidate seed file ${path}: ${error.message}`);
    }
    throw error;
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid candidate seed file ${path}: expected a JSON array`);
  }
  return parsed;
}

function findPropertyByName(db: LocalDatabase, propertyName: string): ExistingIdRow | undefined {
  return db
    .prepare("SELECT id FROM properties WHERE name = ? AND postal_code = '990-2301'")
    .get(propertyName) as ExistingIdRow | undefined;
}
