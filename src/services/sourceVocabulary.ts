/**
 * Canonical source/access vocabulary. Phase 42X adds this guard because Codex
 * flagged free-form drift across source names and access statuses (e.g.
 * "rakuten_travel" vs "rakuten", "booking_com" vs "booking"). Centralizing the
 * vocabulary lets schemas and tests reject obvious drift while still allowing
 * deliberate future extension.
 *
 * Paid infrastructure sources (serpapi/dataforseo/apify/brightdata/oxylabs) are
 * intentionally absent — they are forbidden, not merely non-canonical.
 */
export const CANONICAL_SOURCES = [
  "jalan",
  "rakuten",
  "booking",
  "google_hotels",
  "yahoo_travel",
  "ikyu",
  "trip_com",
  "expedia",
  "hotels_com",
  "official"
] as const;

export type CanonicalSource = (typeof CANONICAL_SOURCES)[number];

/**
 * Escape hatch for a source that is real but not yet promoted to the canonical
 * list. Callers that use "other" MUST supply explanatory notes / evidence so the
 * row stays auditable. The schema layer enforces that requirement.
 */
export const OTHER_SOURCE = "other" as const;

/**
 * Canonical access statuses observed so far across collectors and feasibility
 * probes. New statuses are expected over time; this list documents the agreed
 * vocabulary and powers drift tests.
 */
export const CANONICAL_ACCESS_STATUSES = [
  "collector_working",
  "date_specific_results_not_reached",
  "expected_fields_missing",
  "date_write_not_reflected",
  "date_reflected_in_url",
  "content_visible_no_safe_price",
  "empty_body_or_upstream_bot_detection",
  "consent_or_js_wall",
  "free_direct_feasibility_unresolved",
  "unsupported_free_direct_access",
  "not_found",
  "captcha_detected",
  "login_required",
  "blocked",
  "needs_manual_verification",
  // Phase 43X: promotion-assigned statuses
  "needs_feasibility_probe",
  "content_visibility_unverified"
] as const;

export type CanonicalAccessStatus = (typeof CANONICAL_ACCESS_STATUSES)[number];

const SOURCE_SET = new Set<string>(CANONICAL_SOURCES);
const ACCESS_STATUS_SET = new Set<string>(CANONICAL_ACCESS_STATUSES);

export function normalizeSourceToken(value: string): string {
  return value.trim().toLowerCase();
}

export function isCanonicalSource(value: string): value is CanonicalSource {
  return SOURCE_SET.has(normalizeSourceToken(value));
}

/** Canonical source, or the explicit "other" escape hatch. */
export function isAllowedSource(value: string): boolean {
  const token = normalizeSourceToken(value);
  return token === OTHER_SOURCE || SOURCE_SET.has(token);
}

export function isCanonicalAccessStatus(value: string): value is CanonicalAccessStatus {
  return ACCESS_STATUS_SET.has(value.trim());
}
