import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { getPropertySourceCoverage } from "../src/db/repositories/propertySourceCoverageRepository";
import { buildSourceFeasibilityResult } from "../src/services/sourceFeasibilityResult";
import { updateSourceCoverageFromFeasibility } from "../src/services/updateSourceCoverageFromFeasibility";

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

function feasibility(status: "needs_review" | "blocked", source = "rakuten") {
  return buildSourceFeasibilityResult({
    source,
    propertyName: "ル・ベール蔵王",
    sourcePropertyId: "29465",
    propertyUrl: "https://travel.rakuten.co.jp/HOTEL/29465/",
    classification: { status, accessStatus: "date_write_reflected", notes: "probe note" },
    checkedAtJst: "2026-05-29T12:00:00+09:00"
  });
}

describe("updateSourceCoverageFromFeasibility", () => {
  it("resolves an existing property by exact name and inserts a coverage row", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");

    const outcome = updateSourceCoverageFromFeasibility(db, feasibility("needs_review"));

    expect(outcome.propertyId).toBe("p_levert");
    expect(outcome.inserted).toBe(true);
    expect(outcome.coverageStatus).toBe("needs_review");
    expect(outcome.active).toBe(true);

    const row = getPropertySourceCoverage(db, "p_levert", "rakuten");
    expect(row?.coverageStatus).toBe("needs_review");
    expect(row?.accessStatus).toBe("date_write_reflected");
    expect(row?.lastVerifiedAt).toBe("2026-05-29T12:00:00+09:00");
    expect(row?.active).toBe(true);
    db.close();
  });

  it("is idempotent: a second probe updates the same row rather than duplicating", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");

    updateSourceCoverageFromFeasibility(db, feasibility("needs_review"));
    const second = updateSourceCoverageFromFeasibility(db, feasibility("blocked"));

    expect(second.inserted).toBe(false);
    expect(second.updated).toBe(true);
    expect(second.coverageStatus).toBe("blocked");
    expect(second.active).toBe(false);

    const count = (
      db.prepare("SELECT COUNT(*) AS count FROM property_source_coverage WHERE source = 'rakuten'").get() as {
        count: number;
      }
    ).count;
    expect(count).toBe(1);
    db.close();
  });

  it("inserts a minimal placeholder property when the name is unknown", () => {
    const db = openDb();

    const outcome = updateSourceCoverageFromFeasibility(db, feasibility("needs_review"));

    const property = db.prepare("SELECT name FROM properties WHERE id = ?").get(outcome.propertyId) as
      | { name: string }
      | undefined;
    expect(property?.name).toBe("ル・ベール蔵王");
    expect(getPropertySourceCoverage(db, outcome.propertyId, "rakuten")?.coverageStatus).toBe("needs_review");
    db.close();
  });

  it("never writes a price column (feasibility records access only)", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");

    updateSourceCoverageFromFeasibility(db, feasibility("needs_review"));

    expect((db.prepare("SELECT COUNT(*) AS count FROM rate_snapshots").get() as { count: number }).count).toBe(0);
    db.close();
  });
});
