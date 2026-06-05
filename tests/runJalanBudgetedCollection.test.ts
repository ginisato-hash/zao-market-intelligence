import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { countCollectionJobAttempts, listCollectionJobAttemptsByRun } from "../src/db/repositories/collectionJobAttemptsRepository";
import type { CollectorInput, CollectorResult } from "../src/domain/types";
import { runJalanBudgetedCollection } from "../src/scripts/runJalanBudgetedCollection";

describe("runJalanBudgetedCollection", () => {
  it("mocked execution creates N snapshots and attempts", async () => {
    const db = openDb();
    seed(db);
    const summary = await runJalanBudgetedCollection(
      { priorityFilter: ["S", "A"], maxJobs: 3 },
      { db, collector: mockCollector(), delay: async () => {} }
    );

    expect(summary.attemptedJobsCount).toBe(3);
    expect(summary.persistedRateSnapshots).toBe(3);
    expect(summary.persistedInventorySnapshots).toBe(3);
    expect(summary.persistedJobAttempts).toBe(3);
    expect(countCollectionJobAttempts(db)).toBe(3);
    db.close();
  });

  it("failed attempts do not invent prices", async () => {
    const db = openDb();
    seed(db);
    const summary = await runJalanBudgetedCollection(
      { priorityFilter: ["S", "A"], maxJobs: 2 },
      { db, collector: mockCollector(false), delay: async () => {} }
    );

    const attempts = listCollectionJobAttemptsByRun(db, summary.collectorRunId);
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt.availabilityStatus).toBe("failed");
      expect(attempt.priceTotalTaxIncluded).toBeNull();
      expect(attempt.errorReason).toBe("price_basis_or_date_scope_unclear");
    }
    db.close();
  });
});

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seed(db: LocalDatabase): void {
  for (const [id, name] of [["p1", "Property A"], ["p2", "Property B"]]) {
    const propertyId = id ?? "";
    db.prepare("INSERT INTO properties (id, name, postal_code, area_name, active) VALUES (?, ?, '990-2301', 'Zao', 1)").run(propertyId, name);
    db.prepare(
      `INSERT INTO property_ota_links (id, property_id, ota, property_url, url, active, last_verified_at)
       VALUES (?, ?, 'jalan', ?, ?, 1, '2026-05-29')`
    ).run(`l_${propertyId}`, propertyId, `https://www.jalan.net/yad10000${propertyId.slice(1)}/`, `https://www.jalan.net/yad10000${propertyId.slice(1)}/`);
  }
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td1', '2026-07-18', 'S', 'major', 1)").run();
  db.prepare("INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active) VALUES ('td2', '2026-07-19', 'A', 'sunday', 1)").run();
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
