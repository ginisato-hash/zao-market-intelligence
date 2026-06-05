import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertSourceCoverageCandidate } from "../src/db/repositories/sourceCoverageCandidatesRepository";
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

describe("promoteEligibleCandidates summary output", () => {
  it("counts by source and decision", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");

    upsertSourceCoverageCandidate(db, {
      propertyName: "ル・ベール蔵王",
      source: "rakuten",
      candidateSourcePropertyId: "29465",
      candidatePropertyUrl: "https://travel.rakuten.co.jp/HOTEL/29465/",
      evidenceNote: "Hotel number verified from prior investigation.",
      verificationStatus: "confirmed"
    });
    upsertSourceCoverageCandidate(db, {
      propertyName: "ル・ベール蔵王",
      source: "booking",
      candidateSourcePropertyId: "le-vert-zao",
      candidatePropertyUrl: "https://www.booking.com/hotel/jp/le-vert-zao.ja.html",
      evidenceNote: "Booking slug verified but content feasibility not confirmed.",
      verificationStatus: "confirmed"
    });
    upsertSourceCoverageCandidate(db, {
      propertyName: "ル・ベール蔵王",
      source: "jalan",
      evidenceNote: "Jalan coverage unknown",
      verificationStatus: "candidate"
    });

    const summary = promoteEligibleCandidates(db);

    expect(summary.totalCandidates).toBe(3);
    expect(summary.promotedConfirmed).toBe(1); // only rakuten
    expect(summary.promotedNeedsReview).toBe(1); // booking downgraded
    expect(summary.skippedCandidate).toBe(1);
    expect(summary.skippedMissingUrlOrId).toBe(0);
    expect(summary.countBySource).toMatchObject({ rakuten: 1, booking: 1, jalan: 1 });
    db.close();
  });

  it("returns correct decision list in results", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    upsertSourceCoverageCandidate(db, {
      propertyName: "ル・ベール蔵王",
      source: "google_hotels",
      candidateSourcePropertyId: "CgoIn_eG0v78uPpiEAE",
      candidatePropertyUrl: "https://www.google.com/travel/hotels/entity/CgoIn_eG0v78uPpiEAE",
      evidenceNote: "Google Hotels entity token verified; free direct access gave consent/JS wall.",
      verificationStatus: "needs_review"
    });

    const summary = promoteEligibleCandidates(db);

    const r = summary.results[0];
    expect(r?.decision).toBe("promoted_needs_review");
    expect(r?.coverageStatus).toBe("needs_review");
    expect(r?.source).toBe("google_hotels");
    db.close();
  });

  it("mixed batch: skipped rows do not contaminate promoted counts", () => {
    const db = openDb();

    // Confirmed with ID — will promote
    upsertSourceCoverageCandidate(db, {
      propertyName: "ル・ベール蔵王",
      source: "rakuten",
      candidateSourcePropertyId: "29465",
      evidenceNote: "Verified hotel number.",
      verificationStatus: "confirmed"
    });
    // Candidate without ID — skipped_missing_url_or_id
    upsertSourceCoverageCandidate(db, {
      propertyName: "ホテル喜らく",
      source: "rakuten",
      evidenceNote: "Jalan confirmed; Rakuten unknown.",
      verificationStatus: "confirmed"
    });
    // Plain candidate — skipped_candidate
    upsertSourceCoverageCandidate(db, {
      propertyName: "深山荘 高見屋",
      source: "booking",
      evidenceNote: "Jalan confirmed; booking unknown.",
      verificationStatus: "candidate"
    });

    const summary = promoteEligibleCandidates(db);

    expect(summary.promotedConfirmed + summary.promotedNeedsReview).toBe(1);
    expect(summary.skippedMissingUrlOrId).toBe(1);
    expect(summary.skippedCandidate).toBe(1);
    db.close();
  });
});
