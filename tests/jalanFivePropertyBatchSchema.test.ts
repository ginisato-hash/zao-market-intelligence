import { describe, expect, it } from "vitest";
import { parseJalanFivePropertyBatchConfig } from "../src/prototype/jalanFivePropertyBatchSchema";

describe("jalanFivePropertyBatchSchema", () => {
  it("accepts a valid 5-property batch config", () => {
    expect(parseJalanFivePropertyBatchConfig(validConfig()).properties).toHaveLength(5);
  });

  it("rejects duplicate property URLs", () => {
    const config = validConfig();
    config.properties[1] = { property_name: "Property B", property_url: config.properties[0]?.property_url ?? "" };
    expect(() => parseJalanFivePropertyBatchConfig(config)).toThrow("property URLs must be unique");
  });

  it("rejects duplicate dates", () => {
    const config = validConfig();
    config.stay_dates = ["2026-07-18", "2026-07-18", "2026-10-10"];
    expect(() => parseJalanFivePropertyBatchConfig(config)).toThrow("stay_dates must not contain duplicates");
  });

  it("rejects max_jobs above 15", () => {
    expect(() => parseJalanFivePropertyBatchConfig({ ...validConfig(), max_jobs: 16 })).toThrow();
  });

  it("rejects delay below 3000", () => {
    expect(() => parseJalanFivePropertyBatchConfig({ ...validConfig(), delay_ms_between_jobs: 2999 })).toThrow();
  });
});

function validConfig() {
  return {
    ota: "jalan",
    properties: [
      { property_name: "Property A", property_url: "https://www.jalan.net/yad100001/" },
      { property_name: "Property B", property_url: "https://www.jalan.net/yad100002/" },
      { property_name: "Property C", property_url: "https://www.jalan.net/yad100003/" },
      { property_name: "Property D", property_url: "https://www.jalan.net/yad100004/" },
      { property_name: "Property E", property_url: "https://www.jalan.net/yad100005/" }
    ],
    stay_dates: ["2026-07-18", "2026-08-08", "2026-10-10"],
    adults: 2,
    children: 0,
    rooms: 1,
    nights: 1,
    max_jobs: 15,
    delay_ms_between_jobs: 3000
  };
}
