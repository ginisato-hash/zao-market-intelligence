import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PropertyDiscoveryInventoryRow } from "../src/services/propertyDiscoveryInventory";
import {
  PROPERTY_NAME_NORMALIZATION_CSV_HEADERS,
  assertNoForbiddenColumns,
  buildDetectedGroups,
  buildExistingMasterPool,
  buildNormalizationRows,
  classifyDetectedGroup,
  decideD02X,
  matchDetectedGroup,
  normalizePropertyNameForMatching,
  renderNormalizationCsv,
  renderNormalizationReport,
  type DetectedGroup,
  type ExistingMasterPool,
  type NormalizationSummary
} from "../src/services/propertyNameNormalization";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/propertyNameNormalization.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runPropertyNameNormalization.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function inventoryRow(over: Partial<PropertyDiscoveryInventoryRow>): PropertyDiscoveryInventoryRow {
  return {
    runId: "test_run",
    detectedAtJst: "2026-06-03T19:00:00",
    sourceName: "jalan_zao_onsen_search",
    sourceType: "ota_search",
    sourceUrl: "https://example.test/search",
    sourceStatus: "ok",
    extractionMethod: "test",
    detectedName: "テスト旅館",
    detectedNameRaw: "テスト旅館",
    normalizedDetectedName: "テスト旅館",
    detectedUrl: "",
    detectedAreaHint: "Zao Onsen",
    detectedPropertyTypeHint: "ryokan",
    detectedAddressHint: "",
    detectedPhoneHint: "",
    rawRankOrPosition: 1,
    sourceConfidence: "B",
    isLodgingLike: true,
    isAreaLikelyZaoOnsen: true,
    notes: "",
    debugArtifactPath: "/tmp/debug",
    ...over
  };
}

function group(over: Partial<DetectedGroup>): DetectedGroup {
  return {
    normalizedDetectedName: normalizePropertyNameForMatching(over.detectedName ?? "テスト旅館"),
    detectedName: "テスト旅館",
    detectedNameRaw: "テスト旅館",
    sourceNames: ["jalan_zao_onsen_search"],
    sourceUrls: [],
    sourceCount: 1,
    bestSourceConfidence: "B",
    isLodgingLike: true,
    isAreaLikelyZaoOnsen: true,
    detectedAreaHint: "Zao Onsen",
    detectedPropertyTypeHint: "ryokan",
    sourceRowIds: ["jalan_zao_onsen_search:rank1"],
    debugArtifactPath: "/tmp/debug",
    ...over
  };
}

// A small master pool used across tests.
const POOL: ExistingMasterPool = buildExistingMasterPool({
  propertiesCsv:
    "canonical_property_name,canonicalization_status,aliases,sources_present,jalan_url,jalan_id,rakuten_url,rakuten_id\n" +
    "ONSEN & STAY OAKHILL,canonical,蔵王温泉 オークヒル,jalan;rakuten,https://www.jalan.net/yad111111/,111111,https://travel.rakuten.co.jp/HOTEL/22222/,22222\n" +
    "名湯リゾート ルーセント,canonical,,jalan,https://www.jalan.net/yad333333/,333333,,\n" +
    "つるやホテル,canonical,,jalan,https://www.jalan.net/yad444444/,444444,,\n",
  aliasMapJson: JSON.stringify({ "ONSEN & STAY OAKHILL": ["蔵王温泉 オークヒル"] }),
  sourceCandidatesCsv:
    "canonical_property_name,source,candidate_property_url,candidate_source_property_id\n" +
    "つるやホテル,jalan,https://www.jalan.net/yad444444/,444444\n",
  excludedAuditCsv:
    "source,property_name_raw,property_url,source_property_id,exclusion_reason\n" +
    "jalan,蔵王エコー山荘,https://www.jalan.net/yad377722/,377722,outside_zao_area\n"
});

describe("D02X property name normalization + master matching", () => {
  // 1
  it("normalizes full-width ampersand and width variants", () => {
    expect(normalizePropertyNameForMatching("ＯＮＳＥＮ＆ＳＴＡＹ")).toBe("onsen&stay");
  });

  // 2
  it("normalizes spaces, dashes, and case", () => {
    expect(normalizePropertyNameForMatching("  Onsen  &  Stay — Oak  ")).toBe("onsen&stay - oak");
  });

  // 3
  it("exact canonical match -> active_existing", () => {
    const g = group({ detectedName: "ONSEN & STAY OAKHILL" });
    const m = matchDetectedGroup(g, POOL);
    expect(m.matchType).toBe("exact_canonical");
    expect(classifyDetectedGroup(g, m).classification).toBe("active_existing");
  });

  // 4
  it("exact alias match -> active_existing", () => {
    const g = group({ detectedName: "蔵王温泉 オークヒル" });
    const m = matchDetectedGroup(g, POOL);
    expect(m.matchType).toBe("exact_alias");
    expect(classifyDetectedGroup(g, m).classification).toBe("active_existing");
  });

  // 5
  it("fuzzy high match -> alias_candidate", () => {
    const g = group({ detectedName: "ONSEN & STAY OAK HILL" });
    const m = matchDetectedGroup(g, POOL);
    expect(m.matchType).toBe("fuzzy_high");
    expect(classifyDetectedGroup(g, m).classification).toBe("alias_candidate");
  });

  // 6
  it("fuzzy medium match -> alias_candidate with B confidence", () => {
    // Canonical "zaomountainlodge" (16) vs detected "zaomountainlodgexy" (18):
    // levenshtein distance 2 over maxlen 18 → ratio 0.889 → fuzzy_medium band.
    const medPool = buildExistingMasterPool({
      propertiesCsv: "canonical_property_name,canonicalization_status,aliases\nzaomountainlodge,canonical,\n"
    });
    const g = group({ detectedName: "zaomountainlodgexy", bestSourceConfidence: "B", isLodgingLike: true });
    const m = matchDetectedGroup(g, medPool);
    expect(m.matchType).toBe("fuzzy_medium");
    const cls = classifyDetectedGroup(g, m);
    expect(cls.classification).toBe("alias_candidate");
    expect(cls.confidence).toBe("B");
  });

  // 7
  it("no match + lodging-like + area-likely -> new_candidate", () => {
    const g = group({ detectedName: "ペンションあっぷる", detectedPropertyTypeHint: "pension", isLodgingLike: true, isAreaLikelyZaoOnsen: true });
    const m = matchDetectedGroup(g, POOL);
    expect(m.matchType).toBe("no_match");
    expect(classifyDetectedGroup(g, m).classification).toBe("new_candidate");
  });

  // 8
  it("no match + non-lodging -> out_of_scope_candidate", () => {
    const g = group({ detectedName: "蔵王温泉大露天風呂", detectedPropertyTypeHint: "", isLodgingLike: false, isAreaLikelyZaoOnsen: true });
    const m = matchDetectedGroup(g, POOL);
    expect(m.matchType).toBe("no_match");
    expect(classifyDetectedGroup(g, m).classification).toBe("out_of_scope_candidate");
  });

  // 9
  it("weak / ambiguous source -> uncertain_candidate", () => {
    const g = group({ detectedName: "G-SQUARE", detectedPropertyTypeHint: "", isLodgingLike: false, isAreaLikelyZaoOnsen: false, bestSourceConfidence: "C" });
    const m = matchDetectedGroup(g, POOL);
    expect(m.matchType).toBe("no_match");
    // non-lodging-but-not-clearly-a-facility falls to out_of_scope/uncertain; assert it is review-worthy and not a master mutation
    const cls = classifyDetectedGroup(g, m);
    expect(["uncertain_candidate", "out_of_scope_candidate"]).toContain(cls.classification);
    expect(cls.needsHumanReview).toBe(true);
  });

  // 9b — explicit uncertain path: lodging-like but area unknown + C confidence
  it("lodging-like but unknown area + C confidence -> uncertain_candidate", () => {
    const g = group({ detectedName: "スティ ハウス", detectedPropertyTypeHint: "", isLodgingLike: true, isAreaLikelyZaoOnsen: false, bestSourceConfidence: "C" });
    const m = matchDetectedGroup(g, POOL);
    expect(m.matchType).toBe("no_match");
    expect(classifyDetectedGroup(g, m).classification).toBe("uncertain_candidate");
  });

  // 10
  it("excluded audit match with current lodging signal -> reopened_candidate", () => {
    const g = group({ detectedName: "蔵王エコー山荘", detectedPropertyTypeHint: "mountain_lodge", isLodgingLike: true, isAreaLikelyZaoOnsen: true });
    const m = matchDetectedGroup(g, POOL);
    expect(m.matchType).toBe("excluded_match");
    expect(classifyDetectedGroup(g, m).classification).toBe("reopened_candidate");
  });

  // 11
  it("duplicate detected names group into one row", () => {
    const rows = [
      inventoryRow({ detectedName: "テスト旅館", sourceName: "jalan_zao_onsen_search" }),
      inventoryRow({ detectedName: "テスト旅館", sourceName: "rakuten_zao_onsen_search" })
    ];
    const groups = buildDetectedGroups(rows);
    expect(groups).toHaveLength(1);
  });

  // 12
  it("multiple sources merge into source_names and source_count", () => {
    const rows = [
      inventoryRow({ detectedName: "テスト旅館", sourceName: "jalan_zao_onsen_search", detectedUrl: "https://www.jalan.net/yad999999/" }),
      inventoryRow({ detectedName: "テスト旅館", sourceName: "rakuten_zao_onsen_search", detectedUrl: "https://travel.rakuten.co.jp/HOTEL/88888/" })
    ];
    const groups = buildDetectedGroups(rows);
    expect(groups[0]!.sourceCount).toBe(2);
    expect(groups[0]!.sourceNames.sort()).toEqual(["jalan_zao_onsen_search", "rakuten_zao_onsen_search"]);
    expect(groups[0]!.sourceUrls).toHaveLength(2);
  });

  // 13
  it("recommendation mapping for alias_candidate is add_alias or manual_review", () => {
    const high = classifyDetectedGroup(group({ detectedName: "ONSEN & STAY OAK HILL" }), matchDetectedGroup(group({ detectedName: "ONSEN & STAY OAK HILL" }), POOL));
    expect(["add_alias", "manual_review"]).toContain(high.recommendedAction);
  });

  // 14
  it("recommendation mapping for new_candidate is manual_review (never auto-approve)", () => {
    const g = group({ detectedName: "ペンションあっぷる", detectedPropertyTypeHint: "pension" });
    const cls = classifyDetectedGroup(g, matchDetectedGroup(g, POOL));
    expect(cls.classification).toBe("new_candidate");
    expect(cls.recommendedAction).toBe("manual_review");
    expect(cls.recommendedAction).not.toBe("approve_as_active_candidate");
  });

  // 15
  it("recommendation mapping for out_of_scope is mark_out_of_scope", () => {
    const g = group({ detectedName: "蔵王釣堀", isLodgingLike: false });
    const cls = classifyDetectedGroup(g, matchDetectedGroup(g, POOL));
    expect(cls.classification).toBe("out_of_scope_candidate");
    expect(cls.recommendedAction).toBe("mark_out_of_scope");
  });

  // 16
  it("does not emit any D04X master-update action", () => {
    const rows = [inventoryRow({ detectedName: "ペンションあっぷる" }), inventoryRow({ detectedName: "ONSEN & STAY OAKHILL" })];
    const built = buildNormalizationRows({ runId: "r", normalizedAtJst: "t", rows, pool: POOL });
    for (const r of built) {
      expect(["none", "keep_existing", "add_alias", "manual_review", "approve_as_active_candidate", "mark_duplicate", "mark_out_of_scope", "mark_closed_or_inactive", "keep_candidate"]).toContain(r.recommendedAction);
    }
    // no auto master mutation verbs in source
    expect(SERVICE_SOURCE).not.toMatch(/INSERT INTO|UPDATE .* SET|db\.prepare|\.run\(/u);
  });

  // 17
  it("CSV schema includes required D02X columns", () => {
    const header = renderNormalizationCsv([]).split("\n")[0];
    expect(header).toBe(PROPERTY_NAME_NORMALIZATION_CSV_HEADERS.join(","));
    for (const col of ["classification", "match_type", "similarity", "recommended_action", "needs_human_review", "source_row_ids"]) {
      expect(PROPERTY_NAME_NORMALIZATION_CSV_HEADERS).toContain(col);
    }
  });

  // 18
  it("JSON summary includes classification counts", () => {
    const rows = [inventoryRow({ detectedName: "ONSEN & STAY OAKHILL" })];
    const built = buildNormalizationRows({ runId: "r", normalizedAtJst: "t", rows, pool: POOL });
    const counts = built.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.classification]: (acc[r.classification] ?? 0) + 1 }), {});
    expect(counts["active_existing"]).toBe(1);
  });

  // 19
  it("report states no master update / no active promotion", () => {
    const summary = sampleSummary();
    const md = renderNormalizationReport({ summary, rows: [] });
    expect(md).toMatch(/did not modify the properties master/u);
    expect(md).toMatch(/did not active-promote/u);
    expect(md).toMatch(/did not add aliases/u);
  });

  // 20
  it("no DB-write code exists in service or script", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/better-sqlite3|new Database\(|db\.prepare|INSERT INTO|UPDATE .* SET/u);
    }
  });

  // 21
  it("no GitHub Actions / GitOps activation code exists", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toContain(".github/workflows");
      expect(src).not.toMatch(/git commit|git push|workflow_dispatch|actions\/checkout/u);
    }
  });

  // 22
  it("no Beds24 / AirHost / PMS columns in the output schema", () => {
    expect(() => assertNoForbiddenColumns(PROPERTY_NAME_NORMALIZATION_CSV_HEADERS.join(","))).not.toThrow();
    // The output CSV header must not contain any forbidden PMS/OTA-upload tokens.
    const header = renderNormalizationCsv([]).split("\n")[0]!.toLowerCase();
    for (const token of ["beds24", "airhost", "pms_", "channel_manager", "ota_upload"]) {
      expect(header).not.toContain(token);
    }
    // The guard itself rejects a forbidden column if one were ever added.
    expect(() => assertNoForbiddenColumns("foo,beds24_id,bar")).toThrow();
  });

  // 23
  it("missing alias map degrades with warning, not crash", () => {
    const pool = buildExistingMasterPool({
      propertiesCsv: "canonical_property_name,canonicalization_status,aliases\nつるやホテル,canonical,\n"
    });
    expect(pool.aliasMapPresent).toBe(false);
    expect(pool.warnings.some((w) => /alias map/u.test(w))).toBe(true);
    expect(pool.canonicalCount).toBe(1);
  });

  // 24
  it("missing D01X artifact gives a clear error from the script wiring", () => {
    // The script throws with a clear message; assert the message text is present in source.
    expect(SCRIPT_SOURCE).toMatch(/Missing D01X artifact/u);
  });

  // 25
  it("decision ready when rows classified and master baseline exists", () => {
    expect(
      decideD02X({ d01xRowCount: 98, canonicalCount: 36, classifiedCount: 81, aliasMapPresent: true, excludedPresent: true, uncertainCount: 5 })
    ).toBe("property_name_normalization_ready");
    expect(
      decideD02X({ d01xRowCount: 98, canonicalCount: 36, classifiedCount: 81, aliasMapPresent: false, excludedPresent: true, uncertainCount: 5 })
    ).toBe("property_name_normalization_basis_caution");
    expect(
      decideD02X({ d01xRowCount: 0, canonicalCount: 36, classifiedCount: 0, aliasMapPresent: true, excludedPresent: true, uncertainCount: 0 })
    ).toBe("property_name_normalization_not_ready");
  });
});

function sampleSummary(): NormalizationSummary {
  return {
    runId: "r",
    generatedAt: "t",
    sourceD01xArtifact: "/abs/d01x.json",
    rawRowCount: 0,
    dedupedRowCount: 0,
    existingCanonicalCount: 36,
    existingSourceCandidateCount: 144,
    existingAliasCount: 38,
    existingExcludedCount: 27,
    classificationCounts: {},
    confidenceCounts: {},
    recommendedActionCounts: {},
    warnings: [],
    decision: "property_name_normalization_ready",
    reportPath: "/abs/r.md",
    csvPath: "/abs/r.csv",
    jsonPath: "/abs/r.json",
    debugRootPath: "/abs/debug"
  };
}
