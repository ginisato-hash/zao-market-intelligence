import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  formatJalanAutoUpdatePlan,
  parseMaxJobs,
  parsePostalCode,
  parsePriorityFilter,
  planJalanAutoUpdate
} from "../src/scripts/planJalanAutoUpdate";

const NOW = "2026-05-29T00:00:00+09:00";

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seed(db: LocalDatabase): void {
  db.prepare("INSERT INTO properties (id, name, postal_code, area_name, active) VALUES ('p1', 'Property A', '990-2301', 'Zao', 1)").run();
  db.prepare(
    `INSERT INTO property_ota_links (id, property_id, ota, property_url, url, active, last_verified_at)
     VALUES ('l_p1', 'p1', 'jalan', 'https://www.jalan.net/p1/', 'https://www.jalan.net/p1/', 1, '2026-05-01')`
  ).run();
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td_s', '2026-07-18', 'S', 'peak', 1)").run();
}

describe("plan option parsing", () => {
  it("uses the documented defaults", () => {
    expect(parsePriorityFilter(undefined)).toEqual(["S", "A"]);
    expect(parseMaxJobs(undefined)).toBe(30);
    expect(parsePostalCode(undefined)).toBe("990-2301");
  });

  it("rejects invalid values", () => {
    expect(() => parsePriorityFilter("X")).toThrow();
    expect(() => parseMaxJobs("0")).toThrow();
    expect(() => parsePostalCode("  ")).toThrow();
  });
});

describe("planJalanAutoUpdate", () => {
  it("produces a plan without writing to the DB", () => {
    const db = openDb();
    seed(db);
    const before = db.prepare("SELECT * FROM collection_job_attempts ORDER BY id").all();

    const plan = planJalanAutoUpdate(db, { priorityFilter: ["S", "A"], maxJobs: 30, postalCode: "990-2301" }, NOW);

    expect(plan.dueJobsCount).toBe(1);
    expect(db.prepare("SELECT * FROM collection_job_attempts ORDER BY id").all()).toEqual(before);
    db.close();
  });

  it("formats the dry-run output with the expected keys", () => {
    const db = openDb();
    seed(db);
    const output = formatJalanAutoUpdatePlan(
      planJalanAutoUpdate(db, { priorityFilter: ["S", "A"], maxJobs: 30, postalCode: "990-2301" }, NOW)
    );

    expect(output).toContain("due_jobs_count=1");
    expect(output).toContain("skipped_fresh_jobs_count=0");
    expect(output).toContain("max_jobs=30");
    expect(output).toContain("priority_filter=S,A");
    expect(output).toContain("count_by_priority=");
    expect(output).toContain("earliest_stay_date=2026-07-18");
    expect(output).toContain("sample_jobs:");
    db.close();
  });
});
