// Phase JALAN-AUTO03X - bounded Jalan collection probe helpers.
//
// Pure normalization, classification, URL, and report helpers. The companion
// script performs the bounded live page reads. This module does not append
// history, write DB rows, sync DB, refresh AI context, or generate pricing/PMS
// output.

import { createHash } from "node:crypto";

export type JalanBoundedCollectionDecision =
  | "jalan_bounded_collection_probe_ready"
  | "jalan_bounded_collection_probe_basis_caution"
  | "jalan_bounded_collection_probe_not_ready"
  | "jalan_bounded_collection_probe_failed";

export type ProbeAvailabilityStatus = "available" | "sold_out" | "not_listed" | "not_found" | "failed";
export type ProbeDpUsage = "direct" | "directional" | "excluded";
export type ProbeBasisConfidence = "A" | "B" | "C" | "insufficient";

export interface Auto02xBoundedTarget {
  canonical_property_name: string;
  tier: "tier_1" | "tier_2";
  jalan_source_url: string;
  jalan_property_id: string;
  dates: string[];
  page_count: number;
}

export interface JalanProbeTarget {
  target_id: string;
  canonical_property_name: string;
  facility_tier: "tier_1" | "tier_2";
  jalan_yad_id: string;
  source_slug_or_code: string;
  source_url: string;
  target_url: string;
  checkin: string;
  checkout: string;
  stay_nights: 1;
  group_adults: 2;
  no_rooms: 1;
  group_children: 0;
  currency: "JPY";
  language: "ja";
}

export interface JalanExtractionCandidate {
  facility_name: string | null;
  room_or_plan_name: string | null;
  meal_condition: string | null;
  availability_status: ProbeAvailabilityStatus;
  price_total_tax_included: number | null;
  price_per_person: number | null;
  price_basis_text: string;
  tax_included_evidence: boolean;
  stay_scope_evidence: boolean;
  coupon_or_discount_evidence: boolean;
  date_condition_evidence: boolean;
  property_identity_confirmed: boolean;
  screenshot_path: string | null;
  source_url: string;
  raw_text_excerpt: string;
  error_reason: string | null;
  extraction_confidence: "high" | "medium" | "low";
}

export interface JalanPageResult {
  target_id: string;
  canonical_property_name: string;
  jalan_yad_id: string;
  checkin: string;
  checkout: string;
  target_url: string;
  final_url: string | null;
  http_status: number | null;
  attempt_count: number;
  retry_used: boolean;
  final_status: ProbeAvailabilityStatus;
  price_total_tax_included: number | null;
  basis_confidence: ProbeBasisConfidence;
  dp_usage: ProbeDpUsage;
  error_reason: string | null;
  screenshot_path: string | null;
  text_excerpt_path: string | null;
  html_excerpt_path: string | null;
  target_result_json_path: string | null;
  warning_flags: string[];
}

export interface JalanNormalizedPreviewRow {
  run_id: string;
  checked_at: string;
  collected_date_jst: string;
  collected_at_jst: string;
  normalized_at_jst: string;
  source: "jalan";
  source_phase: "JALAN-AUTO03X";
  collector_stage: "bounded_property_date_preview";
  canonical_property_name: string;
  source_property_name: string;
  property_identity_match: string;
  source_property_id: string;
  source_slug_or_code: string;
  source_url: string;
  checkin: string;
  checkout: string;
  stay_nights: 1;
  group_adults: 2;
  no_rooms: 1;
  group_children: 0;
  currency: "JPY";
  language: "ja";
  stay_scope: string;
  room_or_plan_name: string;
  meal_condition: string;
  availability_status: ProbeAvailabilityStatus;
  sold_out_status: string;
  normalized_total_price: number | null;
  normalized_total_price_source: string;
  normalized_total_price_basis: string;
  normalized_total_price_confidence: ProbeBasisConfidence;
  basis_confidence: ProbeBasisConfidence;
  basis_note: string;
  source_primary_price: number | null;
  source_secondary_price_or_adder: number | null;
  source_computed_total: number | null;
  source_tax_or_fee_classification: string;
  source_classification: string;
  dp_usage: ProbeDpUsage;
  is_price_usable_for_dp_direct: boolean;
  is_price_usable_for_dp_directional: boolean;
  is_price_excluded_from_dp: boolean;
  dp_exclusion_reason: string;
  warning_flags: string;
  error_reason: string;
  screenshot_path: string;
  source_report_path: string;
  source_csv_path: string;
  debug_artifact_path: string;
  schema_version: "zao_local_history_v1";
  raw_text_excerpt: string;
  raw_json: string;
}

export interface SafetyConfirmation {
  max_pages: 25;
  max_retries_per_target: 1;
  max_browser_pages_in_parallel: 1;
  history_append: false;
  history_modification: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  pricing_csv_generation: false;
  pms_beds24_airhost_output: false;
  booking_collection: false;
  rakuten_collection: false;
  google_hotels_collection: false;
  broad_jalan_search_scraping: false;
  area_search_pagination: false;
  unverified_jalan_targets: false;
  paid_apis_or_proxies: false;
  captcha_bypass_or_stealth: false;
  login_or_cookies: false;
  started_auto04x: false;
}

export interface FutureAuto04xPlan {
  phase: "JALAN-AUTO04X";
  objective: string;
  allowed_actions: string[];
  forbidden_actions: string[];
  expected_outputs: string[];
}

export interface JalanProbeOutputShape {
  run_id: string;
  generated_at_jst: string;
  decision: JalanBoundedCollectionDecision;
  source_auto02x_artifact: string;
  target_matrix_summary: Record<string, unknown>;
  page_results_summary: Record<string, unknown>;
  normalized_preview_rows_summary: Record<string, unknown>;
  direct_directional_excluded_summary: Record<string, number>;
  availability_summary: Record<string, number>;
  confidence_summary: Record<string, number>;
  price_basis_summary: Record<string, number>;
  screenshot_summary: Record<string, unknown>;
  failure_summary: Record<string, unknown>;
  normalized_preview_rows: JalanNormalizedPreviewRow[];
  future_auto04x_plan: FutureAuto04xPlan;
  safety_confirmation: SafetyConfirmation;
  next_phase: string;
}

export const MAX_PAGES = 25;
export const MAX_RETRIES_PER_TARGET = 1;

export function loadAuto02xTargetMatrix(artifact: {
  decision?: string;
  auto03x_bounded_matrix?: Auto02xBoundedTarget[];
}): JalanProbeTarget[] {
  if (artifact.decision !== "jalan_target_matrix_proposal_ready" && artifact.decision !== "jalan_target_matrix_proposal_basis_caution") {
    throw new Error("AUTO02X target matrix decision is not usable.");
  }
  const matrix = artifact.auto03x_bounded_matrix ?? [];
  if (matrix.some((row) => !/^yad\d{6}$/u.test(row.jalan_property_id) || !/jalan\.net\/yad\d{6}/u.test(row.jalan_source_url))) {
    throw new Error("AUTO02X target matrix contains an unverified Jalan target.");
  }
  const targets = matrix.flatMap((row) =>
    row.dates.map((date) => buildJalanProbeTarget({
      canonicalPropertyName: row.canonical_property_name,
      facilityTier: row.tier,
      jalanYadId: row.jalan_property_id,
      sourceUrl: row.jalan_source_url,
      checkin: date
    }))
  );
  enforceTargetCaps(targets);
  return targets;
}

export function enforceTargetCaps(targets: readonly JalanProbeTarget[]): void {
  if (targets.length > MAX_PAGES) {
    throw new Error(`AUTO03X target matrix exceeds max_pages=${MAX_PAGES}.`);
  }
  const datesByProperty = new Map<string, Set<string>>();
  for (const target of targets) {
    const dates = datesByProperty.get(target.jalan_yad_id) ?? new Set<string>();
    dates.add(target.checkin);
    datesByProperty.set(target.jalan_yad_id, dates);
  }
  if (datesByProperty.size > 5 || [...datesByProperty.values()].some((dates) => dates.size > 5)) {
    throw new Error("AUTO03X target matrix exceeds property/date caps.");
  }
}

export function buildJalanProbeTarget(input: {
  canonicalPropertyName: string;
  facilityTier: "tier_1" | "tier_2";
  jalanYadId: string;
  sourceUrl: string;
  checkin: string;
}): JalanProbeTarget {
  const normalizedYad = normalizeYadId(input.jalanYadId);
  const checkout = addDays(input.checkin, 1);
  const targetUrl = buildJalanPlanUrl({
    jalanYadId: normalizedYad,
    checkin: input.checkin,
    stayNights: 1,
    adults: 2,
    rooms: 1,
    children: 0
  });
  return {
    target_id: `${normalizedYad}_${input.checkin}`,
    canonical_property_name: input.canonicalPropertyName,
    facility_tier: input.facilityTier,
    jalan_yad_id: normalizedYad,
    source_slug_or_code: normalizedYad,
    source_url: input.sourceUrl,
    target_url: targetUrl,
    checkin: input.checkin,
    checkout,
    stay_nights: 1,
    group_adults: 2,
    no_rooms: 1,
    group_children: 0,
    currency: "JPY",
    language: "ja"
  };
}

export function buildJalanPlanUrl(input: {
  jalanYadId: string;
  checkin: string;
  stayNights: number;
  adults: number;
  rooms: number;
  children: number;
}): string {
  const yadDigits = input.jalanYadId.replace(/^yad/u, "");
  const [year, month, day] = input.checkin.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid checkin date: ${input.checkin}`);
  }
  const url = new URL(`https://www.jalan.net/yad${yadDigits}/plan/`);
  url.searchParams.set("stayYear", year);
  url.searchParams.set("stayMonth", month);
  url.searchParams.set("stayDay", day);
  url.searchParams.set("stayCount", String(input.stayNights));
  url.searchParams.set("roomCount", String(input.rooms));
  url.searchParams.set("roomCrack", `${input.adults}00000`);
  url.searchParams.set("adultNum", String(input.adults));
  url.searchParams.set("childNum", String(input.children));
  url.searchParams.set("yadNo", yadDigits);
  return url.toString();
}

export function classifyExtractionCandidate(candidate: JalanExtractionCandidate): {
  availability_status: ProbeAvailabilityStatus;
  basis_confidence: ProbeBasisConfidence;
  dp_usage: ProbeDpUsage;
  source_classification: string;
  basis_note: string;
  dp_exclusion_reason: string;
  warning_flags: string[];
} {
  const warnings: string[] = [];
  if (candidate.screenshot_path === null) warnings.push("missing_screenshot_path");
  if (candidate.coupon_or_discount_evidence) warnings.push("coupon_member_point_or_suspicious_evidence");
  if (!candidate.date_condition_evidence) warnings.push("date_condition_not_confirmed");
  if (!candidate.stay_scope_evidence) warnings.push("stay_scope_not_confirmed");
  if (!candidate.tax_included_evidence) warnings.push("tax_included_total_not_confirmed");
  if (!candidate.property_identity_confirmed) warnings.push("property_identity_not_confirmed");
  if (candidate.meal_condition === null) warnings.push("meal_condition_missing");

  if (candidate.price_total_tax_included === null) {
    return {
      availability_status: candidate.availability_status,
      basis_confidence: candidate.availability_status === "sold_out" || candidate.availability_status === "not_listed" ? "insufficient" : "C",
      dp_usage: "excluded",
      source_classification: `jalan_${candidate.availability_status}_excluded`,
      basis_note: candidate.error_reason ?? "No clear tax-included price extracted.",
      dp_exclusion_reason: candidate.error_reason ?? "price_missing_or_basis_unclear",
      warning_flags: warnings
    };
  }

  const directEligible =
    candidate.extraction_confidence === "high" &&
    candidate.screenshot_path !== null &&
    candidate.tax_included_evidence &&
    candidate.stay_scope_evidence &&
    candidate.date_condition_evidence &&
    candidate.property_identity_confirmed &&
    !candidate.coupon_or_discount_evidence &&
    candidate.meal_condition !== null;

  if (directEligible) {
    return {
      availability_status: "available",
      basis_confidence: "A",
      dp_usage: "direct",
      source_classification: "jalan_direct_tax_included_total",
      basis_note: "A-confidence Jalan tax-included total with screenshot, scope, date, property, meal, and coupon guards.",
      dp_exclusion_reason: "",
      warning_flags: warnings
    };
  }

  if (candidate.screenshot_path === null || candidate.coupon_or_discount_evidence || !candidate.property_identity_confirmed) {
    return {
      availability_status: "available",
      basis_confidence: "C",
      dp_usage: "excluded",
      source_classification: "jalan_price_disqualified",
      basis_note: candidate.screenshot_path === null
        ? "Price visible but screenshot evidence is missing."
        : candidate.coupon_or_discount_evidence
          ? "Price visible but coupon/member/point/suspicious evidence is present."
          : "Price visible but property identity is not confirmed for the selected price block.",
      dp_exclusion_reason: candidate.screenshot_path === null
        ? "missing_screenshot_path"
        : candidate.coupon_or_discount_evidence
          ? "coupon_member_point_or_suspicious_price"
          : "property_context_mismatch",
      warning_flags: warnings
    };
  }

  return {
    availability_status: "available",
    basis_confidence: "B",
    dp_usage: "directional",
    source_classification: "jalan_directional_tax_included_total",
    basis_note: "Visible tax-included total is useful directionally, but one or more direct-safety gates remain uncertain.",
    dp_exclusion_reason: "",
    warning_flags: warnings
  };
}

export function buildNormalizedPreviewRow(input: {
  runId: string;
  checkedAt: string;
  target: JalanProbeTarget;
  candidate: JalanExtractionCandidate;
  reportPath: string;
  csvPath: string;
  debugPath: string;
}): JalanNormalizedPreviewRow {
  const classification = classifyExtractionCandidate(input.candidate);
  const price = input.candidate.price_total_tax_included;
  return {
    run_id: input.runId,
    checked_at: input.checkedAt,
    collected_date_jst: input.checkedAt.slice(0, 10),
    collected_at_jst: input.checkedAt,
    normalized_at_jst: input.checkedAt,
    source: "jalan",
    source_phase: "JALAN-AUTO03X",
    collector_stage: "bounded_property_date_preview",
    canonical_property_name: input.target.canonical_property_name,
    source_property_name: input.candidate.facility_name ?? input.target.canonical_property_name,
    property_identity_match: input.candidate.property_identity_confirmed ? "verified_target_url" : "unconfirmed",
    source_property_id: input.target.jalan_yad_id,
    source_slug_or_code: input.target.source_slug_or_code,
    source_url: input.target.target_url,
    checkin: input.target.checkin,
    checkout: input.target.checkout,
    stay_nights: 1,
    group_adults: 2,
    no_rooms: 1,
    group_children: 0,
    currency: "JPY",
    language: "ja",
    stay_scope: "2_adults_1_room_1_night",
    room_or_plan_name: input.candidate.room_or_plan_name ?? "",
    meal_condition: input.candidate.meal_condition ?? "",
    availability_status: classification.availability_status,
    sold_out_status: classification.availability_status === "sold_out" ? "sold_out" : "not_sold_out_confirmed",
    normalized_total_price: classification.dp_usage === "excluded" && price === null ? null : price,
    normalized_total_price_source: price === null ? "" : "jalan_visible_total_tax_included",
    normalized_total_price_basis: price === null ? "missing_or_unclear" : "tax_included_total",
    normalized_total_price_confidence: classification.basis_confidence,
    basis_confidence: classification.basis_confidence,
    basis_note: classification.basis_note,
    source_primary_price: price,
    source_secondary_price_or_adder: null,
    source_computed_total: price,
    source_tax_or_fee_classification: price === null ? "missing_or_unclear" : "tax_included_total",
    source_classification: classification.source_classification,
    dp_usage: classification.dp_usage,
    is_price_usable_for_dp_direct: classification.dp_usage === "direct",
    is_price_usable_for_dp_directional: classification.dp_usage === "direct" || classification.dp_usage === "directional",
    is_price_excluded_from_dp: classification.dp_usage === "excluded",
    dp_exclusion_reason: classification.dp_exclusion_reason,
    warning_flags: classification.warning_flags.join(";"),
    error_reason: input.candidate.error_reason ?? "",
    screenshot_path: input.candidate.screenshot_path ?? "",
    source_report_path: input.reportPath,
    source_csv_path: input.csvPath,
    debug_artifact_path: input.debugPath,
    schema_version: "zao_local_history_v1",
    raw_text_excerpt: input.candidate.raw_text_excerpt,
    raw_json: JSON.stringify({ target: input.target, candidate: input.candidate })
  };
}

export function decideJalanBoundedCollectionProbe(input: {
  targetCount: number;
  rowCount: number;
  failedCount: number;
  blockedCount: number;
  pricedRows: number;
  screenshotCount: number;
  artifactWriteFailed?: boolean;
}): JalanBoundedCollectionDecision {
  if (input.artifactWriteFailed) return "jalan_bounded_collection_probe_failed";
  if (input.targetCount === 0 || input.targetCount > MAX_PAGES || input.rowCount !== input.targetCount) {
    return "jalan_bounded_collection_probe_not_ready";
  }
  if (input.failedCount / input.targetCount > 0.6 || input.pricedRows === 0) {
    return "jalan_bounded_collection_probe_not_ready";
  }
  if (input.failedCount > 0 || input.blockedCount > 0 || input.screenshotCount < input.targetCount) {
    return "jalan_bounded_collection_probe_basis_caution";
  }
  return "jalan_bounded_collection_probe_ready";
}

export function buildSummaries(input: {
  targets: readonly JalanProbeTarget[];
  pageResults: readonly JalanPageResult[];
  rows: readonly JalanNormalizedPreviewRow[];
}): {
  target_matrix_summary: Record<string, unknown>;
  page_results_summary: Record<string, unknown>;
  normalized_preview_rows_summary: Record<string, unknown>;
  direct_directional_excluded_summary: Record<string, number>;
  availability_summary: Record<string, number>;
  confidence_summary: Record<string, number>;
  price_basis_summary: Record<string, number>;
  screenshot_summary: Record<string, unknown>;
  failure_summary: Record<string, unknown>;
} {
  const rows = input.rows;
  const pageResults = input.pageResults;
  const failed = pageResults.filter((result) => result.final_status === "failed");
  return {
    target_matrix_summary: {
      target_count: input.targets.length,
      property_count: new Set(input.targets.map((target) => target.jalan_yad_id)).size,
      date_count: new Set(input.targets.map((target) => target.checkin)).size,
      max_pages: MAX_PAGES
    },
    page_results_summary: {
      attempted_pages: pageResults.length,
      retry_used_count: pageResults.filter((result) => result.retry_used).length,
      http_status_counts: countBy(pageResults.map((result) => String(result.http_status ?? "unknown")))
    },
    normalized_preview_rows_summary: {
      row_count: rows.length,
      priced_rows: rows.filter((row) => row.normalized_total_price !== null).length,
      schema_version: "zao_local_history_v1"
    },
    direct_directional_excluded_summary: countBy(rows.map((row) => row.dp_usage)),
    availability_summary: countBy(rows.map((row) => row.availability_status)),
    confidence_summary: countBy(rows.map((row) => row.basis_confidence)),
    price_basis_summary: countBy(rows.map((row) => row.normalized_total_price_basis)),
    screenshot_summary: {
      target_count: input.targets.length,
      screenshot_count: rows.filter((row) => row.screenshot_path !== "").length,
      missing_screenshot_count: rows.filter((row) => row.screenshot_path === "").length
    },
    failure_summary: {
      failed_count: failed.length,
      error_reason_counts: countBy(failed.map((result) => result.error_reason ?? "unknown"))
    }
  };
}

export function buildFutureAuto04xPlan(): FutureAuto04xPlan {
  return {
    phase: "JALAN-AUTO04X",
    objective: "Read AUTO03X preview rows and propose a guarded .data/history append without writing history.",
    allowed_actions: ["Read AUTO03X artifacts", "Compare preview rows with .data/history in memory", "Produce append/skip/conflict proposal"],
    forbidden_actions: ["No live collection", "No history append", "No DB write", "No AI context refresh", "No pricing/PMS output"],
    expected_outputs: ["Jalan history append proposal", "dedupe/conflict summary", "touched shard plan", "approval gate for AUTO05X"]
  };
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    max_pages: 25,
    max_retries_per_target: 1,
    max_browser_pages_in_parallel: 1,
    history_append: false,
    history_modification: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    pricing_csv_generation: false,
    pms_beds24_airhost_output: false,
    booking_collection: false,
    rakuten_collection: false,
    google_hotels_collection: false,
    broad_jalan_search_scraping: false,
    area_search_pagination: false,
    unverified_jalan_targets: false,
    paid_apis_or_proxies: false,
    captcha_bypass_or_stealth: false,
    login_or_cookies: false,
    started_auto04x: false
  };
}

export function renderPreviewRowsCsv(rows: readonly JalanNormalizedPreviewRow[]): string {
  const header = [
    "run_id",
    "source",
    "source_phase",
    "canonical_property_name",
    "source_property_id",
    "checkin",
    "checkout",
    "availability_status",
    "normalized_total_price",
    "basis_confidence",
    "dp_usage",
    "source_classification",
    "error_reason",
    "screenshot_path",
    "debug_artifact_path",
    "schema_version"
  ];
  return [header.join(","), ...rows.map((row) => header.map((key) => csvCell(String(row[key as keyof JalanNormalizedPreviewRow] ?? ""))).join(","))].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: JalanBoundedCollectionDecision;
  sourceAuto02xArtifact: string;
  targetMatrixSummary: Record<string, unknown>;
  pageResultsSummary: Record<string, unknown>;
  normalizedPreviewRowsSummary: Record<string, unknown>;
  availabilitySummary: Record<string, number>;
  priceBasisSummary: Record<string, number>;
  directDirectionalExcludedSummary: Record<string, number>;
  failureSummary: Record<string, unknown>;
  screenshotSummary: Record<string, unknown>;
  futureAuto04xPlan: FutureAuto04xPlan;
  safetyConfirmation: SafetyConfirmation;
}): string {
  return `# Jalan Bounded Collection Probe

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary

JALAN-AUTO03X ran the bounded Jalan preview probe for the AUTO02X matrix. Decision: ${input.decision}.

## 2. Source AUTO02X Matrix

- Artifact: ${input.sourceAuto02xArtifact}
- Summary: ${JSON.stringify(input.targetMatrixSummary)}

## 3. Collection Scope

- Fixed verified Jalan property/date targets only.
- Maximum pages: ${MAX_PAGES}
- Maximum retries per target: ${MAX_RETRIES_PER_TARGET}
- Browser page parallelism: 1

## 4. Page Results Summary

${JSON.stringify(input.pageResultsSummary, null, 2)}

## 5. Normalized Preview Rows

${JSON.stringify(input.normalizedPreviewRowsSummary, null, 2)}

## 6. Availability Summary

${JSON.stringify(input.availabilitySummary, null, 2)}

## 7. Price Basis Summary

${JSON.stringify(input.priceBasisSummary, null, 2)}

## 8. Direct / Directional / Excluded Summary

${JSON.stringify(input.directDirectionalExcludedSummary, null, 2)}

## 9. Failure / Error Summary

${JSON.stringify(input.failureSummary, null, 2)}

## 10. Screenshot / Evidence Summary

${JSON.stringify(input.screenshotSummary, null, 2)}

## 11. Future AUTO04X Plan

- ${input.futureAuto04xPlan.phase}: ${input.futureAuto04xPlan.objective}
- Expected outputs: ${input.futureAuto04xPlan.expected_outputs.join("; ")}

## 12. Safety Confirmation

${Object.entries(input.safetyConfirmation).map(([key, value]) => `- ${key}: ${String(value)}`).join("\n")}

## 13. Decision

${input.decision}

## 14. Next Phase

JALAN-AUTO04X — Jalan history append proposal. Do not start without explicit instruction.
`;
}

export function stableRowHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(row, Object.keys(row).sort())).digest("hex");
}

function normalizeYadId(value: string): string {
  const digits = value.match(/\d{6}/u)?.[0];
  if (digits === undefined) throw new Error(`Invalid Jalan yad id: ${value}`);
  return `yad${digits}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}
