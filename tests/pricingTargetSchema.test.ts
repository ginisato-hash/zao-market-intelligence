import { describe, expect, it } from "vitest";
import { parsePricingTargetSeed } from "../src/config/pricingTargetSchema";

describe("pricingTargetSchema", () => {
  it("validates a pricing target", () => {
    expect(parsePricingTargetSeed([validTarget()])).toHaveLength(1);
  });

  it("rejects invalid source market and rounding unit", () => {
    expect(() => parsePricingTargetSeed([{ ...validTarget(), source_market: "rakuten" }])).toThrow();
    expect(() => parsePricingTargetSeed([{ ...validTarget(), rounding_unit_jpy: 250 }])).toThrow();
  });

  it("rejects max price below min price", () => {
    expect(() => parsePricingTargetSeed([{ ...validTarget(), min_price_jpy: 20000, max_price_jpy: 10000 }])).toThrow();
  });
});

function validTarget() {
  return {
    target_id: "sample",
    property_name: "Sample",
    postal_code: "990-2301",
    source_market: "jalan",
    baseline_adr_jpy: 12000,
    min_price_jpy: 8000,
    max_price_jpy: 35000,
    rounding_unit_jpy: 500,
    strategy: "follow_quality_adjusted_market",
    active: true
  };
}
