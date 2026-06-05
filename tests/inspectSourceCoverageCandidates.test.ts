import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertSourceCoverageCandidate } from "../src/db/repositories/sourceCoverageCandidatesRepository";
import {
  buildSourceCoverageCandidatesInspection,
  formatSourceCoverageCandidatesInspection
} from "../src/scripts/inspectSourceCoverageCandidates";

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedCandidates(db: LocalDatabase): void {
  upsertSourceCoverageCandidate(db, {
    propertyName: "ホテル喜らく",
    source: "rakuten",
    evidenceNote: "jalan confirmed",
    verificationStatus: "candidate"
  });
  upsertSourceCoverageCandidate(db, {
    propertyName: "ホテル喜らく",
    source: "booking",
    evidenceNote: "jalan confirmed",
    verificationStatus: "candidate"
  });
  upsertSourceCoverageCandidate(db, {
    propertyName: "深山荘 高見屋",
    source: "rakuten",
    candidateSourcePropertyId: "12345",
    evidenceNote: "manually found candidate",
    verificationStatus: "needs_review"
  });
  upsertSourceCoverageCandidate(db, {
    propertyName: "ONSEN & STAY OAKHILL",
    source: "jalan",
    evidenceNote: "no coverage yet",
    verificationStatus: "candidate"
  });
}

describe("buildSourceCoverageCandidatesInspection", () => {
  it("counts total candidates and by-source/status breakdowns", () => {
    const db = openDb();
    seedCandidates(db);

    const inspection = buildSourceCoverageCandidatesInspection(db);

    expect(inspection.totalCandidates).toBe(4);
    expect(inspection.countBySource).toEqual({ booking: 1, jalan: 1, rakuten: 2 });
    expect(inspection.countByVerificationStatus).toEqual({ candidate: 3, needs_review: 1 });
    db.close();
  });

  it("splits candidate vs needs_review counts by source", () => {
    const db = openDb();
    seedCandidates(db);

    const inspection = buildSourceCoverageCandidatesInspection(db);

    expect(inspection.candidateCountBySource).toEqual({ booking: 1, jalan: 1, rakuten: 1 });
    expect(inspection.needsReviewCountBySource).toEqual({ rakuten: 1 });
    expect(inspection.confirmedCountBySource).toEqual({});
    db.close();
  });

  it("formats output with the expected header", () => {
    const db = openDb();
    seedCandidates(db);

    const output = formatSourceCoverageCandidatesInspection(buildSourceCoverageCandidatesInspection(db));

    expect(output).toContain("total_candidates=4");
    expect(output).toContain("count_by_source=");
    expect(output).toContain("candidate_count_by_source=");
    expect(output).toContain(
      "source | property_name | verification_status | candidate_source_property_id | evidence_note_excerpt | reviewer_note_excerpt"
    );
    expect(output).toContain("ホテル喜らく");
    db.close();
  });

  it("returns empty counts for an empty table", () => {
    const db = openDb();
    const inspection = buildSourceCoverageCandidatesInspection(db);
    expect(inspection.totalCandidates).toBe(0);
    expect(inspection.countBySource).toEqual({});
    db.close();
  });
});
