import { describe, expect, it } from "vitest";
import { MIN_PLAUSIBLE_BOOKING_PRICE_JPY, validatePrimaryPriceNumeric } from "../src/services/pricePlausibilityGuard";

describe("pricePlausibilityGuard", () => {
  it("flags a booking price of 100 (HAMMOND DOM-extraction defect) as implausible", () => {
    const r = validatePrimaryPriceNumeric({ source: "booking", propertyName: "HAMMOND", price: 100 });
    expect(r.usable).toBe(false);
    expect(r.data_quality_suspect).toBe(true);
    expect(r.reason).toBe("implausible_booking_price_under_1000");
  });

  it("flags a booking price of 999 as implausible (just under threshold)", () => {
    const r = validatePrimaryPriceNumeric({ source: "booking", propertyName: "HAMMOND", price: 999 });
    expect(r.usable).toBe(false);
    expect(r.data_quality_suspect).toBe(true);
  });

  it("accepts a booking price of exactly 1000 (threshold is inclusive)", () => {
    const r = validatePrimaryPriceNumeric({ source: "booking", propertyName: "HAMMOND", price: MIN_PLAUSIBLE_BOOKING_PRICE_JPY });
    expect(r.usable).toBe(true);
    expect(r.data_quality_suspect).toBe(false);
    expect(r.reason).toBe("plausible");
  });

  it("accepts a real HAMMOND price of 14245", () => {
    const r = validatePrimaryPriceNumeric({ source: "booking", propertyName: "HAMMOND", price: 14245 });
    expect(r.usable).toBe(true);
    expect(r.data_quality_suspect).toBe(false);
  });

  it("accepts a real own-property (Miuraya) price of 14470", () => {
    const r = validatePrimaryPriceNumeric({ source: "booking", propertyName: "三浦屋", price: 14470 });
    expect(r.usable).toBe(true);
    expect(r.data_quality_suspect).toBe(false);
  });

  it("treats null/undefined price as unusable but not a data-quality defect", () => {
    expect(validatePrimaryPriceNumeric({ source: "booking", propertyName: "HAMMOND", price: null }).usable).toBe(false);
    expect(validatePrimaryPriceNumeric({ source: "booking", propertyName: "HAMMOND", price: null }).data_quality_suspect).toBe(false);
    expect(validatePrimaryPriceNumeric({ source: "booking", propertyName: "HAMMOND", price: undefined }).usable).toBe(false);
  });

  it("does not apply the booking-specific threshold to other sources", () => {
    const r = validatePrimaryPriceNumeric({ source: "jalan", propertyName: "HAMMOND", price: 100 });
    expect(r.usable).toBe(true);
    expect(r.data_quality_suspect).toBe(false);
  });
});
