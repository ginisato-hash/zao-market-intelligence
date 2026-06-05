import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import type { CollectorInput, CollectorResult } from "../src/domain/types";
import {
  formatLatestMarketUpdateInspection,
  inspectLatestMarketUpdate
} from "../src/scripts/inspectLatestMarketUpdate";
import { runJalanAutoUpdate } from "../src/scripts/runJalanAutoUpdate";

let reportDir: string;

beforeEach(() => {
  reportDir = mkdtempSync(join(tmpdir(), "market-update-inspect-"));
});

afterEach(() => {
  rmSync(reportDir, { recursive: true, force: true });
});

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

function mockCollector() {
  return {
    collect: async (input: CollectorInput): Promise<CollectorResult[]> => {
      const checkedAt = "2026-05-29T10:00:00+09:00";
      return [
        {
          rateSnapshot: {
            id: `rate_${input.propertyId}_${input.stayDate}`,
            runId: input.runId,
            propertyId: input.propertyId,
            ota: "jalan",
            stayDate: input.stayDate,
            guests: input.guests,
            nights: input.nights,
            priceJpy: 12000,
            priceTotalTaxIncluded: 12000,
            availabilityStatus: "available",
            confidence: "B",
            checkedAtJst: checkedAt,
            createdAt: checkedAt
          },
          inventorySnapshot: {
            id: `inv_${input.propertyId}_${input.stayDate}`,
            runId: input.runId,
            propertyId: input.propertyId,
            ota: "jalan",
            stayDate: input.stayDate,
            availabilityStatus: "available",
            confidence: "B",
            checkedAtJst: checkedAt,
            createdAt: checkedAt
          }
        }
      ];
    }
  };
}

describe("inspectLatestMarketUpdate", () => {
  it("reports the latest report path, run id, and analytics counts after a run", async () => {
    const db = openDb();
    seed(db);

    const runResult = await runJalanAutoUpdate(
      { priorityFilter: ["S", "A"], maxJobs: 5, postalCode: "990-2301", nowJst: "2026-05-29T00:00:00+09:00" },
      { db, collector: mockCollector(), delay: async () => {}, now: () => new Date("2026-05-29T12:00:00Z"), reportDir }
    );

    const inspection = inspectLatestMarketUpdate(db, { reportDir });

    expect(inspection.latestReportPath).toBe(runResult.reportPath);
    expect(inspection.latestCollectorRunId).toBe(runResult.runId);
    expect(inspection.attemptedJobCount).toBe(1);
    expect(inspection.latestMarketSignalCount).toBeGreaterThan(0);

    const output = formatLatestMarketUpdateInspection(inspection);
    expect(output).toContain("latest_report_path=");
    expect(output).toContain(`latest_collector_run_id=${runResult.runId}`);
    expect(output).toContain("attempted_job_count=1");
    db.close();
  });

  it("returns nulls when no report or attempts exist", () => {
    const db = openDb();
    const inspection = inspectLatestMarketUpdate(db, { reportDir });
    expect(inspection.latestReportPath).toBeNull();
    expect(inspection.latestCollectorRunId).toBeNull();
    expect(inspection.attemptedJobCount).toBeNull();
    expect(inspection.latestMarketSignalCount).toBe(0);
    db.close();
  });

  it("picks the lexicographically latest report file", () => {
    const db = openDb();
    writeFileSync(join(reportDir, "market_update_report_20260101_000000.md"), "old");
    writeFileSync(join(reportDir, "market_update_report_20260201_000000.md"), "new");
    const inspection = inspectLatestMarketUpdate(db, { reportDir });
    expect(inspection.latestReportPath).toBe(join(reportDir, "market_update_report_20260201_000000.md"));
    db.close();
  });
});
