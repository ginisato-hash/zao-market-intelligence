// Phase AUTO-RUNNER16X — market refresh target universe (pure data + helpers).
//
// Defines the verified live target set (Booking/Jalan) plus candidate_only
// properties that are NOT live-collected until their collector mapping is
// verified in a dedicated phase. No invented slugs/ids: candidates carry an
// empty source key and verified_mapping=false. Rakuten/Google remain disabled.

export type TargetSource = "booking" | "jalan" | "rakuten" | "google_hotels";
export type TargetTier =
  | "tier_anchor_high"
  | "tier_direct_mid"
  | "tier_budget_small"
  | "tier_monitor_only";

export interface MarketRefreshPropertyTarget {
  source: TargetSource;
  canonical_property_name: string;
  property_slug: string;
  source_property_id?: string;
  source_url?: string;
  tier: TargetTier;
  enabled_for_live: boolean;
  verified_mapping: boolean;
  verification_note: string;
}

// Verified live targets — proven collector mappings already used by
// autoRunnerBookingPreview (Booking slugs) and autoRunnerMarketRefresh (Jalan yads).
export const VERIFIED_LIVE_TARGETS: readonly MarketRefreshPropertyTarget[] = [
  // Booking — anchor-high price references
  { source: "booking", canonical_property_name: "蔵王国際ホテル", property_slug: "zao-kokusai", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified_booking_rendered_dom_probe" },
  { source: "booking", canonical_property_name: "蔵王四季のホテル", property_slug: "zao-shiki-no", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified_booking_rendered_dom_probe" },
  { source: "booking", canonical_property_name: "深山荘 高見屋", property_slug: "shinzanso-takamiya", tier: "tier_anchor_high", enabled_for_live: true, verified_mapping: true, verification_note: "verified_booking_rendered_dom_probe" },
  // Jalan — direct-competitor mid tier
  { source: "jalan", canonical_property_name: "ホテル喜らく", property_slug: "yad325153", source_property_id: "yad325153", source_url: "https://www.jalan.net/yad325153/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified_jalan_bounded_collection" },
  { source: "jalan", canonical_property_name: "ル・ベール蔵王", property_slug: "yad328232", source_property_id: "yad328232", source_url: "https://www.jalan.net/yad328232/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified_jalan_bounded_collection" },
  { source: "jalan", canonical_property_name: "HAMMOND", property_slug: "yad348320", source_property_id: "yad348320", source_url: "https://www.jalan.net/yad348320/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified_jalan_bounded_collection" },
  { source: "jalan", canonical_property_name: "吉田屋", property_slug: "yad327282", source_property_id: "yad327282", source_url: "https://www.jalan.net/yad327282/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified_jalan_bounded_collection" },
  { source: "jalan", canonical_property_name: "JURIN", property_slug: "yad332556", source_property_id: "yad332556", source_url: "https://www.jalan.net/yad332556/", tier: "tier_direct_mid", enabled_for_live: true, verified_mapping: true, verification_note: "verified_jalan_bounded_collection" }
] as const;

// Candidate-only properties — NOT live-collected. No slug/id is invented; these
// require a dedicated verification phase (probe collector mapping) before any
// can be promoted to VERIFIED_LIVE_TARGETS. Listed for coverage/roadmap only.
export const CANDIDATE_ONLY_TARGETS: readonly MarketRefreshPropertyTarget[] = [
  { source: "booking", canonical_property_name: "おおみや旅館", property_slug: "", tier: "tier_anchor_high", enabled_for_live: false, verified_mapping: false, verification_note: "mapping_not_verified_requires_probe" },
  { source: "jalan", canonical_property_name: "OAKHILL", property_slug: "", tier: "tier_direct_mid", enabled_for_live: false, verified_mapping: false, verification_note: "mapping_not_verified_requires_probe" },
  { source: "jalan", canonical_property_name: "蔵王プラザホテル", property_slug: "", tier: "tier_direct_mid", enabled_for_live: false, verified_mapping: false, verification_note: "mapping_not_verified_requires_probe" },
  { source: "booking", canonical_property_name: "ペンション・ロッジ系（蔵王温泉）", property_slug: "", tier: "tier_budget_small", enabled_for_live: false, verified_mapping: false, verification_note: "mapping_not_verified_requires_probe" }
] as const;

export function liveTargets(source?: TargetSource): MarketRefreshPropertyTarget[] {
  return VERIFIED_LIVE_TARGETS.filter((t) => t.enabled_for_live && t.verified_mapping && (source === undefined || t.source === source));
}

export function liveBookingTargets(): MarketRefreshPropertyTarget[] {
  return liveTargets("booking");
}

export function liveJalanTargets(): MarketRefreshPropertyTarget[] {
  return liveTargets("jalan");
}

export function candidateTargets(): MarketRefreshPropertyTarget[] {
  return [...CANDIDATE_ONLY_TARGETS];
}

export function tierOf(source: TargetSource, propertySlug: string): TargetTier | null {
  return VERIFIED_LIVE_TARGETS.find((t) => t.source === source && t.property_slug === propertySlug)?.tier ?? null;
}

export function isLiveVerified(source: TargetSource, propertySlug: string): boolean {
  return VERIFIED_LIVE_TARGETS.some((t) => t.source === source && t.property_slug === propertySlug && t.enabled_for_live && t.verified_mapping);
}

export interface UniverseSummary {
  booking_live_verified: number;
  jalan_live_verified: number;
  rakuten_live: number;
  google_hotels_live: number;
  candidate_only: number;
  by_tier: Record<string, number>;
}

export function summarizeUniverse(): UniverseSummary {
  const byTier: Record<string, number> = {};
  for (const t of VERIFIED_LIVE_TARGETS) byTier[t.tier] = (byTier[t.tier] ?? 0) + 1;
  return {
    booking_live_verified: liveBookingTargets().length,
    jalan_live_verified: liveJalanTargets().length,
    rakuten_live: 0,
    google_hotels_live: 0,
    candidate_only: CANDIDATE_ONLY_TARGETS.length,
    by_tier: byTier
  };
}
