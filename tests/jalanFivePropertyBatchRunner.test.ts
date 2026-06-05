import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { countCollectionJobAttempts, listCollectionJobAttemptsByRun } from "../src/db/repositories/collectionJobAttemptsRepository";
import type { CollectorInput, CollectorResult } from "../src/domain/types";
import {
  loadJalanFivePropertyBatchConfig,
  runJalanFivePropertyBatch,
  runJalanFivePropertyDryRun
} from "../src/scripts/runJalanFivePropertyBatch";

function openTestDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function writeTmpConfig(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "jalan-5prop-test-"));
  const path = join(dir, "batch.json");
  writeFileSync(path, JSON.stringify({ ...validConfig(), ...overrides }), "utf8");
  return path;
}

function makeMockResult(input: CollectorInput, available: boolean): CollectorResult {
  const status = available ? "available" : "failed";
  const price = available ? 20000 : null;
  const checkedAt = "2026-05-29T10:00:00+09:00";
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
      confidence: price !== null ? "B" : "C",
      checkedAtJst: checkedAt,
      ...(status === "failed" ? { errorReason: "price_basis_or_date_scope_unclear" } : {}),
      createdAt: checkedAt
    },
    inventorySnapshot: {
      id: `inv_${input.propertyId}_${input.stayDate}`,
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "jalan",
      stayDate: input.stayDate,
      availabilityStatus: status,
      confidence: "B",
      checkedAtJst: checkedAt,
      createdAt: checkedAt
    }
  };
}

describe("runJalanFivePropertyDryRun", () => {
  it("returns planned 15 jobs without DB writes", () => {
    const summary = runJalanFivePropertyDryRun(writeTmpConfig());

    expect(summary.dryRun).toBe(true);
    expect(summary.properties).toHaveLength(5);
    expect(summary.stayDates).toHaveLength(3);
    expect(summary.plannedJobs).toHaveLength(15);
    expect(summary.maxJobs).toBe(15);
  });
});

describe("runJalanFivePropertyBatch", () => {
  it("mocked execution creates 15 snapshots and attempt rows", async () => {
    const db = openTestDb();
    const config = loadJalanFivePropertyBatchConfig(writeTmpConfig());
    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => [makeMockResult(input, true)]
    };

    const summary = await runJalanFivePropertyBatch(config, { db, collector: mockCollector, delay: async () => {} });

    expect(summary.totalJobsAttempted).toBe(15);
    expect(summary.persistedRateSnapshots).toBe(15);
    expect(summary.persistedInventorySnapshots).toBe(15);
    expect(summary.persistedJobAttempts).toBe(15);
    expect(countCollectionJobAttempts(db)).toBe(15);
    db.close();
  });

  it("logs one attempt per job and preserves failed rows without price", async () => {
    const db = openTestDb();
    const config = loadJalanFivePropertyBatchConfig(writeTmpConfig());
    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => [
        makeMockResult(input, input.stayDate !== "2026-10-10")
      ]
    };

    const summary = await runJalanFivePropertyBatch(config, { db, collector: mockCollector, delay: async () => {} });
    const attempts = listCollectionJobAttemptsByRun(db, summary.collectorRunId);
    const failed = attempts.filter((attempt) => attempt.availabilityStatus === "failed");

    expect(attempts).toHaveLength(15);
    expect(failed).toHaveLength(5);
    for (const attempt of failed) {
      expect(attempt.priceTotalTaxIncluded).toBeNull();
      expect(attempt.errorReason).toBe("price_basis_or_date_scope_unclear");
    }
    db.close();
  });

  it("runs sequential delay between jobs", async () => {
    const db = openTestDb();
    const config = loadJalanFivePropertyBatchConfig(writeTmpConfig());
    let delayCalls = 0;
    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => [makeMockResult(input, true)]
    };

    await runJalanFivePropertyBatch(config, {
      db,
      collector: mockCollector,
      delay: async () => { delayCalls += 1; }
    });

    expect(delayCalls).toBe(14);
    db.close();
  });
});

function validConfig() {
  return {
    ota: "jalan",
    properties: [
      { property_name: "Property A", property_url: "https://www.jalan.net/yad100001/" },
      { property_name: "Property B", property_url: "https://www.jalan.net/yad100002/" },
      { property_name: "Property C", property_url: "https://www.jalan.net/yad100003/" },
      { property_name: "Property D", property_url: "https://www.jalan.net/yad100004/" },
      { property_name: "Property E", property_url: "https://www.jalan.net/yad100005/" }
    ],
    stay_dates: ["2026-07-18", "2026-08-08", "2026-10-10"],
    adults: 2,
    children: 0,
    rooms: 1,
    nights: 1,
    max_jobs: 15,
    delay_ms_between_jobs: 3000
  };
}
