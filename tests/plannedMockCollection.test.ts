import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCollector } from "../src/collectors/mockCollector";
import type { CollectorResult } from "../src/domain/types";
import { executeMigration, openLocalDatabase, type LocalDatabase } from "../src/db/client";
import { buildPlannedCollectionJobs } from "../src/planner/runPlanner";
import { persistCollectorResult } from "../src/services/persistCollectorResult";

let db: LocalDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("planned mock collection", () => {
  it("persists planned mock results without invented prices for unavailable statuses", async () => {
    db = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "zao-planned-db-")), "test.sqlite"));
    executeMigration(db);
    seedFixture(db);

    const jobs = buildPlannedCollectionJobs(db, { maxJobs: 4 });
    const collector = new MockCollector();
    const persisted: CollectorResult[] = [];

    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      if (job === undefined) {
        continue;
      }
      const results = await collector.collect({
        runId: "run_planned_test",
        propertyId: job.property_id,
        propertyName: job.property_name,
        ota: "mock",
        stayDate: job.stay_date,
        guests: job.adults,
        nights: job.nights
      });
      const selected = results[index % results.length];
      if (selected !== undefined) {
        persistCollectorResult(db, selected);
        persisted.push(selected);
      }
    }

    expect(persisted).toHaveLength(4);
    const invalidUnavailablePrices = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM rate_snapshots
         WHERE availability_status IN ('sold_out', 'not_listed', 'failed')
           AND price_total_tax_included IS NOT NULL`
      )
      .get() as { count: number };
    const failedWithReason = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM rate_snapshots
         WHERE availability_status = 'failed'
           AND error_reason IS NOT NULL`
      )
      .get() as { count: number };

    expect(invalidUnavailablePrices.count).toBe(0);
    expect(failedWithReason.count).toBe(1);
  });
});

function seedFixture(database: LocalDatabase): void {
  database
    .prepare(
      `INSERT INTO properties (id, name, postal_code, area_name, active)
       VALUES ('property_active', 'Active Lodge', '990-2301', 'Zao Onsen', 1)`
    )
    .run();
  database
    .prepare(
      `INSERT INTO property_ota_links (id, property_id, ota, property_url, active)
       VALUES ('link_active', 'property_active', 'jalan', NULL, 1)`
    )
    .run();
  database
    .prepare(
      `INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active)
       VALUES
         ('target_1', '2026-06-06', 'S', 'Sample 1', 1),
         ('target_2', '2026-06-13', 'A', 'Sample 2', 1),
         ('target_3', '2026-07-18', 'B', 'Sample 3', 1),
         ('target_4', '2026-08-08', 'C', 'Sample 4', 1)`
    )
    .run();
}
