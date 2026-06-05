import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { insertCollectionJobAttempt } from "../src/db/repositories/collectionJobAttemptsRepository";
import type { CollectionJobAttempt } from "../src/domain/types";
import { selectJalanPlannedJobs } from "../src/planner/jalanPlannedJobs";
import { selectJalanStaleJobs } from "../src/planner/jalanStaleJobs";

const NOW = "2026-05-29T00:00:00+09:00";

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedProperty(db: LocalDatabase, id: string, name: string, postalCode = "990-2301"): void {
  db.prepare(
    "INSERT INTO properties (id, name, postal_code, area_name, active) VALUES (?, ?, ?, 'Zao', 1)"
  ).run(id, name, postalCode);
  db.prepare(
    `INSERT INTO property_ota_links (id, property_id, ota, property_url, url, active, last_verified_at)
     VALUES (?, ?, 'jalan', ?, ?, 1, '2026-05-01')`
  ).run(`l_${id}`, id, `https://www.jalan.net/${id}/`, `https://www.jalan.net/${id}/`);
}

function seedTargetDates(db: LocalDatabase): void {
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td_s', '2026-07-18', 'S', 'peak', 1)").run();
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td_a', '2026-07-19', 'A', 'sunday', 1)").run();
}

function jobIdFor(db: LocalDatabase, propertyId: string, stayDate: string): string {
  const jobs = selectJalanPlannedJobs(db, {
    ota: "jalan",
    priorityFilter: ["S", "A", "B", "C"],
    maxJobs: Number.MAX_SAFE_INTEGER,
    adults: 2,
    rooms: 1,
    nights: 1
  });
  const job = jobs.find((candidate) => candidate.property_id === propertyId && candidate.stay_date === stayDate);
  if (job === undefined) throw new Error(`no job for ${propertyId} ${stayDate}`);
  return job.job_id;
}

function seedAttempt(db: LocalDatabase, jobId: string, propertyId: string, stayDate: string, attemptedAtJst: string): void {
  const attempt: CollectionJobAttempt = {
    id: `attempt_${jobId}`,
    jobId,
    runId: "run_seed",
    propertyId,
    ota: "jalan",
    stayDate,
    guests: 2,
    nights: 1,
    attemptedAtJst,
    outcome: "success",
    availabilityStatus: "available",
    priceTotalTaxIncluded: 12000,
    errorReason: null,
    screenshotPath: null,
    debugJsonPath: null,
    retryCount: 0
  };
  insertCollectionJobAttempt(db, attempt);
}

describe("selectJalanStaleJobs", () => {
  it("treats all jobs as due when there are no prior attempts", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");
    seedProperty(db, "p2", "Property B");
    seedTargetDates(db);

    const plan = selectJalanStaleJobs(db, { priorityFilter: ["S", "A"], maxJobs: 30, postalCode: "990-2301", nowJst: NOW });

    expect(plan.dueJobsCount).toBe(4);
    expect(plan.skippedFreshJobsCount).toBe(0);
    expect(plan.countByPriority).toEqual({ S: 2, A: 2 });
    db.close();
  });

  it("respects the max_jobs cap", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");
    seedProperty(db, "p2", "Property B");
    seedTargetDates(db);

    const plan = selectJalanStaleJobs(db, { priorityFilter: ["S", "A"], maxJobs: 1, postalCode: "990-2301", nowJst: NOW });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.dueJobsCount).toBe(1);
    // highest priority first
    expect(plan.jobs[0]?.priority).toBe("S");
    db.close();
  });

  it("respects the priority filter", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");
    seedProperty(db, "p2", "Property B");
    seedTargetDates(db);

    const plan = selectJalanStaleJobs(db, { priorityFilter: ["S"], maxJobs: 30, postalCode: "990-2301", nowJst: NOW });

    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs.every((job) => job.priority === "S")).toBe(true);
    db.close();
  });

  it("excludes properties outside the postal code", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A", "990-2301");
    seedProperty(db, "p2", "Property B", "100-0001");
    seedTargetDates(db);

    const plan = selectJalanStaleJobs(db, { priorityFilter: ["S", "A"], maxJobs: 30, postalCode: "990-2301", nowJst: NOW });

    expect(plan.jobs.every((job) => job.property_id === "p1")).toBe(true);
    expect(plan.dueJobsCount).toBe(2);
    db.close();
  });

  it("skips jobs whose latest attempt is still fresh per cadence", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");
    seedTargetDates(db);

    // fresh S attempt 1h ago → skip; the A job has no attempt → due
    seedAttempt(db, jobIdFor(db, "p1", "2026-07-18"), "p1", "2026-07-18", "2026-05-28T23:00:00+09:00");

    const plan = selectJalanStaleJobs(db, { priorityFilter: ["S", "A"], maxJobs: 30, postalCode: "990-2301", nowJst: NOW });

    expect(plan.skippedFreshJobsCount).toBe(1);
    expect(plan.dueJobsCount).toBe(1);
    expect(plan.jobs[0]?.stay_date).toBe("2026-07-19");
    db.close();
  });

  it("does not mutate the DB", () => {
    const db = openDb();
    seedProperty(db, "p1", "Property A");
    seedTargetDates(db);

    const before = {
      attempts: db.prepare("SELECT * FROM collection_job_attempts ORDER BY id").all(),
      properties: db.prepare("SELECT * FROM properties ORDER BY id").all(),
      targetDates: db.prepare("SELECT * FROM target_dates ORDER BY target_date_id").all()
    };

    selectJalanStaleJobs(db, { priorityFilter: ["S", "A"], maxJobs: 30, postalCode: "990-2301", nowJst: NOW });

    expect(db.prepare("SELECT * FROM collection_job_attempts ORDER BY id").all()).toEqual(before.attempts);
    expect(db.prepare("SELECT * FROM properties ORDER BY id").all()).toEqual(before.properties);
    expect(db.prepare("SELECT * FROM target_dates ORDER BY target_date_id").all()).toEqual(before.targetDates);
    db.close();
  });
});
