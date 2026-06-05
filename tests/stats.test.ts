import { describe, expect, it } from "vitest";
import { medianPriceExcludingConfidenceC } from "../src/utils/stats";

describe("medianPriceExcludingConfidenceC", () => {
  it("excludes confidence C samples from median calculation", () => {
    expect(
      medianPriceExcludingConfidenceC([
        { priceJpy: 10000, confidence: "B" },
        { priceJpy: 999999, confidence: "C" },
        { priceJpy: 20000, confidence: "A" }
      ])
    ).toBe(15000);
  });

  it("returns null when no usable prices remain", () => {
    expect(
      medianPriceExcludingConfidenceC([
        { priceJpy: 999999, confidence: "C" },
        { priceJpy: null, confidence: "B" }
      ])
    ).toBeNull();
  });
});
