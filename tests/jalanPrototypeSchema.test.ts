import { describe, expect, it } from "vitest";
import { parseJalanPrototypeConfig } from "../src/prototype/jalanPrototypeSchema";

const validConfig = {
  ota: "jalan",
  property_name: "Manual Test Property",
  property_url: "https://www.jalan.net/yad123456/",
  stay_dates: ["2026-10-10"],
  adults: 2,
  children: 0,
  rooms: 1,
  nights: 1
};

describe("Jalan prototype config", () => {
  it("accepts a valid config", () => {
    expect(parseJalanPrototypeConfig(validConfig).ota).toBe("jalan");
  });

  it("fails clearly when placeholder values remain", () => {
    expect(() =>
      parseJalanPrototypeConfig({
        ...validConfig,
        property_name: "MANUAL_PROPERTY_NAME_REQUIRED"
      })
    ).toThrow("Jalan prototype config still contains placeholder values");
  });

  it("rejects invalid URL", () => {
    expect(() =>
      parseJalanPrototypeConfig({
        ...validConfig,
        property_url: "not-a-url"
      })
    ).toThrow();
  });

  it("rejects more than two stay dates", () => {
    expect(() =>
      parseJalanPrototypeConfig({
        ...validConfig,
        stay_dates: ["2026-10-10", "2026-10-11", "2026-10-12"]
      })
    ).toThrow();
  });
});
