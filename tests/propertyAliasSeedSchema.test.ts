import { describe, expect, it } from "vitest";
import { propertyAliasSeedFileSchema } from "../src/seeds/propertyAliasSeedSchema";

describe("propertyAliasSeedSchema", () => {
  it("accepts a valid alias seed", () => {
    const parsed = propertyAliasSeedFileSchema.parse([
      aliasRecord("蔵王温泉 名湯リゾート ルーセントタカミヤ", ["名湯リゾート ルーセント"])
    ]);

    expect(parsed).toHaveLength(1);
  });

  it("rejects duplicate canonical names", () => {
    expect(() =>
      propertyAliasSeedFileSchema.parse([
        aliasRecord("深山荘 高見屋", ["Miyamaso Takamiya"]),
        aliasRecord("深山荘高見屋", ["別名"])
      ])
    ).toThrow("canonical_property_name must not be duplicated");
  });

  it("rejects aliases under multiple confirmed canonical names", () => {
    expect(() =>
      propertyAliasSeedFileSchema.parse([
        aliasRecord("宿 A", ["共通名"]),
        aliasRecord("宿 B", ["共通名"])
      ])
    ).toThrow("alias must not appear under multiple canonical names");
  });

  it("allows a shared alias when one record needs review", () => {
    const parsed = propertyAliasSeedFileSchema.parse([
      aliasRecord("宿 A", ["共通名"]),
      aliasRecord("宿 B", ["共通名"], "needs_review")
    ]);

    expect(parsed).toHaveLength(2);
  });
});

function aliasRecord(
  canonical: string,
  aliases: string[],
  status: "confirmed" | "needs_review" | "rejected" = "confirmed"
) {
  return {
    canonical_property_name: canonical,
    aliases,
    status
  };
}
