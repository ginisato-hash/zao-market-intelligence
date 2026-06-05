import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertPropertySourceCoverage } from "../src/db/repositories/propertySourceCoverageRepository";
import { upsertSourceCoverageCandidate } from "../src/db/repositories/sourceCoverageCandidatesRepository";
import {
  buildSourceCoverageInspection,
  formatSourceCoverageInspection
} from "../src/scripts/inspectSourceCoverage";

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

describe("inspectSourceCoverage with candidates (Phase 42X extension)", () => {
  it("reports active_properties_count", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");
    seedProperty(db, "p2", "Property B");
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "jalan", coverageStatus: "confirmed" });

    const inspection = buildSourceCoverageInspection(db);

    expect(inspection.activePropertiesCount).toBe(2);
    db.close();
  });

  it("reports candidate_count_by_source when candidates table is present", () => {
    const db = openDb();
    seedProperty(db, "p1", "ホテル喜らく");
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "jalan", coverageStatus: "confirmed" });
    upsertSourceCoverageCandidate(db, {
      propertyName: "ホテル喜らく",
      source: "rakuten",
      evidenceNote: "needs verification",
      verificationStatus: "candidate"
    });
    upsertSourceCoverageCandidate(db, {
      propertyName: "ホテル喜らく",
      source: "booking",
      evidenceNote: "needs verification",
      verificationStatus: "candidate"
    });

    const inspection = buildSourceCoverageInspection(db);

    expect(inspection.candidateCountBySource).toEqual({ booking: 1, rakuten: 1 });
    db.close();
  });

  it("reports needs_review, blocked, and unsupported counts by source", () => {
    const db = openDb();
    seedProperty(db, "p1", "A");
    seedProperty(db, "p2", "B");
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "rakuten", coverageStatus: "needs_review" });
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "booking", coverageStatus: "blocked" });
    upsertPropertySourceCoverage(db, { propertyId: "p2", source: "google_hotels", coverageStatus: "unsupported" });

    const inspection = buildSourceCoverageInspection(db);

    expect(inspection.needsReviewCountBySource).toEqual({ rakuten: 1 });
    expect(inspection.blockedCountBySource).toEqual({ booking: 1 });
    expect(inspection.unsupportedCountBySource).toEqual({ google_hotels: 1 });
    db.close();
  });

  it("formats all new Phase 42X fields in output without breaking Phase 40X fields", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "jalan", coverageStatus: "confirmed" });

    const output = formatSourceCoverageInspection(buildSourceCoverageInspection(db));

    // Phase 40X fields must still be present
    expect(output).toContain("total_coverage_rows=");
    expect(output).toContain("count_by_source=");
    expect(output).toContain("confirmed_jalan_count=");
    expect(output).toContain("source | property_name | coverage_status | active | source_property_id | property_url");
    // Phase 42X new fields
    expect(output).toContain("active_properties_count=");
    expect(output).toContain("needs_review_count_by_source=");
    expect(output).toContain("blocked_count_by_source=");
    expect(output).toContain("unsupported_count_by_source=");
    expect(output).toContain("candidate_count_by_source=");
    db.close();
  });
});
