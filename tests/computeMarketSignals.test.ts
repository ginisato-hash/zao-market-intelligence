import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { computeMarketSignalsFromSnapshots, confidenceFor, median } from "../src/services/computeMarketSignals";

describe("computeMarketSignals", () => {
  it("computes odd and even medians deterministically", () => {
    expect(median([10000, 20000, 30000])).toBe(20000);
    expect(median([10000, 20000, 30000, 40001])).toBe(25000);
  });

  it("excludes failed, sold_out, and not_listed rows from price samples", () => {
    const db = openDb();
    seedBase(db);
    insertSnapshot(db, { id: "r1", propertyId: "p1", stayDate: "2026-07-18", status: "available", price: 10000 });
    insertSnapshot(db, { id: "r2", propertyId: "p2", stayDate: "2026-07-18", status: "failed", price: null });
    insertSnapshot(db, { id: "r3", propertyId: "p3", stayDate: "2026-07-18", status: "sold_out", price: null });
    insertSnapshot(db, { id: "r4", propertyId: "p4", stayDate: "2026-07-18", status: "not_listed", price: null });

    const [signal] = computeMarketSignalsFromSnapshots(db, { generatedAt: "2026-05-29T00:00:00.000Z" });

    expect(signal?.medianPriceJpy).toBe(10000);
    expect(signal?.qualityAdjustedMedianPriceJpy).toBe(10000);
    expect(signal?.qualityAdjustmentReason).toBe("quality_flags_not_available");
    expect(signal?.availableCount).toBe(1);
    expect(signal?.failedCount).toBe(1);
    expect(signal?.soldOutCount).toBe(1);
    expect(signal?.notListedCount).toBe(1);
    expect(signal?.sampleSize).toBe(1);
    db.close();
  });

  it("uses only the latest snapshot per property/source/stay_date", () => {
    const db = openDb();
    seedBase(db);
    insertSnapshot(db, {
      id: "old",
      propertyId: "p1",
      stayDate: "2026-07-18",
      status: "available",
      price: 10000,
      runId: "run_market_old",
      checkedAt: "2026-05-29T01:00:00+09:00"
    });
    insertSnapshot(db, {
      id: "new",
      propertyId: "p1",
      stayDate: "2026-07-18",
      status: "available",
      price: 30000,
      runId: "run_market_new",
      checkedAt: "2026-05-29T02:00:00+09:00"
    });

    const [signal] = computeMarketSignalsFromSnapshots(db);

    expect(signal?.medianPriceJpy).toBe(30000);
    expect(signal?.sampleSize).toBe(1);
    db.close();
  });

  it("scores confidence A/B/C/insufficient", () => {
    expect(confidenceFor(5, 5)).toBe("A");
    expect(confidenceFor(3, 99)).toBe("B");
    expect(confidenceFor(1, 0)).toBe("C");
    expect(confidenceFor(0, 2)).toBe("insufficient");
  });

  it("retains suspicious low prices instead of filtering them", () => {
    const db = openDb();
    seedBase(db);
    insertSnapshot(db, { id: "low", propertyId: "p1", stayDate: "2026-07-18", status: "available", price: 3000 });
    insertSnapshot(db, { id: "high", propertyId: "p2", stayDate: "2026-07-18", status: "available", price: 25000 });

    const [signal] = computeMarketSignalsFromSnapshots(db);

    expect(signal?.minPriceJpy).toBe(3000);
    expect(signal?.medianPriceJpy).toBe(14000);
    expect(signal?.qualityAdjustedMedianPriceJpy).toBe(14000);
    db.close();
  });

  it("excludes high severity quality flags from adjusted metrics while raw metrics stay unchanged", () => {
    const db = openDb();
    seedBase(db);
    insertSnapshot(db, { id: "low", propertyId: "p1", stayDate: "2026-07-18", status: "available", price: 3000 });
    insertSnapshot(db, { id: "medium", propertyId: "p2", stayDate: "2026-07-18", status: "available", price: 7000 });
    insertSnapshot(db, { id: "clean", propertyId: "p3", stayDate: "2026-07-18", status: "available", price: 25000 });
    insertQuality(db, "low", "high");
    insertQuality(db, "medium", "medium");
    insertQuality(db, "clean", "none");

    const [signal] = computeMarketSignalsFromSnapshots(db);

    expect(signal?.medianPriceJpy).toBe(7000);
    expect(signal?.qualityAdjustedMedianPriceJpy).toBe(16000);
    expect(signal?.qualityAdjustedMinPriceJpy).toBe(7000);
    expect(signal?.qualityAdjustedMaxPriceJpy).toBe(25000);
    expect(signal?.sampleSize).toBe(3);
    expect(signal?.qualityAdjustedSampleSize).toBe(2);
    expect(signal?.excludedHighSeverityCount).toBe(1);
    expect(signal?.qualityAdjustmentReason).toBe("excluded_high_severity_quality_flags");
    db.close();
  });

  it("sets adjusted metrics to null when all available rows are high severity", () => {
    const db = openDb();
    seedBase(db);
    insertSnapshot(db, { id: "only", propertyId: "p1", stayDate: "2026-07-18", status: "available", price: 3000 });
    insertQuality(db, "only", "high");

    const [signal] = computeMarketSignalsFromSnapshots(db);

    expect(signal?.medianPriceJpy).toBe(3000);
    expect(signal?.qualityAdjustedMedianPriceJpy).toBeNull();
    expect(signal?.qualityAdjustedSampleSize).toBe(0);
    expect(signal?.qualityAdjustmentReason).toBe("all_available_rows_excluded_by_quality_flags");
    db.close();
  });

  it("keeps medium and low severity rows in adjusted metrics", () => {
    const db = openDb();
    seedBase(db);
    insertSnapshot(db, { id: "low_flag", propertyId: "p1", stayDate: "2026-07-18", status: "available", price: 5000 });
    insertSnapshot(db, { id: "medium_flag", propertyId: "p2", stayDate: "2026-07-18", status: "available", price: 10000 });
    insertQuality(db, "low_flag", "low");
    insertQuality(db, "medium_flag", "medium");

    const [signal] = computeMarketSignalsFromSnapshots(db);

    expect(signal?.medianPriceJpy).toBe(7500);
    expect(signal?.qualityAdjustedMedianPriceJpy).toBe(7500);
    expect(signal?.qualityAdjustmentReason).toBe("no_high_severity_quality_flags");
    db.close();
  });
});

function openDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedBase(db: LocalDatabase): void {
  db.prepare("INSERT INTO collector_runs (id, ota, started_at_jst, status) VALUES ('run_market', 'jalan', '2026-05-29T00:00:00+09:00', 'completed')").run();
  for (let index = 1; index <= 6; index += 1) {
    db.prepare(
      `INSERT INTO properties (
         id, name, postal_code, area_name, property_type, price_segment, meal_style, ski_access, active, created_at, updated_at
       )
       VALUES (?, ?, '990-2301', 'Zao Onsen', 'hotel', 'unknown', 'unknown', 'unknown', 1, '2026-05-29', '2026-05-29')`
    ).run(`p${index}`, `Property ${index}`);
  }
}

function insertSnapshot(
  db: LocalDatabase,
  input: {
    id: string;
    propertyId: string;
    stayDate: string;
    status: "available" | "failed" | "sold_out" | "not_listed";
    price: number | null;
    runId?: string;
    checkedAt?: string;
  }
): void {
  const runId = input.runId ?? "run_market";
  db.prepare("INSERT OR IGNORE INTO collector_runs (id, ota, started_at_jst, status) VALUES (?, 'jalan', '2026-05-29T00:00:00+09:00', 'completed')").run(runId);
  db.prepare(
    `INSERT INTO rate_snapshots (
       id, run_id, property_id, ota, stay_date, guests, nights, price_jpy,
       price_total_tax_included, availability_status, confidence, checked_at_jst,
       error_reason, created_at
     )
     VALUES (?, ?, ?, 'jalan', ?, 2, 1, ?, ?, ?, 'A', ?, ?, ?)`
  ).run(
    input.id,
    runId,
    input.propertyId,
    input.stayDate,
    input.price,
    input.price,
    input.status,
    input.checkedAt ?? "2026-05-29T01:00:00+09:00",
    input.status === "failed" ? "test_failure" : null,
    input.checkedAt ?? "2026-05-29T01:00:00+09:00"
  );
}

function insertQuality(db: LocalDatabase, rateSnapshotId: string, severity: "none" | "low" | "medium" | "high"): void {
  db.prepare(
    `INSERT INTO price_quality_flags (
       id, rate_snapshot_id, source, property_id, stay_date, price_jpy,
       flags_json, severity, reason, created_at
     )
     SELECT
       'pq_' || id,
       id,
       ota,
       property_id,
       stay_date,
       price_total_tax_included,
       ?,
       ?,
       ?,
       '2026-05-29'
     FROM rate_snapshots
     WHERE id = ?`
  ).run(JSON.stringify(severity === "none" ? ["none"] : ["test_flag"]), severity, severity, rateSnapshotId);
}
