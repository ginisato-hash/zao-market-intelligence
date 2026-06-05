import {
  extractJalanListingsFromHtmlOrText,
  extractRakutenListingsFromHtmlOrText
} from "./extractZaoSourceListings";

export type PropertyDiscoverySourceName =
  | "zao_official_stay"
  | "jalan_zao_onsen_search"
  | "rakuten_zao_onsen_search"
  | "booking_zao_onsen_search"
  | "existing_universe_artifacts"
  | "optional_ota_public_search";

export type PropertyDiscoverySourceType =
  | "official_tourism"
  | "ota_search"
  | "local_artifact"
  | "official_site"
  | "other_public";

export type PropertyDiscoverySourceStatus =
  | "ok"
  | "partial"
  | "blocked_or_unavailable"
  | "navigation_failed"
  | "parse_failed"
  | "skipped";

export type PropertyDiscoverySourceConfidence = "A" | "B" | "C";

export type PropertyDiscoveryDecision =
  | "property_discovery_inventory_ready"
  | "property_discovery_inventory_partial"
  | "property_discovery_inventory_not_ready";

export interface PropertyDiscoveryInventoryRow {
  runId: string;
  detectedAtJst: string;
  sourceName: PropertyDiscoverySourceName;
  sourceType: PropertyDiscoverySourceType;
  sourceUrl: string;
  sourceStatus: PropertyDiscoverySourceStatus;
  extractionMethod: string;
  detectedName: string;
  detectedNameRaw: string;
  normalizedDetectedName: string;
  detectedUrl: string;
  detectedAreaHint: string;
  detectedPropertyTypeHint: string;
  detectedAddressHint: string;
  detectedPhoneHint: string;
  rawRankOrPosition: number | null;
  sourceConfidence: PropertyDiscoverySourceConfidence;
  isLodgingLike: boolean;
  isAreaLikelyZaoOnsen: boolean;
  notes: string;
  debugArtifactPath: string;
}

export interface SourceFetchSummary {
  sourceName: PropertyDiscoverySourceName;
  sourceType: PropertyDiscoverySourceType;
  sourceUrl: string;
  sourceStatus: PropertyDiscoverySourceStatus;
  httpStatus: number | null;
  extractedRowCount: number;
  pageLoadCount: number;
  notes: string;
  debugArtifactPath: string;
}

export interface ExistingUniverseBaseline {
  existingCanonicalCount: number;
  existingSourceCandidateCount: number;
  existingSourcesPresent: string[];
  existingAliasCount: number;
  existingExcludedCount: number;
  warnings: string[];
}

export interface PropertyDiscoveryInventorySummary {
  runId: string;
  generatedAt: string;
  externalPageLoadCount: number;
  maxExternalPageLoads: number;
  existingUniverseBaseline: ExistingUniverseBaseline;
  sourceFetchSummary: SourceFetchSummary[];
  sourceStatusSummary: Record<string, number>;
  rowCount: number;
  rowCountBySource: Record<string, number>;
  dedupedNamePreview: string[];
  decision: PropertyDiscoveryDecision;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

export const PROPERTY_DISCOVERY_INVENTORY_CSV_HEADERS = [
  "run_id",
  "detected_at_jst",
  "source_name",
  "source_type",
  "source_url",
  "source_status",
  "extraction_method",
  "detected_name",
  "detected_name_raw",
  "normalized_detected_name",
  "detected_url",
  "detected_area_hint",
  "detected_property_type_hint",
  "detected_address_hint",
  "detected_phone_hint",
  "raw_rank_or_position",
  "source_confidence",
  "is_lodging_like",
  "is_area_likely_zao_onsen",
  "notes",
  "debug_artifact_path"
] as const;

export const PROPERTY_DISCOVERY_FORBIDDEN_DECISION_WORDS = [
  "new_candidate",
  "alias_candidate",
  "duplicate_candidate",
  "active_existing",
  "out_of_scope_candidate"
] as const;

export const DEFAULT_MAX_EXTERNAL_PAGE_LOADS = 15;

export function normalizeDetectedNamePreview(name: string): string {
  return toHalfWidth(name)
    .replace(/&amp;/giu, "&")
    .replace(/[＆]/gu, "&")
    .replace(/\s+/gu, " ")
    .replace(/[「」『』]/gu, "")
    .trim()
    .toLowerCase();
}

export function sourceStatusForLoadedPage(htmlOrText: string, extractedRowCount: number): PropertyDiscoverySourceStatus {
  if (isBlockedOrUnavailableText(htmlOrText)) return "blocked_or_unavailable";
  if (extractedRowCount === 0) return "parse_failed";
  return "ok";
}

export function isBlockedOrUnavailableText(text: string): boolean {
  return /(captcha|recaptcha|are you a robot|ロボットではありません|セキュリティチェック|access denied|アクセスが集中|bot detection)/iu.test(
    text
  );
}

export function enforcePageLoadCap(nextPageLoads: number, maxPageLoads = DEFAULT_MAX_EXTERNAL_PAGE_LOADS): void {
  if (nextPageLoads > maxPageLoads) {
    throw new Error(`D01X page-load cap exceeded: attempted=${nextPageLoads}, max=${maxPageLoads}`);
  }
}

export function extractOfficialTourismInventoryRows(input: {
  html: string;
  sourceUrl: string;
  runId: string;
  detectedAtJst: string;
  debugArtifactPath: string;
}): PropertyDiscoveryInventoryRow[] {
  const anchors = extractAnchors(input.html, input.sourceUrl);
  const rows: PropertyDiscoveryInventoryRow[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const name = cleanDetectedName(anchor.text);
    if (!looksLikePropertyName(name) || isGenericOfficialLink(name)) continue;
    const key = normalizeDetectedNamePreview(name);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(
      buildInventoryRow({
        ...input,
        sourceName: "zao_official_stay",
        sourceType: "official_tourism",
        sourceStatus: "ok",
        extractionMethod: "official_stay_anchor_text",
        detectedNameRaw: name,
        detectedUrl: anchor.href,
        detectedAreaHint: areaHintForText(`${name} ${anchor.href}`),
        detectedPropertyTypeHint: propertyTypeHintForText(name),
        rawRankOrPosition: rows.length + 1,
        sourceConfidence: "A",
        notes: "Raw lodging-like link extracted from the official Zao Onsen stay page. No master matching performed."
      })
    );
  }
  return rows;
}

export function extractJalanInventoryRows(input: {
  html: string;
  sourceUrl: string;
  runId: string;
  detectedAtJst: string;
  debugArtifactPath: string;
}): PropertyDiscoveryInventoryRow[] {
  return extractJalanListingsFromHtmlOrText(input.html, input.sourceUrl).map((listing, index) =>
    buildInventoryRow({
      ...input,
      sourceName: "jalan_zao_onsen_search",
      sourceType: "ota_search",
      sourceStatus: "ok",
      extractionMethod: "jalan_facilityName_and_yad_id",
      detectedNameRaw: listing.propertyNameRaw,
      detectedUrl: listing.propertyUrl ?? "",
      detectedAreaHint: areaHintForText(listing.propertyNameRaw),
      detectedPropertyTypeHint: propertyTypeHintForText(listing.propertyNameRaw),
      rawRankOrPosition: index + 1,
      sourceConfidence: "B",
      notes: `Raw Jalan listing candidate; source_property_id=${listing.sourcePropertyId ?? "none"}. No master matching performed.`
    })
  );
}

export function extractRakutenInventoryRows(input: {
  html: string;
  sourceUrl: string;
  runId: string;
  detectedAtJst: string;
  debugArtifactPath: string;
}): PropertyDiscoveryInventoryRow[] {
  return extractRakutenListingsFromHtmlOrText(input.html, input.sourceUrl).map((listing, index) =>
    buildInventoryRow({
      ...input,
      sourceName: "rakuten_zao_onsen_search",
      sourceType: "ota_search",
      sourceStatus: "ok",
      extractionMethod: "rakuten_hotelBox_anchor",
      detectedNameRaw: listing.propertyNameRaw,
      detectedUrl: listing.propertyUrl ?? "",
      detectedAreaHint: areaHintForText(listing.propertyNameRaw),
      detectedPropertyTypeHint: propertyTypeHintForText(listing.propertyNameRaw),
      rawRankOrPosition: index + 1,
      sourceConfidence: "B",
      notes: `Raw Rakuten listing candidate; source_property_id=${listing.sourcePropertyId ?? "none"}. No master matching performed.`
    })
  );
}

export function extractBookingInventoryRows(input: {
  html: string;
  sourceUrl: string;
  runId: string;
  detectedAtJst: string;
  debugArtifactPath: string;
}): PropertyDiscoveryInventoryRow[] {
  const anchors = extractAnchors(input.html, input.sourceUrl).filter((anchor) => /booking\.com\/hotel\/jp\//iu.test(anchor.href));
  const rows: PropertyDiscoveryInventoryRow[] = [];
  const seenUrls = new Set<string>();
  for (const anchor of anchors) {
    if (seenUrls.has(anchor.href)) continue;
    seenUrls.add(anchor.href);
    const name = cleanDetectedName(anchor.text || extractBookingSlug(anchor.href));
    if (!looksLikePropertyName(name)) continue;
    rows.push(
      buildInventoryRow({
        ...input,
        sourceName: "booking_zao_onsen_search",
        sourceType: "ota_search",
        sourceStatus: "ok",
        extractionMethod: "booking_public_search_hotel_link",
        detectedNameRaw: name,
        detectedUrl: sanitizeUrl(anchor.href),
        detectedAreaHint: areaHintForText(`${name} ${input.html.slice(Math.max(0, input.html.indexOf(anchor.href) - 300), input.html.indexOf(anchor.href) + 300)}`),
        detectedPropertyTypeHint: propertyTypeHintForText(name),
        rawRankOrPosition: rows.length + 1,
        sourceConfidence: "B",
        notes: "Raw Booking.com public search hotel link. No login, no CAPTCHA bypass, no master matching performed."
      })
    );
  }
  return rows;
}

export function parseExistingUniverseCsvAsInventoryRows(input: {
  csv: string;
  sourceUrl: string;
  runId: string;
  detectedAtJst: string;
  debugArtifactPath: string;
}): PropertyDiscoveryInventoryRow[] {
  const records = parseCsv(input.csv);
  return records.map((record, index) =>
    buildInventoryRow({
      ...input,
      sourceName: "existing_universe_artifacts",
      sourceType: "local_artifact",
      sourceStatus: "ok",
      extractionMethod: "local_zao_universe_properties_csv",
      detectedNameRaw: record["canonical_property_name"] ?? "",
      detectedUrl: record["jalan_url"] || record["rakuten_url"] || "",
      detectedAreaHint: "existing Zao universe local artifact",
      detectedPropertyTypeHint: propertyTypeHintForText(record["canonical_property_name"] ?? ""),
      rawRankOrPosition: index + 1,
      sourceConfidence: "A",
      notes: "Read-only baseline row from existing universe review CSV. Not classified or promoted in D01X."
    })
  );
}

export function buildExistingUniverseBaseline(input: {
  propertiesCsv?: string | undefined;
  sourceCandidatesCsv?: string | undefined;
  aliasMapJson?: string | undefined;
  excludedAuditCsv?: string | undefined;
}): ExistingUniverseBaseline {
  const warnings: string[] = [];
  const propertyRows = input.propertiesCsv ? parseCsv(input.propertiesCsv) : [];
  if (!input.propertiesCsv) warnings.push("properties CSV artifact missing");
  const sourceCandidateRows = input.sourceCandidatesCsv ? parseCsv(input.sourceCandidatesCsv) : [];
  if (!input.sourceCandidatesCsv) warnings.push("source candidates CSV artifact missing");
  const excludedRows = input.excludedAuditCsv ? parseCsv(input.excludedAuditCsv) : [];
  if (!input.excludedAuditCsv) warnings.push("excluded audit CSV artifact missing");
  const sources = new Set<string>();
  for (const row of sourceCandidateRows) {
    const source = row["source"];
    if (source) sources.add(source);
  }
  let aliasCount = 0;
  if (input.aliasMapJson) {
    try {
      const parsed = JSON.parse(input.aliasMapJson) as Record<string, unknown>;
      for (const value of Object.values(parsed)) {
        if (Array.isArray(value)) aliasCount += value.length;
      }
    } catch {
      warnings.push("alias map JSON could not be parsed");
    }
  } else {
    warnings.push("alias map JSON artifact missing");
  }
  return {
    existingCanonicalCount: propertyRows.length,
    existingSourceCandidateCount: sourceCandidateRows.length,
    existingSourcesPresent: [...sources].sort(),
    existingAliasCount: aliasCount,
    existingExcludedCount: excludedRows.length,
    warnings
  };
}

export function buildSourceFetchSummary(input: {
  sourceName: PropertyDiscoverySourceName;
  sourceType: PropertyDiscoverySourceType;
  sourceUrl: string;
  sourceStatus: PropertyDiscoverySourceStatus;
  httpStatus: number | null;
  extractedRowCount: number;
  pageLoadCount: number;
  notes: string;
  debugArtifactPath: string;
}): SourceFetchSummary {
  return input;
}

export function decidePropertyDiscoveryInventory(input: {
  rows: PropertyDiscoveryInventoryRow[];
  baseline: ExistingUniverseBaseline;
  sourceSummaries: SourceFetchSummary[];
}): PropertyDiscoveryDecision {
  const productiveSources = new Set(input.rows.map((row) => row.sourceName));
  const baselineLoaded = input.baseline.existingCanonicalCount > 0;
  if (productiveSources.size >= 2 && baselineLoaded) return "property_discovery_inventory_ready";
  if (productiveSources.size >= 1) return "property_discovery_inventory_partial";
  return "property_discovery_inventory_not_ready";
}

export function buildDiscoverySummary(input: {
  runId: string;
  generatedAt: string;
  externalPageLoadCount: number;
  maxExternalPageLoads: number;
  existingUniverseBaseline: ExistingUniverseBaseline;
  sourceFetchSummary: SourceFetchSummary[];
  rows: PropertyDiscoveryInventoryRow[];
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}): PropertyDiscoveryInventorySummary {
  return {
    runId: input.runId,
    generatedAt: input.generatedAt,
    externalPageLoadCount: input.externalPageLoadCount,
    maxExternalPageLoads: input.maxExternalPageLoads,
    existingUniverseBaseline: input.existingUniverseBaseline,
    sourceFetchSummary: input.sourceFetchSummary,
    sourceStatusSummary: countBy(input.sourceFetchSummary.map((summary) => summary.sourceStatus)),
    rowCount: input.rows.length,
    rowCountBySource: countBy(input.rows.map((row) => row.sourceName)),
    dedupedNamePreview: buildDedupedNamePreview(input.rows),
    decision: decidePropertyDiscoveryInventory({
      rows: input.rows,
      baseline: input.existingUniverseBaseline,
      sourceSummaries: input.sourceFetchSummary
    }),
    reportPath: input.reportPath,
    csvPath: input.csvPath,
    jsonPath: input.jsonPath,
    debugRootPath: input.debugRootPath
  };
}

export function renderPropertyDiscoveryInventoryCsv(rows: PropertyDiscoveryInventoryRow[]): string {
  const body = rows.map((row) =>
    [
      row.runId,
      row.detectedAtJst,
      row.sourceName,
      row.sourceType,
      row.sourceUrl,
      row.sourceStatus,
      row.extractionMethod,
      row.detectedName,
      row.detectedNameRaw,
      row.normalizedDetectedName,
      row.detectedUrl,
      row.detectedAreaHint,
      row.detectedPropertyTypeHint,
      row.detectedAddressHint,
      row.detectedPhoneHint,
      row.rawRankOrPosition === null ? "" : String(row.rawRankOrPosition),
      row.sourceConfidence,
      bool(row.isLodgingLike),
      bool(row.isAreaLikelyZaoOnsen),
      row.notes,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [PROPERTY_DISCOVERY_INVENTORY_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderPropertyDiscoveryInventoryReport(input: {
  summary: PropertyDiscoveryInventorySummary;
  rows: PropertyDiscoveryInventoryRow[];
}): string {
  const rowsBySource = groupRowsBySource(input.rows);
  return [
    "# Property Discovery Source Inventory (Phase D01X)",
    "",
    `Generated at: ${input.summary.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${input.summary.decision}`,
    `- raw_detected_row_count=${input.summary.rowCount}`,
    `- external_page_load_count=${input.summary.externalPageLoadCount}`,
    `- max_external_page_loads=${input.summary.maxExternalPageLoads}`,
    `- source_status_summary=${JSON.stringify(input.summary.sourceStatusSummary)}`,
    `- row_count_by_source=${JSON.stringify(input.summary.rowCountBySource)}`,
    "",
    "## 2. Sources attempted",
    "",
    ...input.summary.sourceFetchSummary.map(
      (source) =>
        `- ${source.sourceName}: status=${source.sourceStatus}, http=${source.httpStatus ?? "n/a"}, rows=${source.extractedRowCount}, loads=${source.pageLoadCount}, url=${source.sourceUrl}`
    ),
    "",
    "## 3. Existing universe baseline",
    "",
    `- existing_canonical_count=${input.summary.existingUniverseBaseline.existingCanonicalCount}`,
    `- existing_source_candidate_count=${input.summary.existingUniverseBaseline.existingSourceCandidateCount}`,
    `- existing_sources_present=${input.summary.existingUniverseBaseline.existingSourcesPresent.join(";")}`,
    `- existing_alias_count=${input.summary.existingUniverseBaseline.existingAliasCount}`,
    `- existing_excluded_count=${input.summary.existingUniverseBaseline.existingExcludedCount}`,
    `- baseline_warnings=${input.summary.existingUniverseBaseline.warnings.join("; ") || "none"}`,
    "",
    "## 4. Detected names by source",
    "",
    ...Object.entries(rowsBySource).flatMap(([source, rows]) => [
      `### ${source}`,
      "",
      ...rows.slice(0, 80).map((row) => `- ${row.detectedName} (${row.detectedUrl || "no url"})`),
      rows.length > 80 ? `- ... ${rows.length - 80} additional rows omitted from this preview` : ""
    ]),
    "",
    "## 5. Deduped name preview",
    "",
    ...input.summary.dedupedNamePreview.slice(0, 120).map((name) => `- ${name}`),
    "",
    "## 6. Blocked / partial sources",
    "",
    ...input.summary.sourceFetchSummary
      .filter((source) => source.sourceStatus !== "ok")
      .map((source) => `- ${source.sourceName}: ${source.sourceStatus} — ${source.notes}`),
    input.summary.sourceFetchSummary.every((source) => source.sourceStatus === "ok") ? "- none" : "",
    "",
    "## 7. Safety confirmation",
    "",
    "- Discovery-only inventory; no DB writes, no properties master update, no active-property creation, no alias promotion.",
    "- No price collection, no reservation flow, no login, no CAPTCHA bypass, no stealth, no paid APIs/proxies.",
    "- No GitHub Actions activation, no git commit, no git push, no GitOps or data-repo mutation.",
    "- D01X intentionally does not assign D02X matching or approval categories.",
    "",
    "## 8. Output paths",
    "",
    `- report_path=${input.summary.reportPath}`,
    `- csv_path=${input.summary.csvPath}`,
    `- json_summary_path=${input.summary.jsonPath}`,
    `- debug_artifact_path=${input.summary.debugRootPath}`,
    "",
    "## 9. Recommended next action",
    "",
    "- Phase D02X: normalize names and match raw inventory rows against the existing properties master with explicit review classifications.",
    ""
  ].join("\n");
}

export function assertNoD01XClassificationWords(text: string): void {
  for (const word of PROPERTY_DISCOVERY_FORBIDDEN_DECISION_WORDS) {
    if (text.includes(word)) {
      throw new Error(`D01X output must not include D02X classification word: ${word}`);
    }
  }
}

function buildInventoryRow(input: {
  runId: string;
  detectedAtJst: string;
  sourceName: PropertyDiscoverySourceName;
  sourceType: PropertyDiscoverySourceType;
  sourceUrl: string;
  sourceStatus: PropertyDiscoverySourceStatus;
  extractionMethod: string;
  detectedNameRaw: string;
  detectedUrl: string;
  detectedAreaHint: string;
  detectedPropertyTypeHint: string;
  rawRankOrPosition: number | null;
  sourceConfidence: PropertyDiscoverySourceConfidence;
  notes: string;
  debugArtifactPath: string;
}): PropertyDiscoveryInventoryRow {
  const detectedName = cleanDetectedName(input.detectedNameRaw);
  const normalized = normalizeDetectedNamePreview(detectedName);
  return {
    runId: input.runId,
    detectedAtJst: input.detectedAtJst,
    sourceName: input.sourceName,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
    sourceStatus: input.sourceStatus,
    extractionMethod: input.extractionMethod,
    detectedName,
    detectedNameRaw: input.detectedNameRaw,
    normalizedDetectedName: normalized,
    detectedUrl: input.detectedUrl,
    detectedAreaHint: input.detectedAreaHint,
    detectedPropertyTypeHint: input.detectedPropertyTypeHint,
    detectedAddressHint: extractAddressHint(`${input.detectedNameRaw} ${input.notes}`),
    detectedPhoneHint: extractPhoneHint(input.notes),
    rawRankOrPosition: input.rawRankOrPosition,
    sourceConfidence: input.sourceConfidence,
    isLodgingLike: isLodgingLike(detectedName),
    isAreaLikelyZaoOnsen: isAreaLikelyZaoOnsen(`${detectedName} ${input.detectedAreaHint} ${input.notes}`),
    notes: input.notes,
    debugArtifactPath: input.debugArtifactPath
  };
}

function extractAnchors(html: string, baseUrl: string): Array<{ href: string; text: string }> {
  const anchors: Array<{ href: string; text: string }> = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const href = absoluteUrl(match[1] ?? "", baseUrl);
    const text = cleanDetectedName(stripTags(match[2] ?? ""));
    anchors.push({ href, text });
  }
  return anchors;
}

function absoluteUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/aid|sid|label|utm_|gclid|yclid|token|auth/iu.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function extractBookingSlug(url: string): string {
  return url.match(/\/hotel\/jp\/([^/?#.]+)\./u)?.[1] ?? url;
}

function cleanDetectedName(text: string): string {
  return decodeHtmlEntities(text)
    .replace(/[\s　]+/gu, " ")
    .replace(/\s*[\r\n]\s*/gu, " ")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/giu, " ").replace(/<style[\s\S]*?<\/style>/giu, " ").replace(/<[^>]+>/gu, " ");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&nbsp;/giu, " ");
}

function looksLikePropertyName(name: string): boolean {
  if (name.length < 2 || name.length > 90) return false;
  if (/^(詳しくはこちら|詳細|予約|宿泊予約|空室|検索|home|top|map|access|more)$/iu.test(name)) return false;
  return /旅館|ホテル|宿|ロッジ|ペンション|民宿|山荘|荘|温泉|onsen|hotel|lodge|ryokan|stay|zao|蔵王|高見屋|jurin|base/iu.test(
    name
  );
}

function isGenericOfficialLink(name: string): boolean {
  return /(泊まる|宿泊施設|ホテル・旅館|ペンション|一覧|観光|温泉街|アクセス|お問い合わせ|パンフレット)$/u.test(name);
}

function isLodgingLike(name: string): boolean {
  return /旅館|ホテル|宿|ロッジ|ペンション|民宿|山荘|荘|villa|hotel|lodge|ryokan|guest|stay|onsen/iu.test(name);
}

function isAreaLikelyZaoOnsen(text: string): boolean {
  return /蔵王温泉|zao onsen|zao-onsen|990-2301|山形市蔵王/iu.test(text);
}

function areaHintForText(text: string): string {
  if (/蔵王温泉|zao onsen|zao-onsen/iu.test(text)) return "Zao Onsen";
  if (/上山|坊平|猿倉/u.test(text)) return "Kaminoyama / Zao Bodaira / Sarakura";
  return "";
}

function propertyTypeHintForText(text: string): string {
  if (/旅館|ryokan/iu.test(text)) return "ryokan";
  if (/ホテル|hotel/iu.test(text)) return "hotel";
  if (/ペンション|pension/iu.test(text)) return "pension";
  if (/ロッジ|lodge/iu.test(text)) return "lodge";
  if (/民宿|guest/iu.test(text)) return "guesthouse";
  if (/山荘/u.test(text)) return "mountain_lodge";
  return "";
}

function extractAddressHint(text: string): string {
  return text.match(/〒?\s*\d{3}-\d{4}[^。,\n]{0,80}/u)?.[0]?.trim() ?? "";
}

function extractPhoneHint(text: string): string {
  return text.match(/0\d{1,4}-\d{1,4}-\d{3,4}/u)?.[0] ?? "";
}

function buildDedupedNamePreview(rows: PropertyDiscoveryInventoryRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    if (!row.normalizedDetectedName || seen.has(row.normalizedDetectedName)) continue;
    seen.add(row.normalizedDetectedName);
    out.push(row.detectedName);
  }
  return out.sort((a, b) => a.localeCompare(b, "ja"));
}

function groupRowsBySource(rows: PropertyDiscoveryInventoryRow[]): Record<string, PropertyDiscoveryInventoryRow[]> {
  const out: Record<string, PropertyDiscoveryInventoryRow[]> = {};
  for (const row of rows) {
    (out[row.sourceName] ??= []).push(row);
  }
  return out;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

function toHalfWidth(text: string): string {
  return text.replace(/[！-～]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function parseCsv(csv: string): Array<Record<string, string>> {
  const rows = parseCsvRows(csv);
  const headers = rows.shift() ?? [];
  return rows
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    const next = csv[i + 1];
    if (inQuotes && ch === "\"" && next === "\"") {
      cell += "\"";
      i++;
    } else if (ch === "\"") {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
