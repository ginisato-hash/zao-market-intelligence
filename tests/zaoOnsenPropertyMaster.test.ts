import { describe, expect, it } from "vitest";
import {
  ZAO_ONSEN_EXPANDED_PROPERTY_MASTER,
  findMasterEntry,
  summarizePropertyMaster
} from "../src/services/zaoOnsenPropertyMaster";
import { discoveryCandidatesFromMaster } from "../src/services/sourceMappingDiscovery";

describe("AUTO-RUNNER16X-F - Zao Onsen expanded property master", () => {
  it("has at least 34 properties", () => {
    expect(ZAO_ONSEN_EXPANDED_PROPERTY_MASTER.length).toBeGreaterThanOrEqual(34);
  });

  it("contains the required expansion properties", () => {
    for (const name of [
      "三浦屋",
      "ロッジまつぽっくり",
      "ロッジイザワ",
      "ペンションぷうたろう",
      "蔵王センタープラザ",
      "ホテル松金屋アネックス",
      "蔵王アストリアホテル"
    ]) {
      expect(findMasterEntry(name), name).toBeDefined();
    }
  });

  it("resolves entries by alias (normalized)", () => {
    expect(findMasterEntry("Miuraya")?.canonical_property_name).toBe("三浦屋");
    expect(findMasterEntry("Matsupokkuri")?.canonical_property_name).toBe("ロッジまつぽっくり");
    expect(findMasterEntry("ロッヂ スガノ")?.canonical_property_name).toBe("ロッジスガノ");
    expect(findMasterEntry("KKR蔵王白銀荘")?.canonical_property_name).toBe("ＫＫＲ蔵王 白銀荘");
    expect(findMasterEntry("nonexistent property xyz")).toBeUndefined();
  });

  it("every entry only declares known sources and a valid tier", () => {
    const sources = new Set(["booking", "jalan", "rakuten", "google_hotels"]);
    const tiers = new Set(["tier_anchor_high", "tier_direct_mid", "tier_budget_small", "tier_monitor_only"]);
    for (const e of ZAO_ONSEN_EXPANDED_PROPERTY_MASTER) {
      expect(e.expected_sources.every((s) => sources.has(s)), e.canonical_property_name).toBe(true);
      expect(tiers.has(e.tier), e.canonical_property_name).toBe(true);
      expect(e.canonical_property_name.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate canonical names", () => {
    expect(summarizePropertyMaster().duplicate_canonical_names).toEqual([]);
  });

  it("derives booking/jalan discovery candidates from the master", () => {
    const candidates = discoveryCandidatesFromMaster(ZAO_ONSEN_EXPANDED_PROPERTY_MASTER);
    // every candidate targets only booking/jalan
    expect(candidates.every((c) => c.target_sources.every((s) => s === "booking" || s === "jalan"))).toBe(true);
    // 三浦屋 expects booking+jalan
    const miuraya = candidates.find((c) => c.canonical_property_name === "三浦屋");
    expect(miuraya?.target_sources.sort()).toEqual(["booking", "jalan"]);
    // 松尾ハウス master excludes jalan (booking+rakuten+google) -> only booking remains
    const matsuo = candidates.find((c) => c.canonical_property_name === "松尾ハウス");
    expect(matsuo?.target_sources).toEqual(["booking"]);
    // ホテル喜らく master excludes booking (jalan+rakuten+google) -> only jalan remains
    const kiraku = candidates.find((c) => c.canonical_property_name === "ホテル喜らく");
    expect(kiraku?.target_sources).toEqual(["jalan"]);
  });
});
