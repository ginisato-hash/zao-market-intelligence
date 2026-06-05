import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { inspectLatestJalanBudgetedRun } from "../src/scripts/inspectLatestJalanBudgetedRun";

describe("inspectLatestJalanBudgetedRun", () => {
  it("handles mixed available and failed rows", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    seed(db);

    const output = inspectLatestJalanBudgetedRun(db);

    expect(output).toContain("collector_run_id=run_budgeted");
    expect(output).toContain("job_count=2");
    expect(output).toContain("count_by_attempt_outcome={\"success\":1,\"failed\":1}");
    expect(output).toContain("priority | stay_date | property | status | persisted_price");
    db.close();
  });
});

function seed(db: LocalDatabase): void {
  db.prepare("INSERT INTO properties (id, name, postal_code, area_name, active) VALUES ('p1', 'Property A', '990-2301', 'Zao', 1)").run();
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td1', '2026-07-18', 'S', 'major', 1)").run();
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td2', '2026-07-19', 'A', 'sunday', 1)").run();
  db.prepare(
    `INSERT INTO collection_job_attempts (
      id, job_id, run_id, property_id, ota, stay_date, guests, nights, attempted_at_jst,
      outcome, availability_status, price_total_tax_included, error_reason, screenshot_path, debug_json_path, retry_count
    ) VALUES
      ('a1', 'jalan_budgeted_1', 'run_budgeted', 'p1', 'jalan', '2026-07-18', 2, 1, '2026-05-29T10:00:00+09:00', 'success', 'available', 12000, NULL, NULL, NULL, 0),
      ('a2', 'jalan_budgeted_2', 'run_budgeted', 'p1', 'jalan', '2026-07-19', 2, 1, '2026-05-29T10:01:00+09:00', 'failed', 'failed', NULL, 'price_basis_or_date_scope_unclear', NULL, NULL, 0)`
  ).run();
}
