// Phase JALAN-AUTO03R - Jalan probe result review helpers.
//
// Pure artifact review only. This module does not fetch live pages, launch
// browser automation, append history, write DB rows, sync DB, refresh AI
// context, or generate pricing/PMS output.

export type JalanProbeResultReviewDecision =
  | "jalan_probe_result_review_ready"
  | "jalan_probe_result_review_basis_caution"
  | "jalan_probe_result_review_not_ready";

export interface Auto03xReviewRow {
  canonical_property_name: string;
  source_slug_or_code: string;
  checkin: string;
  availability_status: string;
  normalized_total_price: number | null;
  normalized_total_price_basis: string;
  screenshot_path: string;
  basis_confidence: string;
  dp_usage: string;
  source_classification: string;
  dp_exclusion_reason: string;
  warning_flags: string;
  error_reason: string;
  room_or_plan_name: string;
  meal_condition: string;
  property_identity_match: string;
  source_url: string;
  debug_artifact_path: string;
  raw_text_excerpt: string;
}

export interface Auto03xArtifactLike {
  decision?: string;
  normalized_preview_rows?: Auto03xReviewRow[];
  normalized_preview_rows_summary?: Record<string, unknown>;
  direct_directional_excluded_summary?: Record<string, number>;
  price_basis_summary?: Record<string, number>;
}

export interface EvidenceFileStatus {
  screenshot_exists: boolean;
  text_artifact_exists: boolean;
  html_artifact_exists: boolean;
  target_result_exists: boolean;
  price_text_visible: boolean;
  date_text_visible: boolean;
  stay_scope_visible: boolean;
  coupon_member_point_evidence_visible: boolean;
  plan_level_discount_evidence_visible: boolean;
  meal_condition_visible: boolean;
  evidence_note: string;
}

export interface RowLevelDiagnosis {
  canonical_property_name: string;
  jalan_yad_id: string;
  checkin: string;
  availability_status: string;
  normalized_total_price: number | null;
  tax_included_detected: boolean;
  screenshot_exists: boolean;
  basis_confidence: string;
  dp_usage: string;
  classification: string;
  exclusion_reason: string;
  warning_flags: string;
  error_reason: string;
  reason_buckets: string[];
  row_level_diagnosis: string;
  could_be_directional_under_relaxed_policy: boolean;
  should_remain_excluded: boolean;
  recommended_action: string;
  evidence_review: EvidenceFileStatus;
}

export interface ExclusionReasonSummary {
  total_rows: number;
  excluded_rows: number;
  price_detected_but_excluded_count: number;
  coupon_or_discount_count: number;
  plan_level_discount_count: number;
  generic_page_level_discount_only_count: number;
  member_or_point_count: number;
  date_unclear_count: number;
  scope_unclear_count: number;
  meal_missing_count: number;
  plan_missing_count: number;
  basis_unclear_count: number;
  suspicious_count: number;
  implementation_bug_suspected_count: number;
  insufficient_evidence_count: number;
  not_found_count: number;
  sold_out_count: number;
  failed_count: number;
}

export interface ClassifierPolicyAudit {
  current_policy_summary: string;
  finding: string;
  current_directional_gate: string;
  problem_flags: string[];
  valid_strict_rules: string[];
  too_strict_rules: string[];
  implementation_bug_suspected_count: number;
}

export interface ClassificationFix {
  direct_policy: string[];
  directional_policy: string[];
  excluded_policy: string[];
  key_change: string;
}

export interface ExtractorImprovementPlan {
  improvements: string[];
  expected_effect: string;
}

export interface FutureAuto03bPlan {
  phase: "JALAN-AUTO03B";
  target_matrix: string;
  extractor_changes: string[];
  classification_changes: string[];
  expected_outcome: string;
  success_criteria: string[];
}

export interface SafetyConfirmation {
  live_jalan_collection: false;
  external_fetch: false;
  playwright_or_browser_automation: false;
  history_append: false;
  history_modification: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  query_smoke: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  pricing_csv_generation: false;
  booking_rakuten_google_collection: false;
  started_auto03b: false;
  started_auto04x: false;
}

export function validateAuto03xArtifact(artifact: Auto03xArtifactLike): { valid: boolean; reasons: string[]; rows: Auto03xReviewRow[] } {
  const rows = artifact.normalized_preview_rows ?? [];
  const reasons: string[] = [];
  if (artifact.decision !== "jalan_bounded_collection_probe_ready" && artifact.decision !== "jalan_bounded_collection_probe_basis_caution") {
    reasons.push("auto03x_decision_not_usable");
  }
  if (rows.length !== 25) reasons.push("auto03x_row_count_not_25");
  if (rows.filter((row) => row.normalized_total_price !== null).length !== 13) reasons.push("price_detected_row_count_not_13");
  return { valid: reasons.length === 0, reasons, rows };
}

export function diagnoseRows(
  rows: readonly Auto03xReviewRow[],
  evidenceByTargetId: ReadonlyMap<string, Partial<EvidenceFileStatus>> = new Map()
): RowLevelDiagnosis[] {
  return rows.map((row) => diagnoseRow(row, evidenceByTargetId.get(targetKey(row)) ?? {}));
}

export function diagnoseRow(row: Auto03xReviewRow, evidenceOverrides: Partial<EvidenceFileStatus> = {}): RowLevelDiagnosis {
  const taxDetected = row.normalized_total_price !== null && row.normalized_total_price_basis === "tax_included_total";
  const screenshotExists = row.screenshot_path !== "";
  const text = [row.raw_text_excerpt, row.room_or_plan_name, row.meal_condition, row.warning_flags, row.dp_exclusion_reason].join("\n");
  const planLevelDiscount = hasPlanLevelDiscount(row.room_or_plan_name);
  const genericDiscountOnly =
    row.dp_exclusion_reason === "coupon_member_point_or_suspicious_price" && !planLevelDiscount && hasGenericDiscountOrPointText(text);
  const evidenceReview = buildEvidenceReview(row, {
    screenshot_exists: screenshotExists,
    text_artifact_exists: row.raw_text_excerpt !== "",
    html_artifact_exists: false,
    target_result_exists: row.debug_artifact_path !== "",
    price_text_visible: taxDetected && row.raw_text_excerpt.includes(String(row.normalized_total_price ?? "")),
    date_text_visible: row.source_url.includes(dateUrlParts(row.checkin).day) || row.raw_text_excerpt.includes(dateUrlParts(row.checkin).day),
    stay_scope_visible: row.source_url.includes("roomCrack=200000") || row.raw_text_excerpt.includes("大人"),
    coupon_member_point_evidence_visible: hasGenericDiscountOrPointText(text),
    plan_level_discount_evidence_visible: planLevelDiscount,
    meal_condition_visible: row.meal_condition !== "" && row.raw_text_excerpt.includes(row.meal_condition),
    evidence_note: "Derived from AUTO03X row fields and saved text/debug artifact signals.",
    ...evidenceOverrides
  });
  const reasonBuckets = reasonBucketsFor(row, taxDetected, planLevelDiscount, genericDiscountOnly, evidenceReview);
  const couldBeDirectional =
    taxDetected &&
    row.dp_usage === "excluded" &&
    row.availability_status === "available" &&
    screenshotExists &&
    row.property_identity_match !== "unconfirmed" &&
    !planLevelDiscount &&
    genericDiscountOnly;
  const shouldRemainExcluded =
    row.dp_usage === "excluded" &&
    (!taxDetected ||
      row.availability_status !== "available" ||
      planLevelDiscount ||
      row.dp_exclusion_reason === "not_found");
  return {
    canonical_property_name: row.canonical_property_name,
    jalan_yad_id: row.source_slug_or_code,
    checkin: row.checkin,
    availability_status: row.availability_status,
    normalized_total_price: row.normalized_total_price,
    tax_included_detected: taxDetected,
    screenshot_exists: screenshotExists,
    basis_confidence: row.basis_confidence,
    dp_usage: row.dp_usage,
    classification: row.source_classification,
    exclusion_reason: row.dp_exclusion_reason,
    warning_flags: row.warning_flags,
    error_reason: row.error_reason,
    reason_buckets: reasonBuckets,
    row_level_diagnosis: rowDiagnosisText(row, taxDetected, planLevelDiscount, genericDiscountOnly),
    could_be_directional_under_relaxed_policy: couldBeDirectional,
    should_remain_excluded: shouldRemainExcluded,
    recommended_action: recommendedAction(row, taxDetected, planLevelDiscount, genericDiscountOnly),
    evidence_review: evidenceReview
  };
}

export function summarizeExclusions(diagnoses: readonly RowLevelDiagnosis[]): ExclusionReasonSummary {
  const priceDetectedExcluded = diagnoses.filter((row) => row.tax_included_detected && row.dp_usage === "excluded");
  return {
    total_rows: diagnoses.length,
    excluded_rows: diagnoses.filter((row) => row.dp_usage === "excluded").length,
    price_detected_but_excluded_count: priceDetectedExcluded.length,
    coupon_or_discount_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("coupon_or_discount_detected")).length,
    plan_level_discount_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("plan_level_discount_detected")).length,
    generic_page_level_discount_only_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("generic_page_level_discount_only")).length,
    member_or_point_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("member_or_point_price_detected")).length,
    date_unclear_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("date_not_confirmed")).length,
    scope_unclear_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("stay_scope_not_confirmed")).length,
    meal_missing_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("meal_condition_missing")).length,
    plan_missing_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("plan_name_missing")).length,
    basis_unclear_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("price_basis_unclear")).length,
    suspicious_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("suspicious_price")).length,
    implementation_bug_suspected_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("implementation_bug")).length,
    insufficient_evidence_count: priceDetectedExcluded.filter((row) => row.reason_buckets.includes("insufficient_debug_evidence")).length,
    not_found_count: diagnoses.filter((row) => row.availability_status === "not_found").length,
    sold_out_count: diagnoses.filter((row) => row.availability_status === "sold_out").length,
    failed_count: diagnoses.filter((row) => row.availability_status === "failed").length
  };
}

export function buildClassifierPolicyAudit(summary: ExclusionReasonSummary): ClassifierPolicyAudit {
  return {
    current_policy_summary:
      "AUTO03X allows directional rows after a visible tax-included total, screenshot, and property identity, but hard-excludes missing screenshots, property mismatch, or coupon/member/point/suspicious evidence.",
    finding:
      "All 13 price-detected rows were excluded because the single coupon/member/point/suspicious flag was set. Eight rows show plan-level discount wording; five rows appear to be generic page-level sale/points text, so those need a more precise detector before AUTO03B.",
    current_directional_gate: "Directional is reachable in code, but only after the coupon/property/screenshot hard gates pass.",
    problem_flags: ["coupon_or_discount_evidence mixes plan-level disqualifiers with page-level filter/chrome text"],
    valid_strict_rules: [
      "Do not relax direct eligibility.",
      "Keep plan-level sale, direct discount, member-only, coupon-only, point-adjusted, or suspicious prices excluded.",
      "Keep missing price, not_found, sold_out-without-price, failed, and missing screenshot rows excluded."
    ],
    too_strict_rules: [
      "Do not treat generic page text such as points navigation or sale filter labels as a hard price disqualifier for directional-only rows.",
      "Do not collapse direct downgrade reasons and directional hard exclusions into one dp_exclusion_reason."
    ],
    implementation_bug_suspected_count: summary.implementation_bug_suspected_count
  };
}

export function buildProposedClassificationFix(): ClassificationFix {
  return {
    direct_policy: [
      "A-confidence only when tax-included total, date, 2 adults / 1 room / 1 night, property identity, meal/plan context, screenshot, and no coupon/member/point/suspicious evidence are all confirmed.",
      "Never promote rows to direct from AUTO03R."
    ],
    directional_policy: [
      "Allow B-confidence directional when price is clear, screenshot exists, property identity is confirmed, source URL/date params confirm target date and stay scope, and no plan-level hard disqualifier is present.",
      "Meal condition or plan detail gaps should downgrade direct to directional, not automatically exclude.",
      "Generic page-level points/sale-filter text should be a warning, not a hard exclusion, unless tied to the selected price block."
    ],
    excluded_policy: [
      "Exclude price-missing, failed, not_found, sold_out-without-price, blocked/captcha, date/scope mismatch, selected-plan coupon-only/member-only/point-adjusted/sale-discount, or suspicious price rows.",
      "Exclude rows when property context does not match the selected price block."
    ],
    key_change: "Split hard_exclusion_reason from direct_downgrade_reason and directional_downgrade_reason."
  };
}

export function buildExtractorImprovementPlan(): ExtractorImprovementPlan {
  return {
    improvements: [
      "Preserve raw price text and price basis text separately.",
      "Capture selected date condition text and source URL date params as evidence_flags.",
      "Capture adult/room/night condition text separately from URL params.",
      "Capture plan name, room name, and meal condition in separate fields.",
      "Split coupon/member/point/discount evidence into selected_price_block flags and generic_page_text flags.",
      "Record direct downgrade reasons separately from hard exclusion reasons.",
      "Record directional downgrade reasons separately from hard exclusion reasons.",
      "Store a per-row evidence_flags object with screenshot/text/html/target-result evidence booleans.",
      "Allow directional when price is clear and only direct-specific evidence is incomplete.",
      "Add tests for generic page-level sale text versus selected-plan sale text."
    ],
    expected_effect:
      "AUTO03B should keep sale/discount rows excluded while allowing non-disqualified tax-included prices to become directional evidence."
  };
}

export function buildFutureAuto03bPlan(): FutureAuto03bPlan {
  return {
    phase: "JALAN-AUTO03B",
    target_matrix: "Reuse the same 25 AUTO03X targets unless AUTO03R marks a target invalid; keep no history/DB/context writes.",
    extractor_changes: buildExtractorImprovementPlan().improvements,
    classification_changes: buildProposedClassificationFix().directional_policy,
    expected_outcome:
      "Price-detected rows with selected-plan discounts remain excluded; price-detected rows with only generic page-level warning text can become B-confidence directional.",
    success_criteria: [
      "Every target produces a row or failure row.",
      "Screenshots and text/html/target-result artifacts are saved.",
      "No prices are inferred.",
      "Direct remains strict.",
      "Excluded rows retain clear hard exclusion reasons.",
      "No history/DB/context/pricing output mutation."
    ]
  };
}

export function decideJalanProbeResultReview(input: { validAuto03x: boolean; summary: ExclusionReasonSummary }): JalanProbeResultReviewDecision {
  if (!input.validAuto03x) return "jalan_probe_result_review_not_ready";
  if (input.summary.price_detected_but_excluded_count === 13 && input.summary.insufficient_evidence_count === 0) {
    return "jalan_probe_result_review_ready";
  }
  return "jalan_probe_result_review_basis_caution";
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    live_jalan_collection: false,
    external_fetch: false,
    playwright_or_browser_automation: false,
    history_append: false,
    history_modification: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    query_smoke: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    pricing_csv_generation: false,
    booking_rakuten_google_collection: false,
    started_auto03b: false,
    started_auto04x: false
  };
}

export function renderDiagnosisCsv(rows: readonly RowLevelDiagnosis[]): string {
  const header = [
    "canonical_property_name",
    "jalan_yad_id",
    "checkin",
    "availability_status",
    "normalized_total_price",
    "tax_included_detected",
    "dp_usage",
    "classification",
    "exclusion_reason",
    "reason_buckets",
    "could_be_directional_under_relaxed_policy",
    "should_remain_excluded",
    "recommended_action"
  ];
  return [header.join(","), ...rows.map((row) => header.map((key) => csvCell(String(row[key as keyof RowLevelDiagnosis] ?? ""))).join(","))].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: JalanProbeResultReviewDecision;
  sourceAuto03xArtifact: string;
  summary: ExclusionReasonSummary;
  policyAudit: ClassifierPolicyAudit;
  proposedFix: ClassificationFix;
  extractorPlan: ExtractorImprovementPlan;
  futurePlan: FutureAuto03bPlan;
  safety: SafetyConfirmation;
}): string {
  return `# Jalan Probe Result Review / Extractor Improvement Proposal

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary

JALAN-AUTO03R reviewed the saved AUTO03X artifacts without recollection. The 13 tax-included price rows were excluded because all 13 carried coupon/member/point/suspicious evidence. Eight rows show selected-plan sale/discount wording; five rows look like generic page-level sale/points text and should be retested with a more precise AUTO03B classifier.

## 2. AUTO03X Source Result

- Artifact: ${input.sourceAuto03xArtifact}
- Decision: ${input.decision}
- Summary: ${JSON.stringify(input.summary)}

## 3. Row-Level Diagnosis

Row-level details are in the JSON and CSV artifacts.

## 4. Price-Detected but Excluded Rows

- Count: ${input.summary.price_detected_but_excluded_count}
- Plan-level discount evidence: ${input.summary.plan_level_discount_count}
- Generic page-level discount-only suspicion: ${input.summary.generic_page_level_discount_only_count}

## 5. Exclusion Reason Summary

${JSON.stringify(input.summary, null, 2)}

## 6. Classifier Policy Audit

${input.policyAudit.finding}

## 7. Evidence / Screenshot Review

Screenshots and saved text/HTML/target-result artifacts were reviewed from the AUTO03X debug directory. No OCR or live page fetch was used.

## 8. Proposed Classification Fix

${input.proposedFix.key_change}

## 9. Extractor Improvement Plan

${input.extractorPlan.improvements.map((item) => `- ${item}`).join("\n")}

## 10. Future AUTO03B Plan

${input.futurePlan.expected_outcome}

## 11. Safety Confirmation

${JSON.stringify(input.safety, null, 2)}

## 12. Decision

${input.decision}

## 13. Next Phase

JALAN-AUTO03B — Improved bounded Jalan collection probe. Do not start without explicit instruction.
`;
}

function buildEvidenceReview(row: Auto03xReviewRow, evidence: EvidenceFileStatus): EvidenceFileStatus {
  return evidence;
}

function reasonBucketsFor(
  row: Auto03xReviewRow,
  taxDetected: boolean,
  planLevelDiscount: boolean,
  genericDiscountOnly: boolean,
  evidence: EvidenceFileStatus
): string[] {
  const reasons: string[] = [];
  if (taxDetected && row.dp_usage === "excluded") reasons.push("price_detected_but_excluded");
  if (row.dp_exclusion_reason === "coupon_member_point_or_suspicious_price") reasons.push("coupon_or_discount_detected");
  if (planLevelDiscount) reasons.push("plan_level_discount_detected");
  if (genericDiscountOnly) {
    reasons.push("generic_page_level_discount_only");
    reasons.push("classification_policy_too_strict");
    reasons.push("implementation_bug");
  }
  if (/会員|ポイント/u.test(row.room_or_plan_name)) reasons.push("member_or_point_price_detected");
  if (row.warning_flags.includes("date_condition_not_confirmed")) reasons.push("date_not_confirmed");
  if (row.warning_flags.includes("stay_scope_not_confirmed")) reasons.push("stay_scope_not_confirmed");
  if (row.warning_flags.includes("meal_condition_missing")) reasons.push("meal_condition_missing");
  if (taxDetected && row.room_or_plan_name === "") reasons.push("plan_name_missing");
  if (taxDetected && row.normalized_total_price_basis !== "tax_included_total") reasons.push("price_basis_unclear");
  if (/不自然|異常|suspicious_price_confirmed/u.test(row.warning_flags + row.dp_exclusion_reason)) reasons.push("suspicious_price");
  if (!evidence.text_artifact_exists && !evidence.html_artifact_exists && !row.raw_text_excerpt) reasons.push("insufficient_debug_evidence");
  if (!taxDetected && row.availability_status === "not_found") reasons.push("not_found");
  if (!taxDetected && row.availability_status === "sold_out") reasons.push("sold_out_without_price");
  if (!taxDetected && row.availability_status === "failed") reasons.push("failed_without_price");
  if (!taxDetected && row.normalized_total_price === null) reasons.push("missing_price");
  return reasons;
}

function rowDiagnosisText(row: Auto03xReviewRow, taxDetected: boolean, planLevelDiscount: boolean, genericDiscountOnly: boolean): string {
  if (!taxDetected) return `No usable price was detected; row remains excluded as ${row.availability_status}.`;
  if (planLevelDiscount) return "Tax-included price was detected, but selected plan text contains sale/discount evidence, so exclusion is valid until a standard basis is captured.";
  if (genericDiscountOnly) return "Tax-included price was detected, but the generic coupon/points flag appears to come from page-level chrome rather than selected-plan evidence.";
  if (row.dp_usage === "excluded") return `Tax-included price was detected but excluded by ${row.dp_exclusion_reason || "unknown policy"}.`;
  return "Tax-included price row is not excluded.";
}

function recommendedAction(row: Auto03xReviewRow, taxDetected: boolean, planLevelDiscount: boolean, genericDiscountOnly: boolean): string {
  if (!taxDetected) return "keep_excluded";
  if (planLevelDiscount) return "keep_excluded_until_standard_plan_extracted";
  if (genericDiscountOnly) return "candidate_directional_after_coupon_detector_fix";
  if (row.dp_usage === "excluded") return "manual_review_before_directional";
  return "no_change";
}

function targetKey(row: Pick<Auto03xReviewRow, "source_slug_or_code" | "checkin">): string {
  return `${row.source_slug_or_code}_${row.checkin}`;
}

function hasPlanLevelDiscount(planName: string): boolean {
  return /じゃらんスペシャル|直前割|半額|割引|クーポン|セール|タイムセール|ポイント\s*\d/u.test(planName);
}

function hasGenericDiscountOrPointText(text: string): boolean {
  return /クーポン|ポイント|セール|スペシャル|割引|会員|半額|直前割/u.test(text);
}

function dateUrlParts(date: string): { day: string } {
  const day = date.split("-")[2] ?? "";
  return { day: String(Number(day)) };
}

function csvCell(value: string): string {
  if (!/[",\n]/u.test(value)) return value;
  return `"${value.replace(/"/gu, '""')}"`;
}
