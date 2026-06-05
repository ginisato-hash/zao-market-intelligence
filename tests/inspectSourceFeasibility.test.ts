import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { buildSourceFeasibilityResult } from "../src/services/sourceFeasibilityResult";
import { updateSourceCoverageFromFeasibility } from "../src/services/updateSourceCoverageFromFeasibility";
import {
  buildSourceFeasibilityInspection,
  formatSourceFeasibilityInspection
} from "../src/scripts/inspectSourceFeasibility";

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

function seedScenario(db: LocalDatabase): void {
  seedProperty(db, "p_levert", "ル・ベール蔵王");
  updateSourceCoverageFromFeasibility(
    db,
    buildSourceFeasibilityResult({
      source: "rakuten",
      propertyName: "ル・ベール蔵王",
      sourcePropertyId: "29465",
      propertyUrl: "https://travel.rakuten.co.jp/HOTEL/29465/",
      classification: { status: "needs_review", accessStatus: "date_write_reflected", notes: "ok" },
      checkedAtJst: "2026-05-29T12:00:00+09:00"
    })
  );
  updateSourceCoverageFromFeasibility(
    db,
    buildSourceFeasibilityResult({
      source: "booking",
      propertyName: "ル・ベール蔵王",
      sourcePropertyId: "le-vert-zao",
      propertyUrl: "https://www.booking.com/hotel/jp/le-vert-zao.ja.html",
      classification: { status: "blocked", accessStatus: "empty_or_near_empty_body", notes: "blocked" },
      checkedAtJst: "2026-05-29T12:05:00+09:00"
    })
  );
}

describe("buildSourceFeasibilityInspection", () => {
  it("counts coverage by source and status and active/inactive split", () => {
    const db = openDb();
    seedScenario(db);

    const inspection = buildSourceFeasibilityInspection(db);

    expect(inspection.totalCoverageRows).toBe(2);
    expect(inspection.countBySource).toEqual({ booking: 1, rakuten: 1 });
    expect(inspection.countByCoverageStatus).toEqual({ blocked: 1, needs_review: 1 });
    expect(inspection.activeCount).toBe(1);
    expect(inspection.inactiveCount).toBe(1);
    db.close();
  });

  it("formats access_status and last_verified_at in the row view", () => {
    const db = openDb();
    seedScenario(db);

    const output = formatSourceFeasibilityInspection(buildSourceFeasibilityInspection(db));

    expect(output).toContain("source | property_name | coverage_status | access_status | last_verified_at | active | notes");
    expect(output).toContain("date_write_reflected");
    expect(output).toContain("empty_or_near_empty_body");
    expect(output).toContain("2026-05-29T12:00:00+09:00");
    db.close();
  });
});
