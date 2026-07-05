import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APPEND_PLAN_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runBookingMarketRecrawlAppendPlan.ts"), "utf8");
const PRICING_CRITICAL_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runPricingCriticalRecrawl.ts"), "utf8");

describe("implausible Booking price is excluded from append candidates (competitor path)", () => {
  it("imports and calls the shared plausibility guard", () => {
    expect(APPEND_PLAN_SOURCE).toContain('from "../services/pricePlausibilityGuard"');
    expect(APPEND_PLAN_SOURCE).toContain("validatePrimaryPriceNumeric");
  });

  it("filters implausible rows BEFORE the duplicate/conflict dedup check", () => {
    const guardIdx = APPEND_PLAN_SOURCE.indexOf("plausibility.data_quality_suspect");
    const dedupIdx = APPEND_PLAN_SOURCE.indexOf("duplicate_conflict");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(dedupIdx);
  });

  it("reports an implausible_price_excluded count and sample rows in the plan summary", () => {
    expect(APPEND_PLAN_SOURCE).toContain("implausible_price_excluded: implausiblePrice");
    expect(APPEND_PLAN_SOURCE).toContain("implausible_price_samples");
  });

  it("never adds an implausible row to toAppend", () => {
    // The implausible branch must `continue` before reaching `toAppend.push(hRow)`.
    const guardIdx = APPEND_PLAN_SOURCE.indexOf("if (priced && plausibility.data_quality_suspect)");
    const pushIdx = APPEND_PLAN_SOURCE.indexOf("toAppend.push", guardIdx);
    const continueIdx = APPEND_PLAN_SOURCE.indexOf("continue;", guardIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(continueIdx).toBeGreaterThan(guardIdx);
    // The guard's own continue must fire strictly before any toAppend.push call
    // that appears later in the loop (the legitimate new-row path).
    expect(continueIdx).toBeLessThan(pushIdx);
  });
});

describe("implausible Booking price is excluded from append candidates (own-property path)", () => {
  it("imports and calls the shared plausibility guard", () => {
    expect(PRICING_CRITICAL_SOURCE).toContain('from "../services/pricePlausibilityGuard"');
    expect(PRICING_CRITICAL_SOURCE).toContain("validatePrimaryPriceNumeric");
  });

  it("reports an own_implausible_price_excluded diagnostic", () => {
    expect(PRICING_CRITICAL_SOURCE).toContain("own_implausible_price_excluded");
    expect(PRICING_CRITICAL_SOURCE).toContain("implausiblePrice");
  });
});
