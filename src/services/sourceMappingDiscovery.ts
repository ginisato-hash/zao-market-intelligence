// Phase AUTO-RUNNER16X-A4 — public OTA source mapping discovery (pure).
//
// Goal: expand the verified Booking/Jalan target universe by discovering
// property page URLs (Booking hotel slug / Jalan yadId) on PUBLIC OTA pages,
// then verifying identity (name + region) — identity only, NEVER price
// collection, NEVER booking flow, NEVER login/cookie/captcha bypass, NEVER
// paid scraping/proxy. Discovery sources are first-party public OTA pages
// (Jalan keyword listing, Booking area search results) plus repo-internal
// Phase 47X public-URL seeds. This module is pure: no I/O, no network.

import { regionMatches } from "./sourceMappingVerification";
import { isLiveVerified } from "./marketRefreshTargetUniverse";

export type DiscoverySource = "booking" | "jalan";

export type DiscoveryStatus =
  | "verified"
  | "candidate_found_needs_review"
  | "not_found_after_public_search"
  | "ambiguous_multiple_matches"
  | "blocked_or_captcha"
  | "failed";

export interface SourceMappingDiscoveryCandidate {
  canonical_property_name: string;
  aliases: string[];
  tier: "tier_anchor_high" | "tier_direct_mid" | "tier_budget_small" | "tier_monitor_only";
  target_sources: DiscoverySource[];
}

export interface SourceMappingDiscoveryResult {
  source: DiscoverySource;
  canonical_property_name: string;
  matched_name: string;
  source_slug_or_id: string;
  source_url: string;
  status: DiscoveryStatus;
  identity_confidence: "A" | "B" | "C";
  safe_to_enable_live: boolean;
  evidence: {
    page_title?: string;
    h1?: string;
    visible_property_name?: string;
    region_text?: string;
    url_match?: string;
    source_id_or_slug_match?: string;
    alias_match?: string;
  };
  rejection_reason: string;
  debug_artifact_path: string;
  searched_query: string;
}

// ---------------------------------------------------------------------------
// Candidate universe (work-order §3). target_sources exclude pairs already
// live-verified in marketRefreshTargetUniverse (dedup; the runner re-checks
// with isLiveVerified as well). Generic items in the work order
// (「ロッジ系」「ペンション系」「素泊まり宿」) are categories, not properties —
// they are represented as alias breadth on the concrete candidates, not as
// discovery candidates themselves.
export const DISCOVERY_CANDIDATES: readonly SourceMappingDiscoveryCandidate[] = [
  { canonical_property_name: "おおみや旅館", aliases: ["蔵王温泉 おおみや旅館", "omiya ryokan", "zao onsen omiya ryokan", "omiya-ryokan"], tier: "tier_direct_mid", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "ONSEN & STAY OAKHILL", aliases: ["オークヒル", "ホテルオークヒル", "蔵王温泉 ホテルオークヒル", "onsen & stay oakhill", "onsen&stay oakhill", "oakhill"], tier: "tier_direct_mid", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "源泉湯宿 蔵王プラザホテル", aliases: ["蔵王プラザホテル", "zao plaza hotel", "zao-plaza"], tier: "tier_direct_mid", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "ぼくのうち", aliases: ["蔵王温泉 ぼくのうち", "ペンションぼくのうち", "bokunouchi", "boku no uchi"], tier: "tier_budget_small", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "ロッジスガノ", aliases: ["ロッヂ スガノ", "ロッヂスガノ", "ロッジ スガノ", "lodge sugano", "rotudi-sugano", "sugano"], tier: "tier_budget_small", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "松尾ハウス", aliases: ["蔵王温泉 松尾ハウス", "matsuo house", "matsuo-house"], tier: "tier_budget_small", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "ＫＫＲ蔵王 白銀荘", aliases: ["KKR蔵王白銀荘", "KKR白銀荘", "ＫＫＲ蔵王白銀荘", "kkr zao hakuginso", "kkrzaohakuginso", "白銀荘"], tier: "tier_direct_mid", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "たかみや瑠璃倶楽", aliases: ["たかみや瑠璃倶楽リゾート", "瑠璃倶楽リゾート", "瑠璃倶楽", "rurikura resort", "rurikura"], tier: "tier_anchor_high", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "こけしの宿 招仙閣", aliases: ["招仙閣", "こけしの宿招仙閣", "shosenkaku"], tier: "tier_budget_small", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "名湯リゾート ルーセントタカミヤ", aliases: ["ルーセントタカミヤ", "名湯リゾート ルーセント", "takamiya hotel lucent", "lucent takamiya", "lucent-takamiya"], tier: "tier_anchor_high", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "名湯舎 創", aliases: ["名湯舎創", "meitoya so", "meitoya sou", "meitoya-sou", "ＭＥＩＴＯＹＡ ＳＯ"], tier: "tier_direct_mid", target_sources: ["booking", "jalan"] },
  { canonical_property_name: "蔵王・和歌（うた）の宿 わかまつや", aliases: ["わかまつや", "和歌の宿 わかまつや", "蔵王・和歌の宿 わかまつや", "wakamatsuya"], tier: "tier_direct_mid", target_sources: ["booking", "jalan"] },
  // Jalan-only gaps (Booking side already live-verified):
  { canonical_property_name: "深山荘 高見屋", aliases: ["深山荘高見屋", "深山荘 高見屋 －MIYAMASO TAKAMIYA－", "miyamaso takamiya"], tier: "tier_anchor_high", target_sources: ["jalan"] },
  { canonical_property_name: "蔵王国際ホテル", aliases: ["zao kokusai hotel", "蔵王国際"], tier: "tier_anchor_high", target_sources: ["jalan"] },
  { canonical_property_name: "蔵王四季のホテル", aliases: ["四季のホテル", "zao shiki no hotel"], tier: "tier_anchor_high", target_sources: ["jalan"] },
  // Booking-only gaps (Jalan side already live-verified):
  { canonical_property_name: "BED'n ONSEN HAMMOND", aliases: ["ホテルハモンドたかみや", "蔵王温泉 ホテルハモンドたかみや", "ハモンド", "hammond", "hammond-takamiya"], tier: "tier_direct_mid", target_sources: ["booking"] },
  { canonical_property_name: "吉田屋", aliases: ["蔵王温泉 吉田屋", "yoshidaya", "yoshida-ya"], tier: "tier_direct_mid", target_sources: ["booking"] },
  { canonical_property_name: "JURIN", aliases: ["蔵王温泉 JURIN", "ジュリン", "jurin"], tier: "tier_direct_mid", target_sources: ["booking"] },
  { canonical_property_name: "ホテル喜らく", aliases: ["喜らく", "kiraku", "hotel kiraku"], tier: "tier_direct_mid", target_sources: ["booking"] }
] as const;

// Phase 47X repo-internal seeds: Booking hotel slugs previously found via
// targeted PUBLIC first-party URL discovery (discoverMissingZaoSourceIds
// BUILT_IN_DISCOVERY_RESULTS). They are candidate URLs only — every one must
// pass the live identity probe before being verified.
export const BOOKING_SLUG_SEEDS: Readonly<Record<string, string>> = {
  "おおみや旅館": "omiya-ryokan-yamagata",
  "ONSEN & STAY OAKHILL": "onsen-amp-stay-oakhill",
  "源泉湯宿 蔵王プラザホテル": "zao-plaza",
  "たかみや瑠璃倶楽": "rurikura-resort",
  "名湯リゾート ルーセントタカミヤ": "lucent-takamiya",
  "BED'n ONSEN HAMMOND": "hammond-takamiya",
  "JURIN": "jurin",
  "名湯舎 創": "meitoya-sou",
  "蔵王・和歌（うた）の宿 わかまつや": "wakamatsuya"
};

// Phase AUTO-RUNNER16X-F — derive discovery candidates from the expanded Zao
// Onsen property master. Every master entry whose expected_sources include
// booking/jalan becomes a discovery candidate for those sources, carrying the
// master aliases. tier_monitor_only entries map onto our existing tier set as
// tier_budget_small (no separate discovery behavior). This is the source of
// truth the runner uses; the legacy DISCOVERY_CANDIDATES above is kept for the
// 16X-A4 tests and as a fallback.
export function discoveryCandidatesFromMaster(
  master: readonly {
    canonical_property_name: string;
    aliases: readonly string[];
    tier: "tier_anchor_high" | "tier_direct_mid" | "tier_budget_small" | "tier_monitor_only";
    expected_sources: readonly ("booking" | "jalan" | "rakuten" | "google_hotels")[];
  }[]
): SourceMappingDiscoveryCandidate[] {
  return master.map((e) => ({
    canonical_property_name: e.canonical_property_name,
    aliases: [...e.aliases],
    tier: e.tier,
    target_sources: e.expected_sources.filter((s): s is DiscoverySource => s === "booking" || s === "jalan")
  })).filter((c) => c.target_sources.length > 0);
}

// ---------------------------------------------------------------------------
// Extraction helpers.

/** Booking hotel slug from a /hotel/jp/<slug>(.<lang>)?.html URL; null otherwise. */
export function extractBookingSlug(input: string): string | null {
  const m = input.match(/booking\.com\/hotel\/jp\/([a-z0-9-]+)\.(?:[a-z]{2}(?:-[a-z]{2})?\.)?html/u);
  return m?.[1] ?? null;
}

export function bookingHotelUrl(slug: string): string {
  return `https://www.booking.com/hotel/jp/${slug}.ja.html`;
}

/** Jalan yadId ("yadNNNNNN") from a jalan.net/yadNNNNNN/ URL or bare id. */
export function extractJalanYadIdFromUrl(input: string): string | null {
  const m = input.match(/yad(\d{4,8})/u);
  if (m?.[1]) return `yad${m[1]}`;
  const bare = input.match(/^\s*(\d{4,8})\s*$/u);
  return bare?.[1] ? `yad${bare[1]}` : null;
}

export function jalanYadUrl(yadId: string): string {
  const id = yadId.startsWith("yad") ? yadId : `yad${yadId}`;
  return `https://www.jalan.net/${id}/`;
}

// ---------------------------------------------------------------------------
// Alias matching. Normalization: NFKC (full/half width), lowercase, strip
// spaces and common punctuation, fold ヂ→ジ / ヅ→ズ so OTA spelling variants
// (ロッヂ スガノ vs ロッジスガノ) still match.
export function normalizeForAliasMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ヂぢ]/gu, "ジ")
    .replace(/[ヅづ]/gu, "ズ")
    .replace(/[\s　・･,，.。'’‘"“”\-–—‐~〜（）()【】\[\]/／&＆]+/gu, "");
}

/** First alias (or canonical name) found inside text, after normalization. */
export function aliasHit(candidate: SourceMappingDiscoveryCandidate, text: string): string | null {
  const hay = normalizeForAliasMatch(text);
  if (hay === "") return null;
  for (const alias of [candidate.canonical_property_name, ...candidate.aliases]) {
    const needle = normalizeForAliasMatch(alias);
    if (needle.length >= 2 && hay.includes(needle)) return alias;
  }
  return null;
}

export interface DiscoveredPagePair {
  source: DiscoverySource;
  slug_or_id: string;
  display_name: string;
  url: string;
  found_on: string; // public list/search page URL the pair was extracted from
}

/** All pairs whose display name (or slug) matches a candidate alias, deduped by id. */
export function matchPairsToCandidate(
  candidate: SourceMappingDiscoveryCandidate,
  pairs: readonly DiscoveredPagePair[]
): DiscoveredPagePair[] {
  const out: DiscoveredPagePair[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    const hit = aliasHit(candidate, pair.display_name) ?? aliasHit(candidate, pair.slug_or_id);
    if (hit === null) continue;
    if (seen.has(pair.slug_or_id)) continue;
    seen.add(pair.slug_or_id);
    out.push(pair);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identity decision over a probed property page.

export interface DiscoveryProbeObservation {
  loaded: boolean;
  http_status: number;
  blocked_or_captcha: boolean;
  login_required: boolean;
  not_found_page: boolean;
  page_title: string;
  h1: string;
  visible_text: string;
  error: string;
}

const REGION_EVIDENCE_RE = /(蔵王温泉|蔵王|山形市|山形県|山形|zao\s*onsen|zao|yamagata|990-?2301)/iu;

function regionEvidence(text: string): string {
  const m = text.match(REGION_EVIDENCE_RE);
  return m?.[1] ?? "";
}

export function decideDiscovery(input: {
  candidate: SourceMappingDiscoveryCandidate;
  source: DiscoverySource;
  searched_query: string;
  matches: readonly DiscoveredPagePair[];
  probe?: DiscoveryProbeObservation | undefined;
}): Omit<SourceMappingDiscoveryResult, "debug_artifact_path"> {
  const { candidate, source, searched_query, matches, probe } = input;
  const base = {
    source,
    canonical_property_name: candidate.canonical_property_name,
    searched_query
  };
  const reject = (
    status: DiscoveryStatus,
    rejection_reason: string,
    extra: Partial<Pick<SourceMappingDiscoveryResult, "matched_name" | "source_slug_or_id" | "source_url" | "evidence">> = {}
  ): Omit<SourceMappingDiscoveryResult, "debug_artifact_path"> => ({
    ...base,
    matched_name: extra.matched_name ?? "",
    source_slug_or_id: extra.source_slug_or_id ?? "",
    source_url: extra.source_url ?? "",
    status,
    identity_confidence: "C",
    safe_to_enable_live: false,
    evidence: extra.evidence ?? {},
    rejection_reason
  });

  if (matches.length === 0) {
    return reject("not_found_after_public_search", "no_public_ota_page_matched_name_or_alias");
  }
  if (matches.length > 1) {
    return reject("ambiguous_multiple_matches", `multiple_distinct_matches: ${matches.map((m) => m.slug_or_id).join(",")}`, {
      evidence: { url_match: matches.map((m) => m.url).join(" | ") }
    });
  }

  const match = matches[0]!;
  const matchEvidence = {
    url_match: match.url,
    source_id_or_slug_match: match.slug_or_id,
    visible_property_name: match.display_name,
    alias_match: aliasHit(candidate, match.display_name) ?? aliasHit(candidate, match.slug_or_id) ?? ""
  };
  if (match.slug_or_id === "" || match.url === "") {
    return reject("not_found_after_public_search", "matched_pair_missing_slug_or_url", { matched_name: match.display_name, evidence: matchEvidence });
  }
  if (!probe) {
    return reject("failed", "identity_probe_not_executed", { matched_name: match.display_name, source_slug_or_id: match.slug_or_id, source_url: match.url, evidence: matchEvidence });
  }
  if (!probe.loaded || probe.error !== "") {
    return reject("failed", probe.error || "page_not_loaded", { matched_name: match.display_name, source_slug_or_id: match.slug_or_id, source_url: match.url, evidence: matchEvidence });
  }
  if (probe.blocked_or_captcha || probe.login_required) {
    return reject("blocked_or_captcha", probe.login_required ? "login_required" : "blocked_or_captcha", { matched_name: match.display_name, source_slug_or_id: match.slug_or_id, source_url: match.url, evidence: matchEvidence });
  }
  if (probe.not_found_page || probe.http_status === 404 || probe.http_status === 410) {
    return reject("not_found_after_public_search", `property_page_gone (http_status=${probe.http_status})`, { matched_name: match.display_name, source_slug_or_id: match.slug_or_id, source_url: match.url, evidence: matchEvidence });
  }

  const haystack = `${probe.page_title}\n${probe.h1}\n${probe.visible_text}`;
  const nameAlias = aliasHit(candidate, haystack);
  const region = regionEvidence(haystack);
  const evidence = {
    ...matchEvidence,
    page_title: probe.page_title.slice(0, 200),
    h1: probe.h1.slice(0, 200),
    region_text: region,
    alias_match: nameAlias ?? matchEvidence.alias_match
  };

  if (nameAlias !== null && region !== "") {
    return {
      ...base,
      matched_name: match.display_name,
      source_slug_or_id: match.slug_or_id,
      source_url: match.url,
      status: "verified",
      identity_confidence: "A",
      safe_to_enable_live: true,
      evidence,
      rejection_reason: ""
    };
  }
  if (nameAlias !== null) {
    return {
      ...base,
      matched_name: match.display_name,
      source_slug_or_id: match.slug_or_id,
      source_url: match.url,
      status: "candidate_found_needs_review",
      identity_confidence: "B",
      safe_to_enable_live: false,
      evidence,
      rejection_reason: "region_not_confirmed_on_property_page"
    };
  }
  return {
    ...base,
    matched_name: match.display_name,
    source_slug_or_id: match.slug_or_id,
    source_url: match.url,
    status: "candidate_found_needs_review",
    identity_confidence: "C",
    safe_to_enable_live: false,
    evidence,
    rejection_reason: "name_not_confirmed_on_property_page"
  };
}

/** True when this (source, candidate) pair should be skipped: already live. */
export function alreadyLiveVerified(source: DiscoverySource, slugOrId: string): boolean {
  return slugOrId !== "" && isLiveVerified(source, slugOrId);
}

// ---------------------------------------------------------------------------
// Summary / rendering.

export interface DiscoverySummary {
  booking_verified_new: number;
  jalan_verified_new: number;
  needs_review_count: number;
  not_found_count: number;
  ambiguous_count: number;
  blocked_or_captcha_count: number;
  failed_count: number;
}

export function summarizeDiscovery(results: readonly SourceMappingDiscoveryResult[]): DiscoverySummary {
  const by = (s: DiscoveryStatus): number => results.filter((r) => r.status === s).length;
  return {
    booking_verified_new: results.filter((r) => r.status === "verified" && r.source === "booking").length,
    jalan_verified_new: results.filter((r) => r.status === "verified" && r.source === "jalan").length,
    needs_review_count: by("candidate_found_needs_review"),
    not_found_count: by("not_found_after_public_search"),
    ambiguous_count: by("ambiguous_multiple_matches"),
    blocked_or_captcha_count: by("blocked_or_captcha"),
    failed_count: by("failed")
  };
}

export const DISCOVERY_CSV_HEADERS = [
  "source", "canonical_property_name", "matched_name", "source_slug_or_id", "source_url",
  "status", "identity_confidence", "safe_to_enable_live", "rejection_reason", "searched_query"
] as const;

function csvCell(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

export function renderDiscoveryCsv(results: readonly SourceMappingDiscoveryResult[]): string {
  const body = results.map((r) =>
    [r.source, r.canonical_property_name, r.matched_name, r.source_slug_or_id, r.source_url, r.status, r.identity_confidence, String(r.safe_to_enable_live), r.rejection_reason, r.searched_query]
      .map(csvCell).join(",")
  );
  return [DISCOVERY_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderDiscoveryReport(input: {
  generatedAtJst: string;
  dryRun: boolean;
  pagesUsed: number;
  maxPages: number;
  results: readonly SourceMappingDiscoveryResult[];
  summary: DiscoverySummary;
  liveBookingBefore: number;
  liveJalanBefore: number;
}): string {
  const { results, summary } = input;
  const failedLines = results
    .filter((r) => !r.safe_to_enable_live)
    .map((r) => [
      `- property: ${r.canonical_property_name}`,
      `  - source: ${r.source}`,
      `  - searched query: ${r.searched_query || "(public area listing scan)"}`,
      `  - candidate_url: ${r.source_url || "(none found)"}`,
      `  - status: ${r.status}`,
      `  - reason: ${r.rejection_reason}`,
      `  - missing evidence: ${r.status === "not_found_after_public_search" ? "no public OTA property page matched name+region" : r.status === "candidate_found_needs_review" ? "identity confidence below A (need name+region on the property page)" : r.status === "ambiguous_multiple_matches" ? "a single unambiguous property page" : "clean page load"}`,
      `  - next manual action: ${r.status === "not_found_after_public_search" ? "provide the OTA property URL manually if the property is listed" : "open the candidate_url manually and confirm identity, then add to universe by hand"}`
    ].join("\n"))
    .join("\n");
  return `# Source Mapping Discovery (AUTO-RUNNER16X-A4)

Generated at JST: ${input.generatedAtJst}
Mode: ${input.dryRun ? "dry-run (report/debug artifacts only; no universe/history/db/ai mutation)" : "report-only (this script never mutates universe/history/db/ai)"}
Public pages used: ${input.pagesUsed} / ${input.maxPages}

## Summary
${JSON.stringify(summary, null, 2)}

## Verified totals (live universe before -> after manual promotion of safe rows)
- booking: ${input.liveBookingBefore} -> ${input.liveBookingBefore + summary.booking_verified_new}
- jalan: ${input.liveJalanBefore} -> ${input.liveJalanBefore + summary.jalan_verified_new}

## Results
${results.map((r) => `- [${r.status}] ${r.source} ${r.canonical_property_name} -> ${r.source_slug_or_id || "(no id)"} confidence=${r.identity_confidence} safe_to_enable_live=${r.safe_to_enable_live} ${r.source_url ? `url=${r.source_url}` : ""}${r.rejection_reason ? ` reason=${r.rejection_reason}` : ""}`).join("\n")}

## Unverified candidates (evidence for manual follow-up)
${failedLines || "- (none)"}

## Safety
- identity-only discovery on public OTA pages; no price collection, no booking flow, no login/cookies, no captcha bypass, no stealth, no paid proxy/scraping service.
- blocked/captcha/login candidates are never verified.
- verified requires: concrete slug/yadId + property page URL + name/alias match + region match on the live page.
`;
}
