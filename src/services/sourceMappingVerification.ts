// Phase AUTO-RUNNER16X-A3 — source mapping verification (pure).
//
// Identity-only verification: given a light probe observation of a candidate's
// Booking slug / Jalan yadId page, decide whether the slug/id maps to the
// expected property in the expected region. NEVER price collection, NEVER booking
// flow, NEVER login/captcha bypass. Candidates with no known id are not_found
// (we never guess/search an id). This module is pure: no I/O, no network.

export type MappingVerificationSource = "booking" | "jalan";

export type MappingVerificationStatus =
  | "verified"
  | "candidate_found_needs_review"
  | "not_found"
  | "ambiguous"
  | "blocked_or_captcha"
  | "failed";

export type MappingEvidenceSource =
  | "existing_history"
  | "existing_report"
  | "source_coverage_seed"
  | "property_discovery_review"
  | "public_ota_search_page"
  | "manual_candidate_universe";

export type MappingTier = "tier_anchor_high" | "tier_direct_mid" | "tier_budget_small" | "tier_monitor_only";

export interface MappingVerificationCandidate {
  source: MappingVerificationSource;
  canonical_property_name: string;
  candidate_slug_or_id: string;
  candidate_url: string;
  evidence_source: MappingEvidenceSource;
  tier: MappingTier;
}

export interface MappingVerificationResult {
  source: MappingVerificationSource;
  canonical_property_name: string;
  candidate_slug_or_id: string;
  candidate_url: string;
  status: MappingVerificationStatus;
  property_identity_match: boolean;
  identity_confidence: "A" | "B" | "C";
  evidence_text: string[];
  rejection_reason: string;
  safe_to_enable_live: boolean;
  debug_artifact_path: string;
}

// Region tokens for 蔵王温泉 / 山形市 / 990-2301.
const REGION_TOKENS = ["蔵王", "ザオウ", "zao", "山形", "yamagata", "990-2301", "990-2301"];

export interface ProbeObservation {
  has_id: boolean;            // candidate actually carries a slug/yadId
  loaded: boolean;
  http_status: number;
  blocked_or_captcha: boolean;
  login_required: boolean;
  not_found: boolean;
  page_title: string;
  visible_text: string;
  error: string;
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").toLowerCase().trim();
}

export function nameMatches(canonicalName: string, text: string): boolean {
  const t = normalize(text);
  const name = normalize(canonicalName);
  if (name === "" || t === "") return false;
  if (t.includes(name)) return true;
  // token overlap fallback: most non-trivial tokens of the canonical name appear
  const tokens = name.split(/[\s・/]+/u).filter((tok) => tok.length >= 2);
  if (tokens.length === 0) return false;
  const hit = tokens.filter((tok) => t.includes(tok)).length;
  return hit / tokens.length >= 0.6;
}

export function regionMatches(text: string): boolean {
  const t = normalize(text);
  return REGION_TOKENS.some((tok) => t.includes(normalize(tok)));
}

export function decideVerification(candidate: MappingVerificationCandidate, obs: ProbeObservation): Omit<MappingVerificationResult, "debug_artifact_path"> {
  const base = {
    source: candidate.source,
    canonical_property_name: candidate.canonical_property_name,
    candidate_slug_or_id: candidate.candidate_slug_or_id,
    candidate_url: candidate.candidate_url
  };
  const haystack = `${obs.page_title}\n${obs.visible_text}`;
  const nameHit = nameMatches(candidate.canonical_property_name, haystack);
  const regionHit = regionMatches(haystack);

  if (!obs.has_id) {
    return { ...base, status: "not_found", property_identity_match: false, identity_confidence: "C", evidence_text: ["no_source_id: candidate has no slug/yadId; not guessed/searched"], rejection_reason: "no_source_id_no_guess", safe_to_enable_live: false };
  }
  if (!obs.loaded || obs.error !== "") {
    return { ...base, status: "failed", property_identity_match: false, identity_confidence: "C", evidence_text: [obs.error || "page_not_loaded"], rejection_reason: "load_failed", safe_to_enable_live: false };
  }
  if (obs.blocked_or_captcha) {
    return { ...base, status: "blocked_or_captcha", property_identity_match: false, identity_confidence: "C", evidence_text: ["captcha_or_security_detected"], rejection_reason: "blocked_or_captcha", safe_to_enable_live: false };
  }
  if (obs.login_required) {
    return { ...base, status: "blocked_or_captcha", property_identity_match: false, identity_confidence: "C", evidence_text: ["login_required_detected"], rejection_reason: "login_required", safe_to_enable_live: false };
  }
  if (obs.not_found || obs.http_status === 404) {
    return { ...base, status: "not_found", property_identity_match: false, identity_confidence: "C", evidence_text: [`http_status=${obs.http_status}`], rejection_reason: "page_not_found", safe_to_enable_live: false };
  }
  if (nameHit && regionHit) {
    return { ...base, status: "verified", property_identity_match: true, identity_confidence: "A", evidence_text: ["name_match=true", "region_match=true", `title=${obs.page_title.slice(0, 120)}`], rejection_reason: "", safe_to_enable_live: true };
  }
  if (nameHit && !regionHit) {
    return { ...base, status: "candidate_found_needs_review", property_identity_match: true, identity_confidence: "B", evidence_text: ["name_match=true", "region_match=false"], rejection_reason: "region_not_confirmed", safe_to_enable_live: false };
  }
  return { ...base, status: "ambiguous", property_identity_match: false, identity_confidence: "C", evidence_text: ["name_match=false", `region_match=${regionHit}`], rejection_reason: "name_not_confirmed", safe_to_enable_live: false };
}

export interface VerificationSummary {
  verified_booking_count: number;
  verified_jalan_count: number;
  candidate_found_needs_review_count: number;
  not_found_count: number;
  ambiguous_count: number;
  blocked_or_captcha_count: number;
  failed_count: number;
}

export function summarize(results: readonly MappingVerificationResult[]): VerificationSummary {
  const byStatus = (s: MappingVerificationStatus): number => results.filter((r) => r.status === s).length;
  return {
    verified_booking_count: results.filter((r) => r.status === "verified" && r.source === "booking").length,
    verified_jalan_count: results.filter((r) => r.status === "verified" && r.source === "jalan").length,
    candidate_found_needs_review_count: byStatus("candidate_found_needs_review"),
    not_found_count: byStatus("not_found"),
    ambiguous_count: byStatus("ambiguous"),
    blocked_or_captcha_count: byStatus("blocked_or_captcha"),
    failed_count: byStatus("failed")
  };
}

export const VERIFICATION_CSV_HEADERS = [
  "source", "canonical_property_name", "candidate_slug_or_id", "status",
  "property_identity_match", "identity_confidence", "safe_to_enable_live", "rejection_reason"
] as const;

export function renderVerificationCsv(results: readonly MappingVerificationResult[]): string {
  const body = results.map((r) =>
    [r.source, r.canonical_property_name, r.candidate_slug_or_id, r.status, String(r.property_identity_match), r.identity_confidence, String(r.safe_to_enable_live), r.rejection_reason]
      .map((c) => (/[",\n]/u.test(c) ? `"${c.replace(/"/gu, '""')}"` : c)).join(",")
  );
  return [VERIFICATION_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderVerificationReport(input: { generatedAtJst: string; results: readonly MappingVerificationResult[]; summary: VerificationSummary }): string {
  return `# Source Mapping Verification (AUTO-RUNNER16X-A3)

Generated at JST: ${input.generatedAtJst}

## Summary
${JSON.stringify(input.summary, null, 2)}

## Results
${input.results.map((r) => `- [${r.status}] ${r.source} ${r.canonical_property_name} (${r.candidate_slug_or_id || "no-id"}) safe_to_enable_live=${r.safe_to_enable_live} — ${r.rejection_reason || r.evidence_text.join("; ")}`).join("\n")}

## Safety
- mapping verification only; no price collection, no booking flow, no login/cookies, no captcha bypass, no paid proxy.
- candidates with no source id are not guessed/searched (status=not_found).
`;
}
