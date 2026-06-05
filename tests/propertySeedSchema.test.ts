import { describe, expect, it } from "vitest";
import { propertyOtaLinkSeedRecordSchema, propertySeedRecordSchema } from "../src/seeds/propertySeedSchema";

const validPropertySeed = {
  property_name: "テスト宿",
  postal_code: "990-2301",
  property_type: "ryokan",
  price_segment: "unknown",
  meal_style: "unknown",
  has_onsen: null,
  ski_access: "unknown",
  active: true,
  notes: "Test seed"
};

describe("property seed validation", () => {
  it("accepts a valid property seed", () => {
    expect(propertySeedRecordSchema.parse(validPropertySeed).property_name).toBe("テスト宿");
  });

  it("rejects an invalid postal code", () => {
    expect(() =>
      propertySeedRecordSchema.parse({
        ...validPropertySeed,
        postal_code: "000-0000"
      })
    ).toThrow();
  });

  it("rejects an invalid enum value", () => {
    expect(() =>
      propertySeedRecordSchema.parse({
        ...validPropertySeed,
        property_type: "capsule"
      })
    ).toThrow();
  });

  it("allows OTA link seed records with null URL", () => {
    const parsed = propertyOtaLinkSeedRecordSchema.parse({
      property_name: "テスト宿",
      ota: "jalan",
      ota_property_id: null,
      property_url: null,
      active: false,
      last_verified_at: null,
      notes: "URL unknown"
    });

    expect(parsed.property_url).toBeNull();
  });
});
