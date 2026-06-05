import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { generateTargetDates } from "../src/services/generateTargetDates";
import { importGeneratedTargetDates } from "../src/scripts/generateTargetDateSeed";

describe("generateTargetDateSeed", () => {
  it("imports generated target dates idempotently", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    const generated = generateTargetDates({
      from: "2026-07-18",
      to: "2026-07-20",
      today: "2026-05-29",
      holidays: [{ date: "2026-07-20", name: "海の日" }]
    });

    const first = importGeneratedTargetDates(db, generated);
    const second = importGeneratedTargetDates(db, generated);

    expect(first.insertedCount).toBe(3);
    expect(first.updatedCount).toBe(0);
    expect(first.unchangedCount).toBe(0);
    expect(second.insertedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.unchangedCount).toBe(3);
    expect((db.prepare("SELECT COUNT(*) AS count FROM target_dates").get() as { count: number }).count).toBe(3);
    db.close();
  });
});
