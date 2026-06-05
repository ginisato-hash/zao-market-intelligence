import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  getPropertySourceCoverage,
  listPropertySourceCoverage
} from "../src/db/repositories/propertySourceCoverageRepository";
import { importPropertySourceCoverage } from "../src/seeds/importPropertySourceCoverage";

let workDir: string;
let seedPath: string;
let aliasPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "source-coverage-import-"));
  seedPath = join(workDir, "seed.json");
  aliasPath = join(workDir, "aliases.json");
  writeFileSync(aliasPath, JSON.stringify([]));
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
  db.prepare("INSERT INTO properties (id, name, postal_code, area_name, active) VALUES (?, ?, '990-2301', 'Zao Onsen', 1)").run(
    id,
    name
  );
}

function writeSeed(records: unknown[]): void {
  writeFileSync(seedPath, JSON.stringify(records));
}

const validRows = [
  {
    property_name: "ル・ベール蔵王",
    source: "jalan",
    source_property_id: "yad328232",
    property_url: "https://www.jalan.net/yad328232/",
    coverage_status: "confirmed",
    access_status: "collector_working",
    active: true
  },
  {
    property_name: "ル・ベール蔵王",
    source: "booking",
    source_property_id: "le-vert-zao",
    property_url: "https://www.booking.com/hotel/jp/le-vert-zao.ja.html",
    coverage_status: "blocked",
    notes: "empty body / upstream bot detection",
    active: false
  },
  {
    property_name: "ル・ベール蔵王",
    source: "rakuten",
    source_property_id: "29465",
    property_url: "https://travel.rakuten.co.jp/HOTEL/29465/",
    coverage_status: "needs_review",
    active: true
  }
];

describe("importPropertySourceCoverage", () => {
  it("imports seed rows and preserves confirmed/blocked/needs_review statuses", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    writeSeed(validRows);

    const summary = importPropertySourceCoverage({ db, seedPath, aliasSeedPath: aliasPath });

    expect(summary.coverageInserted).toBe(3);
    expect(summary.coverageUpdated).toBe(0);
    expect(summary.skippedRecords).toBe(0);
    expect(summary.countBySource).toEqual({ booking: 1, jalan: 1, rakuten: 1 });
    expect(summary.countByCoverageStatus).toEqual({ blocked: 1, confirmed: 1, needs_review: 1 });

    expect(getPropertySourceCoverage(db, "p_levert", "jalan")?.coverageStatus).toBe("confirmed");
    expect(getPropertySourceCoverage(db, "p_levert", "booking")?.coverageStatus).toBe("blocked");
    expect(getPropertySourceCoverage(db, "p_levert", "rakuten")?.coverageStatus).toBe("needs_review");
    db.close();
  });

  it("is idempotent on a second run (updates, no duplicates)", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    writeSeed(validRows);

    importPropertySourceCoverage({ db, seedPath, aliasSeedPath: aliasPath });
    const second = importPropertySourceCoverage({ db, seedPath, aliasSeedPath: aliasPath });

    expect(second.coverageInserted).toBe(0);
    expect(second.coverageUpdated).toBe(3);
    expect(listPropertySourceCoverage(db)).toHaveLength(3);
    db.close();
  });

  it("resolves aliases without creating duplicate physical properties", () => {
    const db = openDb();
    seedProperty(db, "p_lucent", "名湯リゾート ルーセント");
    writeFileSync(
      aliasPath,
      JSON.stringify([
        {
          canonical_property_name: "名湯リゾート ルーセント",
          aliases: ["蔵王温泉 名湯リゾート ルーセントタカミヤ"],
          status: "confirmed"
        }
      ])
    );
    writeSeed([
      {
        property_name: "蔵王温泉 名湯リゾート ルーセントタカミヤ",
        source: "jalan",
        source_property_id: "yad331969",
        property_url: "https://www.jalan.net/yad331969/",
        coverage_status: "confirmed",
        active: true
      }
    ]);

    const summary = importPropertySourceCoverage({ db, seedPath, aliasSeedPath: aliasPath });

    expect(summary.aliasResolvedCount).toBe(1);
    expect(summary.propertiesInserted).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM properties").get() as { count: number }).count).toBe(1);
    expect(getPropertySourceCoverage(db, "p_lucent", "jalan")?.coverageStatus).toBe("confirmed");
    db.close();
  });

  it("reports skipped invalid records (forbidden paid source) and still imports valid ones", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    writeSeed([
      validRows[0],
      {
        property_name: "ル・ベール蔵王",
        source: "serpapi",
        coverage_status: "confirmed",
        property_url: "https://serpapi.com/x"
      }
    ]);

    const summary = importPropertySourceCoverage({ db, seedPath, aliasSeedPath: aliasPath });

    expect(summary.coverageInserted).toBe(1);
    expect(summary.skippedRecords).toBe(1);
    expect(summary.skipped[0]?.reason).toContain("forbidden paid source");
    db.close();
  });

  it("does not run any collection (no collector_runs / rate_snapshots written)", () => {
    const db = openDb();
    seedProperty(db, "p_levert", "ル・ベール蔵王");
    writeSeed(validRows);

    importPropertySourceCoverage({ db, seedPath, aliasSeedPath: aliasPath });

    expect((db.prepare("SELECT COUNT(*) AS count FROM collector_runs").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM rate_snapshots").get() as { count: number }).count).toBe(0);
    db.close();
  });
});
