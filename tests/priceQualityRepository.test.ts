import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  getPriceQualityFlagForSnapshot,
  listPriceQualityFlags,
  upsertPriceQualityFlag
} from "../src/db/repositories/priceQualityRepository";

describe("priceQualityRepository", () => {
  it("upserts quality flags idempotently", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    upsertPriceQualityFlag(db, {
      id: "pq1",
      rateSnapshotId: "rs1",
      source: "jalan",
      propertyId: "p1",
      stayDate: "2026-07-18",
      assessment: { priceJpy: 5000, flags: ["too_low_absolute"], severity: "medium", reason: "too_low_absolute" },
      createdAt: "2026-05-29T00:00:00.000Z"
    });
    upsertPriceQualityFlag(db, {
      id: "pq1",
      rateSnapshotId: "rs1",
      source: "jalan",
      propertyId: "p1",
      stayDate: "2026-07-18",
      assessment: { priceJpy: 5000, flags: ["too_low_absolute", "price_basis_suspicious"], severity: "high", reason: "updated" },
      createdAt: "2026-05-29T00:00:00.000Z"
    });

    expect(listPriceQualityFlags(db)).toHaveLength(1);
    expect(getPriceQualityFlagForSnapshot(db, "rs1")?.severity).toBe("high");
    db.close();
  });
});
