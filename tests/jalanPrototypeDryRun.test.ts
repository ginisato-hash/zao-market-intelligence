import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runJalanPrototypeDryRun } from "../src/scripts/runJalanPrototype";

describe("runJalanPrototypeDryRun", () => {
  it("validates config and does not write database rows or screenshots", () => {
    const configPath = join(mkdtempSync(join(tmpdir(), "jalan-prototype-")), "jalan.prototype.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ota: "jalan",
        property_name: "Manual Test Property",
        property_url: "https://www.jalan.net/yad123456/",
        stay_dates: ["2026-10-10"],
        adults: 2,
        children: 0,
        rooms: 1,
        nights: 1
      }),
      "utf8"
    );

    const summary = runJalanPrototypeDryRun(configPath);

    expect(summary.dryRun).toBe(true);
    expect(summary.propertyName).toBe("Manual Test Property");
    expect(summary.attemptedDates).toEqual(["2026-10-10"]);
  });
});
