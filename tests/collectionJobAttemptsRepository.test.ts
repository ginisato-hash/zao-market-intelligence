import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  countCollectionJobAttempts,
  getLatestCollectionJobAttempt,
  insertCollectionJobAttempt,
  listCollectionJobAttemptsByRun
} from "../src/db/repositories/collectionJobAttemptsRepository";
import type { CollectionJobAttempt } from "../src/domain/types";

function openTestDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function makeAttempt(overrides: Partial<CollectionJobAttempt> = {}): CollectionJobAttempt {
  return {
    id: "attempt_test_001",
    jobId: "job_jalan_date1",
    runId: "run_test_001",
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
    debugJsonPath: ".data/debug/jalan/run_test_001/2026-08-08.json",
    retryCount: 0,
    ...overrides
  };
}

describe("collectionJobAttemptsRepository", () => {
  it("migration creates collection_job_attempts table", () => {
    const db = openTestDb();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collection_job_attempts'")
      .get();
    expect(table).toBeTruthy();
    db.close();
  });

  it("migration is idempotent", () => {
    const db = openTestDb();
    // Running executeMigration a second time must not throw
    expect(() => executeMigration(db)).not.toThrow();
    db.close();
  });

  it("inserts and retrieves a successful attempt", () => {
    const db = openTestDb();
    const attempt = makeAttempt();
    insertCollectionJobAttempt(db, attempt);

    const attempts = listCollectionJobAttemptsByRun(db, "run_test_001");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.jobId).toBe("job_jalan_date1");
    expect(attempts[0]?.outcome).toBe("success");
    expect(attempts[0]?.availabilityStatus).toBe("available");
    expect(attempts[0]?.priceTotalTaxIncluded).toBe(25000);
    db.close();
  });

  it("inserts a failed attempt with error reason", () => {
    const db = openTestDb();
    insertCollectionJobAttempt(
      db,
      makeAttempt({
        id: "attempt_fail",
        outcome: "failed",
        availabilityStatus: "failed",
        priceTotalTaxIncluded: null,
        errorReason: "price_basis_or_date_scope_unclear"
      })
    );

    const attempts = listCollectionJobAttemptsByRun(db, "run_test_001");
    expect(attempts[0]?.outcome).toBe("failed");
    expect(attempts[0]?.priceTotalTaxIncluded).toBeNull();
    expect(attempts[0]?.errorReason).toBe("price_basis_or_date_scope_unclear");
    db.close();
  });

  it("inserts a blocked attempt", () => {
    const db = openTestDb();
    insertCollectionJobAttempt(
      db,
      makeAttempt({
        id: "attempt_blocked",
        outcome: "blocked",
        availabilityStatus: "failed",
        priceTotalTaxIncluded: null,
        errorReason: "Jalan page appears blocked or challenged access."
      })
    );

    const attempts = listCollectionJobAttemptsByRun(db, "run_test_001");
    expect(attempts[0]?.outcome).toBe("blocked");
    db.close();
  });

  it("duplicate (job_id, run_id) is silently ignored by INSERT OR IGNORE", () => {
    const db = openTestDb();
    const attempt = makeAttempt();
    insertCollectionJobAttempt(db, attempt);
    // Second insert with same job_id and run_id: should not throw, row count stays 1
    insertCollectionJobAttempt(db, { ...attempt, id: "attempt_test_002" });

    expect(countCollectionJobAttempts(db)).toBe(1);
    db.close();
  });

  it("allows the same job_id across different run_ids", () => {
    const db = openTestDb();
    insertCollectionJobAttempt(db, makeAttempt({ id: "attempt_run1", runId: "run_001" }));
    insertCollectionJobAttempt(db, makeAttempt({ id: "attempt_run2", runId: "run_002" }));

    expect(countCollectionJobAttempts(db)).toBe(2);
    db.close();
  });

  it("getLatestCollectionJobAttempt returns the most recent attempt for a job", () => {
    const db = openTestDb();
    insertCollectionJobAttempt(
      db,
      makeAttempt({ id: "attempt_old", runId: "run_001", attemptedAtJst: "2026-05-27T09:00:00+09:00" })
    );
    insertCollectionJobAttempt(
      db,
      makeAttempt({ id: "attempt_new", runId: "run_002", attemptedAtJst: "2026-05-28T10:00:00+09:00" })
    );

    const latest = getLatestCollectionJobAttempt(db, "job_jalan_date1");
    expect(latest?.id).toBe("attempt_new");
    db.close();
  });

  it("getLatestCollectionJobAttempt returns undefined for unknown job", () => {
    const db = openTestDb();
    expect(getLatestCollectionJobAttempt(db, "job_does_not_exist")).toBeUndefined();
    db.close();
  });

  it("countCollectionJobAttempts returns 0 on empty table", () => {
    const db = openTestDb();
    expect(countCollectionJobAttempts(db)).toBe(0);
    db.close();
  });

  it("listCollectionJobAttemptsByRun returns empty array for unknown run", () => {
    const db = openTestDb();
    expect(listCollectionJobAttemptsByRun(db, "run_unknown")).toEqual([]);
    db.close();
  });
});
