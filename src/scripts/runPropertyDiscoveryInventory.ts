import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_MAX_EXTERNAL_PAGE_LOADS,
  assertNoD01XClassificationWords,
  buildDiscoverySummary,
  buildExistingUniverseBaseline,
  buildSourceFetchSummary,
  enforcePageLoadCap,
  extractBookingInventoryRows,
  extractJalanInventoryRows,
  extractOfficialTourismInventoryRows,
  extractRakutenInventoryRows,
  parseExistingUniverseCsvAsInventoryRows,
  renderPropertyDiscoveryInventoryCsv,
  renderPropertyDiscoveryInventoryReport,
  sourceStatusForLoadedPage,
  type PropertyDiscoveryInventoryRow,
  type PropertyDiscoverySourceName,
  type PropertyDiscoverySourceStatus,
  type PropertyDiscoverySourceType,
  type SourceFetchSummary
} from "../services/propertyDiscoveryInventory";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/property-discovery";

const OFFICIAL_STAY_URL = "https://zaomountainresort.com/stay/";
const JALAN_URL =
  "https://www.jalan.net/uw/uwp2011/uww2011search.do?actionId=G&keyword=%91%A0%89%A4%89%B7%90%F2&dateUndecided=1&stayYear=2026&stayMonth=06&stayDay=01&minPrice=0&maxPrice=999999&distCd=06&rootCd=7701&activeSort=0&screenId=UWW2011&dispStartIndex=0";
const JALAN_DISPLAY_URL =
  "https://www.jalan.net/uw/uwp2011/uww2011init.do?keyword=%91%A0%89%A4%89%B7%90%F2&distCd=06&rootCd=7701&screenId=FWPCTOP&ccnt=button-fw&image1=";
const RAKUTEN_URL = "https://travel.rakuten.co.jp/onsen/yamagata/OK00161.html";
const BOOKING_URL =
  "https://www.booking.com/searchresults.ja.html?ss=%E8%94%B5%E7%8E%8B%E6%B8%A9%E6%B3%89&checkin=2026-08-12&checkout=2026-08-13&group_adults=2&no_rooms=1&group_children=0&selected_currency=JPY&lang=ja";

const UNIVERSE_PROPERTIES_CSV = ".data/exports/zao-universe-review/zao_universe_properties_20260531_231933.csv";
const UNIVERSE_CANDIDATES_CSV = ".data/exports/zao-universe-review/zao_source_candidates_20260531_231933.csv";
const UNIVERSE_ALIAS_JSON = ".data/exports/zao-universe-review/zao_alias_map_20260531_231933.json";
const UNIVERSE_EXCLUDED_CSV = ".data/exports/zao-universe-review/zao_excluded_audit_20260531_231933.csv";

const USER_AGENT =
  "Mozilla/5.0 (compatible; zao-market-intelligence-property-discovery/0.1; low-volume source inventory)";

interface FetchResult {
  html: string;
  finalUrl: string;
  httpStatus: number;
}

function timestampJst(): string {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(d);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}_${get("hour")}${get("minute")}${get("second")}`;
}

function detectedAtJst(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
    .format(new Date())
    .replace(" ", "T");
}

async function fetchText(url: string, encoding: "utf-8" | "shift_jis"): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      "accept-language": "ja,en;q=0.8"
    },
    redirect: "follow"
  });
  const buffer = new Uint8Array(await response.arrayBuffer());
  return {
    html: new TextDecoder(encoding, { fatal: false }).decode(buffer),
    finalUrl: response.url || url,
    httpStatus: response.status
  };
}

async function collectExternalSource(input: {
  sourceName: PropertyDiscoverySourceName;
  sourceType: PropertyDiscoverySourceType;
  sourceUrl: string;
  fetchUrl: string;
  encoding: "utf-8" | "shift_jis";
  pageArtifactName: string;
  debugRootPath: string;
  runId: string;
  detectedAt: string;
  pageLoadCount: number;
  extractor: (args: {
    html: string;
    sourceUrl: string;
    runId: string;
    detectedAtJst: string;
    debugArtifactPath: string;
  }) => PropertyDiscoveryInventoryRow[];
}): Promise<{ rows: PropertyDiscoveryInventoryRow[]; summary: SourceFetchSummary; pageLoadCount: number }> {
  enforcePageLoadCap(input.pageLoadCount + 1, DEFAULT_MAX_EXTERNAL_PAGE_LOADS);
  const sourceDebugDir = join(input.debugRootPath, "debug_pages", input.sourceName);
  await mkdir(sourceDebugDir, { recursive: true });
  const debugArtifactPath = sourceDebugDir;

  try {
    const fetched = await fetchText(input.fetchUrl, input.encoding);
    const rows = input.extractor({
      html: fetched.html,
      sourceUrl: input.sourceUrl,
      runId: input.runId,
      detectedAtJst: input.detectedAt,
      debugArtifactPath
    });
    const status = sourceStatusForLoadedPage(fetched.html, rows.length);
    await writeFile(join(sourceDebugDir, `${input.pageArtifactName}.html`), fetched.html.slice(0, 500_000), "utf8");
    await writeFile(join(sourceDebugDir, "visible_text.txt"), stripHtml(fetched.html).slice(0, 250_000), "utf8");
    await writeFile(join(sourceDebugDir, "source_url_sanitized.txt"), fetched.finalUrl, "utf8");
    await writeFile(join(sourceDebugDir, "extracted_names.json"), JSON.stringify(rows.map((row) => row.detectedName), null, 2), "utf8");
    return {
      rows: rows.map((row) => ({ ...row, sourceStatus: status })),
      pageLoadCount: input.pageLoadCount + 1,
      summary: buildSourceFetchSummary({
        sourceName: input.sourceName,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        sourceStatus: status,
        httpStatus: fetched.httpStatus,
        extractedRowCount: rows.length,
        pageLoadCount: 1,
        notes:
          status === "ok"
            ? `Parsed ${rows.length} raw inventory rows from ${input.sourceName}.`
            : `Loaded page but source status is ${status}; no bypass attempted.`,
        debugArtifactPath
      })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(join(sourceDebugDir, "error.txt"), message, "utf8");
    return {
      rows: [],
      pageLoadCount: input.pageLoadCount + 1,
      summary: buildSourceFetchSummary({
        sourceName: input.sourceName,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        sourceStatus: "navigation_failed",
        httpStatus: null,
        extractedRowCount: 0,
        pageLoadCount: 1,
        notes: `Fetch/navigation failed: ${message}`,
        debugArtifactPath
      })
    };
  }
}

async function main(): Promise<void> {
  const ts = timestampJst();
  const runId = `property_discovery_inventory_${ts}`;
  const detectedAt = detectedAtJst();
  const reportDir = resolve(REPORT_DIR);
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });
  mkdirSync(join(debugRootPath, "debug_pages"), { recursive: true });

  const sourceArtifactPaths = {
    universePropertiesCsv: resolve(UNIVERSE_PROPERTIES_CSV),
    universeSourceCandidatesCsv: resolve(UNIVERSE_CANDIDATES_CSV),
    universeAliasJson: resolve(UNIVERSE_ALIAS_JSON),
    universeExcludedCsv: resolve(UNIVERSE_EXCLUDED_CSV)
  };

  const propertiesCsv = readIfExists(UNIVERSE_PROPERTIES_CSV);
  const candidatesCsv = readIfExists(UNIVERSE_CANDIDATES_CSV);
  const aliasJson = readIfExists(UNIVERSE_ALIAS_JSON);
  const excludedCsv = readIfExists(UNIVERSE_EXCLUDED_CSV);
  const baseline = buildExistingUniverseBaseline({
    propertiesCsv,
    sourceCandidatesCsv: candidatesCsv,
    aliasMapJson: aliasJson,
    excludedAuditCsv: excludedCsv
  });

  const rows: PropertyDiscoveryInventoryRow[] = [];
  const sourceSummaries: SourceFetchSummary[] = [];
  let pageLoadCount = 0;

  if (propertiesCsv) {
    const localRows = parseExistingUniverseCsvAsInventoryRows({
      csv: propertiesCsv,
      sourceUrl: resolve(UNIVERSE_PROPERTIES_CSV),
      runId,
      detectedAtJst: detectedAt,
      debugArtifactPath: debugRootPath
    });
    rows.push(...localRows);
    sourceSummaries.push(
      buildSourceFetchSummary({
        sourceName: "existing_universe_artifacts",
        sourceType: "local_artifact",
        sourceUrl: resolve(UNIVERSE_PROPERTIES_CSV),
        sourceStatus: "ok",
        httpStatus: null,
        extractedRowCount: localRows.length,
        pageLoadCount: 0,
        notes: "Read existing universe review CSV as a local baseline source only.",
        debugArtifactPath: debugRootPath
      })
    );
  } else {
    sourceSummaries.push(
      buildSourceFetchSummary({
        sourceName: "existing_universe_artifacts",
        sourceType: "local_artifact",
        sourceUrl: resolve(UNIVERSE_PROPERTIES_CSV),
        sourceStatus: "skipped",
        httpStatus: null,
        extractedRowCount: 0,
        pageLoadCount: 0,
        notes: "Existing universe properties CSV was missing; external sources still attempted.",
        debugArtifactPath: debugRootPath
      })
    );
  }

  for (const source of [
    {
      sourceName: "zao_official_stay" as const,
      sourceType: "official_tourism" as const,
      sourceUrl: OFFICIAL_STAY_URL,
      fetchUrl: OFFICIAL_STAY_URL,
      encoding: "utf-8" as const,
      pageArtifactName: "official_stay",
      extractor: extractOfficialTourismInventoryRows
    },
    {
      sourceName: "jalan_zao_onsen_search" as const,
      sourceType: "ota_search" as const,
      sourceUrl: JALAN_DISPLAY_URL,
      fetchUrl: JALAN_URL,
      encoding: "shift_jis" as const,
      pageArtifactName: "jalan_search_page0",
      extractor: extractJalanInventoryRows
    },
    {
      sourceName: "rakuten_zao_onsen_search" as const,
      sourceType: "ota_search" as const,
      sourceUrl: RAKUTEN_URL,
      fetchUrl: RAKUTEN_URL,
      encoding: "shift_jis" as const,
      pageArtifactName: "rakuten_onsen",
      extractor: extractRakutenInventoryRows
    },
    {
      sourceName: "booking_zao_onsen_search" as const,
      sourceType: "ota_search" as const,
      sourceUrl: BOOKING_URL,
      fetchUrl: BOOKING_URL,
      encoding: "utf-8" as const,
      pageArtifactName: "booking_search",
      extractor: extractBookingInventoryRows
    }
  ]) {
    const result = await collectExternalSource({
      ...source,
      debugRootPath,
      runId,
      detectedAt,
      pageLoadCount
    });
    pageLoadCount = result.pageLoadCount;
    rows.push(...result.rows);
    sourceSummaries.push(result.summary);
  }

  const csvPath = resolve(REPORT_DIR, `property_discovery_inventory_${ts}.csv`);
  const reportPath = resolve(REPORT_DIR, `property_discovery_inventory_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `property_discovery_inventory_${ts}.json`);
  const summary = buildDiscoverySummary({
    runId,
    generatedAt: new Date().toISOString(),
    externalPageLoadCount: pageLoadCount,
    maxExternalPageLoads: DEFAULT_MAX_EXTERNAL_PAGE_LOADS,
    existingUniverseBaseline: baseline,
    sourceFetchSummary: sourceSummaries,
    rows,
    reportPath,
    csvPath,
    jsonPath,
    debugRootPath
  });

  const csv = renderPropertyDiscoveryInventoryCsv(rows);
  const report = renderPropertyDiscoveryInventoryReport({ summary, rows });
  assertNoD01XClassificationWords(report);
  assertNoD01XClassificationWords(csv);

  writeFileSync(csvPath, csv, "utf8");
  writeFileSync(reportPath, report, "utf8");
  writeFileSync(jsonPath, JSON.stringify({ summary, rows }, null, 2), "utf8");
  writeFileSync(join(debugRootPath, "source_artifacts_used.json"), JSON.stringify(sourceArtifactPaths, null, 2), "utf8");
  writeFileSync(join(debugRootPath, "source_fetch_summary.json"), JSON.stringify(sourceSummaries, null, 2), "utf8");
  writeFileSync(join(debugRootPath, "raw_detected_rows.json"), JSON.stringify(rows, null, 2), "utf8");
  writeFileSync(join(debugRootPath, "existing_universe_baseline.json"), JSON.stringify(baseline, null, 2), "utf8");
  writeFileSync(join(debugRootPath, "source_status_summary.json"), JSON.stringify(summary.sourceStatusSummary, null, 2), "utf8");
  writeFileSync(join(debugRootPath, "deduped_name_preview.json"), JSON.stringify(summary.dedupedNamePreview, null, 2), "utf8");

  console.log(`decision=${summary.decision}`);
  console.log(`raw_detected_row_count=${summary.rowCount}`);
  console.log(`external_page_load_count=${summary.externalPageLoadCount}`);
  console.log(`source_status_summary=${JSON.stringify(summary.sourceStatusSummary)}`);
  console.log(`row_count_by_source=${JSON.stringify(summary.rowCountBySource)}`);
  console.log(`existing_canonical_count=${summary.existingUniverseBaseline.existingCanonicalCount}`);
  console.log(`existing_source_candidate_count=${summary.existingUniverseBaseline.existingSourceCandidateCount}`);
  console.log(`report_path=${reportPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`json_summary_path=${jsonPath}`);
  console.log(`debug_artifact_path=${debugRootPath}`);
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/giu, " ").replace(/<style[\s\S]*?<\/style>/giu, " ").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
