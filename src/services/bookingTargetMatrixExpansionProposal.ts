// Phase BOOKING-B08X — Booking.com target matrix expansion proposal.
//
// Proposal-only, pure planning layer. This module performs no live Booking fetch,
// no Playwright/browser work, no DB writes, no .data/history append, no AI context
// refresh, no PMS/Beds24/AirHost/OTA output, and no Booking base * 1.1 logic.

import { buildBookingRenderedDomUrl, checkoutForOneNight } from "./bookingRenderedDomProbe";

export type BookingTargetMatrixExpansionDecision =
  | "booking_target_matrix_expansion_proposal_ready"
  | "booking_target_matrix_expansion_proposal_basis_caution"
  | "booking_target_matrix_expansion_proposal_not_ready";

export const B08X_B07B_EXPECTED_DECISION = "post_booking_history_append_refresh_basis_caution";
export const B08X_PRICE_POLICY_VERSION = "booking_official_visible_adder_v1";

export const B05X_VERIFIED_SLUGS = [
  { canonical_property_name: "蔵王国際ホテル", slug: "zao-kokusai", source_artifact: "B05X fixed verified target" },
  { canonical_property_name: "蔵王四季のホテル", slug: "zao-shiki-no", source_artifact: "B05X fixed verified target" },
  { canonical_property_name: "深山荘 高見屋", slug: "shinzanso-takamiya", source_artifact: "B05X fixed verified target" }
] as const;

export const HIGH_VALUE_ANCHORS = [
  "蔵王国際ホテル",
  "蔵王四季のホテル",
  "深山荘 高見屋",
  "名湯リゾート ルーセント",
  "JURIN",
  "ONSEN & STAY OAKHILL",
  "BED'n ONSEN HAMMOND",
  "おおみや旅館",
  "源泉湯宿 蔵王プラザホテル",
  "ル・ベール蔵王"
] as const;

export const DATE_WINDOW_STRATEGY = [
  {
    bucket: "near_term_movement",
    purpose: "short-term price pressure and availability changes",
    dates: ["2026-06-07", "2026-06-14", "2026-06-21", "2026-06-28"]
  },
  {
    bucket: "summer_holiday_pressure",
    purpose: "summer holiday / Obon / peak domestic-inbound pressure",
    dates: ["2026-07-18", "2026-07-19", "2026-07-20", "2026-08-08", "2026-08-12", "2026-08-15"]
  },
  {
    bucket: "autumn_leaf_long_weekend",
    purpose: "autumn foliage / long-weekend pressure",
    dates: ["2026-09-19", "2026-09-20", "2026-09-21", "2026-10-10", "2026-10-11", "2026-10-12"]
  },
  {
    bucket: "winter_early_signal",
    purpose: "early ski-season / snow-demand signal",
    dates: ["2026-12-05", "2026-12-12", "2026-12-19"]
  }
] as const;

export const DEFAULT_FIRST_EXPANSION_DATES = [
  "2026-06-07",
  "2026-06-14",
  "2026-06-21",
  "2026-06-28",
  "2026-07-18",
  "2026-08-12",
  "2026-08-15",
  "2026-09-19",
  "2026-10-10",
  "2026-12-12"
] as const;

export interface CurrentBookingContext {
  history_rows: number;
  db_market_signal_history_rows: number;
  ai_context_row_count: number;
  booking_rows: number;
  booking_directional_rows: number;
  booking_excluded_rows: number;
  booking_direct_rows: number;
  b07b_decision: string;
  rakuten_priority_decision: "NO_GO_FREEZE_RAKUTEN";
}

export interface LocalBookingSlugEvidence {
  canonical_property_name: string;
  slug: string;
  source_artifact: string;
  evidence_note: string;
  feasibility_note: string;
}

export interface VerifiedBookingProperty {
  canonical_property_name: string;
  booking_slug: string;
  booking_url: string;
  slug_status: "verified_b05x" | "verified_local_artifact";
  source_artifact: string;
  risk_level: "low" | "medium" | "high";
  include_in_b09x_live_collection: boolean;
  evidence_note: string;
}

export interface MissingBookingSlugCandidate {
  canonical_property_name: string;
  possible_existing_sources: string[];
  booking_slug_status: "missing_booking_slug";
  recommended_action: "manual_slug_review" | "exclude_from_next_live_collection";
  manual_review_needed: true;
  do_not_include_in_b09x_live_collection: true;
  evidence_note: string;
}

export interface ProposedBookingTargetCell {
  canonical_property_name: string;
  booking_slug: string;
  checkin: string;
  checkout: string;
  url: string;
  query_scope: "2_adults_1_room_1_night_jpy_ja";
  slug_status: VerifiedBookingProperty["slug_status"];
  risk_level: VerifiedBookingProperty["risk_level"];
}

export interface PageCapPlan {
  max_properties: number;
  max_dates_per_property: number;
  max_pages: number;
  proposed_properties: number;
  proposed_dates_per_property: number;
  proposed_pages: number;
  caps_respected: boolean;
  note: string;
}

export interface PriceBasisPolicy {
  policy_version: string;
  computed_total_rule: "primary_price_numeric + official_tax_fee_adder_numeric";
  forbidden_rule: "primary_price_numeric * 1.1";
  valid_rows: {
    basis_confidence: "B";
    dp_usage: "directional";
    price_pressure_usable: true;
    dp_usable: false;
  };
  missing_official_adder_rows: {
    basis_confidence: "C";
    dp_usage: "excluded";
    price_pressure_usable: false;
    dp_usable: false;
    exclusion_reason: "missing_official_tax_fee_adder";
  };
  booking_direct_rows_allowed: 0;
}

export interface RiskAssessment {
  overall_risk: "medium";
  risks: string[];
  fallback_plan: string[];
}

export interface FutureB09XPlan {
  phase: "BOOKING-B09X — Bounded expanded Booking.com normalized collection";
  collection_rules: string[];
  blocked_handling: string[];
  not_allowed: string[];
}

export interface SafetyConfirmation {
  live_booking_fetch: false;
  playwright_used: false;
  db_writes: false;
  history_append: false;
  ai_context_refresh: false;
  booking_search_scraping: false;
  slug_invention: false;
  pms_beds24_airhost_ota_output: false;
  price_update: false;
  paid_source_tooling: false;
  booking_base_times_1_1: false;
  rakuten_restart: false;
  jalan_automation_start: false;
  started_next_phase: false;
}

export interface BookingTargetMatrixExpansionProposal {
  run_id: string;
  generated_at_jst: string;
  decision: BookingTargetMatrixExpansionDecision;
  source_b07b_artifact_path: string;
  current_booking_context: CurrentBookingContext;
  verified_booking_properties: VerifiedBookingProperty[];
  missing_booking_slug_candidates: MissingBookingSlugCandidate[];
  date_window_strategy: typeof DATE_WINDOW_STRATEGY;
  proposed_b09x_target_matrix: ProposedBookingTargetCell[];
  page_cap_plan: PageCapPlan;
  price_basis_policy: PriceBasisPolicy;
  risk_assessment: RiskAssessment;
  future_b09x_plan: FutureB09XPlan;
  safety_confirmation: SafetyConfirmation;
  report_path: string;
  json_path: string;
  csv_path: string;
  debug_artifact_path: string;
}

export function extractBookingSlug(url: string): string | null {
  const match = /^https:\/\/www\.booking\.com\/hotel\/jp\/([^/.?#]+)(?:\.[a-z-]+)?\.html(?:[?#].*)?$/u.exec(url.trim());
  return match?.[1] ?? null;
}

export function buildBookingPropertyUrl(slug: string): string {
  return `https://www.booking.com/hotel/jp/${slug}.ja.html`;
}

export function buildVerifiedBookingProperties(extraEvidence: readonly LocalBookingSlugEvidence[]): VerifiedBookingProperty[] {
  const byName = new Map<string, VerifiedBookingProperty>();
  for (const item of B05X_VERIFIED_SLUGS) {
    byName.set(item.canonical_property_name, {
      canonical_property_name: item.canonical_property_name,
      booking_slug: item.slug,
      booking_url: buildBookingPropertyUrl(item.slug),
      slug_status: "verified_b05x",
      source_artifact: item.source_artifact,
      risk_level: "low",
      include_in_b09x_live_collection: true,
      evidence_note: "Fixed verified B05X Booking.com target; already flowed through B07X/B07B."
    });
  }
  for (const evidence of extraEvidence) {
    if (!HIGH_VALUE_ANCHORS.includes(evidence.canonical_property_name as (typeof HIGH_VALUE_ANCHORS)[number])) continue;
    if (byName.has(evidence.canonical_property_name)) continue;
    byName.set(evidence.canonical_property_name, {
      canonical_property_name: evidence.canonical_property_name,
      booking_slug: evidence.slug,
      booking_url: buildBookingPropertyUrl(evidence.slug),
      slug_status: "verified_local_artifact",
      source_artifact: evidence.source_artifact,
      risk_level: evidence.feasibility_note.toLowerCase().includes("varies") ? "medium" : "low",
      include_in_b09x_live_collection: true,
      evidence_note: evidence.evidence_note
    });
  }
  return [...byName.values()].sort(
    (a, b) => HIGH_VALUE_ANCHORS.indexOf(a.canonical_property_name as never) - HIGH_VALUE_ANCHORS.indexOf(b.canonical_property_name as never)
  );
}

export function buildMissingBookingSlugCandidates(input: {
  verified: readonly VerifiedBookingProperty[];
  sourceCoverage: Record<string, string[]>;
}): MissingBookingSlugCandidate[] {
  const verifiedNames = new Set(input.verified.map((p) => p.canonical_property_name));
  return HIGH_VALUE_ANCHORS.filter((name) => !verifiedNames.has(name)).map((name) => ({
    canonical_property_name: name,
    possible_existing_sources: input.sourceCoverage[name] ?? [],
    booking_slug_status: "missing_booking_slug",
    recommended_action: "manual_slug_review",
    manual_review_needed: true,
    do_not_include_in_b09x_live_collection: true,
    evidence_note: "No verified Booking.com slug was found in local artifacts; do not invent a slug from the property name."
  }));
}

export function buildPageCapPlan(verifiedCount: number): PageCapPlan {
  const maxProperties = verifiedCount <= 3 ? 3 : 5;
  const maxDatesPerProperty = verifiedCount <= 3 ? 10 : 8;
  const maxPages = verifiedCount <= 3 ? 30 : 40;
  const proposedProperties = Math.min(verifiedCount, maxProperties);
  const proposedDatesPerProperty = Math.min(DEFAULT_FIRST_EXPANSION_DATES.length, maxDatesPerProperty);
  const proposedPages = proposedProperties * proposedDatesPerProperty;
  return {
    max_properties: maxProperties,
    max_dates_per_property: maxDatesPerProperty,
    max_pages: maxPages,
    proposed_properties: proposedProperties,
    proposed_dates_per_property: proposedDatesPerProperty,
    proposed_pages: proposedPages,
    caps_respected: proposedPages <= maxPages && proposedProperties <= maxProperties && proposedDatesPerProperty <= maxDatesPerProperty,
    note:
      verifiedCount <= 3
        ? "Only the B05X verified baseline is available; use at most 3 properties × 10 dates."
        : "Additional local verified slug exists; use at most 5 properties × 8 dates and stay under 40 pages."
  };
}

export function buildProposedTargetMatrix(verified: readonly VerifiedBookingProperty[], cap: PageCapPlan): ProposedBookingTargetCell[] {
  return verified.slice(0, cap.proposed_properties).flatMap((property) =>
    DEFAULT_FIRST_EXPANSION_DATES.slice(0, cap.proposed_dates_per_property).map((checkin) => ({
      canonical_property_name: property.canonical_property_name,
      booking_slug: property.booking_slug,
      checkin,
      checkout: checkoutForOneNight(checkin),
      url: buildBookingRenderedDomUrl({ canonicalPropertyName: property.canonical_property_name, slug: property.booking_slug, checkin }),
      query_scope: "2_adults_1_room_1_night_jpy_ja" as const,
      slug_status: property.slug_status,
      risk_level: property.risk_level
    }))
  );
}

export function buildPriceBasisPolicy(): PriceBasisPolicy {
  return {
    policy_version: B08X_PRICE_POLICY_VERSION,
    computed_total_rule: "primary_price_numeric + official_tax_fee_adder_numeric",
    forbidden_rule: "primary_price_numeric * 1.1",
    valid_rows: { basis_confidence: "B", dp_usage: "directional", price_pressure_usable: true, dp_usable: false },
    missing_official_adder_rows: {
      basis_confidence: "C",
      dp_usage: "excluded",
      price_pressure_usable: false,
      dp_usable: false,
      exclusion_reason: "missing_official_tax_fee_adder"
    },
    booking_direct_rows_allowed: 0
  };
}

export function buildRiskAssessment(missingCount: number): RiskAssessment {
  return {
    overall_risk: "medium",
    risks: [
      "Booking.com rendered DOM can produce consent/security/near-empty pages; B09X must record blocked status and stop.",
      `${missingCount} high-value anchor properties lack verified Booking slugs and must not be collected live.`,
      "Booking rows remain B-confidence directional evidence, not direct automatic-pricing rows.",
      "Rakuten remains frozen and must not be restarted as part of Booking expansion."
    ],
    fallback_plan: [
      "If a fixed slug page is blocked, record blocked/security status and do not bypass.",
      "If official tax/fee adder is missing, emit C-confidence excluded audit row.",
      "If page count would exceed cap, reduce dates before adding properties.",
      "Do not use Booking search results, pagination, cookies, login, stealth, paid APIs, or CAPTCHA bypass."
    ]
  };
}

export function buildFutureB09XPlan(): FutureB09XPlan {
  return {
    phase: "BOOKING-B09X — Bounded expanded Booking.com normalized collection",
    collection_rules: [
      "Use fixed Booking.com property slug URLs only.",
      "Use checkin/checkout/group_adults=2/no_rooms=1/group_children=0/selected_currency=JPY/lang=ja query params.",
      "Use Playwright rendered DOM only for the fixed approved B09X pages.",
      "Do not scrape Booking search results.",
      "Do not paginate.",
      "Do not discover new slugs live.",
      "Do not retry aggressively."
    ],
    blocked_handling: [
      "Record blocked/captcha/security/consent-wall status.",
      "Do not bypass.",
      "Do not use stealth.",
      "Do not use cookies or login.",
      "Use at most one conservative retry only if already implemented safely."
    ],
    not_allowed: [
      "No history append in B09X unless a later approved append phase exists.",
      "No DB write or AI context refresh in B09X collection.",
      "No PMS/Beds24/AirHost/OTA output.",
      "No Booking base * 1.1."
    ]
  };
}

export function decideBookingTargetMatrixExpansion(input: {
  b07bDecision: string;
  verifiedCount: number;
  pageCapOk: boolean;
  missingCount: number;
}): BookingTargetMatrixExpansionDecision {
  if (input.b07bDecision === "" || input.verifiedCount === 0 || !input.pageCapOk) {
    return "booking_target_matrix_expansion_proposal_not_ready";
  }
  if (input.missingCount > 0) return "booking_target_matrix_expansion_proposal_basis_caution";
  return "booking_target_matrix_expansion_proposal_ready";
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    live_booking_fetch: false,
    playwright_used: false,
    db_writes: false,
    history_append: false,
    ai_context_refresh: false,
    booking_search_scraping: false,
    slug_invention: false,
    pms_beds24_airhost_ota_output: false,
    price_update: false,
    paid_source_tooling: false,
    booking_base_times_1_1: false,
    rakuten_restart: false,
    jalan_automation_start: false,
    started_next_phase: false
  };
}

export function renderBookingTargetMatrixExpansionCsv(proposal: BookingTargetMatrixExpansionProposal): string {
  const headers = [
    "canonical_property_name",
    "booking_slug",
    "checkin",
    "checkout",
    "url",
    "slug_status",
    "risk_level"
  ];
  const lines = proposal.proposed_b09x_target_matrix.map((row) =>
    [row.canonical_property_name, row.booking_slug, row.checkin, row.checkout, row.url, row.slug_status, row.risk_level]
      .map((value) => `"${String(value).replace(/"/gu, '""')}"`)
      .join(",")
  );
  return [headers.join(","), ...lines].join("\n") + "\n";
}

export function renderBookingTargetMatrixExpansionReport(proposal: BookingTargetMatrixExpansionProposal): string {
  const cap = proposal.page_cap_plan;
  return [
    "# Booking.com Target Matrix Expansion Proposal",
    "",
    `Generated at: ${proposal.generated_at_jst}`,
    `Decision: ${proposal.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    `- Booking is now present in DB/context with ${proposal.current_booking_context.booking_rows} rows: ${proposal.current_booking_context.booking_directional_rows} directional, ${proposal.current_booking_context.booking_excluded_rows} excluded, ${proposal.current_booking_context.booking_direct_rows} direct.`,
    `- Proposed B09X live matrix: ${cap.proposed_properties} properties × ${cap.proposed_dates_per_property} dates = ${cap.proposed_pages} pages.`,
    `- Page cap respected: ${cap.caps_respected}; max_pages=${cap.max_pages}.`,
    "- Rakuten remains frozen: NO_GO_FREEZE_RAKUTEN.",
    "",
    "## 2. Current Booking Coverage",
    "",
    `- .data/history rows: ${proposal.current_booking_context.history_rows}`,
    `- DB market_signal_history rows: ${proposal.current_booking_context.db_market_signal_history_rows}`,
    `- AI context row count: ${proposal.current_booking_context.ai_context_row_count}`,
    `- Booking rows: ${proposal.current_booking_context.booking_rows} (directional ${proposal.current_booking_context.booking_directional_rows}, excluded ${proposal.current_booking_context.booking_excluded_rows}, direct ${proposal.current_booking_context.booking_direct_rows})`,
    "",
    "## 3. Verified Booking Slugs",
    "",
    ...proposal.verified_booking_properties.map(
      (p) => `- ${p.canonical_property_name}: ${p.booking_slug} (${p.slug_status}, risk=${p.risk_level})`
    ),
    "",
    "## 4. Missing Booking Slug Candidates",
    "",
    ...proposal.missing_booking_slug_candidates.map(
      (p) => `- ${p.canonical_property_name}: ${p.booking_slug_status}; action=${p.recommended_action}; sources=${p.possible_existing_sources.join("|") || "none"}`
    ),
    "",
    "## 5. Date Window Strategy",
    "",
    ...proposal.date_window_strategy.map((b) => `- ${b.bucket}: ${b.dates.join(", ")} — ${b.purpose}`),
    "",
    "## 6. Proposed B09X Target Matrix",
    "",
    ...proposal.proposed_b09x_target_matrix.map(
      (r) => `- ${r.canonical_property_name} / ${r.booking_slug} / ${r.checkin} → ${r.checkout}`
    ),
    "",
    "## 7. Page Cap Plan",
    "",
    `- max_properties=${cap.max_properties}`,
    `- max_dates_per_property=${cap.max_dates_per_property}`,
    `- max_pages=${cap.max_pages}`,
    `- proposed_pages=${cap.proposed_pages}`,
    `- note=${cap.note}`,
    "",
    "## 8. Price Basis Policy",
    "",
    `- computed_total_with_tax_fee = ${proposal.price_basis_policy.computed_total_rule}`,
    `- forbidden: ${proposal.price_basis_policy.forbidden_rule}`,
    "- Valid Booking rows: basis_confidence=B, dp_usage=directional, price_pressure_usable=true, dp_usable=false.",
    "- Missing official adder rows: basis_confidence=C, dp_usage=excluded, price_pressure_usable=false, dp_usable=false.",
    "- Booking direct rows allowed: 0.",
    "",
    "## 9. Risk Assessment",
    "",
    `- overall_risk=${proposal.risk_assessment.overall_risk}`,
    ...proposal.risk_assessment.risks.map((risk) => `- ${risk}`),
    "",
    "## 10. Future B09X Plan",
    "",
    ...proposal.future_b09x_plan.collection_rules.map((rule) => `- ${rule}`),
    "",
    "## 11. Safety Confirmation",
    "",
    ...Object.entries(proposal.safety_confirmation).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## 12. Decision",
    "",
    `- ${proposal.decision}`,
    "",
    "## 13. Next Step",
    "",
    "- BOOKING-B09X — Bounded expanded Booking.com normalized collection. Do not start without explicit instruction.",
    ""
  ].join("\n");
}
