import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeMigration, openLocalDatabase, type LocalDatabase } from "../src/db/client";
import { importTargetDateSeeds } from "../src/seeds/importTargetDateSeeds";

let db: LocalDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("target date seed import", () => {
  it("is idempotent", () => {
    const seedPath = writeTargetDateSeed([
      {
        stay_date: "2026-10-10",
        priority: "S",
        reason: "Autumn sample",
        active: true
      }
    ]);
    db = openTestDatabase();

    const first = importTargetDateSeeds({ db, targetDateSeedPath: seedPath });
    const second = importTargetDateSeeds({ db, targetDateSeedPath: seedPath });

    expect(first.targetDatesInserted).toBe(1);
    expect(first.targetDatesUpdated).toBe(0);
    expect(second.targetDatesInserted).toBe(0);
    expect(second.targetDatesUpdated).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM target_dates").get() as { count: number }).count).toBe(1);
  });
});

function openTestDatabase(): LocalDatabase {
  const database = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "zao-target-db-")), "test.sqlite"));
  executeMigration(database);
  return database;
}

function writeTargetDateSeed(records: unknown[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "zao-target-seeds-")), "target-dates.json");
  writeFileSync(path, JSON.stringify(records), "utf8");
  return path;
}
