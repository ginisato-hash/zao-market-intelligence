import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { upsertPriceQualityFlag } from "../src/db/repositories/priceQualityRepository";
import { formatPriceQualityInspection, inspectPriceQualityFlags } from "../src/scripts/inspectPriceQualityFlags";

describe("inspectPriceQualityFlags", () => {
  it("prints quality flag counts and sample rows", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    db.prepare(
      `INSERT INTO properties (
         id, name, postal_code, area_name, property_type, price_segment, meal_style, ski_access, active, created_at, updated_at
       )
       VALUES ('p1', '吉田屋', '990-2301', 'Zao Onsen', 'ryokan', 'unknown', 'unknown', 'unknown', 1, '2026-05-29', '2026-05-29')`
    ).run();
    upsertPriceQualityFlag(db, {
      id: "pq1",
      rateSnapshotId: "rs1",
      source: "jalan",
      propertyId: "p1",
      stayDate: "2026-07-18",
      assessment: { priceJpy: 3000, flags: ["too_low_absolute"], severity: "medium", reason: "too_low_absolute" },
      createdAt: "2026-05-29"
    });

    const output = formatPriceQualityInspection(inspectPriceQualityFlags(db));

    expect(output).toContain("total_quality_rows=1");
    expect(output).toContain("flagged_count=1");
    expect(output).toContain("吉田屋 price=3000");
    db.close();
  });
});
