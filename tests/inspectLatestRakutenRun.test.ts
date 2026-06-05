import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { insertCollectionJobAttempt } from "../src/db/repositories/collectionJobAttemptsRepository";
import type { CollectionJobAttempt } from "../src/domain/types";
import {
  buildRakutenInspectOutput,
  inspectLatestRakutenRun
} from "../src/scripts/inspectLatestRakutenRun";

function openTestDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  db.prepare(
    "INSERT OR IGNORE INTO properties (id, name, postal_code, area_name) VALUES ('prop_rakuten_test', '蔵王温泉 ル・ベール蔵王', '990-2301', 'Zao Onsen')"
  ).run();
  return db;
}

function seedRakutenRun(
  db: LocalDatabase,
  runId: string,
  stayDate: string,
  available: boolean
): void {
  const status = available ? "available" : "failed";
  const price = available ? 18000 : null;
  const checkedAt = "2026-05-28T10:00:00+09:00";

  db.prepare(
    `INSERT OR IGNORE INTO collector_runs (id, ota, started_at_jst, finished_at_jst, status, created_at)
     VALUES (?, 'rakuten', ?, ?, 'completed', ?)`
  ).run(runId, checkedAt, checkedAt, checkedAt);

  const errorReason = available ? null : "rakuten_price_or_status_unclear";
  db.prepare(
    `INSERT OR IGNORE INTO rate_snapshots
     (id, run_id, property_id, ota, stay_date, guests, nights, price_jpy, price_total_tax_included,
      availability_status, confidence, checked_at_jst, error_reason, created_at)
     VALUES (?, ?, 'prop_rakuten_test', 'rakuten', ?, 2, 1, ?, ?, ?, 'B', ?, ?, ?)`
  ).run(
    `rate_${runId}_${stayDate}`,
    runId,
    stayDate,
    price,
    price,
    status,
    checkedAt,
    errorReason,
    checkedAt
  );

  db.prepare(
    `INSERT OR IGNORE INTO inventory_snapshots
     (id, run_id, property_id, ota, stay_date, availability_status, confidence, checked_at_jst, created_at)
     VALUES (?, ?, 'prop_rakuten_test', 'rakuten', ?, ?, 'B', ?, ?)`
  ).run(
    `inv_${runId}_${stayDate}`,
    runId,
    stayDate,
    status,
    checkedAt,
    checkedAt
  );

  const attempt: CollectionJobAttempt = {
    id: `attempt_${runId}_${stayDate}`,
    jobId: `rakuten_prototype_${stayDate}`,
    runId,
    propertyId: "prop_rakuten_test",
    ota: "rakuten",
    stayDate,
    guests: 2,
    nights: 1,
    attemptedAtJst: checkedAt,
    outcome: available ? "success" : "failed",
    availabilityStatus: status,
    priceTotalTaxIncluded: price,
    errorReason: available ? null : "rakuten_price_or_status_unclear",
    screenshotPath: available ? `.data/screenshots/${runId}.png` : null,
    debugJsonPath: `.data/debug/rakuten/${runId}/${stayDate}.json`,
    retryCount: 0
  };
  insertCollectionJobAttempt(db, attempt);
}

describe("inspectLatestRakutenRun", () => {
  it("returns no_rakuten_runs_found when DB is empty", () => {
    const db = openTestDb();
    expect(inspectLatestRakutenRun(db)).toBe("no_rakuten_runs_found");
    db.close();
  });

  it("returns output for an available run", () => {
    const db = openTestDb();
    seedRakutenRun(db, "run_rakuten_001", "2026-08-08", true);

    const output = inspectLatestRakutenRun(db);
    expect(output).toContain("collector_run_id=run_rakuten_001");
    expect(output).toContain("availability_status=available");
    expect(output).toContain("persisted_price=18000");
    expect(output).toContain("attempt_outcome=success");
    expect(output).toContain("stay_date=2026-08-08");
    db.close();
  });

  it("returns output for a failed run with error_reason", () => {
    const db = openTestDb();
    seedRakutenRun(db, "run_rakuten_002", "2026-08-08", false);

    const output = inspectLatestRakutenRun(db);
    expect(output).toContain("availability_status=failed");
    expect(output).toContain("persisted_price=null");
    expect(output).toContain("attempt_outcome=failed");
    expect(output).toContain("error_reason=rakuten_price_or_status_unclear");
    db.close();
  });

  it("returns the latest run when multiple runs exist", () => {
    const db = openTestDb();
    seedRakutenRun(db, "run_rakuten_001", "2026-08-08", false);

    // Insert run_rakuten_002 directly with a later created_at to ensure ordering
    const laterAt = "2026-05-29T10:00:00+09:00";
    db.prepare(
      `INSERT OR IGNORE INTO collector_runs (id, ota, started_at_jst, finished_at_jst, status, created_at)
       VALUES (?, 'rakuten', ?, ?, 'completed', ?)`
    ).run("run_rakuten_002", laterAt, laterAt, laterAt);
    db.prepare(
      `INSERT OR IGNORE INTO rate_snapshots
       (id, run_id, property_id, ota, stay_date, guests, nights, price_jpy, price_total_tax_included,
        availability_status, confidence, checked_at_jst, created_at)
       VALUES (?, 'run_rakuten_002', 'prop_rakuten_test', 'rakuten', '2026-08-08', 2, 1, 18000, 18000, 'available', 'B', ?, ?)`
    ).run("rate_r2_2026-08-08", laterAt, laterAt);

    const output = inspectLatestRakutenRun(db);
    expect(output).toContain("collector_run_id=run_rakuten_002");
    db.close();
  });
});

describe("buildRakutenInspectOutput", () => {
  it("returns no_rakuten_runs_found for empty rows", () => {
    const db = openTestDb();
    expect(buildRakutenInspectOutput(db, [])).toBe("no_rakuten_runs_found");
    db.close();
  });
});
