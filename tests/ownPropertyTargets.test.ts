import { describe, expect, it } from "vitest";
import {
  OWN_PROPERTY_TARGETS,
  excludeOwnPropertiesFromCompetitorMarket,
  getOwnPropertyKey,
  includeOwnPropertiesForOwnPriceTracking,
  isOwnPropertyName,
  normalizeOwnPropertyName
} from "../src/services/ownPropertyTargets";

describe("PRICING-CRITICAL01 - own property name matching (§12.2)", () => {
  it("has exactly 2 own properties, both critical", () => {
    expect(OWN_PROPERTY_TARGETS).toHaveLength(2);
    expect(OWN_PROPERTY_TARGETS.every((p) => p.priority_level === "critical")).toBe(true);
    expect(OWN_PROPERTY_TARGETS.map((p) => p.canonical_property_key).sort()).toEqual(["kiraku", "miuraya"]);
  });

  const MIURAYA_VARIANTS = ["三浦屋", "Miuraya", "MIURAYA", "Guesthouse Miuraya", "ゲストハウス三浦屋"];
  for (const v of MIURAYA_VARIANTS) {
    it(`"${v}" -> miuraya`, () => {
      expect(getOwnPropertyKey(v)).toBe("miuraya");
      expect(isOwnPropertyName(v)).toBe(true);
      expect(normalizeOwnPropertyName(v)).toBe("三浦屋");
    });
  }

  const KIRAKU_VARIANTS = [
    "喜らく", "きらく", "旅館きらく", "ホテル喜らく",
    "ZAO SPA HOTEL Kiraku", "Zao Spa Hotel Kiraku", "ZAO SPA HOTEL KIRAKU", "Kiraku", "KIRAKU", "Zao Spa Hotel"
  ];
  for (const v of KIRAKU_VARIANTS) {
    it(`"${v}" -> kiraku`, () => {
      expect(getOwnPropertyKey(v)).toBe("kiraku");
      expect(isOwnPropertyName(v)).toBe(true);
      expect(normalizeOwnPropertyName(v)).toBe("ホテル喜らく");
    });
  }

  it("unrelated / competitor names do not match", () => {
    expect(isOwnPropertyName("HAMMOND")).toBe(false);
    expect(isOwnPropertyName("蔵王国際ホテル")).toBe(false);
    expect(getOwnPropertyKey("")).toBeNull();
  });
});

describe("PRICING-CRITICAL01 - responsibility split (§6.2)", () => {
  const rows = [
    { canonical_property_name: "三浦屋" },
    { canonical_property_name: "ホテル喜らく" },
    { canonical_property_name: "HAMMOND" },
    { canonical_property_name: "蔵王国際ホテル" }
  ];

  it("excludeOwnPropertiesFromCompetitorMarket keeps only non-own rows", () => {
    const out = excludeOwnPropertiesFromCompetitorMarket(rows);
    expect(out.map((r) => r.canonical_property_name).sort()).toEqual(["HAMMOND", "蔵王国際ホテル"]);
  });

  it("includeOwnPropertiesForOwnPriceTracking keeps only own rows", () => {
    const out = includeOwnPropertiesForOwnPriceTracking(rows);
    expect(out.map((r) => r.canonical_property_name).sort()).toEqual(["ホテル喜らく", "三浦屋"]);
  });

  it("the two views are disjoint and cover all rows", () => {
    const excl = excludeOwnPropertiesFromCompetitorMarket(rows);
    const incl = includeOwnPropertiesForOwnPriceTracking(rows);
    expect(excl.length + incl.length).toBe(rows.length);
  });
});
