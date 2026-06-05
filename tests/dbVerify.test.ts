import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { verifyLocalDb } from "../src/db/verify";

describe("verifyLocalDb", () => {
  it("catches invalid failed price rows and missing error reasons when constraints are bypassed", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);

    db.pragma("ignore_check_constraints = ON");
    db.prepare("INSERT INTO properties (id, name, postal_code, area_name) VALUES ('property_test', 'Test', '990-2301', 'Zao Onsen')").run();
    db.prepare(
      `INSERT INTO collector_runs (id, ota, started_at_jst, status)
       VALUES ('run_invalid', 'mock', '2026-01-01T09:00:00+09:00', 'failed')`
    ).run();
    db.prepare(
      `INSERT INTO rate_snapshots (
        id,
        run_id,
        property_id,
        ota,
        stay_date,
        guests,
        nights,
        price_jpy,
        price_total_tax_included,
        availability_status,
        confidence,
        checked_at_jst
      )
      VALUES (
        'rate_invalid',
        'run_invalid',
        'property_test',
        'mock',
        '2026-02-01',
        2,
        1,
        12345,
        12345,
        'failed',
        'C',
        '2026-01-01T09:00:00+09:00'
      )`
    ).run();

    const result = verifyLocalDb(db);

    expect(result.invalidUnavailablePriceCount).toBe(1);
    expect(result.failedRowsMissingErrorReasonCount).toBe(1);
    expect(result.errors).toHaveLength(2);

    db.close();
  });
});
