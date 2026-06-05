import { describe, expect, it } from "vitest";
import { MockCollector } from "../src/collectors/mockCollector";

const input = {
  runId: "run_test",
  propertyId: "property_test",
  propertyName: "Test Property",
  ota: "mock" as const,
  stayDate: "2026-02-01",
  guests: 2,
  nights: 1
};

describe("MockCollector", () => {
  it("returns an available result with a price", async () => {
    const results = await new MockCollector().collect(input);
    const available = results.find((result) => result.rateSnapshot.availabilityStatus === "available");

    expect(available?.rateSnapshot.priceJpy).toBe(22000);
    expect(available?.rateSnapshot.confidence).toBe("B");
  });

  it("returns a sold_out result without a price", async () => {
    const results = await new MockCollector().collect(input);
    const soldOut = results.find((result) => result.rateSnapshot.availabilityStatus === "sold_out");

    expect(soldOut?.rateSnapshot.priceJpy).toBeNull();
    expect(soldOut?.inventorySnapshot.availabilityStatus).toBe("sold_out");
  });

  it("returns a failed result without converting it into a price", async () => {
    const results = await new MockCollector().collect(input);
    const failed = results.find((result) => result.rateSnapshot.availabilityStatus === "failed");

    expect(failed?.rateSnapshot.priceJpy).toBeNull();
    expect(failed?.rateSnapshot.confidence).toBe("C");
    expect(failed?.rateSnapshot.rawTextExcerpt).toContain("failed");
  });
});
