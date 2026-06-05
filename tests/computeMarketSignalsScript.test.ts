import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { computeAndUpsertMarketSignals, formatMarketComputeSummary } from "../src/scripts/computeMarketSignals";

describe("computeMarketSignals script helpers", () => {
  it("computes and upserts from a fixture database", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    seedFixture(db);

    const summary = computeAndUpsertMarketSignals(db, { generatedAt: "2026-05-29T00:00:00.000Z" });
    const output = formatMarketComputeSummary(summary);

    expect(summary.processedDatesCount).toBe(1);
    expect(summary.insertedOrUpdatedCount).toBe(1);
    expect(output).toContain("processed_dates_count=1");
    expect(output).toContain("adjusted_median=20000");
    expect((db.prepare("SELECT COUNT(*) AS count FROM market_daily_signals").get() as { count: number }).count).toBe(1);
    db.close();
  });
});

function seedFixture(db: LocalDatabase): void {
  db.prepare("INSERT INTO collector_runs (id, ota, started_at_jst, status) VALUES ('run_script', 'jalan', '2026-05-29T00:00:00+09:00', 'completed')").run();
  db.prepare(
    `INSERT INTO properties (
       id, name, postal_code, area_name, property_type, price_segment, meal_style, ski_access, active, created_at, updated_at
     )
     VALUES ('p1', 'Property 1', '990-2301', 'Zao Onsen', 'hotel', 'unknown', 'unknown', 'unknown', 1, '2026-05-29', '2026-05-29')`
  ).run();
  db.prepare(
    `INSERT INTO rate_snapshots (
       id, run_id, property_id, ota, stay_date, guests, nights, price_jpy,
       price_total_tax_included, availability_status, confidence, checked_at_jst, created_at
     )
     VALUES ('rs1', 'run_script', 'p1', 'jalan', '2026-07-18', 2, 1, 20000, 20000, 'available', 'A', '2026-05-29T01:00:00+09:00', '2026-05-29')`
  ).run();
}
