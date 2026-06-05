import { describe, expect, it } from "vitest";
import { normalizePriceJpy } from "../src/utils/price";

describe("normalizePriceJpy", () => {
  it("normalizes yen strings and numeric values", () => {
    expect(normalizePriceJpy("¥22,000")).toBe(22000);
    expect(normalizePriceJpy("JPY 12,345")).toBe(12345);
    expect(normalizePriceJpy(19999.6)).toBe(20000);
  });

  it("returns null for missing or invalid prices", () => {
    expect(normalizePriceJpy(null)).toBeNull();
    expect(normalizePriceJpy("sold out")).toBeNull();
    expect(normalizePriceJpy(-1)).toBeNull();
  });
});
