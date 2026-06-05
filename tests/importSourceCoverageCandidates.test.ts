import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { listSourceCoverageCandidates } from "../src/db/repositories/sourceCoverageCandidatesRepository";
import { importSourceCoverageCandidates } from "../src/seeds/importSourceCoverageCandidates";

let workDir: string;
let seedPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "candidate-import-"));
  seedPath = join(workDir, "candidates.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

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

const validCandidate = {
  property_name: "ホテル喜らく",
  source: "rakuten",
  candidate_property_url: null,
  candidate_source_property_id: null,
  candidate_label: "Rakuten Travel hotel page to be manually verified",
  evidence_note: "Jalan coverage confirmed (yad325153); Rakuten hotel number not yet verified.",
  verification_status: "candidate"
};

describe("importSourceCoverageCandidates", () => {
  it("imports candidate rows and returns a correct summary", () => {
    const db = openDb();
    writeFileSync(seedPath, JSON.stringify([validCandidate]));

    const summary = importSourceCoverageCandidates({ db, seedPath });

    expect(summary.candidatesInserted).toBe(1);
    expect(summary.candidatesUpdated).toBe(0);
    expect(summary.skippedRecords).toBe(0);
    expect(summary.countBySource).toEqual({ rakuten: 1 });
    expect(summary.countByVerificationStatus).toEqual({ candidate: 1 });
    db.close();
  });

  it("is idempotent: a second import updates rather than duplicates", () => {
    const db = openDb();
    writeFileSync(seedPath, JSON.stringify([validCandidate]));

    importSourceCoverageCandidates({ db, seedPath });
    const second = importSourceCoverageCandidates({ db, seedPath });

    expect(second.candidatesInserted).toBe(0);
    expect(second.candidatesUpdated).toBe(1);
    expect(listSourceCoverageCandidates(db)).toHaveLength(1);
    db.close();
  });

  it("resolves property_id when the property is already in the DB", () => {
    const db = openDb();
    seedProperty(db, "p_kiraku", "ホテル喜らく");
    writeFileSync(seedPath, JSON.stringify([validCandidate]));

    const summary = importSourceCoverageCandidates({ db, seedPath });

    expect(summary.propertyResolvedCount).toBe(1);
    const rows = listSourceCoverageCandidates(db);
    expect(rows[0]?.propertyId).toBe("p_kiraku");
    db.close();
  });

  it("does NOT create a new property row for unknown names", () => {
    const db = openDb();
    writeFileSync(seedPath, JSON.stringify([validCandidate]));

    importSourceCoverageCandidates({ db, seedPath });

    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM properties").get() as { count: number }).count
    ).toBe(0);
    db.close();
  });

  it("skips records with forbidden paid sources", () => {
    const db = openDb();
    writeFileSync(
      seedPath,
      JSON.stringify([validCandidate, { ...validCandidate, source: "serpapi" }])
    );

    const summary = importSourceCoverageCandidates({ db, seedPath });

    expect(summary.candidatesInserted).toBe(1);
    expect(summary.skippedRecords).toBe(1);
    expect(summary.skipped[0]?.reason).toContain("forbidden paid source");
    db.close();
  });

  it("skips records with blank evidence_note", () => {
    const db = openDb();
    writeFileSync(seedPath, JSON.stringify([{ ...validCandidate, evidence_note: "  " }]));

    const summary = importSourceCoverageCandidates({ db, seedPath });

    expect(summary.candidatesInserted).toBe(0);
    expect(summary.skippedRecords).toBe(1);
    db.close();
  });

  it("does not modify property_source_coverage", () => {
    const db = openDb();
    writeFileSync(seedPath, JSON.stringify([validCandidate]));

    importSourceCoverageCandidates({ db, seedPath });

    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM property_source_coverage").get() as { count: number }).count
    ).toBe(0);
    db.close();
  });

  it("does not write any rate_snapshots", () => {
    const db = openDb();
    writeFileSync(seedPath, JSON.stringify([validCandidate]));

    importSourceCoverageCandidates({ db, seedPath });

    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM rate_snapshots").get() as { count: number }).count
    ).toBe(0);
    db.close();
  });
});
