// Phase D02X — Property Name Normalization and Existing Master Matching.
//
// Pure, read-only matching layer. Converts D01X raw inventory rows into
// normalized, deduped, classified candidate rows by matching against the
// existing properties master pool (canonical names, aliases, source
// candidates, excluded audit). Produces local report/CSV/JSON only.
//
// THIS MODULE MUTATES NOTHING. No DB writes. No properties-master update. No
// alias update. No active promotion. No price-collection-target update. No
// GitHub Actions / GitOps / cron. No paid sources. Classification here is for
// human review (D03X) only; D04X is the only phase that may update the master.

import type { PropertyDiscoveryInventoryRow } from "./propertyDiscoveryInventory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatchEntryType = "canonical" | "alias" | "source_candidate" | "excluded";

export type MatchType =
  | "exact_canonical"
  | "exact_alias"
  | "exact_source_candidate"
  | "fuzzy_high"
  | "fuzzy_medium"
  | "excluded_match"
  | "no_match";

export type D02XClassification =
  | "active_existing"
  | "alias_candidate"
  | "duplicate_candidate"
  | "new_candidate"
  | "reopened_candidate"
  | "closed_or_inactive_candidate"
  | "out_of_scope_candidate"
  | "uncertain_candidate";

export type D02XConfidence = "A" | "B" | "C";

export type D02XRecommendedAction =
  | "none"
  | "keep_existing"
  | "add_alias"
  | "manual_review"
  | "approve_as_active_candidate"
  | "mark_duplicate"
  | "mark_out_of_scope"
  | "mark_closed_or_inactive"
  | "keep_candidate";

export type D02XDecision =
  | "property_name_normalization_ready"
  | "property_name_normalization_basis_caution"
  | "property_name_normalization_not_ready";

export interface MasterPoolEntry {
  entryType: MatchEntryType;
  canonicalPropertyName: string;
  rawName: string;
  normalizedName: string;
  sourceName: string;
  sourceUrl: string;
  jalanId: string;
  rakutenId: string;
  isActiveCanonical: boolean;
}

export interface ExistingMasterPool {
  entries: MasterPoolEntry[];
  canonicalCount: number;
  aliasCount: number;
  sourceCandidateCount: number;
  excludedCount: number;
  aliasMapPresent: boolean;
  excludedPresent: boolean;
  warnings: string[];
}

export interface DetectedGroup {
  normalizedDetectedName: string;
  detectedName: string;
  detectedNameRaw: string;
  sourceNames: string[];
  sourceUrls: string[];
  sourceCount: number;
  bestSourceConfidence: D02XConfidence;
  isLodgingLike: boolean;
  isAreaLikelyZaoOnsen: boolean;
  detectedAreaHint: string;
  detectedPropertyTypeHint: string;
  sourceRowIds: string[];
  debugArtifactPath: string;
}

export interface MatchResult {
  matchedExistingName: string;
  matchedCanonicalPropertyName: string;
  matchedEntryType: MatchEntryType | "";
  matchType: MatchType;
  similarity: number;
}

export interface ClassificationResult {
  classification: D02XClassification;
  confidence: D02XConfidence;
  recommendedAction: D02XRecommendedAction;
  reason: string;
  needsHumanReview: boolean;
}

export interface PropertyNormalizationRow {
  runId: string;
  normalizedAtJst: string;
  detectedName: string;
  detectedNameRaw: string;
  normalizedDetectedName: string;
  sourceNames: string[];
  sourceUrls: string[];
  sourceCount: number;
  bestSourceConfidence: D02XConfidence;
  isLodgingLike: boolean;
  isAreaLikelyZaoOnsen: boolean;
  matchedExistingName: string;
  matchedCanonicalPropertyName: string;
  matchedEntryType: MatchEntryType | "";
  matchType: MatchType;
  similarity: number;
  classification: D02XClassification;
  confidence: D02XConfidence;
  recommendedAction: D02XRecommendedAction;
  reason: string;
  needsHumanReview: boolean;
  detectedAreaHint: string;
  detectedPropertyTypeHint: string;
  sourceRowIds: string[];
  debugArtifactPath: string;
}

export const PROPERTY_NAME_NORMALIZATION_CSV_HEADERS = [
  "run_id",
  "normalized_at_jst",
  "detected_name",
  "detected_name_raw",
  "normalized_detected_name",
  "source_names",
  "source_urls",
  "source_count",
  "best_source_confidence",
  "is_lodging_like",
  "is_area_likely_zao_onsen",
  "matched_existing_name",
  "matched_canonical_property_name",
  "matched_entry_type",
  "match_type",
  "similarity",
  "classification",
  "confidence",
  "recommended_action",
  "reason",
  "needs_human_review",
  "detected_area_hint",
  "detected_property_type_hint",
  "source_row_ids",
  "debug_artifact_path"
] as const;

// Forbidden column tokens that must never appear in D02X output (Beds24/AirHost/PMS).
export const D02X_FORBIDDEN_COLUMN_TOKENS = [
  "beds24",
  "airhost",
  "pms_",
  "channel_manager",
  "ota_upload"
] as const;

export const FUZZY_HIGH_THRESHOLD = 0.92;
export const FUZZY_MEDIUM_THRESHOLD = 0.84;
export const SHORT_NAME_LENGTH = 3;

// ---------------------------------------------------------------------------
// 6.1 Name normalization
// ---------------------------------------------------------------------------

const SOURCE_NOISE_WORDS = ["宿泊予約", "料金", "空室状況", "空室", "プラン", "口コミ", "公式"];

export function normalizePropertyNameForMatching(name: string): string {
  if (!name) return "";
  let s = name.normalize("NFKC");
  s = s.toLowerCase();
  for (const noise of SOURCE_NOISE_WORDS) {
    s = s.split(noise.toLowerCase()).join(" ");
  }
  // Unify hyphen/dash variants to "-" (deliberately excludes katakana ー U+30FC).
  s = s.replace(/[‐‑‒–—―−-]/gu, "-");
  // Normalize ampersand spacing: "a & b" -> "a&b".
  s = s.replace(/\s*&\s*/gu, "&");
  // Remove bracket / punctuation noise (keep alphanumerics, &, -, spaces, JP).
  s = s.replace(/[（）()「」『』【】〔〕［］\[\]｛｝{}、，,。．.・/／\\|!！?？:：;；"'’＇`~＊*＃#]/gu, " ");
  // Collapse all whitespace (incl. ideographic space).
  s = s.replace(/[\s　]+/gu, " ").trim();
  return s;
}

// ---------------------------------------------------------------------------
// 6.4 Similarity scoring (deterministic)
// ---------------------------------------------------------------------------

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

export function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export function tokenOverlapScore(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

export function similarityScore(a: string, b: string): number {
  if (a === b) return 1;
  // Short names: only exact equality counts (avoid false positives).
  if (Math.min(a.length, b.length) <= SHORT_NAME_LENGTH) return 0;
  return Math.max(tokenOverlapScore(a, b), levenshteinRatio(a, b));
}

// ---------------------------------------------------------------------------
// 6.2 Existing master pool
// ---------------------------------------------------------------------------

export function buildExistingMasterPool(input: {
  propertiesCsv?: string | undefined;
  aliasMapJson?: string | undefined;
  sourceCandidatesCsv?: string | undefined;
  excludedAuditCsv?: string | undefined;
}): ExistingMasterPool {
  const warnings: string[] = [];
  const entries: MasterPoolEntry[] = [];
  let canonicalCount = 0;
  let aliasCount = 0;
  let sourceCandidateCount = 0;
  let excludedCount = 0;

  // Canonical + aliases from the properties CSV.
  const propertyRows = input.propertiesCsv ? parseCsv(input.propertiesCsv) : [];
  if (!input.propertiesCsv) warnings.push("properties CSV artifact missing");
  for (const row of propertyRows) {
    const canonical = row["canonical_property_name"] ?? "";
    if (!canonical) continue;
    const isActive = (row["canonicalization_status"] ?? "").toLowerCase() === "canonical";
    canonicalCount++;
    entries.push(makeEntry("canonical", canonical, canonical, "", "", row["jalan_id"] ?? "", row["rakuten_id"] ?? "", isActive));
    for (const alias of splitAliases(row["aliases"] ?? "")) {
      aliasCount++;
      entries.push(makeEntry("alias", canonical, alias, "", "", "", "", isActive));
    }
  }

  // Aliases from the alias map JSON.
  const aliasMapPresent = Boolean(input.aliasMapJson);
  if (input.aliasMapJson) {
    try {
      const parsed = JSON.parse(input.aliasMapJson) as Record<string, unknown>;
      for (const [canonical, value] of Object.entries(parsed)) {
        if (!Array.isArray(value)) continue;
        for (const alias of value) {
          if (typeof alias !== "string") continue;
          aliasCount++;
          entries.push(makeEntry("alias", canonical, alias, "", "", "", "", true));
        }
      }
    } catch {
      warnings.push("alias map JSON could not be parsed");
    }
  } else {
    warnings.push("alias map JSON artifact missing");
  }

  // Source candidates (carry URL + id for URL/id-based exact matching).
  const sourceCandidateRows = input.sourceCandidatesCsv ? parseCsv(input.sourceCandidatesCsv) : [];
  if (!input.sourceCandidatesCsv) warnings.push("source candidates CSV artifact missing");
  for (const row of sourceCandidateRows) {
    const canonical = row["canonical_property_name"] ?? "";
    if (!canonical) continue;
    sourceCandidateCount++;
    const source = row["source"] ?? "";
    const url = row["candidate_property_url"] ?? "";
    const id = row["candidate_source_property_id"] ?? "";
    entries.push(
      makeEntry(
        "source_candidate",
        canonical,
        canonical,
        source,
        url,
        source === "jalan" ? id : "",
        source === "rakuten" ? id : "",
        true
      )
    );
  }

  // Excluded audit entries.
  const excludedPresent = Boolean(input.excludedAuditCsv);
  const excludedRows = input.excludedAuditCsv ? parseCsv(input.excludedAuditCsv) : [];
  if (!input.excludedAuditCsv) warnings.push("excluded audit CSV artifact missing");
  for (const row of excludedRows) {
    const name = row["property_name_raw"] ?? "";
    if (!name) continue;
    excludedCount++;
    const source = row["source"] ?? "";
    const id = row["source_property_id"] ?? "";
    entries.push(
      makeEntry(
        "excluded",
        name,
        name,
        source,
        row["property_url"] ?? "",
        source === "jalan" ? id : "",
        source === "rakuten" ? id : "",
        false
      )
    );
  }

  return {
    entries,
    canonicalCount,
    aliasCount,
    sourceCandidateCount,
    excludedCount,
    aliasMapPresent,
    excludedPresent,
    warnings
  };
}

function makeEntry(
  entryType: MatchEntryType,
  canonicalPropertyName: string,
  rawName: string,
  sourceName: string,
  sourceUrl: string,
  jalanId: string,
  rakutenId: string,
  isActiveCanonical: boolean
): MasterPoolEntry {
  return {
    entryType,
    canonicalPropertyName,
    rawName,
    normalizedName: normalizePropertyNameForMatching(rawName),
    sourceName,
    sourceUrl,
    jalanId,
    rakutenId,
    isActiveCanonical
  };
}

// ---------------------------------------------------------------------------
// 6.3 Matching
// ---------------------------------------------------------------------------

const ENTRY_PRIORITY: Record<MatchEntryType, number> = {
  canonical: 3,
  alias: 2,
  source_candidate: 1,
  excluded: 0
};

export function extractSourceIds(url: string): { jalanId: string; rakutenId: string } {
  const jalan = url.match(/jalan\.net\/yad(\d+)/u)?.[1] ?? "";
  const rakuten = url.match(/(?:travel\.rakuten\.co\.jp\/HOTEL\/|\bHOTEL\/)(\d+)/u)?.[1] ?? "";
  return { jalanId: jalan, rakutenId: rakuten };
}

export function matchDetectedGroup(group: DetectedGroup, pool: ExistingMasterPool): MatchResult {
  // 1. URL / id exact match → exact_source_candidate (strongest existing signal).
  for (const url of group.sourceUrls) {
    const { jalanId, rakutenId } = extractSourceIds(url);
    if (!jalanId && !rakutenId) continue;
    const hit = pool.entries.find(
      (e) =>
        e.entryType !== "excluded" &&
        ((jalanId && e.jalanId === jalanId) || (rakutenId && e.rakutenId === rakutenId))
    );
    if (hit) {
      return {
        matchedExistingName: hit.rawName,
        matchedCanonicalPropertyName: hit.canonicalPropertyName,
        matchedEntryType: hit.entryType === "canonical" ? "canonical" : "source_candidate",
        matchType: hit.entryType === "canonical" ? "exact_canonical" : "exact_source_candidate",
        similarity: 1
      };
    }
    // Excluded id match.
    const excludedHit = pool.entries.find(
      (e) => e.entryType === "excluded" && ((jalanId && e.jalanId === jalanId) || (rakutenId && e.rakutenId === rakutenId))
    );
    if (excludedHit) {
      return {
        matchedExistingName: excludedHit.rawName,
        matchedCanonicalPropertyName: excludedHit.canonicalPropertyName,
        matchedEntryType: "excluded",
        matchType: "excluded_match",
        similarity: 1
      };
    }
  }

  // 2. Normalized-name exact match (prefer canonical > alias > source_candidate > excluded).
  const exactMatches = pool.entries.filter((e) => e.normalizedName && e.normalizedName === group.normalizedDetectedName);
  if (exactMatches.length > 0) {
    const best = exactMatches.sort((a, b) => ENTRY_PRIORITY[b.entryType] - ENTRY_PRIORITY[a.entryType])[0]!;
    return {
      matchedExistingName: best.rawName,
      matchedCanonicalPropertyName: best.canonicalPropertyName,
      matchedEntryType: best.entryType,
      matchType: exactMatchType(best.entryType),
      similarity: 1
    };
  }

  // 3. Fuzzy: best similarity across all entries.
  let best: { entry: MasterPoolEntry; score: number } | null = null;
  for (const entry of pool.entries) {
    if (!entry.normalizedName) continue;
    const score = similarityScore(group.normalizedDetectedName, entry.normalizedName);
    if (!best || score > best.score || (score === best.score && ENTRY_PRIORITY[entry.entryType] > ENTRY_PRIORITY[best.entry.entryType])) {
      best = { entry, score };
    }
  }
  if (!best || best.score < FUZZY_MEDIUM_THRESHOLD) {
    return { matchedExistingName: "", matchedCanonicalPropertyName: "", matchedEntryType: "", matchType: "no_match", similarity: best?.score ?? 0 };
  }
  const matchType: MatchType =
    best.entry.entryType === "excluded" ? "excluded_match" : best.score >= FUZZY_HIGH_THRESHOLD ? "fuzzy_high" : "fuzzy_medium";
  return {
    matchedExistingName: best.entry.rawName,
    matchedCanonicalPropertyName: best.entry.canonicalPropertyName,
    matchedEntryType: best.entry.entryType,
    matchType,
    similarity: round2(best.score)
  };
}

function exactMatchType(entryType: MatchEntryType): MatchType {
  if (entryType === "canonical") return "exact_canonical";
  if (entryType === "alias") return "exact_alias";
  if (entryType === "source_candidate") return "exact_source_candidate";
  return "excluded_match";
}

// ---------------------------------------------------------------------------
// 7 / 8 / 9 Classification, confidence, recommended action
// ---------------------------------------------------------------------------

const NON_LODGING_KEYWORDS =
  /大露天風呂|釣堀|釣り堀|ロープウェイ|ropeway|スキー場|ski\s*lift|リフト|レストラン|restaurant|食堂|売店|観光案内|駐車場|parking/iu;
const CLOSED_KEYWORDS = /休業|閉館|閉業|廃業|closed|out of business/iu;

export function classifyDetectedGroup(group: DetectedGroup, match: MatchResult): ClassificationResult {
  const lodging = group.isLodgingLike;
  const area = group.isAreaLikelyZaoOnsen;
  const text = `${group.detectedName} ${group.detectedPropertyTypeHint} ${group.detectedAreaHint}`;

  // 1. Exact existing match → active_existing.
  if (match.matchType === "exact_canonical" || match.matchType === "exact_alias" || match.matchType === "exact_source_candidate") {
    return {
      classification: "active_existing",
      confidence: "A",
      recommendedAction: "keep_existing",
      reason: `Exact ${match.matchType} match to existing canonical property "${match.matchedCanonicalPropertyName}".`,
      needsHumanReview: false
    };
  }

  // 2. Closed / inactive textual signal.
  if (CLOSED_KEYWORDS.test(text)) {
    return {
      classification: "closed_or_inactive_candidate",
      confidence: "B",
      recommendedAction: "mark_closed_or_inactive",
      reason: "Source text indicates the lodging is closed/inactive (休業/閉館/closed).",
      needsHumanReview: true
    };
  }

  // 3. Excluded-audit match.
  if (match.matchType === "excluded_match") {
    if (lodging && area) {
      return {
        classification: "reopened_candidate",
        confidence: "B",
        recommendedAction: "manual_review",
        reason: `Matches excluded audit entry "${match.matchedExistingName}" but a current lodging listing is visible again in-area.`,
        needsHumanReview: true
      };
    }
    return {
      classification: "out_of_scope_candidate",
      confidence: "B",
      recommendedAction: "mark_out_of_scope",
      reason: `Matches excluded audit entry "${match.matchedExistingName}" (previously excluded; no renewed in-area lodging signal).`,
      needsHumanReview: false
    };
  }

  // 4. Clearly non-lodging / out-of-area facility.
  if (NON_LODGING_KEYWORDS.test(text)) {
    return {
      classification: "out_of_scope_candidate",
      confidence: "B",
      recommendedAction: "mark_out_of_scope",
      reason: "Detected name indicates a non-lodging facility (e.g. bath/fishing/ropeway/restaurant).",
      needsHumanReview: false
    };
  }

  // 5. Fuzzy match to an existing canonical (alias candidate).
  if (match.matchType === "fuzzy_high" || match.matchType === "fuzzy_medium") {
    if (!lodging) {
      return {
        classification: "uncertain_candidate",
        confidence: "C",
        recommendedAction: "manual_review",
        reason: `Fuzzy ${match.matchType} match to "${match.matchedCanonicalPropertyName}" but lodging status is unclear.`,
        needsHumanReview: true
      };
    }
    if (match.matchType === "fuzzy_high") {
      const confidence: D02XConfidence = group.bestSourceConfidence === "A" ? "A" : "B";
      return {
        classification: "alias_candidate",
        confidence,
        recommendedAction: "add_alias",
        reason: `High-similarity (${match.similarity}) match to canonical "${match.matchedCanonicalPropertyName}"; likely alias.`,
        needsHumanReview: true
      };
    }
    return {
      classification: "alias_candidate",
      confidence: "B",
      recommendedAction: "manual_review",
      reason: `Medium-similarity (${match.similarity}) match to canonical "${match.matchedCanonicalPropertyName}"; possible alias pending review.`,
      needsHumanReview: true
    };
  }

  // 6. No match.
  if (!lodging || NON_LODGING_KEYWORDS.test(text)) {
    return {
      classification: "out_of_scope_candidate",
      confidence: "C",
      recommendedAction: "mark_out_of_scope",
      reason: "No master match and the detected name does not look like a lodging facility.",
      needsHumanReview: true
    };
  }
  if (lodging && area && (group.bestSourceConfidence === "A" || group.bestSourceConfidence === "B")) {
    return {
      classification: "new_candidate",
      confidence: "B",
      recommendedAction: "manual_review",
      reason: "No master match; lodging-like and likely in the Zao Onsen area from an official/OTA source. Possible new property.",
      needsHumanReview: true
    };
  }
  return {
    classification: "uncertain_candidate",
    confidence: "C",
    recommendedAction: "manual_review",
    reason: "Name detected but lodging status / area / source signal is weak or ambiguous.",
    needsHumanReview: true
  };
}

// ---------------------------------------------------------------------------
// 10 Deduping into groups
// ---------------------------------------------------------------------------

const LODGING_KEYWORDS = /旅館|ホテル|宿|ロッジ|ペンション|民宿|山荘|荘|villa|hotel|lodge|ryokan|guest|stay|inn|onsen|温泉|高見屋/iu;
const AREA_KEYWORDS = /蔵王温泉|zao\s*onsen|zao-onsen|990-2301|山形市蔵王/iu;

export function buildDetectedGroups(rows: PropertyDiscoveryInventoryRow[]): DetectedGroup[] {
  const groups = new Map<string, DetectedGroup>();
  for (const row of rows) {
    const key = normalizePropertyNameForMatching(row.detectedName);
    if (!key) continue;
    const rowRef = `${row.sourceName}:${row.detectedUrl || `rank${row.rawRankOrPosition ?? ""}`}`;
    const lodging = row.isLodgingLike || LODGING_KEYWORDS.test(`${row.detectedName} ${row.detectedPropertyTypeHint}`) || row.detectedPropertyTypeHint !== "";
    const area = row.isAreaLikelyZaoOnsen || AREA_KEYWORDS.test(`${row.detectedName} ${row.detectedAreaHint}`);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        normalizedDetectedName: key,
        detectedName: row.detectedName,
        detectedNameRaw: row.detectedNameRaw,
        sourceNames: [row.sourceName],
        sourceUrls: row.detectedUrl ? [row.detectedUrl] : [],
        sourceCount: 1,
        bestSourceConfidence: row.sourceConfidence,
        isLodgingLike: lodging,
        isAreaLikelyZaoOnsen: area,
        detectedAreaHint: row.detectedAreaHint,
        detectedPropertyTypeHint: row.detectedPropertyTypeHint,
        sourceRowIds: [rowRef],
        debugArtifactPath: row.debugArtifactPath
      });
    } else {
      if (!existing.sourceNames.includes(row.sourceName)) existing.sourceNames.push(row.sourceName);
      if (row.detectedUrl && !existing.sourceUrls.includes(row.detectedUrl)) existing.sourceUrls.push(row.detectedUrl);
      existing.sourceCount = existing.sourceNames.length;
      existing.bestSourceConfidence = maxConfidence(existing.bestSourceConfidence, row.sourceConfidence);
      existing.isLodgingLike = existing.isLodgingLike || lodging;
      existing.isAreaLikelyZaoOnsen = existing.isAreaLikelyZaoOnsen || area;
      if (!existing.detectedAreaHint && row.detectedAreaHint) existing.detectedAreaHint = row.detectedAreaHint;
      if (!existing.detectedPropertyTypeHint && row.detectedPropertyTypeHint) existing.detectedPropertyTypeHint = row.detectedPropertyTypeHint;
      existing.sourceRowIds.push(rowRef);
    }
  }
  return [...groups.values()].sort((a, b) => a.detectedName.localeCompare(b.detectedName, "ja"));
}

// ---------------------------------------------------------------------------
// Build classified rows (+ duplicate post-pass)
// ---------------------------------------------------------------------------

export function buildNormalizationRows(input: {
  runId: string;
  normalizedAtJst: string;
  rows: PropertyDiscoveryInventoryRow[];
  pool: ExistingMasterPool;
}): PropertyNormalizationRow[] {
  const groups = buildDetectedGroups(input.rows);
  const out: PropertyNormalizationRow[] = groups.map((group) => {
    const match = matchDetectedGroup(group, input.pool);
    const cls = classifyDetectedGroup(group, match);
    return {
      runId: input.runId,
      normalizedAtJst: input.normalizedAtJst,
      detectedName: group.detectedName,
      detectedNameRaw: group.detectedNameRaw,
      normalizedDetectedName: group.normalizedDetectedName,
      sourceNames: group.sourceNames,
      sourceUrls: group.sourceUrls,
      sourceCount: group.sourceCount,
      bestSourceConfidence: group.bestSourceConfidence,
      isLodgingLike: group.isLodgingLike,
      isAreaLikelyZaoOnsen: group.isAreaLikelyZaoOnsen,
      matchedExistingName: match.matchedExistingName,
      matchedCanonicalPropertyName: match.matchedCanonicalPropertyName,
      matchedEntryType: match.matchedEntryType,
      matchType: match.matchType,
      similarity: match.similarity,
      classification: cls.classification,
      confidence: cls.confidence,
      recommendedAction: cls.recommendedAction,
      reason: cls.reason,
      needsHumanReview: cls.needsHumanReview,
      detectedAreaHint: group.detectedAreaHint,
      detectedPropertyTypeHint: group.detectedPropertyTypeHint,
      sourceRowIds: group.sourceRowIds,
      debugArtifactPath: group.debugArtifactPath
    };
  });
  return markDuplicateCandidates(out);
}

// Conservative duplicate pass: the same detected URL appearing under 2+ distinct
// normalized names indicates the same facility detected under multiple names.
function markDuplicateCandidates(rows: PropertyNormalizationRow[]): PropertyNormalizationRow[] {
  const urlToNames = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const url of row.sourceUrls) {
      if (!url) continue;
      (urlToNames.get(url) ?? urlToNames.set(url, new Set()).get(url)!).add(row.normalizedDetectedName);
    }
  }
  const duplicateUrls = new Set([...urlToNames.entries()].filter(([, names]) => names.size >= 2).map(([url]) => url));
  if (duplicateUrls.size === 0) return rows;
  const seenCanonicalForUrl = new Set<string>();
  return rows.map((row) => {
    const sharesDuplicateUrl = row.sourceUrls.some((u) => duplicateUrls.has(u));
    if (!sharesDuplicateUrl || row.classification === "active_existing") return row;
    const key = row.sourceUrls.find((u) => duplicateUrls.has(u)) ?? "";
    if (!seenCanonicalForUrl.has(key)) {
      seenCanonicalForUrl.add(key);
      return row;
    }
    return {
      ...row,
      classification: "duplicate_candidate",
      recommendedAction: "mark_duplicate",
      reason: `Same detected URL appears under multiple detected names; likely a duplicate of an already-listed facility. (${row.reason})`,
      needsHumanReview: true
    };
  });
}

// ---------------------------------------------------------------------------
// Summaries + decision
// ---------------------------------------------------------------------------

export interface NormalizationSummary {
  runId: string;
  generatedAt: string;
  sourceD01xArtifact: string;
  rawRowCount: number;
  dedupedRowCount: number;
  existingCanonicalCount: number;
  existingSourceCandidateCount: number;
  existingAliasCount: number;
  existingExcludedCount: number;
  classificationCounts: Record<string, number>;
  confidenceCounts: Record<string, number>;
  recommendedActionCounts: Record<string, number>;
  warnings: string[];
  decision: D02XDecision;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

export function decideD02X(input: {
  d01xRowCount: number;
  canonicalCount: number;
  classifiedCount: number;
  aliasMapPresent: boolean;
  excludedPresent: boolean;
  uncertainCount: number;
}): D02XDecision {
  if (input.d01xRowCount === 0 || input.classifiedCount === 0) return "property_name_normalization_not_ready";
  if (input.canonicalCount === 0) return "property_name_normalization_not_ready";
  const manyUncertain = input.classifiedCount > 0 && input.uncertainCount / input.classifiedCount > 0.5;
  if (!input.aliasMapPresent || !input.excludedPresent || manyUncertain) return "property_name_normalization_basis_caution";
  return "property_name_normalization_ready";
}

export function countBy<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderNormalizationCsv(rows: PropertyNormalizationRow[]): string {
  const body = rows.map((row) =>
    [
      row.runId,
      row.normalizedAtJst,
      row.detectedName,
      row.detectedNameRaw,
      row.normalizedDetectedName,
      row.sourceNames.join(";"),
      row.sourceUrls.join(";"),
      String(row.sourceCount),
      row.bestSourceConfidence,
      bool(row.isLodgingLike),
      bool(row.isAreaLikelyZaoOnsen),
      row.matchedExistingName,
      row.matchedCanonicalPropertyName,
      row.matchedEntryType,
      row.matchType,
      String(row.similarity),
      row.classification,
      row.confidence,
      row.recommendedAction,
      row.reason,
      bool(row.needsHumanReview),
      row.detectedAreaHint,
      row.detectedPropertyTypeHint,
      row.sourceRowIds.join(";"),
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [PROPERTY_NAME_NORMALIZATION_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderNormalizationReport(input: { summary: NormalizationSummary; rows: PropertyNormalizationRow[] }): string {
  const { summary, rows } = input;
  const byClass = (c: D02XClassification): PropertyNormalizationRow[] => rows.filter((r) => r.classification === c);
  const list = (c: D02XClassification): string[] => {
    const items = byClass(c);
    if (items.length === 0) return ["- none"];
    return items
      .slice(0, 60)
      .map(
        (r) =>
          `- ${r.detectedName} → ${r.matchedCanonicalPropertyName || "(no match)"} [${r.matchType}, sim=${r.similarity}, conf=${r.confidence}, action=${r.recommendedAction}]`
      );
  };
  return [
    "# Property Name Normalization and Master Matching (Phase D02X)",
    "",
    `Generated at: ${summary.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${summary.decision}`,
    `- source_d01x_artifact=${summary.sourceD01xArtifact}`,
    `- raw_row_count=${summary.rawRowCount}`,
    `- deduped_row_count=${summary.dedupedRowCount}`,
    "",
    "## 2. Existing master baseline",
    "",
    `- existing_canonical_count=${summary.existingCanonicalCount}`,
    `- existing_source_candidate_count=${summary.existingSourceCandidateCount}`,
    `- existing_alias_count=${summary.existingAliasCount}`,
    `- existing_excluded_count=${summary.existingExcludedCount}`,
    "",
    "## 3. Classification counts",
    "",
    `- ${JSON.stringify(summary.classificationCounts)}`,
    "",
    "## 4. Confidence counts",
    "",
    `- ${JSON.stringify(summary.confidenceCounts)}`,
    "",
    "## 5. Recommended action counts",
    "",
    `- ${JSON.stringify(summary.recommendedActionCounts)}`,
    "",
    "## 6. active_existing matches (sample)",
    "",
    ...list("active_existing").slice(0, 40),
    "",
    "## 7. alias_candidate list",
    "",
    ...list("alias_candidate"),
    "",
    "## 8. new_candidate list",
    "",
    ...list("new_candidate"),
    "",
    "## 9. duplicate_candidate list",
    "",
    ...list("duplicate_candidate"),
    "",
    "## 10. reopened_candidate list",
    "",
    ...list("reopened_candidate"),
    "",
    "## 11. closed_or_inactive_candidate list",
    "",
    ...list("closed_or_inactive_candidate"),
    "",
    "## 12. out_of_scope_candidate list",
    "",
    ...list("out_of_scope_candidate"),
    "",
    "## 13. uncertain_candidate list",
    "",
    ...list("uncertain_candidate"),
    "",
    "## 14. Warnings",
    "",
    summary.warnings.length > 0 ? summary.warnings.map((w) => `- ${w}`).join("\n") : "- none",
    "",
    "## 15. Safety confirmation",
    "",
    "- D02X did not modify the properties master.",
    "- D02X did not add aliases.",
    "- D02X did not active-promote candidates.",
    "- D02X did not add price collection targets.",
    "- No DB writes, no GitHub Actions/GitOps activation, no version-control commits or pushes, no paid sources.",
    "",
    "## 16. Output paths",
    "",
    `- report_path=${summary.reportPath}`,
    `- csv_path=${summary.csvPath}`,
    `- json_summary_path=${summary.jsonPath}`,
    `- debug_artifact_path=${summary.debugRootPath}`,
    "",
    "## 17. Recommended next action",
    "",
    "- Phase D03X: turn these classifications into a human-readable review packet with recommended actions (still no master update).",
    ""
  ].join("\n");
}

export function assertNoForbiddenColumns(headerLine: string): void {
  const lower = headerLine.toLowerCase();
  for (const token of D02X_FORBIDDEN_COLUMN_TOKENS) {
    if (lower.includes(token)) {
      throw new Error(`D02X output must not include forbidden column token: ${token}`);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function splitAliases(aliases: string): string[] {
  return aliases
    .split(/[;；]/u)
    .map((a) => a.trim())
    .filter(Boolean);
}

function maxConfidence(a: D02XConfidence, b: D02XConfidence): D02XConfidence {
  const rank: Record<D02XConfidence, number> = { A: 3, B: 2, C: 1 };
  return rank[a] >= rank[b] ? a : b;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
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
