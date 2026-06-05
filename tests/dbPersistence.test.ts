import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCollector } from "../src/collectors/mockCollector";
import { executeMigration, openLocalDatabase, type LocalDatabase } from "../src/db/client";
import { persistCollectorResult } from "../src/services/persistCollectorResult";

let db: LocalDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("local SQLite persistence", () => {
  it("runs the initial migration on a temp database", () => {
    db = openTestDatabase();
    executeMigration(db);

    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_snapshots'").get();
    expect(table).toBeTruthy();
  });

  it("persists mock collector price and non-price outcomes correctly", async () => {
    db = openTestDatabase();
    executeMigration(db);

    const results = await new MockCollector().collect({
      runId: "run_test_persistence",
      propertyId: "property_test",
      propertyName: "Test Property",
      ota: "mock",
      stayDate: "2026-02-01",
      guests: 2,
      nights: 1
    });

    for (const result of results) {
      persistCollectorResult(db, result);
    }

    expect(priceFor("available")).toBe(22000);
    expect(priceFor("sold_out")).toBeNull();
    expect(priceFor("not_listed")).toBeNull();

    const failed = db
      .prepare("SELECT price_total_tax_included, error_reason FROM rate_snapshots WHERE availability_status = 'failed'")
      .get() as { price_total_tax_included: number | null; error_reason: string | null };

    expect(failed.price_total_tax_included).toBeNull();
    expect(failed.error_reason).toContain("failed collection");
  });
});

function openTestDatabase(): LocalDatabase {
  return openLocalDatabase(join(mkdtempSync(join(tmpdir(), "zao-db-")), "test.sqlite"));
}

function priceFor(status: string): number | null {
  const row = db
    ?.prepare("SELECT price_total_tax_included FROM rate_snapshots WHERE availability_status = ?")
    .get(status) as { price_total_tax_included: number | null };

  return row.price_total_tax_included;
}
