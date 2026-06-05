import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeMigration, openLocalDatabase, type LocalDatabase } from "../src/db/client";
import { getPropertyListingSummary } from "../src/db/propertyListing";
import { importPropertySeeds } from "../src/seeds/importPropertySeeds";

let db: LocalDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("property seed import", () => {
  it("inserts properties and OTA links, then upserts without duplicates", () => {
    const paths = writeSeedFiles([
      {
        property_id: "property_test_seed",
        property_name: "テスト宿",
        postal_code: "990-2301",
        property_type: "ryokan",
        price_segment: "midscale",
        meal_style: "half_board",
        has_onsen: true,
        ski_access: "walkable",
        room_count_estimate: 10,
        max_capacity_estimate: 30,
        active: true,
        notes: "Manual verification required."
      }
    ]);
    db = openTestDatabase();

    const first = importPropertySeeds({ db, propertySeedPath: paths.propertySeedPath, otaLinkSeedPath: paths.otaLinkSeedPath });
    const second = importPropertySeeds({ db, propertySeedPath: paths.propertySeedPath, otaLinkSeedPath: paths.otaLinkSeedPath });

    expect(first.propertiesInserted).toBe(1);
    expect(first.otaLinksInserted).toBe(1);
    expect(second.propertiesUpdated).toBe(1);
    expect(second.otaLinksUpdated).toBe(1);
    expect(count("properties")).toBe(1);
    expect(count("property_ota_links")).toBe(1);
  });

  it("resolves OTA link property_name to property_id and stores null property_url", () => {
    const paths = writeSeedFiles([
      {
        property_id: "property_test_seed",
        property_name: "テスト宿",
        postal_code: "990-2301",
        property_type: "pension",
        price_segment: "unknown",
        meal_style: "unknown",
        has_onsen: null,
        ski_access: "unknown",
        active: true
      }
    ]);
    db = openTestDatabase();
    importPropertySeeds({ db, propertySeedPath: paths.propertySeedPath, otaLinkSeedPath: paths.otaLinkSeedPath });

    const row = db
      .prepare("SELECT property_id, property_url FROM property_ota_links WHERE ota = 'jalan'")
      .get() as { property_id: string; property_url: string | null };

    expect(row.property_id).toBe("property_test_seed");
    expect(row.property_url).toBeNull();
  });

  it("returns listing counts for imported properties", () => {
    const paths = writeSeedFiles([
      {
        property_id: "property_ryokan",
        property_name: "旅館テスト",
        postal_code: "990-2301",
        property_type: "ryokan",
        price_segment: "luxury",
        meal_style: "half_board",
        has_onsen: true,
        ski_access: "walkable",
        active: true
      },
      {
        property_id: "property_pension",
        property_name: "ペンションテスト",
        postal_code: "990-2301",
        property_type: "pension",
        price_segment: "economy",
        meal_style: "breakfast",
        has_onsen: false,
        ski_access: "car",
        active: false
      }
    ]);
    db = openTestDatabase();
    importPropertySeeds({ db, propertySeedPath: paths.propertySeedPath, otaLinkSeedPath: paths.otaLinkSeedPath });

    const summary = getPropertyListingSummary(db);

    expect(summary.totalProperties).toBe(2);
    expect(summary.activeProperties).toBe(1);
    expect(summary.countByPropertyType.ryokan).toBe(1);
    expect(summary.countByPropertyType.pension).toBe(1);
    expect(summary.countByPriceSegment.luxury).toBe(1);
    expect(summary.countByMealStyle.half_board).toBe(1);
    expect(summary.otaLinkCountByOta.jalan).toBe(1);
    expect(summary.propertiesMissingAllActiveOtaLinks).toEqual(["旅館テスト"]);
  });
});

function openTestDatabase(): LocalDatabase {
  const database = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "zao-seed-db-")), "test.sqlite"));
  executeMigration(database);
  return database;
}

function writeSeedFiles(properties: unknown[]): { propertySeedPath: string; otaLinkSeedPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "zao-seeds-"));
  const propertySeedPath = join(dir, "properties.json");
  const otaLinkSeedPath = join(dir, "ota-links.json");
  const linkPropertyName = propertyNameFrom(properties[0]);

  writeFileSync(propertySeedPath, JSON.stringify(properties), "utf8");
  writeFileSync(
    otaLinkSeedPath,
    JSON.stringify([
      {
        property_name: linkPropertyName,
        ota: "jalan",
        ota_property_id: null,
        property_url: null,
        active: false,
        last_verified_at: null,
        notes: "URL unknown"
      }
    ]),
    "utf8"
  );

  return { propertySeedPath, otaLinkSeedPath };
}

function propertyNameFrom(value: unknown): string {
  if (typeof value === "object" && value !== null && "property_name" in value && typeof value.property_name === "string") {
    return value.property_name;
  }

  return "テスト宿";
}

function count(table: string): number {
  return (db?.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
