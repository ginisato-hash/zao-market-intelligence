import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { insertCollectionJobAttempt } from "../src/db/repositories/collectionJobAttemptsRepository";
import { verifyLocalDb } from "../src/db/verify";
import type { CollectionJobAttempt } from "../src/domain/types";

function openTestDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedProperty(db: LocalDatabase): void {
  db.prepare(
    "INSERT OR IGNORE INTO properties (id, name, postal_code, area_name) VALUES ('property_test', 'ル・ベール蔵王', '990-2301', 'Zao Onsen')"
  ).run();
}

function makeAttempt(overrides: Partial<CollectionJobAttempt> = {}): CollectionJobAttempt {
  return {
    id: "attempt_001",
    jobId: "jalan_multi_date_2026-08-08",
    runId: "run_inspect_001",
    propertyId: "property_test",
    ota: "jalan",
    stayDate: "2026-08-08",
    guests: 2,
    nights: 1,
    attemptedAtJst: "2026-05-28T10:00:00+09:00",
    outcome: "success",
    availabilityStatus: "available",
    priceTotalTaxIncluded: 25000,
    errorReason: null,
    screenshotPath: ".data/screenshots/test.png",
    debugJsonPath: ".data/debug/jalan/run_inspect_001/2026-08-08.json",
    retryCount: 0,
    ...overrides
  };
}

describe("inspectLatestCollectionJobAttempts", () => {
  it("verifyLocalDb reports 0 collection_job_attempts on empty table", () => {
    const db = openTestDb();
    const result = verifyLocalDb(db);
    expect(result.collectionJobAttemptsCount).toBe(0);
    expect(result.invalidAttemptPriceCount).toBe(0);
    expect(result.attemptsMissingErrorReasonCount).toBe(0);
    db.close();
  });

  it("verifyLocalDb reports correct attempt counts after insert", () => {
    const db = openTestDb();
    seedProperty(db);
    insertCollectionJobAttempt(db, makeAttempt());

    const result = verifyLocalDb(db);
    expect(result.collectionJobAttemptsCount).toBe(1);
    db.close();
  });

  it("verifyLocalDb detects invalid attempt with price on non-available status", () => {
    const db = openTestDb();
    seedProperty(db);

    // Insert a sold_out attempt that incorrectly has a price
    db.pragma("ignore_check_constraints = ON");
    insertCollectionJobAttempt(
      db,
      makeAttempt({
        id: "attempt_bad",
        outcome: "success",
        availabilityStatus: "sold_out",
        priceTotalTaxIncluded: 25000
      })
    );
    db.pragma("ignore_check_constraints = OFF");

    const result = verifyLocalDb(db);
    expect(result.invalidAttemptPriceCount).toBe(1);
    expect(result.errors).toContain(
      "collection_job_attempts: non-available rows must not have price_total_tax_included"
    );
    db.close();
  });

  it("verifyLocalDb reports attempts_missing_error_reason for failed outcome with null error", () => {
    const db = openTestDb();
    seedProperty(db);
    insertCollectionJobAttempt(
      db,
      makeAttempt({
        outcome: "failed",
        availabilityStatus: "failed",
        priceTotalTaxIncluded: null,
        errorReason: null
      })
    );

    const result = verifyLocalDb(db);
    expect(result.attemptsMissingErrorReasonCount).toBe(1);
    db.close();
  });

  it("verifyLocalDb reports 0 errors for a valid available attempt", () => {
    const db = openTestDb();
    seedProperty(db);
    insertCollectionJobAttempt(db, makeAttempt());

    const result = verifyLocalDb(db);
    expect(result.errors).toHaveLength(0);
    expect(result.invalidAttemptPriceCount).toBe(0);
    db.close();
  });

  it("verifyLocalDb reports 0 errors for a valid failed attempt with error reason", () => {
    const db = openTestDb();
    seedProperty(db);
    insertCollectionJobAttempt(
      db,
      makeAttempt({
        outcome: "failed",
        availabilityStatus: "failed",
        priceTotalTaxIncluded: null,
        errorReason: "price_basis_or_date_scope_unclear"
      })
    );

    const result = verifyLocalDb(db);
    expect(result.errors).toHaveLength(0);
    expect(result.attemptsMissingErrorReasonCount).toBe(0);
    db.close();
  });
});
