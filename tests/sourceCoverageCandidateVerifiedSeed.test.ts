import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { importSourceCoverageCandidates } from "../src/seeds/importSourceCoverageCandidates";
import { getPropertySourceCoverage } from "../src/db/repositories/propertySourceCoverageRepository";
import { promoteEligibleCandidates } from "../src/services/promoteSourceCoverageCandidates";
import { sourceCoverageCandidateRecordSchema } from "../src/seeds/sourceCoverageCandidateSchema";
import { readRawCandidateSeed } from "../src/seeds/importSourceCoverageCandidates";

const VERIFIED_SEED_PATH = "data/seeds/source_coverage_candidates.990-2301.verified.sample.json";

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

describe("verified candidate seed", () => {
  it("every row in the verified seed passes schema validation", () => {
    const rows = readRawCandidateSeed(VERIFIED_SEED_PATH);
    for (const row of rows) {
      const result = sourceCoverageCandidateRecordSchema.safeParse(row);
      expect(result.success, `row failed: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it("imports with zero skipped records", () => {
    const db = openDb();
    const summary = importSourceCoverageCandidates({ db, seedPath: VERIFIED_SEED_PATH });
    expect(summary.skippedRecords).toBe(0);
    expect(summary.candidatesInserted).toBe(3);
    db.close();
  });

  it("is idempotent: second import updates not inserts", () => {
    const db = openDb();
    importSourceCoverageCandidates({ db, seedPath: VERIFIED_SEED_PATH });
    const second = importSourceCoverageCandidates({ db, seedPath: VERIFIED_SEED_PATH });
    expect(second.candidatesInserted).toBe(0);
    expect(second.candidatesUpdated).toBe(3);
    db.close();
  });

  it("after import + promote: Rakuten row is confirmed, Booking is needs_review, Google is needs_review", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");

    importSourceCoverageCandidates({ db, seedPath: VERIFIED_SEED_PATH });
    const summary = promoteEligibleCandidates(db);

    expect(summary.promotedConfirmed).toBe(1); // rakuten
    expect(summary.promotedNeedsReview).toBe(2); // booking + google_hotels

    const rakuten = getPropertySourceCoverage(db, "p_levert", "rakuten");
    expect(rakuten?.coverageStatus).toBe("confirmed");
    expect(rakuten?.accessStatus).toBe("needs_feasibility_probe");

    const booking = getPropertySourceCoverage(db, "p_levert", "booking");
    expect(booking?.coverageStatus).toBe("needs_review");
    expect(booking?.accessStatus).toBe("content_visibility_unverified");

    const google = getPropertySourceCoverage(db, "p_levert", "google_hotels");
    expect(google?.coverageStatus).toBe("needs_review");
    expect(google?.accessStatus).toBe("free_direct_feasibility_unresolved");
    db.close();
  });

  it("promotion does not write any rate_snapshots", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    importSourceCoverageCandidates({ db, seedPath: VERIFIED_SEED_PATH });
    promoteEligibleCandidates(db);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM rate_snapshots").get() as { count: number }).count
    ).toBe(0);
    db.close();
  });
});
