import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { countCollectionJobAttempts } from "../src/db/repositories/collectionJobAttemptsRepository";
import { formatJalanBudgetedPlan, planJalanBudgetedJobs } from "../src/scripts/planJalanBudgetedJobs";

describe("planJalanBudgetedJobs", () => {
  it("formats a dry-run plan without DB writes or attempts", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    seed(db);

    const options = { priorityFilter: ["S", "A"] as const, maxJobs: 2 };
    const jobs = planJalanBudgetedJobs(db, { priorityFilter: [...options.priorityFilter], maxJobs: options.maxJobs });
    const output = formatJalanBudgetedPlan(jobs, { priorityFilter: [...options.priorityFilter], maxJobs: options.maxJobs });

    expect(output).toContain("planned_jobs_count=2");
    expect(output).toContain("priority_filter=S,A");
    expect(countCollectionJobAttempts(db)).toBe(0);
    db.close();
  });
});

function seed(db: LocalDatabase): void {
  db.prepare("INSERT INTO properties (id, name, postal_code, area_name, active) VALUES ('p1', 'Property A', '990-2301', 'Zao', 1)").run();
  db.prepare(
    `INSERT INTO property_ota_links (id, property_id, ota, property_url, url, active, last_verified_at)
     VALUES ('l1', 'p1', 'jalan', 'https://www.jalan.net/yad100001/', 'https://www.jalan.net/yad100001/', 1, '2026-05-29')`
  ).run();
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td1', '2026-07-18', 'S', 'major', 1)").run();
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td2', '2026-07-19', 'A', 'sunday', 1)").run();
}
