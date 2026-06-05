import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  getPropertySourceCoverage,
  listPropertySourceCoverage,
  summarizePropertySourceCoverage,
  upsertPropertySourceCoverage
} from "../src/db/repositories/propertySourceCoverageRepository";

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedProperty(db: LocalDatabase, id: string, name: string): void {
  db.prepare("INSERT INTO properties (id, name, postal_code, area_name, active) VALUES (?, ?, '990-2301', 'Zao Onsen', 1)").run(
    id,
    name
  );
}

describe("propertySourceCoverageRepository", () => {
  it("inserts a new coverage row", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");

    const result = upsertPropertySourceCoverage(db, {
      propertyId: "p1",
      source: "jalan",
      sourcePropertyId: "yad1",
      propertyUrl: "https://www.jalan.net/yad1/",
      coverageStatus: "confirmed",
      accessStatus: "collector_working",
      active: true
    });

    expect(result).toEqual({ inserted: true, updated: false });
    const row = getPropertySourceCoverage(db, "p1", "jalan");
    expect(row?.coverageStatus).toBe("confirmed");
    expect(row?.active).toBe(true);
    db.close();
  });

  it("updates an existing coverage row and preserves created_at", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");

    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "rakuten", coverageStatus: "needs_review", active: true });
    const before = getPropertySourceCoverage(db, "p1", "rakuten");

    const result = upsertPropertySourceCoverage(db, {
      propertyId: "p1",
      source: "rakuten",
      coverageStatus: "blocked",
      active: false
    });

    expect(result).toEqual({ inserted: false, updated: true });
    const after = getPropertySourceCoverage(db, "p1", "rakuten");
    expect(after?.coverageStatus).toBe("blocked");
    expect(after?.active).toBe(false);
    expect(after?.id).toBe(before?.id);
    expect(after?.createdAt).toBe(before?.createdAt);
    db.close();
  });

  it("is idempotent on repeated identical upserts (one row per property+source)", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");

    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "jalan", coverageStatus: "confirmed" });
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "jalan", coverageStatus: "confirmed" });

    expect(listPropertySourceCoverage(db, { source: "jalan" })).toHaveLength(1);
    db.close();
  });

  it("filters by source", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "jalan", coverageStatus: "confirmed" });
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "booking", coverageStatus: "blocked" });

    const jalan = listPropertySourceCoverage(db, { source: "jalan" });
    expect(jalan).toHaveLength(1);
    expect(jalan[0]?.source).toBe("jalan");
    db.close();
  });

  it("filters by coverage_status", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");
    seedProperty(db, "p2", "Property B");
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "jalan", coverageStatus: "confirmed" });
    upsertPropertySourceCoverage(db, { propertyId: "p2", source: "jalan", coverageStatus: "needs_review" });

    const confirmed = listPropertySourceCoverage(db, { coverageStatus: "confirmed" });
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.propertyId).toBe("p1");
    db.close();
  });

  it("summarizes counts by source and coverage_status", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");
    seedProperty(db, "p2", "Property B");
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "jalan", coverageStatus: "confirmed" });
    upsertPropertySourceCoverage(db, { propertyId: "p2", source: "jalan", coverageStatus: "confirmed" });
    upsertPropertySourceCoverage(db, { propertyId: "p1", source: "booking", coverageStatus: "blocked" });

    const summary = summarizePropertySourceCoverage(db);
    expect(summary.totalCoverageRows).toBe(3);
    expect(summary.countBySource).toEqual({ booking: 1, jalan: 2 });
    expect(summary.countByCoverageStatus).toEqual({ blocked: 1, confirmed: 2 });
    db.close();
  });
});
