import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { countCollectionJobAttempts, listCollectionJobAttemptsByRun } from "../src/db/repositories/collectionJobAttemptsRepository";
import type { CollectorInput, CollectorResult } from "../src/domain/types";
import {
  loadJalanMultiDatePrototypeConfig,
  runJalanMultiDateDryRun,
  runJalanMultiDatePrototype
} from "../src/scripts/runJalanMultiDatePrototype";

function openTestDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function writeTmpConfig(dates: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "jalan-attempt-test-"));
  const path = join(dir, "jalan.multi-date.prototype.json");
  writeFileSync(
    path,
    JSON.stringify({
      ota: "jalan",
      property_name: "Test Property",
      property_url: "https://www.jalan.net/yad123456/",
      stay_dates: dates,
      adults: 2,
      children: 0,
      rooms: 1,
      nights: 1,
      max_attempts: dates.length,
      delay_ms_between_attempts: 2000
    }),
    "utf8"
  );
  return path;
}

function makeMockResult(input: CollectorInput, available: boolean): CollectorResult {
  const status = available ? "available" : "failed";
  const price = available ? 25000 : null;
  const checkedAt = "2026-05-28T10:00:00+09:00";
  return {
    rateSnapshot: {
      id: `rate_${input.stayDate}`,
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
      id: `inv_${input.stayDate}`,
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

describe("Jalan multi-date attempt logging", () => {
  it("dry-run does not write any collection_job_attempts", () => {
    const configPath = writeTmpConfig(["2026-08-08"]);
    const summary = runJalanMultiDateDryRun(configPath);

    expect(summary.dryRun).toBe(true);
    expect(summary.plannedDates).toEqual(["2026-08-08"]);
    // No DB was opened; just verify the return value is dry
  });

  it("mocked execution for one available date writes one attempt row", async () => {
    const db = openTestDb();
    const configPath = writeTmpConfig(["2026-08-08"]);
    const config = loadJalanMultiDatePrototypeConfig(configPath);

    let capturedInput: CollectorInput | undefined;
    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => {
        capturedInput = input;
        return [makeMockResult(input, true)];
      }
    };

    const summary = await runJalanMultiDatePrototype(config, {
      db,
      collector: mockCollector,
      delay: async () => {}
    });

    expect(summary.persistedJobAttempts).toBe(1);
    expect(summary.persistedRateSnapshots).toBe(1);

    const attempts = listCollectionJobAttemptsByRun(db, summary.collectorRunId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.stayDate).toBe("2026-08-08");
    expect(attempts[0]?.ota).toBe("jalan");
    expect(attempts[0]?.outcome).toBe("success");
    expect(attempts[0]?.availabilityStatus).toBe("available");
    expect(attempts[0]?.priceTotalTaxIncluded).toBe(25000);
    expect(attempts[0]?.jobId).toBe(`jalan_multi_date_2026-08-08`);
    expect(attempts[0]?.debugJsonPath).toContain("2026-08-08.json");
    expect(capturedInput).toBeDefined();

    db.close();
  });

  it("mocked execution for two dates (one available, one failed) writes two attempt rows", async () => {
    const db = openTestDb();
    const configPath = writeTmpConfig(["2026-08-08", "2026-12-12"]);
    const config = loadJalanMultiDatePrototypeConfig(configPath);

    const mockCollector = {
      collect: async (input: CollectorInput): Promise<CollectorResult[]> => {
        const available = input.stayDate === "2026-08-08";
        return [makeMockResult(input, available)];
      }
    };

    const summary = await runJalanMultiDatePrototype(config, {
      db,
      collector: mockCollector,
      delay: async () => {}
    });

    expect(summary.persistedJobAttempts).toBe(2);

    const attempts = listCollectionJobAttemptsByRun(db, summary.collectorRunId);
    expect(attempts).toHaveLength(2);

    const available = attempts.find((a) => a.stayDate === "2026-08-08");
    const failed = attempts.find((a) => a.stayDate === "2026-12-12");

    expect(available?.outcome).toBe("success");
    expect(available?.priceTotalTaxIncluded).toBe(25000);
    expect(failed?.outcome).toBe("failed");
    expect(failed?.priceTotalTaxIncluded).toBeNull();
    expect(failed?.errorReason).toBe("price_basis_or_date_scope_unclear");

    db.close();
  });

  it("total attempt count increments correctly across runs", async () => {
    const db = openTestDb();

    for (const date of ["2026-08-08", "2026-10-10"] as const) {
      const configPath = writeTmpConfig([date]);
      const config = loadJalanMultiDatePrototypeConfig(configPath);
      const mockCollector = {
        collect: async (input: CollectorInput): Promise<CollectorResult[]> => [makeMockResult(input, true)]
      };
      await runJalanMultiDatePrototype(config, { db, collector: mockCollector, delay: async () => {} });
    }

    expect(countCollectionJobAttempts(db)).toBe(2);
    db.close();
  });
});
