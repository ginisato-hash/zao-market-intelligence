import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeMigration, openLocalDatabase, type LocalDatabase } from "../src/db/client";
import { buildPlannedCollectionJobs } from "../src/planner/runPlanner";

let db: LocalDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("run planner", () => {
  it("uses only active properties, active OTA links, and active target dates", () => {
    db = openPlannerDb();
    seedPlannerFixture(db);

    const jobs = buildPlannedCollectionJobs(db);

    expect(jobs).toHaveLength(8);
    expect(jobs.every((job) => job.property_name === "Active Lodge")).toBe(true);
    expect(jobs.every((job) => job.ota !== "rakuten")).toBe(true);
    expect(jobs.every((job) => job.stay_date !== "2026-12-24")).toBe(true);
  });

  it("orders S before A before B before C and supports maxJobs", () => {
    db = openPlannerDb();
    seedPlannerFixture(db);

    const jobs = buildPlannedCollectionJobs(db, { maxJobs: 5 });

    expect(jobs.map((job) => job.priority)).toEqual(["S", "S", "S", "S", "A"]);
    expect(jobs).toHaveLength(5);
  });

  it("supports priority filtering", () => {
    db = openPlannerDb();
    seedPlannerFixture(db);

    const jobs = buildPlannedCollectionJobs(db, { priorityFilter: ["S", "A"] });

    expect(jobs).toHaveLength(6);
    expect(new Set(jobs.map((job) => job.priority))).toEqual(new Set(["S", "A"]));
  });

  it("includes jobs with null property_url", () => {
    db = openPlannerDb();
    seedPlannerFixture(db);

    const jobs = buildPlannedCollectionJobs(db);

    expect(jobs.some((job) => job.property_url === null)).toBe(true);
  });
});

function openPlannerDb(): LocalDatabase {
  const database = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "zao-planner-db-")), "test.sqlite"));
  executeMigration(database);
  return database;
}

function seedPlannerFixture(database: LocalDatabase): void {
  database
    .prepare(
      `INSERT INTO properties (id, name, postal_code, area_name, active)
       VALUES
         ('property_active', 'Active Lodge', '990-2301', 'Zao Onsen', 1),
         ('property_inactive', 'Inactive Lodge', '990-2301', 'Zao Onsen', 0)`
    )
    .run();
  database
    .prepare(
      `INSERT INTO property_ota_links (id, property_id, ota, property_url, active)
       VALUES
         ('link_active_null', 'property_active', 'jalan', NULL, 1),
         ('link_active_url', 'property_active', 'booking', 'https://example.com/active', 1),
         ('link_inactive', 'property_active', 'rakuten', NULL, 0),
         ('link_inactive_property', 'property_inactive', 'jalan', NULL, 1)`
    )
    .run();
  database
    .prepare(
      `INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active)
       VALUES
         ('target_s_2', '2026-10-11', 'S', 'Second S sample', 1),
         ('target_b', '2026-07-18', 'B', 'B sample', 1),
         ('target_s_1', '2026-10-10', 'S', 'First S sample', 1),
         ('target_a', '2026-06-06', 'A', 'A sample', 1),
         ('target_inactive', '2026-12-24', 'C', 'Inactive sample', 0)`
    )
    .run();
}
