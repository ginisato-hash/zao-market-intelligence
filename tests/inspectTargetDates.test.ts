import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import { importGeneratedTargetDates } from "../src/scripts/generateTargetDateSeed";
import { formatTargetDatesInspection, inspectTargetDates } from "../src/scripts/inspectTargetDates";
import { generateTargetDates } from "../src/services/generateTargetDates";

describe("inspectTargetDates", () => {
  it("prints counts by priority", () => {
    const db = new Database(":memory:") as LocalDatabase;
    executeMigration(db);
    importGeneratedTargetDates(
      db,
      generateTargetDates({
        from: "2026-07-18",
        to: "2026-07-21",
        today: "2026-05-29",
        holidays: [{ date: "2026-07-20", name: "海の日" }]
      })
    );

    const output = formatTargetDatesInspection(inspectTargetDates(db));

    expect(output).toContain("total_target_dates=4");
    expect(output).toContain("count_by_priority=");
    expect(output).toContain("sample_s_dates:");
    db.close();
  });
});
