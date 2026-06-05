import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertPropertySourceCoverage } from "../src/db/repositories/propertySourceCoverageRepository";
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
  db.prepare("INSERT INTO properties (id, name, postal_code, area_name, active) VALUES (?, ?, '990-2301', 'Zao Onsen', 1)").run(
    id,
    name
  );
}

function seedCoverageScenario(db: LocalDatabase): void {
  seedProperty(db, "p_levert", "ル・ベール蔵王");
  seedProperty(db, "p_lucent", "名湯リゾート ルーセント");
  upsertPropertySourceCoverage(db, { propertyId: "p_levert", source: "jalan", coverageStatus: "confirmed", active: true });
  upsertPropertySourceCoverage(db, { propertyId: "p_levert", source: "booking", coverageStatus: "blocked", active: false });
  upsertPropertySourceCoverage(db, { propertyId: "p_levert", source: "rakuten", coverageStatus: "needs_review", active: true });
  upsertPropertySourceCoverage(db, {
    propertyId: "p_levert",
    source: "google_hotels",
    coverageStatus: "needs_review",
    active: true
  });
  upsertPropertySourceCoverage(db, { propertyId: "p_lucent", source: "jalan", coverageStatus: "confirmed", active: true });
}

describe("buildSourceCoverageInspection", () => {
  it("computes per-source and per-status counts", () => {
    const db = openDb();
    seedCoverageScenario(db);

    const inspection = buildSourceCoverageInspection(db);

    expect(inspection.totalCoverageRows).toBe(5);
    expect(inspection.countBySource).toEqual({ booking: 1, google_hotels: 1, jalan: 2, rakuten: 1 });
    expect(inspection.countByCoverageStatus).toEqual({ blocked: 1, confirmed: 2, needs_review: 2 });
    db.close();
  });

  it("computes confirmed Jalan and per-source review/blocked counts", () => {
    const db = openDb();
    seedCoverageScenario(db);

    const inspection = buildSourceCoverageInspection(db);

    expect(inspection.confirmedJalanCount).toBe(2);
    expect(inspection.rakutenNeedsReviewCount).toBe(1);
    expect(inspection.bookingBlockedOrReviewCount).toBe(1);
    expect(inspection.googleHotelsReviewOrUnsupportedCount).toBe(1);
    db.close();
  });

  it("makes missing coverage visible per source", () => {
    const db = openDb();
    seedCoverageScenario(db);

    const inspection = buildSourceCoverageInspection(db);

    expect(inspection.propertiesMissingJalanCoverage).toBe(0);
    expect(inspection.propertiesMissingRakutenCoverage).toBe(1);
    expect(inspection.propertiesMissingBookingCoverage).toBe(1);
    expect(inspection.propertiesMissingGoogleHotelsCoverage).toBe(1);
    db.close();
  });

  it("formats the inspection output with the expected keys and sample header", () => {
    const db = openDb();
    seedCoverageScenario(db);

    const output = formatSourceCoverageInspection(buildSourceCoverageInspection(db));

    expect(output).toContain("count_by_source=");
    expect(output).toContain("count_by_coverage_status=");
    expect(output).toContain("confirmed_jalan_count=2");
    expect(output).toContain("rakuten_needs_review_count=1");
    expect(output).toContain("booking_blocked_or_review_count=1");
    expect(output).toContain("google_hotels_review_or_unsupported_count=1");
    expect(output).toContain("properties_missing_rakuten_coverage=1");
    expect(output).toContain("source | property_name | coverage_status | active | source_property_id | property_url");
    db.close();
  });
});
