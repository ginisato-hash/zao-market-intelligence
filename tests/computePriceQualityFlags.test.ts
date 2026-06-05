import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { computeAndPersistPriceQualityFlags } from "../src/scripts/computePriceQualityFlags";

describe("computePriceQualityFlags", () => {
  it("flags known low examples and leaves raw rate snapshots unchanged", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    seedFixture(db);

    const before = countRateSnapshots(db);
    const summary = computeAndPersistPriceQualityFlags(db, { createdAt: "2026-05-29T00:00:00.000Z" });
    const after = countRateSnapshots(db);

    expect(summary.assessedCount).toBe(3);
    expect(summary.flaggedCount).toBe(2);
    expect(summary.countByFlag.too_low_absolute).toBe(2);
    expect(after).toBe(before);
    expect((db.prepare("SELECT COUNT(*) AS count FROM price_quality_flags").get() as { count: number }).count).toBe(3);
    db.close();
  });
});

function countRateSnapshots(db: LocalDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM rate_snapshots").get() as { count: number }).count;
}

function seedFixture(db: LocalDatabase): void {
  db.prepare("INSERT INTO collector_runs (id, ota, started_at_jst, status) VALUES ('run_quality', 'jalan', '2026-05-29T00:00:00+09:00', 'completed')").run();
  db.prepare(
    `INSERT INTO market_daily_signals (
       id, stay_date, source, postal_code, median_price_jpy, min_price_jpy, max_price_jpy,
       available_count, sold_out_count, not_listed_count, failed_count, sample_size,
       confidence, generated_at, created_at, updated_at
     )
     VALUES ('mds1', '2026-07-18', 'jalan', '990-2301', 10000, 3000, 25000, 3, 0, 0, 0, 3, 'B', '2026-05-29', '2026-05-29', '2026-05-29')`
  ).run();
  for (const [id, name, type] of [
    ["p1", "吉田屋", "ryokan"],
    ["p2", "HAMMOND", "hotel"],
    ["p3", "Normal", "hotel"]
  ]) {
    db.prepare(
      `INSERT INTO properties (
         id, name, postal_code, area_name, property_type, price_segment, meal_style, ski_access, active, created_at, updated_at
       )
       VALUES (?, ?, '990-2301', 'Zao Onsen', ?, 'unknown', 'unknown', 'unknown', 1, '2026-05-29', '2026-05-29')`
    ).run(id, name, type);
  }
  for (const [id, propertyId, price] of [
    ["rs1", "p1", 3000],
    ["rs2", "p2", 4000],
    ["rs3", "p3", 10000]
  ]) {
    db.prepare(
      `INSERT INTO rate_snapshots (
         id, run_id, property_id, ota, stay_date, guests, nights, price_jpy,
         price_total_tax_included, availability_status, confidence, checked_at_jst, created_at
       )
       VALUES (?, 'run_quality', ?, 'jalan', '2026-07-18', 2, 1, ?, ?, 'available', 'A', '2026-05-29T01:00:00+09:00', '2026-05-29')`
    ).run(id, propertyId, price, price);
  }
}
