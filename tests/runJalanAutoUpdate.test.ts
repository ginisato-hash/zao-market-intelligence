import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { countCollectionJobAttempts } from "../src/db/repositories/collectionJobAttemptsRepository";
import type { CollectorInput, CollectorResult } from "../src/domain/types";
import {
  AUTO_UPDATE_NON_GOAL_WARNING,
  renderMarketUpdateReport,
  runJalanAutoUpdate,
  type JalanAutoUpdateResult
} from "../src/scripts/runJalanAutoUpdate";

let reportDir: string;

beforeEach(() => {
  reportDir = mkdtempSync(join(tmpdir(), "market-update-report-"));
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
  for (const [id, name] of [["p1", "Property A"], ["p2", "Property B"]] as const) {
    db.prepare("INSERT INTO properties (id, name, postal_code, area_name, active) VALUES (?, ?, '990-2301', 'Zao', 1)").run(id, name);
    db.prepare(
      `INSERT INTO property_ota_links (id, property_id, ota, property_url, url, active, last_verified_at)
       VALUES (?, ?, 'jalan', ?, ?, 1, '2026-05-01')`
    ).run(`l_${id}`, id, `https://www.jalan.net/${id}/`, `https://www.jalan.net/${id}/`);
  }
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td_s', '2026-07-18', 'S', 'peak', 1)").run();
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td_a', '2026-07-19', 'A', 'sunday', 1)").run();
}

function mockCollector(available = true) {
  return {
    collect: async (input: CollectorInput): Promise<CollectorResult[]> => [mockResult(input, available)]
  };
}

function mockResult(input: CollectorInput, available: boolean): CollectorResult {
  const checkedAt = "2026-05-29T10:00:00+09:00";
  const price = available ? 12000 : null;
  const status = available ? "available" : "failed";
  return {
    rateSnapshot: {
      id: `rate_${input.propertyId}_${input.stayDate}`,
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "jalan",
      stayDate: input.stayDate,
      guests: input.guests,
      nights: input.nights,
      priceJpy: price,
      priceTotalTaxIncluded: price,
      availabilityStatus: status,
      confidence: available ? "B" : "C",
      checkedAtJst: checkedAt,
      ...(available ? {} : { errorReason: "price_basis_or_date_scope_unclear" }),
      createdAt: checkedAt
    },
    inventorySnapshot: {
      id: `inv_${input.propertyId}_${input.stayDate}`,
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "jalan",
      stayDate: input.stayDate,
      availabilityStatus: status,
      confidence: available ? "B" : "C",
      checkedAtJst: checkedAt,
      createdAt: checkedAt
    }
  };
}

describe("runJalanAutoUpdate (mocked collector, no network)", () => {
  it("collects due jobs, records attempts, recomputes analytics, and writes a report", async () => {
    const db = openDb();
    seed(db);

    const result = await runJalanAutoUpdate(
      { priorityFilter: ["S", "A"], maxJobs: 3, postalCode: "990-2301", nowJst: "2026-05-29T00:00:00+09:00" },
      { db, collector: mockCollector(), delay: async () => {}, now: () => new Date("2026-05-29T12:00:00Z"), reportDir }
    );

    expect(result.attemptedJobsCount).toBe(3);
    expect(result.successCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(countCollectionJobAttempts(db)).toBe(3);
    expect(result.marketSignalsRecomputedCount).not.toBeNull();
    expect(result.qualityFlagsRecomputedCount).not.toBeNull();

    expect(result.reportPath).not.toBeNull();
    const report = readFileSync(result.reportPath as string, "utf8");
    expect(report).toContain("# Market DB Auto-Update Report");
    expect(report).toContain(result.runId);
    expect(report).toContain("No Beds24 / AirHost export generated.");
    expect(report).toContain("No prices applied");
    expect(report).toContain("No upload performed");
    db.close();
  });

  it("counts failed collections without inventing prices", async () => {
    const db = openDb();
    seed(db);

    const result = await runJalanAutoUpdate(
      { priorityFilter: ["S", "A"], maxJobs: 4, postalCode: "990-2301", nowJst: "2026-05-29T00:00:00+09:00" },
      { db, collector: mockCollector(false), delay: async () => {}, now: () => new Date("2026-05-29T12:00:00Z"), writeReport: false, reportDir }
    );

    expect(result.attemptedJobsCount).toBe(4);
    expect(result.failedCount).toBe(4);
    expect(result.successCount).toBe(0);
    expect(result.reportPath).toBeNull();
    db.close();
  });

  it("skips fresh jobs by cadence so nothing is attempted when all are fresh", async () => {
    const db = openDb();
    seed(db);

    // First run makes everything fresh as of the run time.
    await runJalanAutoUpdate(
      { priorityFilter: ["S", "A"], maxJobs: 4, postalCode: "990-2301", nowJst: "2026-05-29T10:00:00+09:00" },
      { db, collector: mockCollector(), delay: async () => {}, now: () => new Date("2026-05-29T12:00:00Z"), writeReport: false, reportDir }
    );

    // Second run shortly after: attempts were recorded at 2026-05-29T10:00 (mock checkedAt),
    // so an hour later all S/A jobs are still fresh.
    const second = await runJalanAutoUpdate(
      { priorityFilter: ["S", "A"], maxJobs: 4, postalCode: "990-2301", nowJst: "2026-05-29T11:00:00+09:00" },
      { db, collector: mockCollector(), delay: async () => {}, now: () => new Date("2026-05-29T12:00:00Z"), writeReport: false, reportDir }
    );

    expect(second.attemptedJobsCount).toBe(0);
    expect(second.plan.skippedFreshJobsCount).toBe(4);
    db.close();
  });
});

describe("renderMarketUpdateReport", () => {
  it("includes the non-goal warning and no upload-format columns", () => {
    const result: JalanAutoUpdateResult = {
      runId: "run_test",
      generatedAt: "2026-05-29T12:00:00.000Z",
      plan: {
        jobs: [],
        dueJobsCount: 0,
        skippedFreshJobsCount: 0,
        countByPriority: {},
        earliestStayDate: null,
        latestStayDate: null,
        maxJobs: 30,
        priorityFilter: ["S", "A"],
        postalCode: "990-2301",
        nowJst: "2026-05-29T12:00:00.000Z"
      },
      attemptedJobsCount: 0,
      successCount: 0,
      failedCount: 0,
      statusCounts: {},
      countByPriority: {},
      marketSignalsRecomputedCount: null,
      qualityFlagsRecomputedCount: null,
      reportPath: null
    };

    const report = renderMarketUpdateReport(result);
    for (const line of AUTO_UPDATE_NON_GOAL_WARNING) {
      expect(report).toContain(line);
    }
    const lower = report.toLowerCase();
    for (const forbidden of ["roomid", "inventory_count", "multiplier", "price1", "price2", "price3", "price4"]) {
      expect(lower).not.toContain(forbidden);
    }
  });
});
