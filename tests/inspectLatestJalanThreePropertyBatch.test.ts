import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { insertCollectionJobAttempt } from "../src/db/repositories/collectionJobAttemptsRepository";
import type { CollectionJobAttempt } from "../src/domain/types";
import {
  buildThreePropertyInspectOutput,
  buildThreePropertyInspectSummary,
  findLatestThreePropertyBatchRunId,
  inspectLatestJalanThreePropertyBatch,
  loadBatchAttemptRows
} from "../src/scripts/inspectLatestJalanThreePropertyBatch";

function openTestDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  db.prepare(
    "INSERT OR IGNORE INTO properties (id, name, postal_code, area_name) VALUES ('prop_a', 'Property A', '990-2301', 'Zao Onsen')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO properties (id, name, postal_code, area_name) VALUES ('prop_b', 'Property B', '990-2301', 'Zao Onsen')"
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO properties (id, name, postal_code, area_name) VALUES ('prop_c', 'Property C', '990-2301', 'Zao Onsen')"
  ).run();
  return db;
}

function makeAttempt(
  runId: string,
  propertyId: string,
  stayDate: string,
  available: boolean,
  id: string
): CollectionJobAttempt {
  return {
    id,
    jobId: `jalan_three_property_${propertyId}_${stayDate}`,
    runId,
    propertyId,
    ota: "jalan",
    stayDate,
    guests: 2,
    nights: 1,
    attemptedAtJst: "2026-05-28T10:00:00+09:00",
    outcome: available ? "success" : "failed",
    availabilityStatus: available ? "available" : "failed",
    priceTotalTaxIncluded: available ? 22000 : null,
    errorReason: available ? null : "price_basis_or_date_scope_unclear",
    screenshotPath: available ? `.data/screenshots/${id}.png` : null,
    debugJsonPath: `.data/debug/jalan/${runId}/${propertyId}_${stayDate}.json`,
    retryCount: 0
  };
}

function seedBatchRun(db: LocalDatabase, runId: string, dates = ["2026-07-18", "2026-08-08", "2026-10-10"]): void {
  const props = ["prop_a", "prop_b", "prop_c"];
  let idx = 0;
  for (const prop of props) {
    for (const date of dates) {
      insertCollectionJobAttempt(db, makeAttempt(runId, prop, date, idx % 2 === 0, `attempt_${runId}_${prop}_${date}`));
      idx++;
    }
  }
}

describe("findLatestThreePropertyBatchRunId", () => {
  it("returns undefined when no attempts exist", () => {
    const db = openTestDb();
    expect(findLatestThreePropertyBatchRunId(db)).toBeUndefined();
    db.close();
  });

  it("returns undefined when only single-property runs exist", () => {
    const db = openTestDb();
    insertCollectionJobAttempt(db, makeAttempt("run_single", "prop_a", "2026-07-18", true, "att_single"));
    expect(findLatestThreePropertyBatchRunId(db)).toBeUndefined();
    db.close();
  });

  it("returns run_id for a run with 3+ distinct properties", () => {
    const db = openTestDb();
    seedBatchRun(db, "run_batch_001");
    expect(findLatestThreePropertyBatchRunId(db)).toBe("run_batch_001");
    db.close();
  });

  it("returns the most recent batch run when multiple exist", () => {
    const db = openTestDb();
    seedBatchRun(db, "run_batch_001");

    // run_batch_002 has a later attempted_at_jst so it should be returned
    const laterTime = "2026-05-29T10:00:00+09:00";
    const makeAttemptLater = (id: string, prop: string, date: string, avail: boolean): CollectionJobAttempt => ({
      ...makeAttempt("run_batch_002", prop, date, avail, id),
      attemptedAtJst: laterTime
    });
    insertCollectionJobAttempt(db, makeAttemptLater("att2_a", "prop_a", "2026-07-18", true));
    insertCollectionJobAttempt(db, makeAttemptLater("att2_b", "prop_b", "2026-07-18", true));
    insertCollectionJobAttempt(db, makeAttemptLater("att2_c", "prop_c", "2026-07-18", false));
    expect(findLatestThreePropertyBatchRunId(db)).toBe("run_batch_002");
    db.close();
  });
});

describe("buildThreePropertyInspectSummary", () => {
  it("counts available, failed, attempt totals correctly", () => {
    const db = openTestDb();
    seedBatchRun(db, "run_batch_001");
    const rows = loadBatchAttemptRows(db, "run_batch_001");
    const summary = buildThreePropertyInspectSummary("run_batch_001", rows);

    expect(summary.collectorRunId).toBe("run_batch_001");
    expect(summary.propertyCount).toBe(3);
    expect(summary.dateCount).toBe(3);
    expect(summary.attemptCount).toBe(9);
    db.close();
  });
});

describe("buildThreePropertyInspectOutput", () => {
  it("returns 'none' message when rows are empty", () => {
    const summary = buildThreePropertyInspectSummary("run_empty", []);
    expect(buildThreePropertyInspectOutput(summary)).toBe("latest_jalan_three_property_batch=none");
  });

  it("includes matrix header and per-row lines", () => {
    const db = openTestDb();
    seedBatchRun(db, "run_batch_001");
    const rows = loadBatchAttemptRows(db, "run_batch_001");
    const summary = buildThreePropertyInspectSummary("run_batch_001", rows);
    const output = buildThreePropertyInspectOutput(summary);

    expect(output).toContain("collector_run_id=run_batch_001");
    expect(output).toContain("property_count=3");
    expect(output).toContain("attempt_count=9");
    expect(output).toContain("property | stay_date | status | persisted_price | attempt_outcome | error_reason");
    expect(output).toContain("Property A");
    expect(output).toContain("2026-07-18");
    db.close();
  });
});

describe("inspectLatestJalanThreePropertyBatch", () => {
  it("returns no_collection_job_attempts_found on empty DB", () => {
    const db = openTestDb();
    expect(inspectLatestJalanThreePropertyBatch(db)).toBe("no_collection_job_attempts_found");
    db.close();
  });

  it("returns no_three_property_batch_found when only single-property attempts exist", () => {
    const db = openTestDb();
    insertCollectionJobAttempt(db, makeAttempt("run_single", "prop_a", "2026-07-18", true, "att_s"));
    expect(inspectLatestJalanThreePropertyBatch(db)).toBe("no_three_property_batch_found");
    db.close();
  });

  it("returns full matrix for a valid batch run", () => {
    const db = openTestDb();
    seedBatchRun(db, "run_batch_001");
    const output = inspectLatestJalanThreePropertyBatch(db);

    expect(output).toContain("collector_run_id=run_batch_001");
    expect(output).toContain("attempt_count=9");
    db.close();
  });
});
