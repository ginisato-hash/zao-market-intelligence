import { describe, expect, it } from "vitest";
import { parseJalanMultiDatePrototypeConfig } from "../src/prototype/jalanPrototypeSchema";

describe("Jalan multi-date prototype schema", () => {
  it("validates up to five dates", () => {
    const config = parseJalanMultiDatePrototypeConfig(validConfig());

    expect(config.stay_dates).toHaveLength(5);
    expect(config.delay_ms_between_attempts).toBe(3000);
  });

  it("rejects duplicate dates", () => {
    expect(() =>
      parseJalanMultiDatePrototypeConfig({
        ...validConfig(),
        stay_dates: ["2026-08-08", "2026-08-08"]
      })
    ).toThrow();
  });

  it("rejects more than five dates", () => {
    expect(() =>
      parseJalanMultiDatePrototypeConfig({
        ...validConfig(),
        stay_dates: ["2026-07-18", "2026-08-08", "2026-08-15", "2026-10-10", "2026-12-12", "2026-12-19"]
      })
    ).toThrow();
  });

  it("rejects delay under 2000 ms", () => {
    expect(() =>
      parseJalanMultiDatePrototypeConfig({
        ...validConfig(),
        delay_ms_between_attempts: 1000
      })
    ).toThrow();
  });
});

function validConfig() {
  return {
    ota: "jalan",
    property_name: "ル・ベール蔵王",
    property_url: "https://www.jalan.net/yad328232/",
    stay_dates: ["2026-07-18", "2026-08-08", "2026-08-15", "2026-10-10", "2026-12-12"],
    adults: 2,
    children: 0,
    rooms: 1,
    nights: 1,
    max_attempts: 5,
    delay_ms_between_attempts: 3000
  };
}
