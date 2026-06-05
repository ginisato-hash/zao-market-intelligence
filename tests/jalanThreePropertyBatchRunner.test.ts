import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { countCollectionJobAttempts, listCollectionJobAttemptsByRun } from "../src/db/repositories/collectionJobAttemptsRepository";
import type { CollectorInput, CollectorResult } from "../src/domain/types";
import {
  loadJalanThreePropertyBatchConfig,
  runJalanThreePropertyBatch,
  runJalanThreePropertyDryRun
} from "../src/scripts/runJalanThreePropertyBatch";

function openTestDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function writeTmpConfig(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "jalan-3prop-test-"));
  const path = join(dir, "batch.json");
  writeFileSync(
    path,
    JSON.stringify({
      ota: "jalan",
      properties: [
        { property_name: "Property A", property_url: "https://www.jalan.net/yad100001/" },
        { property_name: "Property B", property_url: "https://www.jalan.net/yad100002/" },
        { property_name: "Property C", property_url: "https://www.jalan.net/yad100003/" }
      ],
      stay_dates: ["2026-07-18", "2026-08-08", "2026-10-10"],
      adults: 2,
      children: 0,
      rooms: 1,
      nights: 1,
      max_jobs: 9,
      delay_ms_between_jobs: 3000,
      ...overrides
    }),
    "utf8"
  );
  return path;
}

function makeMockResult(input: CollectorInput, available: boolean): CollectorResult {
  const status = available ? "available" : "failed";
  const price = available ? 20000 : null;
  const checkedAt = "2026-05-28T10:00:00+09:00";
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

describe("runJalanThreePropertyDryRun", () => {
  it("returns dry-run summary with no DB writes", () => {
    const configPath = writeTmpConfig();
    const summary = runJalanThreePropertyDryRun(configPath);

    expect(summary.dryRun).toBe(true);
    expect(summary.properties).toHaveLength(3);
    expect(summary.stayDates).toHaveLength(3);
    expect(summary.plannedJobs).toHaveLength(9);
    expect(summary.maxJobs).toBe(9);
  });

  it("planned jobs are property × date combinations in order", () => {
    const configPath = writeTmpConfig();
    const summary = runJalanThreePropertyDryRun(configPath);

    expect(summary.plannedJobs[0]).toEqual({ propertyName: "Property A", stayDate: "2026-07-18" });
    expect(summary.plannedJobs[3]).toEqual({ propertyName: "Property B", stayDate: "2026-07-18" });
    expect(summary.plannedJobs[6]).toEqual({ propertyName: "Property C", stayDate: "2026-07-18" });
  });
});

describe("runJalanThreePropertyBatch", () => {
  it("mocked all-available: 9 rate snapshots, 9 inventory snapshots, 9 attempt rows", async () => {
    const db = openTestDb();
    const configPath = writeTmpConfig();
    const config = loadJalanThreePropertyBatchConfig(configPath);

    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => [makeMockResult(input, true)]
    };

    const summary = await runJalanThreePropertyBatch(config, {
      db,
      collector: mockCollector,
      delay: async () => {}
    });

    expect(summary.totalJobsAttempted).toBe(9);
    expect(summary.persistedRateSnapshots).toBe(9);
    expect(summary.persistedInventorySnapshots).toBe(9);
    expect(summary.persistedJobAttempts).toBe(9);
    expect(countCollectionJobAttempts(db)).toBe(9);
    db.close();
  });

  it("each property has 3 attempt rows (one per date)", async () => {
    const db = openTestDb();
    const configPath = writeTmpConfig();
    const config = loadJalanThreePropertyBatchConfig(configPath);

    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => [makeMockResult(input, true)]
    };

    const summary = await runJalanThreePropertyBatch(config, {
      db,
      collector: mockCollector,
      delay: async () => {}
    });

    const attempts = listCollectionJobAttemptsByRun(db, summary.collectorRunId);
    const byProperty = new Map<string, number>();
    for (const a of attempts) {
      byProperty.set(a.propertyId, (byProperty.get(a.propertyId) ?? 0) + 1);
    }
    expect(byProperty.size).toBe(3);
    for (const count of byProperty.values()) {
      expect(count).toBe(3);
    }
    db.close();
  });

  it("mixed outcomes: available rows have price, failed rows have null price and error_reason", async () => {
    const db = openTestDb();
    const configPath = writeTmpConfig();
    const config = loadJalanThreePropertyBatchConfig(configPath);

    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => {
        const available = input.stayDate === "2026-07-18";
        return [makeMockResult(input, available)];
      }
    };

    const summary = await runJalanThreePropertyBatch(config, {
      db,
      collector: mockCollector,
      delay: async () => {}
    });

    const attempts = listCollectionJobAttemptsByRun(db, summary.collectorRunId);
    const availableAttempts = attempts.filter((a) => a.availabilityStatus === "available");
    const failedAttempts = attempts.filter((a) => a.availabilityStatus === "failed");

    expect(availableAttempts).toHaveLength(3);
    expect(failedAttempts).toHaveLength(6);

    for (const a of availableAttempts) {
      expect(a.priceTotalTaxIncluded).toBe(20000);
      expect(a.outcome).toBe("success");
    }
    for (const a of failedAttempts) {
      expect(a.priceTotalTaxIncluded).toBeNull();
      expect(a.outcome).toBe("failed");
      expect(a.errorReason).toBe("price_basis_or_date_scope_unclear");
    }
    db.close();
  });

  it("respects max_jobs limit", async () => {
    const db = openTestDb();
    const configPath = writeTmpConfig({ max_jobs: 5 });
    const config = loadJalanThreePropertyBatchConfig(configPath);

    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => [makeMockResult(input, true)]
    };

    const summary = await runJalanThreePropertyBatch(config, {
      db,
      collector: mockCollector,
      delay: async () => {}
    });

    expect(summary.totalJobsAttempted).toBe(5);
    expect(countCollectionJobAttempts(db)).toBe(5);
    db.close();
  });

  it("delay is called between jobs (not before first)", async () => {
    const db = openTestDb();
    const configPath = writeTmpConfig();
    const config = loadJalanThreePropertyBatchConfig(configPath);

    let delayCalls = 0;
    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => [makeMockResult(input, true)]
    };

    await runJalanThreePropertyBatch(config, {
      db,
      collector: mockCollector,
      delay: async () => { delayCalls += 1; }
    });

    expect(delayCalls).toBe(8);
    db.close();
  });

  it("attempt rows have correct jobId pattern", async () => {
    const db = openTestDb();
    const configPath = writeTmpConfig();
    const config = loadJalanThreePropertyBatchConfig(configPath);

    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => [makeMockResult(input, true)]
    };

    const summary = await runJalanThreePropertyBatch(config, {
      db,
      collector: mockCollector,
      delay: async () => {}
    });

    const attempts = listCollectionJobAttemptsByRun(db, summary.collectorRunId);
    for (const a of attempts) {
      expect(a.jobId).toContain("jalan_three_property");
      expect(a.jobId).toContain(a.stayDate);
    }
    db.close();
  });

  it("debugJsonPath includes propertyId and stayDate", async () => {
    const db = openTestDb();
    const configPath = writeTmpConfig();
    const config = loadJalanThreePropertyBatchConfig(configPath);

    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => [makeMockResult(input, true)]
    };

    const summary = await runJalanThreePropertyBatch(config, {
      db,
      collector: mockCollector,
      delay: async () => {}
    });

    const attempts = listCollectionJobAttemptsByRun(db, summary.collectorRunId);
    for (const a of attempts) {
      expect(a.debugJsonPath).toContain(a.stayDate);
      expect(a.debugJsonPath).toContain(".data/debug/jalan");
    }
    db.close();
  });
});
