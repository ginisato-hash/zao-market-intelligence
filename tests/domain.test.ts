import { describe, expect, it } from "vitest";
import { CONFIDENCE_DESCRIPTIONS } from "../src/domain/constants";
import { assertAvailabilityStatus, isAvailabilityStatus } from "../src/services/marketSignal";

describe("domain rules", () => {
  it("validates supported availability statuses", () => {
    expect(isAvailabilityStatus("available")).toBe(true);
    expect(isAvailabilityStatus("sold_out")).toBe(true);
    expect(isAvailabilityStatus("failed")).toBe(true);
    expect(isAvailabilityStatus("unknown")).toBe(false);
  });

  it("throws for invalid availability status values", () => {
    expect(() => assertAvailabilityStatus("unknown")).toThrow("Invalid availability_status");
  });

  it("documents confidence C as unsuitable for later median calculations", () => {
    expect(CONFIDENCE_DESCRIPTIONS.C).toContain("Unavailable");
  });
});
