import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOKING_SLUG_SEEDS,
  DISCOVERY_CANDIDATES,
  aliasHit,
  alreadyLiveVerified,
  bookingHotelUrl,
  decideDiscovery,
  extractBookingSlug,
  extractJalanYadIdFromUrl,
  jalanYadUrl,
  matchPairsToCandidate,
  normalizeForAliasMatch,
  renderDiscoveryCsv,
  summarizeDiscovery,
  type DiscoveredPagePair,
  type DiscoveryProbeObservation,
  type SourceMappingDiscoveryCandidate,
  type SourceMappingDiscoveryResult
} from "../src/services/sourceMappingDiscovery";
import { liveTargets } from "../src/services/marketRefreshTargetUniverse";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/sourceMappingDiscovery.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runSourceMappingDiscovery.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const OMIYA: SourceMappingDiscoveryCandidate = {
  canonical_property_name: "おおみや旅館",
  aliases: ["蔵王温泉 おおみや旅館", "omiya ryokan", "zao onsen omiya ryokan"],
  tier: "tier_direct_mid",
  target_sources: ["booking", "jalan"]
};

const SUGANO: SourceMappingDiscoveryCandidate = {
  canonical_property_name: "ロッジスガノ",
  aliases: ["ロッヂ スガノ", "lodge sugano", "rotudi-sugano"],
  tier: "tier_budget_small",
  target_sources: ["booking", "jalan"]
};

function pair(over: Partial<DiscoveredPagePair>): DiscoveredPagePair {
  return { source: "jalan", slug_or_id: "yad338565", display_name: "蔵王温泉 おおみや旅館", url: "https://www.jalan.net/yad338565/", found_on: "list", ...over };
}

function cleanProbe(over: Partial<DiscoveryProbeObservation> = {}): DiscoveryProbeObservation {
  return {
    loaded: true,
    http_status: 200,
    blocked_or_captcha: false,
    login_required: false,
    not_found_page: false,
    page_title: "蔵王温泉 おおみや旅館【公式】",
    h1: "蔵王温泉 おおみや旅館",
    visible_text: "山形県山形市蔵王温泉 46 高湯通り",
    error: "",
    ...over
  };
}

describe("16X-A4 discovery — URL/id extraction", () => {
  it("extracts Jalan yadId from URL forms", () => {
    expect(extractJalanYadIdFromUrl("https://www.jalan.net/yad338565/")).toBe("yad338565");
    expect(extractJalanYadIdFromUrl("yad327282")).toBe("yad327282");
    expect(extractJalanYadIdFromUrl("338565")).toBe("yad338565");
    expect(extractJalanYadIdFromUrl("https://www.jalan.net/")).toBeNull();
    expect(jalanYadUrl("yad338565")).toBe("https://www.jalan.net/yad338565/");
    expect(jalanYadUrl("338565")).toBe("https://www.jalan.net/yad338565/");
  });

  it("extracts Booking hotel slug from jp hotel URLs only", () => {
    expect(extractBookingSlug("https://www.booking.com/hotel/jp/zao-plaza.ja.html")).toBe("zao-plaza");
    expect(extractBookingSlug("https://www.booking.com/hotel/jp/omiya-ryokan-yamagata.html")).toBe("omiya-ryokan-yamagata");
    expect(extractBookingSlug("https://www.booking.com/hotel/jp/le-vert-zao.en-gb.html")).toBe("le-vert-zao");
    expect(extractBookingSlug("https://www.booking.com/searchresults.ja.html?ss=zao")).toBeNull();
    expect(extractBookingSlug("https://www.booking.com/hotel/fr/paris.html")).toBeNull();
    expect(bookingHotelUrl("zao-plaza")).toBe("https://www.booking.com/hotel/jp/zao-plaza.ja.html");
  });
});

describe("16X-A4 discovery — alias/name matching", () => {
  it("normalization folds width, case, spacing and ヂ/ジ variants", () => {
    expect(normalizeForAliasMatch("ロッヂ　スガノ")).toBe(normalizeForAliasMatch("ロッジスガノ"));
    expect(normalizeForAliasMatch("ＫＫＲ蔵王 白銀荘")).toBe(normalizeForAliasMatch("KKR蔵王白銀荘"));
    expect(normalizeForAliasMatch("ONSEN & STAY OAKHILL")).toBe(normalizeForAliasMatch("onsen&stay oakhill"));
  });

  it("matches candidate aliases against OTA display names", () => {
    expect(aliasHit(OMIYA, "蔵王温泉おおみや旅館")).not.toBeNull();
    expect(aliasHit(OMIYA, "Zao Onsen Omiya Ryokan（蔵王温泉）")).not.toBeNull();
    expect(aliasHit(SUGANO, "ロッヂ　スガノ")).not.toBeNull();
    expect(aliasHit(OMIYA, "松金や ANNEX")).toBeNull();
    expect(aliasHit(OMIYA, "")).toBeNull();
  });

  it("does not cross-match similar Zao properties", () => {
    const matsuo: SourceMappingDiscoveryCandidate = { canonical_property_name: "松尾ハウス", aliases: ["matsuo house"], tier: "tier_budget_small", target_sources: ["jalan"] };
    expect(aliasHit(matsuo, "ホテル松金屋アネックス")).toBeNull();
    expect(aliasHit(matsuo, "Green Season - 民泊 Matsuo House in Zao Onsen")).not.toBeNull();
  });

  it("matchPairsToCandidate dedupes ids and matches by name or slug", () => {
    const pairs = [
      pair({}),
      pair({}), // duplicate id
      pair({ slug_or_id: "yad999999", display_name: "えびや旅館" }),
      pair({ source: "booking", slug_or_id: "omiya-ryokan-yamagata", display_name: "（表示名なし）", url: "https://www.booking.com/hotel/jp/omiya-ryokan-yamagata.ja.html" })
    ];
    const matches = matchPairsToCandidate({ ...OMIYA, aliases: [...OMIYA.aliases, "omiya-ryokan-yamagata"] }, pairs);
    expect(matches.map((m) => m.slug_or_id)).toEqual(["yad338565", "omiya-ryokan-yamagata"]);
  });
});

describe("16X-A4 discovery — verification decision", () => {
  it("verifies only with id + name match + region match on a clean page", () => {
    const result = decideDiscovery({ candidate: OMIYA, source: "jalan", searched_query: "q", matches: [pair({})], probe: cleanProbe() });
    expect(result.status).toBe("verified");
    expect(result.identity_confidence).toBe("A");
    expect(result.safe_to_enable_live).toBe(true);
    expect(result.source_slug_or_id).toBe("yad338565");
    expect(result.source_url).toContain("/yad338565/");
    expect(result.evidence.page_title).toContain("おおみや");
    expect(result.evidence.region_text).not.toBe("");
  });

  it("no public match -> not_found_after_public_search, never live", () => {
    const result = decideDiscovery({ candidate: OMIYA, source: "booking", searched_query: "q", matches: [] });
    expect(result.status).toBe("not_found_after_public_search");
    expect(result.safe_to_enable_live).toBe(false);
    expect(result.source_slug_or_id).toBe("");
  });

  it("multiple distinct matches -> ambiguous, never live", () => {
    const result = decideDiscovery({
      candidate: OMIYA,
      source: "jalan",
      searched_query: "q",
      matches: [pair({}), pair({ slug_or_id: "yad111111", display_name: "おおみや旅館 別館" })],
      probe: cleanProbe()
    });
    expect(result.status).toBe("ambiguous_multiple_matches");
    expect(result.safe_to_enable_live).toBe(false);
  });

  it("blocked/captcha or login pages are never verified", () => {
    for (const probe of [cleanProbe({ blocked_or_captcha: true }), cleanProbe({ login_required: true })]) {
      const result = decideDiscovery({ candidate: OMIYA, source: "booking", searched_query: "q", matches: [pair({})], probe });
      expect(result.status).toBe("blocked_or_captcha");
      expect(result.safe_to_enable_live).toBe(false);
    }
  });

  it("name match without region -> needs_review (B), not live", () => {
    const result = decideDiscovery({
      candidate: OMIYA,
      source: "jalan",
      searched_query: "q",
      matches: [pair({})],
      probe: cleanProbe({ page_title: "おおみや旅館", h1: "おおみや旅館", visible_text: "ご予約はこちら" })
    });
    expect(result.status).toBe("candidate_found_needs_review");
    expect(result.identity_confidence).toBe("B");
    expect(result.safe_to_enable_live).toBe(false);
  });

  it("page without the property name -> needs_review (C), not live", () => {
    const result = decideDiscovery({
      candidate: OMIYA,
      source: "jalan",
      searched_query: "q",
      matches: [pair({})],
      probe: cleanProbe({ page_title: "別の宿", h1: "別の宿", visible_text: "山形県の宿" })
    });
    expect(result.status).toBe("candidate_found_needs_review");
    expect(result.identity_confidence).toBe("C");
    expect(result.safe_to_enable_live).toBe(false);
  });

  it("404 / gone property pages are not verified", () => {
    const result = decideDiscovery({ candidate: OMIYA, source: "jalan", searched_query: "q", matches: [pair({})], probe: cleanProbe({ http_status: 404, not_found_page: true }) });
    expect(result.status).toBe("not_found_after_public_search");
    expect(result.safe_to_enable_live).toBe(false);
  });

  it("load failure -> failed, not live", () => {
    const result = decideDiscovery({ candidate: OMIYA, source: "jalan", searched_query: "q", matches: [pair({})], probe: cleanProbe({ loaded: false, error: "timeout" }) });
    expect(result.status).toBe("failed");
    expect(result.safe_to_enable_live).toBe(false);
  });

  it("a match without slug or url can never be verified", () => {
    const result = decideDiscovery({ candidate: OMIYA, source: "jalan", searched_query: "q", matches: [pair({ slug_or_id: "", url: "" })], probe: cleanProbe() });
    expect(result.safe_to_enable_live).toBe(false);
    expect(result.status).toBe("not_found_after_public_search");
  });
});

describe("16X-A4 discovery — candidate universe & dedup", () => {
  it("candidates only target booking/jalan", () => {
    expect(DISCOVERY_CANDIDATES.every((c) => c.target_sources.every((s) => s === "booking" || s === "jalan"))).toBe(true);
    expect(DISCOVERY_CANDIDATES.length).toBeGreaterThanOrEqual(15);
  });

  it("booking seeds map onto declared candidates", () => {
    const names = new Set(DISCOVERY_CANDIDATES.map((c) => c.canonical_property_name));
    for (const seedName of Object.keys(BOOKING_SLUG_SEEDS)) {
      expect(names.has(seedName)).toBe(true);
    }
  });

  it("alreadyLiveVerified matches the live universe and rejects empty ids", () => {
    const live = liveTargets();
    expect(live.length).toBeGreaterThan(0);
    const first = live[0]!;
    expect(alreadyLiveVerified(first.source as "booking" | "jalan", first.property_slug)).toBe(true);
    expect(alreadyLiveVerified("booking", "")).toBe(false);
    expect(alreadyLiveVerified("booking", "no-such-slug")).toBe(false);
  });
});

describe("16X-A4 discovery — summary & csv", () => {
  const mk = (over: Partial<SourceMappingDiscoveryResult>): SourceMappingDiscoveryResult => ({
    source: "booking",
    canonical_property_name: "x",
    matched_name: "x",
    source_slug_or_id: "slug",
    source_url: "https://www.booking.com/hotel/jp/slug.ja.html",
    status: "verified",
    identity_confidence: "A",
    safe_to_enable_live: true,
    evidence: {},
    rejection_reason: "",
    debug_artifact_path: "",
    searched_query: "q, with comma",
    ...over
  });

  it("summarize counts by status and source", () => {
    const s = summarizeDiscovery([
      mk({}),
      mk({ source: "jalan" }),
      mk({ status: "candidate_found_needs_review", safe_to_enable_live: false }),
      mk({ status: "not_found_after_public_search", safe_to_enable_live: false }),
      mk({ status: "ambiguous_multiple_matches", safe_to_enable_live: false }),
      mk({ status: "blocked_or_captcha", safe_to_enable_live: false }),
      mk({ status: "failed", safe_to_enable_live: false })
    ]);
    expect(s).toEqual({
      booking_verified_new: 1,
      jalan_verified_new: 1,
      needs_review_count: 1,
      not_found_count: 1,
      ambiguous_count: 1,
      blocked_or_captcha_count: 1,
      failed_count: 1
    });
  });

  it("csv quotes commas and includes all rows", () => {
    const csv = renderDiscoveryCsv([mk({})]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("source_slug_or_id");
    expect(lines[1]).toContain('"q, with comma"');
  });
});

describe("16X-A4 discovery — static safety", () => {
  it("no paid scraping/proxy/stealth/cookie injection/captcha bypass anywhere", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/serpapi|brightdata|smartproxy|scrapingbee|zenrows|2captcha|solveCaptcha|stealth-plugin|StealthPlugin|addCookies|storageState|proxy:\s*\{/iu);
  });

  it("runner writes only discovery report/debug artifacts (no history/db/ai mutation)", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/historyToDb|localHistory|persistCollectorResult|better-sqlite3|aiContext|chatGptDb|publish/iu);
    expect(SCRIPT_SOURCE).toContain(".data/reports/source-mapping-discovery");
    expect(SCRIPT_SOURCE).toContain(".data/debug/source-mapping-discovery");
  });

  it("runner does not collect price or enter the booking flow", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/normalized_total_price|予約する|checkout|add_to_cart|reservation/iu);
  });

  it("package wires discover:source-mappings", () => {
    expect(PACKAGE_JSON).toContain('"discover:source-mappings"');
  });
});
