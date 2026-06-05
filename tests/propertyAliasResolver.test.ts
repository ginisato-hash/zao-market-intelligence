import { describe, expect, it } from "vitest";
import {
  findPossibleDuplicateProperties,
  normalizePropertyName,
  resolveCanonicalPropertyName,
  resolveCanonicalPropertyNameDetailed,
  type PropertyAlias
} from "../src/services/propertyAliasResolver";

describe("propertyAliasResolver", () => {
  it("normalizes spaces and punctuation", () => {
    expect(normalizePropertyName(" 深山荘　高見屋 −MIYAMASO TAKAMIYA− ")).toBe(
      normalizePropertyName("深山荘高見屋 MIYAMASO TAKAMIYA")
    );
  });

  it("maps an alias to its canonical name", () => {
    expect(resolveCanonicalPropertyName("蔵王温泉 名湯リゾート ルーセントタカミヤ", aliases())).toBe(
      "名湯リゾート ルーセント"
    );
  });

  it("leaves unknown names unchanged", () => {
    expect(resolveCanonicalPropertyName("未確認の宿", aliases())).toBe("未確認の宿");
  });

  it("marks needs_review alias matches as ambiguous", () => {
    const resolution = resolveCanonicalPropertyNameDetailed("共通名", [
      {
        canonical_property_name: "宿 A",
        aliases: ["共通名"],
        status: "needs_review"
      }
    ]);

    expect(resolution.status).toBe("ambiguous");
  });

  it("separates alias-resolved and unresolved duplicate candidates", () => {
    const duplicates = findPossibleDuplicateProperties([
      "深山荘 高見屋",
      "深山荘 高見屋 −MIYAMASO TAKAMIYA−",
      "蔵王温泉ホテル A",
      "蔵王温泉ホテル A 別館"
    ], aliases());

    expect(duplicates.find((candidate) => candidate.names.includes("深山荘 高見屋"))?.status).toBe("alias_resolved");
    expect(duplicates.find((candidate) => candidate.names.includes("蔵王温泉ホテル A"))?.status).toBe("unresolved");
  });
});

function aliases(): PropertyAlias[] {
  return [
    {
      canonical_property_name: "名湯リゾート ルーセント",
      aliases: ["蔵王温泉 名湯リゾート ルーセントタカミヤ"],
      status: "confirmed"
    },
    {
      canonical_property_name: "深山荘 高見屋",
      aliases: ["深山荘 高見屋 −MIYAMASO TAKAMIYA−", "深山荘高見屋"],
      status: "confirmed"
    }
  ];
}
