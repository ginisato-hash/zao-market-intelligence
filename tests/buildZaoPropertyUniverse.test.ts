import { describe, expect, it } from "vitest";
import {
  buildZaoPropertyUniverse,
  type BuildUniverseResult
} from "../src/services/buildZaoPropertyUniverse";
import type { ExtractedSourceListing } from "../src/services/extractZaoSourceListings";
import type { PropertyAlias } from "../src/services/propertyAliasResolver";

function listing(
  source: "jalan" | "rakuten",
  propertyNameRaw: string,
  sourcePropertyId: string
): ExtractedSourceListing {
  return {
    source,
    sourceListUrl: `https://${source}.example/list`,
    propertyNameRaw,
    propertyNameNormalized: propertyNameRaw,
    propertyUrl:
      source === "jalan"
        ? `https://www.jalan.net/yad${sourcePropertyId}/`
        : `https://travel.rakuten.co.jp/HOTEL/${sourcePropertyId}/`,
    sourcePropertyId,
    extractionStatus: "extracted",
    evidenceNote: `fixture ${source} listing`
  };
}

const aliases: PropertyAlias[] = [
  {
    canonical_property_name: "深山荘 高見屋",
    aliases: ["深山荘高見屋", "深山荘 高見屋 −MIYAMASO TAKAMIYA−"],
    status: "confirmed",
    notes: "test alias"
  },
  {
    canonical_property_name: "名湯リゾート ルーセント",
    aliases: ["蔵王温泉 名湯リゾート ルーセントタカミヤ", "ルーセント"],
    status: "confirmed",
    notes: "test alias"
  }
];

function build(): BuildUniverseResult {
  return buildZaoPropertyUniverse(
    [
      listing("jalan", "深山荘 高見屋 −MIYAMASO TAKAMIYA−", "321744"),
      listing("rakuten", "深山荘 高見屋", "38534"),
      listing("jalan", "蔵王温泉 名湯リゾート ルーセントタカミヤ", "331969"),
      listing("rakuten", "名湯リゾート ルーセント", "12345"),
      listing("jalan", "property_mock_zao_001", "999999"),
      listing("jalan", "山形駅前ホテル", "111111")
    ],
    aliases,
    ["深山荘 高見屋", "名湯リゾート ルーセント"]
  );
}

describe("buildZaoPropertyUniverse", () => {
  it("dedupes confirmed alias variants into canonical properties", () => {
    const result = build();
    expect(result.errors).not.toEqual(expect.arrayContaining([expect.stringContaining("duplicate")]));
    expect(result.universe.map((r) => r.canonical_property_name).sort()).toEqual([
      "名湯リゾート ルーセント",
      "深山荘 高見屋"
    ]);
    const takamiya = result.universe.find((r) => r.canonical_property_name === "深山荘 高見屋");
    expect(takamiya?.sources_present.sort()).toEqual(["jalan", "rakuten"]);
    expect(takamiya?.canonicalization_status).toBe("canonical");
  });

  it("excludes mock/test rows and off-market keyword noise", () => {
    const result = build();
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property_name_raw: "property_mock_zao_001", reason: "mock_or_test" }),
        expect.objectContaining({ property_name_raw: "山形駅前ホテル", reason: "station_area_noise" })
      ])
    );
    expect(result.universe.map((r) => r.canonical_property_name)).not.toContain("property_mock_zao_001");
  });

  it("includes local/operator extensions without marking them as OTA-confirmed", () => {
    const result = buildZaoPropertyUniverse([], aliases, [], [
      {
        property_name: "三浦屋",
        source: "local_operator",
        canonicalization_status: "canonical",
        evidence_note: "User-operated property."
      },
      {
        property_name: "シバママのお宿",
        source: "local_known",
        canonicalization_status: "needs_review",
        evidence_note: "Known local lodging candidate."
      },
      {
        property_name: "松尾ハウス",
        source: "local_known",
        canonicalization_status: "needs_review",
        evidence_note: "Known local lodging candidate."
      }
    ]);

    expect(result.universe).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonical_property_name: "三浦屋",
          sources_present: ["local_operator"],
          jalan: null,
          rakuten: null,
          canonicalization_status: "canonical"
        }),
        expect.objectContaining({
          canonical_property_name: "シバママのお宿",
          sources_present: ["local_known"],
          canonicalization_status: "needs_review"
        }),
        expect.objectContaining({
          canonical_property_name: "松尾ハウス",
          sources_present: ["local_known"],
          canonicalization_status: "needs_review"
        })
      ])
    );
  });

  it("forces 善七乃湯/oohira HOTEL variants into one canonical property", () => {
    const result = buildZaoPropertyUniverse(
      [
        listing("jalan", "善七乃湯・oohira HOTEL", "111111"),
        listing("rakuten", "最上高湯 善七乃湯（旧：蔵王温泉 大平ホテル）", "22222")
      ],
      aliases,
      []
    );

    expect(result.errors).not.toEqual(
      expect.arrayContaining([expect.stringContaining("善七乃湯 variants leaked")])
    );
    expect(result.universe.map((r) => r.canonical_property_name)).toEqual(["最上高湯 善七乃湯"]);
    expect(result.universe[0]).toMatchObject({
      aliases: expect.arrayContaining([
        "善七乃湯・oohira HOTEL",
        "最上高湯 善七乃湯（旧：蔵王温泉 大平ホテル）"
      ])
    });
  });

  it("excludes 蔵王エコー山荘 and 蔵王ライザウッディロッジ as geographic boundary leakage", () => {
    const result = buildZaoPropertyUniverse(
      [
        listing("jalan", "蔵王エコー山荘", "377722"),
        listing("jalan", "蔵王ライザウッディロッジ", "324339"),
        listing("jalan", "YuiLocalZao", "346260")
      ],
      aliases,
      []
    );

    expect(result.universe.map((row) => row.canonical_property_name)).not.toContain("蔵王エコー山荘");
    expect(result.universe.map((row) => row.canonical_property_name)).not.toContain("蔵王ライザウッディロッジ");
    expect(result.excludedAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          propertyNameRaw: "蔵王エコー山荘",
          exclusionReason: "outside_zao_area",
          evidenceNote: expect.stringContaining("Kaminoyama / Zao Bodaira / Sarakura")
        }),
        expect.objectContaining({
          propertyNameRaw: "蔵王ライザウッディロッジ",
          exclusionReason: "outside_zao_area"
        })
      ])
    );
  });

  it("retains YuiLocalZao, ZAO BASE, and ユニテ蔵王ジョーニダ・リゾート as accepted canonical properties", () => {
    const result = buildZaoPropertyUniverse(
      [
        listing("jalan", "YuiLocalZao", "346260"),
        listing("jalan", "ZAO BASE", "365550"),
        listing("jalan", "ユニテ蔵王ジョーニダ・リゾート", "354840")
      ],
      aliases,
      []
    );

    expect(result.universe).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonical_property_name: "YuiLocalZao", canonicalization_status: "canonical" }),
        expect.objectContaining({ canonical_property_name: "ZAO BASE", canonicalization_status: "canonical" }),
        expect.objectContaining({
          canonical_property_name: "ユニテ蔵王ジョーニダ・リゾート",
          canonicalization_status: "canonical"
        })
      ])
    );
  });

  it("reports anchor checks and excluded audit evidence", () => {
    const result = build();
    expect(result.anchorChecks.find((a) => a.anchor === "深山荘 高見屋")).toMatchObject({
      present: true,
      canonical_property_name: "深山荘 高見屋"
    });
    expect(result.excludedAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          propertyNameRaw: "property_mock_zao_001",
          exclusionReason: "mock_or_test",
          evidenceNote: expect.stringContaining("mock/test")
        }),
        expect.objectContaining({
          propertyNameRaw: "山形駅前ホテル",
          sourcePropertyId: "111111",
          evidenceNote: expect.stringContaining("outside Zao Onsen")
        })
      ])
    );
  });
});
