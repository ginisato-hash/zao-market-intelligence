import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRakutenPrototypeDryRun } from "../src/scripts/runRakutenPrototype";

describe("Rakuten prototype dry-run", () => {
  it("validates config, builds attempt URLs, and does not write DB", () => {
    const configPath = join(mkdtempSync(join(tmpdir(), "rakuten-prototype-")), "rakuten.prototype.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ota: "rakuten",
        property_name: "Manual Rakuten Property",
        property_url: "https://travel.rakuten.co.jp/HOTEL/12345/",
        stay_dates: ["2026-08-08"],
        adults: 2,
        children: 0,
        rooms: 1,
        nights: 1
      }),
      "utf8"
    );

    const summary = runRakutenPrototypeDryRun(configPath);

    expect(summary.dryRun).toBe(true);
    expect(summary.ota).toBe("rakuten");
    expect(summary.attemptUrls[0]).toContain("travel.rakuten.co.jp/HOTEL/12345/");
    expect(summary.attemptUrls[0]).toContain("f_checkin_date=2026%2F08%2F08");
  });
});
