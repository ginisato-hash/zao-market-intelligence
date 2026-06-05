import { describe, expect, it } from "vitest";
import {
  jalanThreePropertyBatchSchema,
  parseJalanThreePropertyBatchConfig
} from "../src/prototype/jalanThreePropertyBatchSchema";

function validConfig() {
  return {
    ota: "jalan" as const,
    properties: [
      { property_name: "ル・ベール蔵王", property_url: "https://www.jalan.net/yad328232/" },
      { property_name: "深山荘 高見屋", property_url: "https://www.jalan.net/yad321744/" },
      { property_name: "名湯リゾート ルーセントタカミヤ", property_url: "https://www.jalan.net/yad331969/" }
    ],
    stay_dates: ["2026-07-18", "2026-08-08", "2026-10-10"],
    adults: 2 as const,
    children: 0,
    rooms: 1 as const,
    nights: 1 as const,
    max_jobs: 9,
    delay_ms_between_jobs: 3000
  };
}

describe("jalanThreePropertyBatchSchema", () => {
  it("valid config passes", () => {
    expect(() => jalanThreePropertyBatchSchema.parse(validConfig())).not.toThrow();
  });

  it("parses valid config correctly", () => {
    const config = jalanThreePropertyBatchSchema.parse(validConfig());
    expect(config.ota).toBe("jalan");
    expect(config.properties).toHaveLength(3);
    expect(config.stay_dates).toHaveLength(3);
    expect(config.max_jobs).toBe(9);
    expect(config.delay_ms_between_jobs).toBe(3000);
  });

  it("placeholder property_name fails clearly", () => {
    const input = validConfig();
    input.properties[1] = {
      property_name: "MANUAL_PROPERTY_NAME_REQUIRED",
      property_url: "https://www.jalan.net/yad999999/"
    };
    expect(() => parseJalanThreePropertyBatchConfig(input)).toThrow(/placeholder/i);
  });

  it("placeholder property_url fails clearly", () => {
    const input = {
      ...validConfig(),
      properties: [
        validConfig().properties[0]!,
        { property_name: "Property B", property_url: "MANUAL_JALAN_PROPERTY_URL_REQUIRED" },
        validConfig().properties[2]!
      ]
    };
    expect(() => parseJalanThreePropertyBatchConfig(input)).toThrow(/placeholder/i);
  });

  it("duplicate property URLs rejected", () => {
    const input = validConfig();
    input.properties[2] = { ...input.properties[0]! };
    expect(() => jalanThreePropertyBatchSchema.parse(input)).toThrow();
  });

  it("duplicate stay dates rejected", () => {
    const input = { ...validConfig(), stay_dates: ["2026-07-18", "2026-07-18", "2026-10-10"] };
    expect(() => jalanThreePropertyBatchSchema.parse(input)).toThrow();
  });

  it("max_jobs > 9 rejected", () => {
    expect(() => jalanThreePropertyBatchSchema.parse({ ...validConfig(), max_jobs: 10 })).toThrow();
  });

  it("delay_ms_between_jobs < 3000 rejected", () => {
    expect(() => jalanThreePropertyBatchSchema.parse({ ...validConfig(), delay_ms_between_jobs: 2999 })).toThrow();
  });

  it("exactly 2 properties rejected", () => {
    const input = { ...validConfig(), properties: validConfig().properties.slice(0, 2) };
    expect(() => jalanThreePropertyBatchSchema.parse(input)).toThrow();
  });

  it("exactly 4 properties rejected", () => {
    const input = {
      ...validConfig(),
      properties: [
        ...validConfig().properties,
        { property_name: "Extra", property_url: "https://www.jalan.net/yad111111/" }
      ]
    };
    expect(() => jalanThreePropertyBatchSchema.parse(input)).toThrow();
  });

  it("property_url not matching jalan.net/yad pattern rejected", () => {
    const input = validConfig();
    input.properties[0] = { property_name: "Bad URL", property_url: "https://www.booking.com/hotel/jp/xyz.html" };
    expect(() => jalanThreePropertyBatchSchema.parse(input)).toThrow();
  });

  it("adults not 2 rejected", () => {
    expect(() => jalanThreePropertyBatchSchema.parse({ ...validConfig(), adults: 3 as never })).toThrow();
  });

  it("rooms not 1 rejected", () => {
    expect(() => jalanThreePropertyBatchSchema.parse({ ...validConfig(), rooms: 2 as never })).toThrow();
  });

  it("nights not 1 rejected", () => {
    expect(() => jalanThreePropertyBatchSchema.parse({ ...validConfig(), nights: 2 as never })).toThrow();
  });
});
