// ZMI-MKT-OBS02 PART B4 — operational pair report contract.
//
// The report must never let a same-instant refetch be presented as a
// time-separated morning/afternoon pair, and must surface the honest negative
// categories (unavailable comparisons, identity mismatch, parse failures)
// alongside the successes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(resolve(__dirname, "../src/scripts/reportCoreCompetitorObservationPairs.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

describe("PART B4 — pair report honesty", () => {
  it("is wired as an npm script", () => {
    expect(PACKAGE_JSON).toContain('"market-observation:pair-report"');
    expect(PACKAGE_JSON).toContain("reportCoreCompetitorObservationPairs.ts");
  });

  it("always states the REAL observed gap and flags a same-instant refetch", () => {
    expect(SCRIPT).toContain("real_observed_gap_minutes");
    expect(SCRIPT).toContain("is_same_instant_refetch");
    // Derived from the actual observed_at values in the store, never assumed.
    expect(SCRIPT).toMatch(/Date\.parse\(r\.observedAtJst\)/u);
  });

  it("never hardcodes a 12h assumption", () => {
    expect(SCRIPT).not.toMatch(/12\s*\*\s*60\s*\*\s*60/u);
    expect(SCRIPT).not.toContain("720");
  });

  it("refuses to report when there are not two distinct collector runs", () => {
    expect(SCRIPT).toContain("core_competitor_pair_report_insufficient_runs");
    expect(SCRIPT).toMatch(/a === ""\s*\|\|\s*b === ""\s*\|\|\s*a === b/u);
  });

  it("reports every required per-competitor column, including the negatives", () => {
    for (const column of [
      "morning_obs",
      "afternoon_obs",
      "comparable_pairs",
      "price_up",
      "price_down",
      "depletion",
      "expansion",
      "sell_out",
      "reopen",
      "unavailable_cmp",
      "identity_mismatch",
      "parse_failures"
    ]) {
      expect(SCRIPT, `missing column ${column}`).toContain(column);
    }
  });

  it("excludes non-comparable pairs from the comparable count rather than silently pairing them", () => {
    expect(SCRIPT).toContain("checkPairComparable");
    expect(SCRIPT).toMatch(/identityMismatch\s*\+=\s*1;\s*continue;/u);
    expect(SCRIPT).toMatch(/pairs\.length - identityMismatch/u);
  });

  it("counts one-sided products (seen in only one run) instead of hiding them", () => {
    expect(SCRIPT).toContain("one-sided");
    expect(SCRIPT).toMatch(/keysA\b[\s\S]{0,200}keysB\b/u);
  });

  it("covers both sources for all three CORE competitors", () => {
    expect(SCRIPT).toContain("CORE_COMPETITORS");
    expect(SCRIPT).toMatch(/\["booking",\s*"jalan"\]/u);
  });

  it("is read-only: never writes, appends, commits, or pushes", () => {
    for (const forbidden of ["writeFileSync", "appendMarketObservations", "spawnSync", '"push"', '"commit"']) {
      expect(SCRIPT, `report must not ${forbidden}`).not.toContain(forbidden);
    }
  });
});
