import { describe, expect, it } from "vitest";
import { assessJalanPriceQuality } from "../src/services/priceQuality";

describe("priceQuality", () => {
  it("flags absolute low and high prices", () => {
    expect(assessJalanPriceQuality({ priceJpy: 5000 }).flags).toContain("too_low_absolute");
    expect(assessJalanPriceQuality({ priceJpy: 151000 }).flags).toContain("too_high_absolute");
  });

  it("flags market-relative low and high prices when sample size is enough", () => {
    expect(
      assessJalanPriceQuality({ priceJpy: 4000, marketMedianJpy: 10000, marketSampleSize: 3 }).flags
    ).toContain("too_low_vs_market");
    expect(
      assessJalanPriceQuality({ priceJpy: 26000, marketMedianJpy: 10000, marketSampleSize: 3 }).flags
    ).toContain("too_high_vs_market");
  });

  it("does not apply market-relative flags with fewer than three samples", () => {
    expect(assessJalanPriceQuality({ priceJpy: 4000, marketMedianJpy: 10000, marketSampleSize: 2 }).flags).not.toContain(
      "too_low_vs_market"
    );
  });

  it("flags single sample low confidence", () => {
    expect(assessJalanPriceQuality({ priceJpy: 12000, marketMedianJpy: 12000, marketSampleSize: 1 }).flags).toContain(
      "single_sample_low_confidence"
    );
  });
});
