import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertSourceCoverageCandidate } from "../src/db/repositories/sourceCoverageCandidatesRepository";
import { getPropertySourceCoverage } from "../src/db/repositories/propertySourceCoverageRepository";
import { promoteEligibleCandidates } from "../src/services/promoteSourceCoverageCandidates";

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedProperty(db: LocalDatabase, id: string, name: string): void {
  db.prepare(
    "INSERT INTO properties (id, name, postal_code, area_name, active) VALUES (?, ?, '990-2301', 'Zao Onsen', 1)"
  ).run(id, name);
}

function seedCandidate(
  db: LocalDatabase,
  overrides: Partial<Parameters<typeof upsertSourceCoverageCandidate>[1]> = {}
): void {
  upsertSourceCoverageCandidate(db, {
    propertyName: "ル・ベール蔵王",
    source: "rakuten",
    candidatePropertyUrl: "https://travel.rakuten.co.jp/HOTEL/29465/",
    candidateSourcePropertyId: "29465",
    evidenceNote: "Rakuten Travel HOTEL/29465 URL verified from Phase 19/20/21 investigation.",
    verificationStatus: "confirmed",
    reviewerNote: "Verified",
    ...overrides
  });
}

describe("promoteEligibleCandidates: promotion decisions", () => {
  it("promotes a confirmed Rakuten candidate as coverage_status=confirmed, access_status=needs_feasibility_probe", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db);

    const summary = promoteEligibleCandidates(db);

    expect(summary.promotedConfirmed).toBe(1);
    expect(summary.promotedNeedsReview).toBe(0);
    const coverage = getPropertySourceCoverage(db, "p_levert", "rakuten");
    expect(coverage?.coverageStatus).toBe("confirmed");
    expect(coverage?.accessStatus).toBe("needs_feasibility_probe");
    expect(coverage?.active).toBe(true);
    expect(coverage?.sourcePropertyId).toBe("29465");
    db.close();
  });

  it("promotes a confirmed Jalan candidate as coverage_status=confirmed, access_status=collector_working", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db, {
      source: "jalan",
      candidateSourcePropertyId: "yad328232",
      candidatePropertyUrl: "https://www.jalan.net/yad328232/"
    });

    const summary = promoteEligibleCandidates(db);

    expect(summary.promotedConfirmed).toBe(1);
    const coverage = getPropertySourceCoverage(db, "p_levert", "jalan");
    expect(coverage?.coverageStatus).toBe("confirmed");
    expect(coverage?.accessStatus).toBe("collector_working");
    db.close();
  });

  it("promotes a Booking candidate as needs_review even when verification_status=confirmed", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db, {
      source: "booking",
      candidateSourcePropertyId: "le-vert-zao",
      candidatePropertyUrl: "https://www.booking.com/hotel/jp/le-vert-zao.ja.html"
    });

    const summary = promoteEligibleCandidates(db);

    expect(summary.promotedNeedsReview).toBe(1);
    expect(summary.promotedConfirmed).toBe(0);
    const coverage = getPropertySourceCoverage(db, "p_levert", "booking");
    expect(coverage?.coverageStatus).toBe("needs_review");
    expect(coverage?.accessStatus).toBe("content_visibility_unverified");
    db.close();
  });

  it("promotes a Google Hotels candidate as needs_review, not confirmed", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db, {
      source: "google_hotels",
      candidateSourcePropertyId: "CgoIn_eG0v78uPpiEAE",
      candidatePropertyUrl: "https://www.google.com/travel/hotels/entity/CgoIn_eG0v78uPpiEAE"
    });

    const summary = promoteEligibleCandidates(db);

    expect(summary.promotedNeedsReview).toBe(1);
    const coverage = getPropertySourceCoverage(db, "p_levert", "google_hotels");
    expect(coverage?.coverageStatus).toBe("needs_review");
    expect(coverage?.accessStatus).toBe("free_direct_feasibility_unresolved");
    db.close();
  });

  it("promotes a needs_review Rakuten candidate as needs_review", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db, { verificationStatus: "needs_review" });

    const summary = promoteEligibleCandidates(db);

    expect(summary.promotedNeedsReview).toBe(1);
    const coverage = getPropertySourceCoverage(db, "p_levert", "rakuten");
    expect(coverage?.coverageStatus).toBe("needs_review");
    db.close();
  });

  it("skips plain candidate rows", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db, { verificationStatus: "candidate" });

    const summary = promoteEligibleCandidates(db);

    expect(summary.skippedCandidate).toBe(1);
    expect(summary.promotedConfirmed).toBe(0);
    expect(summary.promotedNeedsReview).toBe(0);
    expect(getPropertySourceCoverage(db, "p_levert", "rakuten")).toBeNull();
    db.close();
  });

  it("skips rejected rows", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db, { verificationStatus: "rejected" });

    const summary = promoteEligibleCandidates(db);

    expect(summary.skippedRejected).toBe(1);
    expect(getPropertySourceCoverage(db, "p_levert", "rakuten")).toBeNull();
    db.close();
  });

  it("skips rows with both URL and source_property_id null", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db, {
      candidatePropertyUrl: null,
      candidateSourcePropertyId: null
    });

    const summary = promoteEligibleCandidates(db);

    expect(summary.skippedMissingUrlOrId).toBe(1);
    db.close();
  });

  it("skips rows with a non-canonical source", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    // Insert directly to bypass schema validation
    db.prepare(
      `INSERT INTO source_coverage_candidates
         (id, property_name, source, candidate_source_property_id, evidence_note, verification_status)
       VALUES ('test_id', 'ル・ベール蔵王', 'rakuten_travel', '99', 'test evidence', 'confirmed')`
    ).run();

    const summary = promoteEligibleCandidates(db);

    expect(summary.skippedInvalidSource).toBe(1);
    db.close();
  });

  it("creates a minimal placeholder property when the property is not in the DB yet", () => {
    const db = openDb();
    seedCandidate(db);

    const summary = promoteEligibleCandidates(db);

    expect(summary.promotedConfirmed).toBe(1);
    const propCount = (
      db.prepare("SELECT COUNT(*) AS count FROM properties WHERE name = 'ル・ベール蔵王'").get() as {
        count: number;
      }
    ).count;
    expect(propCount).toBe(1);
    db.close();
  });

  it("is idempotent: promoting twice updates the coverage row rather than duplicating", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db);

    promoteEligibleCandidates(db);
    promoteEligibleCandidates(db);

    const count = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM property_source_coverage WHERE property_id='p_levert' AND source='rakuten'"
        )
        .get() as { count: number }
    ).count;
    expect(count).toBe(1);
    db.close();
  });

  it("does not write any rate_snapshots", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db);
    promoteEligibleCandidates(db);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM rate_snapshots").get() as { count: number }).count
    ).toBe(0);
    db.close();
  });

  it("builds property URL from source+id when candidate_property_url is null", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    seedCandidate(db, { candidatePropertyUrl: null, candidateSourcePropertyId: "29465" });

    promoteEligibleCandidates(db);

    const coverage = getPropertySourceCoverage(db, "p_levert", "rakuten");
    expect(coverage?.propertyUrl).toBe("https://travel.rakuten.co.jp/HOTEL/29465/");
    db.close();
  });
});
