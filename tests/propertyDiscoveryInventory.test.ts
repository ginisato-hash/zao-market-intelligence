import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoD01XClassificationWords,
  buildDiscoverySummary,
  buildExistingUniverseBaseline,
  buildSourceFetchSummary,
  decidePropertyDiscoveryInventory,
  enforcePageLoadCap,
  extractBookingInventoryRows,
  extractJalanInventoryRows,
  extractOfficialTourismInventoryRows,
  extractRakutenInventoryRows,
  isBlockedOrUnavailableText,
  normalizeDetectedNamePreview,
  parseExistingUniverseCsvAsInventoryRows,
  renderPropertyDiscoveryInventoryCsv,
  renderPropertyDiscoveryInventoryReport,
  sourceStatusForLoadedPage,
  type PropertyDiscoveryInventoryRow
} from "../src/services/propertyDiscoveryInventory";

const base = {
  runId: "run_d01x_test",
  detectedAtJst: "2026-06-02T12:00:00",
  debugArtifactPath: ".data/debug/property-discovery/test"
};

describe("property discovery source extractors", () => {
  it("extracts official lodging names from fixture HTML", () => {
    const rows = extractOfficialTourismInventoryRows({
      ...base,
      sourceUrl: "https://zaomountainresort.com/stay/",
      html: `
        <a href="/stay/takamiya">深山荘 高見屋</a>
        <a href="/stay/jurin">JURIN</a>
        <a href="/access">アクセス</a>
      `
    });
    expect(rows.map((row) => row.detectedName)).toEqual(["深山荘 高見屋", "JURIN"]);
    expect(rows[0]).toMatchObject({
      sourceName: "zao_official_stay",
      sourceType: "official_tourism",
      sourceConfidence: "A"
    });
  });

  it("extracts Jalan listing names from fixture HTML", () => {
    const rows = extractJalanInventoryRows({
      ...base,
      sourceUrl: "https://jalan.example/search",
      html: `
        <a href="javascript:openYadoSyosai('5723','1_1_1')"></a>
        <h2 class="facilityName">蔵王温泉　蔵王国際ホテル</h2>
      `
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceName: "jalan_zao_onsen_search",
      detectedName: "蔵王温泉 蔵王国際ホテル",
      detectedUrl: "https://www.jalan.net/yad5723/",
      sourceConfidence: "B"
    });
  });

  it("extracts Rakuten listing names from fixture HTML", () => {
    const rows = extractRakutenInventoryRows({
      ...base,
      sourceUrl: "https://travel.rakuten.co.jp/onsen/yamagata/OK00161.html",
      html: `
        <div class="hotelBox"><h3><span>蔵王温泉</span><a href="//travel.rakuten.co.jp/HOTEL/5723/5723.html">蔵王温泉　蔵王国際ホテル</a></h3></div>
      `
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceName: "rakuten_zao_onsen_search",
      detectedName: "蔵王温泉 蔵王国際ホテル",
      detectedUrl: "https://travel.rakuten.co.jp/HOTEL/5723/"
    });
  });

  it("extracts Booking listing names from fixture HTML", () => {
    const rows = extractBookingInventoryRows({
      ...base,
      sourceUrl: "https://www.booking.com/searchresults.ja.html?ss=zao",
      html: `
        <a href="https://www.booking.com/hotel/jp/zao-kokusai.ja.html?aid=secret&sid=session">蔵王国際ホテル</a>
        <a href="/hotel/jp/zao-shiki-no.ja.html">蔵王四季のホテル</a>
      `
    });
    expect(rows.map((row) => row.detectedName)).toEqual(["蔵王国際ホテル", "蔵王四季のホテル"]);
    expect(rows[0]?.detectedUrl).not.toContain("aid=");
    expect(rows[0]?.detectedUrl).not.toContain("sid=");
  });
});

describe("local artifact baseline and raw inventory model", () => {
  const universeCsv = [
    "canonical_property_name,canonicalization_status,aliases,sources_present,jalan_url,jalan_id,rakuten_url,rakuten_id,local_source,evidence_note,needs_human_review,review_decision,reviewer_note",
    "蔵王国際ホテル,canonical,,jalan;rakuten,https://www.jalan.net/yad5723/,5723,https://travel.rakuten.co.jp/HOTEL/5723/,5723,,evidence,false,pending,",
    "三浦屋,canonical,,local_operator,,,,,local_operator,evidence,false,pending,"
  ].join("\n");

  it("parses existing universe CSV as a local artifact source", () => {
    const rows = parseExistingUniverseCsvAsInventoryRows({
      ...base,
      csv: universeCsv,
      sourceUrl: ".data/exports/zao-universe-review/zao_universe_properties_20260531_231933.csv"
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sourceName: "existing_universe_artifacts",
      sourceType: "local_artifact",
      detectedName: "蔵王国際ホテル",
      sourceConfidence: "A"
    });
  });

  it("builds existing universe baseline summary", () => {
    const baseline = buildExistingUniverseBaseline({
      propertiesCsv: universeCsv,
      sourceCandidatesCsv: "canonical_property_name,source\n蔵王国際ホテル,jalan\n蔵王国際ホテル,rakuten\n",
      aliasMapJson: JSON.stringify({ "蔵王国際ホテル": ["Zao Kokusai Hotel"] }),
      excludedAuditCsv: "source,property_name_raw\njalan,蔵王エコー山荘\n"
    });
    expect(baseline).toMatchObject({
      existingCanonicalCount: 2,
      existingSourceCandidateCount: 2,
      existingSourcesPresent: ["jalan", "rakuten"],
      existingAliasCount: 1,
      existingExcludedCount: 1
    });
  });

  it("normalizes detected name preview without fuzzy matching", () => {
    expect(normalizeDetectedNamePreview(" ＺＡＯ　ＢＡＳＥ &amp; Stay ")).toBe("zao base & stay");
  });

  it("marks CAPTCHA/block text as blocked and empty parse as parse_failed", () => {
    expect(isBlockedOrUnavailableText("Are you a robot? CAPTCHA")).toBe(true);
    expect(sourceStatusForLoadedPage("Are you a robot? CAPTCHA", 0)).toBe("blocked_or_unavailable");
    expect(sourceStatusForLoadedPage("<html>normal page</html>", 0)).toBe("parse_failed");
  });

  it("enforces the external page-load cap", () => {
    expect(() => enforcePageLoadCap(15, 15)).not.toThrow();
    expect(() => enforcePageLoadCap(16, 15)).toThrow(/page-load cap exceeded/u);
  });
});

describe("renderers, decision, and safety boundaries", () => {
  const row: PropertyDiscoveryInventoryRow = extractOfficialTourismInventoryRows({
    ...base,
    sourceUrl: "https://zaomountainresort.com/stay/",
    html: `<a href="/stay/kokusai">蔵王国際ホテル</a>`
  })[0]!;
  const baseline = buildExistingUniverseBaseline({
    propertiesCsv: "canonical_property_name\n蔵王国際ホテル\n",
    sourceCandidatesCsv: "canonical_property_name,source\n蔵王国際ホテル,jalan\n",
    aliasMapJson: "{}",
    excludedAuditCsv: "source,property_name_raw\n"
  });
  const summarySource = buildSourceFetchSummary({
    sourceName: "zao_official_stay",
    sourceType: "official_tourism",
    sourceUrl: "https://zaomountainresort.com/stay/",
    sourceStatus: "ok",
    httpStatus: 200,
    extractedRowCount: 1,
    pageLoadCount: 1,
    notes: "ok",
    debugArtifactPath: ".data/debug/property-discovery/test"
  });

  it("does not classify rows into D02X candidate categories", () => {
    expect(row).not.toHaveProperty("new_candidate");
    expect(row).not.toHaveProperty("alias_candidate");
    const csv = renderPropertyDiscoveryInventoryCsv([row]);
    expect(() => assertNoD01XClassificationWords(csv)).not.toThrow();
  });

  it("renders raw inventory CSV schema without upload/PMS columns", () => {
    const header = renderPropertyDiscoveryInventoryCsv([row]).split("\n")[0] ?? "";
    expect(header).toContain("detected_name");
    expect(header).toContain("source_confidence");
    for (const forbidden of ["roomid", "Beds24", "AirHost", "PMS", "price1", "inventory"]) {
      expect(header).not.toContain(forbidden);
    }
  });

  it("renders report with source status summary and safety confirmation", () => {
    const summary = buildDiscoverySummary({
      runId: base.runId,
      generatedAt: "2026-06-02T00:00:00.000Z",
      externalPageLoadCount: 1,
      maxExternalPageLoads: 15,
      existingUniverseBaseline: baseline,
      sourceFetchSummary: [summarySource],
      rows: [row],
      reportPath: ".data/reports/source-discovery/property_discovery_inventory_test.md",
      csvPath: ".data/reports/source-discovery/property_discovery_inventory_test.csv",
      jsonPath: ".data/reports/source-discovery/property_discovery_inventory_test.json",
      debugRootPath: ".data/debug/property-discovery/test"
    });
    const report = renderPropertyDiscoveryInventoryReport({ summary, rows: [row] });
    expect(report).toContain("source_status_summary");
    expect(report).toContain("No price collection");
    expect(report).toContain("No GitHub Actions activation");
    expect(() => assertNoD01XClassificationWords(report)).not.toThrow();
  });

  it("returns ready when at least two source groups produce rows and baseline loads", () => {
    const secondRow = { ...row, sourceName: "existing_universe_artifacts" as const, sourceType: "local_artifact" as const };
    expect(decidePropertyDiscoveryInventory({ rows: [row, secondRow], baseline, sourceSummaries: [summarySource] })).toBe(
      "property_discovery_inventory_ready"
    );
    expect(decidePropertyDiscoveryInventory({ rows: [row], baseline: { ...baseline, existingCanonicalCount: 0 }, sourceSummaries: [] })).toBe(
      "property_discovery_inventory_partial"
    );
    expect(decidePropertyDiscoveryInventory({ rows: [], baseline, sourceSummaries: [] })).toBe(
      "property_discovery_inventory_not_ready"
    );
  });

  it("script does not contain DB writes, promotion, or active-property creation", () => {
    const service = readFileSync(resolve("src/services/propertyDiscoveryInventory.ts"), "utf8");
    const script = readFileSync(resolve("src/scripts/runPropertyDiscoveryInventory.ts"), "utf8");
    for (const source of [service, script]) {
      expect(source).not.toMatch(/INSERT\s+INTO/iu);
      expect(source).not.toMatch(/UPDATE\s+properties/iu);
      expect(source).not.toMatch(/promoteSourceCoverageCandidates/iu);
    }
  });
});
