import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertSourceCoverageCandidate } from "../src/db/repositories/sourceCoverageCandidatesRepository";
import {
  buildSourceCoverageCandidatesInspection,
  formatSourceCoverageCandidatesInspection
} from "../src/scripts/inspectSourceCoverageCandidates";
import { sourceCoverageCandidateRecordSchema } from "../src/seeds/sourceCoverageCandidateSchema";

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

describe("source=other schema guard (Codex suggestion)", () => {
  const baseOther = {
    property_name: "テスト宿",
    source: "other",
    candidate_property_url: null,
    candidate_source_property_id: null,
    evidence_note: "This evidence note is long enough to pass the 30-char requirement.",
    candidate_label: "Alternative booking platform not in canonical list",
    verification_status: "candidate" as const
  };

  it("accepts source=other with long evidence_note and non-blank label", () => {
    expect(sourceCoverageCandidateRecordSchema.safeParse(baseOther).success).toBe(true);
  });

  it("rejects source=other when evidence_note is under 30 characters", () => {
    const result = sourceCoverageCandidateRecordSchema.safeParse({
      ...baseOther,
      evidence_note: "Too short"
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("at least 30 characters");
  });

  it("rejects source=other when candidate_label is blank", () => {
    const result = sourceCoverageCandidateRecordSchema.safeParse({
      ...baseOther,
      candidate_label: "  "
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("candidate_label must not be blank");
  });

  it("rejects source=other confirmed without reviewer_note", () => {
    const result = sourceCoverageCandidateRecordSchema.safeParse({
      ...baseOther,
      verification_status: "confirmed",
      reviewer_note: null
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("reviewer_note must not be blank");
  });

  it("accepts source=other confirmed with reviewer_note", () => {
    expect(
      sourceCoverageCandidateRecordSchema.safeParse({
        ...baseOther,
        verification_status: "confirmed",
        reviewer_note: "Manually confirmed this platform is relevant."
      }).success
    ).toBe(true);
  });
});

describe("inspection evidence/reviewer excerpts (Codex suggestion)", () => {
  it("truncates long evidence_note to 60 chars with ellipsis", () => {
    const db = openDb();
    const longNote = "A".repeat(80);
    upsertSourceCoverageCandidate(db, {
      propertyName: "テスト宿",
      source: "jalan",
      evidenceNote: longNote,
      verificationStatus: "candidate"
    });

    const inspection = buildSourceCoverageCandidatesInspection(db);
    const row = inspection.sampleRows[0];

    expect(row?.evidenceNoteExcerpt).toHaveLength(61); // 60 chars + "…"
    expect(row?.evidenceNoteExcerpt?.endsWith("…")).toBe(true);
    db.close();
  });

  it("keeps short evidence_note as-is", () => {
    const db = openDb();
    upsertSourceCoverageCandidate(db, {
      propertyName: "テスト宿",
      source: "jalan",
      evidenceNote: "Short note",
      verificationStatus: "candidate"
    });

    const inspection = buildSourceCoverageCandidatesInspection(db);
    expect(inspection.sampleRows[0]?.evidenceNoteExcerpt).toBe("Short note");
    db.close();
  });

  it("sets reviewerNoteExcerpt to null when reviewer_note is absent", () => {
    const db = openDb();
    upsertSourceCoverageCandidate(db, {
      propertyName: "テスト宿",
      source: "jalan",
      evidenceNote: "Evidence note here",
      verificationStatus: "candidate",
      reviewerNote: null
    });

    const inspection = buildSourceCoverageCandidatesInspection(db);
    expect(inspection.sampleRows[0]?.reviewerNoteExcerpt).toBeNull();
    db.close();
  });

  it("includes evidence_note_excerpt and reviewer_note_excerpt in formatted output", () => {
    const db = openDb();
    upsertSourceCoverageCandidate(db, {
      propertyName: "ル・ベール蔵王",
      source: "rakuten",
      candidateSourcePropertyId: "29465",
      evidenceNote: "Hotel number 29465 verified from prior investigation.",
      verificationStatus: "confirmed",
      reviewerNote: "Phase 19/20/21 confirmed."
    });

    const output = formatSourceCoverageCandidatesInspection(buildSourceCoverageCandidatesInspection(db));

    expect(output).toContain("evidence_note_excerpt");
    expect(output).toContain("reviewer_note_excerpt");
    expect(output).toContain("Hotel number 29465");
    expect(output).toContain("Phase 19/20/21");
    db.close();
  });

  it("shows rejected_count_by_source in output", () => {
    const db = openDb();
    upsertSourceCoverageCandidate(db, {
      propertyName: "テスト宿",
      source: "booking",
      evidenceNote: "Rejected — slug does not resolve to this property.",
      verificationStatus: "rejected"
    });

    const inspection = buildSourceCoverageCandidatesInspection(db);
    const output = formatSourceCoverageCandidatesInspection(inspection);

    expect(inspection.rejectedCountBySource).toEqual({ booking: 1 });
    expect(output).toContain("rejected_count_by_source=");
    db.close();
  });
});
