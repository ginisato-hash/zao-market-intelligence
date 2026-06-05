import { describe, expect, it } from "vitest";
import { jalanVerifiedPropertySeedFileSchema } from "../src/seeds/jalanVerifiedPropertySeedSchema";

describe("Jalan verified property seed schema", () => {
  it("accepts a valid seed", () => {
    const parsed = jalanVerifiedPropertySeedFileSchema.parse([validSeed()]);

    expect(parsed[0]?.verification_status).toBe("confirmed");
  });

  it("rejects invalid Jalan URL", () => {
    expect(() =>
      jalanVerifiedPropertySeedFileSchema.parse([
        {
          ...validSeed(),
          property_url: "https://example.com/yad328232/"
        }
      ])
    ).toThrow();
  });

  it("rejects confirmed seed without verified_at", () => {
    const { verified_at: _verifiedAt, ...seed } = validSeed();

    expect(() => jalanVerifiedPropertySeedFileSchema.parse([seed])).toThrow("verified_at is required");
  });
});

function validSeed() {
  return {
    property_name: "ル・ベール蔵王",
    property_url: "https://www.jalan.net/yad328232/",
    verification_status: "confirmed",
    verification_method: "targeted_web",
    verified_at: "2026-05-28",
    notes: "test"
  };
}
