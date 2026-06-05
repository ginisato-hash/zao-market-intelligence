import { describe, expect, it } from "vitest";
import { parseRakutenPrototypeConfig } from "../src/prototype/rakutenPrototypeSchema";

const validConfig = {
  ota: "rakuten",
  property_name: "Manual Rakuten Property",
  property_url: "https://travel.rakuten.co.jp/HOTEL/12345/",
  stay_dates: ["2026-08-08"],
  adults: 2,
  children: 0,
  rooms: 1,
  nights: 1
};

describe("Rakuten prototype config", () => {
  it("accepts a valid config", () => {
    expect(parseRakutenPrototypeConfig(validConfig).ota).toBe("rakuten");
  });

  it("fails clearly when placeholder URL remains", () => {
    expect(() =>
      parseRakutenPrototypeConfig({
        ...validConfig,
        property_url: "MANUAL_RAKUTEN_PROPERTY_URL_REQUIRED"
      })
    ).toThrow("Rakuten prototype config still contains placeholder values");
  });

  it("rejects non-Rakuten URL", () => {
    expect(() =>
      parseRakutenPrototypeConfig({
        ...validConfig,
        property_url: "https://example.com/HOTEL/12345/"
      })
    ).toThrow();
  });

  it("rejects invalid HOTEL URL", () => {
    expect(() =>
      parseRakutenPrototypeConfig({
        ...validConfig,
        property_url: "https://travel.rakuten.co.jp/hotel/not-number/"
      })
    ).toThrow();
  });

  it("rejects more than two dates", () => {
    expect(() =>
      parseRakutenPrototypeConfig({
        ...validConfig,
        stay_dates: ["2026-08-08", "2026-08-09", "2026-08-10"]
      })
    ).toThrow();
  });
});
