// Phase JALAN-AUTO03B - improved bounded Jalan collection probe helpers.
//
// Coupon-aware directional policy. Booking remains the main directional backbone;
// Jalan is a supplementary domestic OTA signal. The key correction over AUTO03X:
// a coupon / point / discount signal blocks DIRECT usage but does NOT
// automatically block DIRECTIONAL usage. Coupon evidence is split into
// selected-plan evidence (hard, tied to the chosen price block) and page-chrome
// evidence (soft, generic page-level campaign text).
//
// Pure normalization / classification / report helpers only. This module does
// not append history, write DB rows, sync DB, refresh AI context, or generate
// pricing / PMS output. The companion script performs the bounded live reads.

import { createHash } from "node:crypto";
import { classifyJalanMealBasis } from "./mealBasisClassification";
import { classifyRoomBasis, roomBasisDpExclusionReason } from "./roomBasisClassification";
import {
  buildJalanPlanUrl,
  buildJalanProbeTarget,
  enforceTargetCaps,
  loadAuto02xTargetMatrix,
  MAX_PAGES,
  MAX_RETRIES_PER_TARGET,
  type Auto02xBoundedTarget,
  type JalanProbeTarget,
  type ProbeAvailabilityStatus,
  type ProbeBasisConfidence,
  type ProbeDpUsage
} from "./jalanBoundedCollectionProbe";

export {
  buildJalanPlanUrl,
  buildJalanProbeTarget,
  enforceTargetCaps,
  loadAuto02xTargetMatrix,
  MAX_PAGES,
  MAX_RETRIES_PER_TARGET
};
export type { Auto02xBoundedTarget, JalanProbeTarget, ProbeAvailabilityStatus, ProbeBasisConfidence, ProbeDpUsage };

export type JalanImprovedDecision =
  | "jalan_bounded_collection_probe_improved_ready"
  | "jalan_bounded_collection_probe_improved_basis_caution"
  | "jalan_bounded_collection_probe_improved_not_ready"
  | "jalan_bounded_collection_probe_improved_failed";

// ---------------------------------------------------------------------------
// Evidence flags (Section 8 of the AUTO03B spec)
// ---------------------------------------------------------------------------

export interface JalanEvidenceFlags {
  tax_included_total_visible: boolean;
  date_condition_confirmed: boolean;
  stay_scope_confirmed: boolean;
  property_identity_confirmed: boolean;
  screenshot_saved: boolean;
  selected_plan_name_visible: boolean;
  room_name_visible: boolean;
  meal_condition_visible: boolean;

  selected_plan_coupon_or_discount_evidence: boolean;
  selected_plan_member_or_point_evidence: boolean;
  page_chrome_coupon_or_discount_evidence: boolean;
  page_chrome_member_or_point_evidence: boolean;
  suspicious_price_evidence: boolean;

  price_inferred: false;
}

// Raw candidate extracted from a single live page read. The classifier consumes
// this; the live script populates it. selected_block_text is the text of the
// chosen price block (empty when no priced block was selected); page_text is the
// broader page body excerpt. The coupon split is derived from these two.
export interface JalanImprovedExtractionCandidate {
  facility_name: string | null;
  room_or_plan_name: string | null;
  room_name: string | null;
  plan_name: string | null;
  meal_condition: string | null;
  availability_status: ProbeAvailabilityStatus;
  price_total_tax_included: number | null;
  price_per_person: number | null;
  price_basis_text: string;
  tax_included_evidence: boolean;
  stay_scope_evidence: boolean;
  date_condition_evidence: boolean;
  property_identity_confirmed: boolean;
  screenshot_path: string | null;
  source_url: string;
  selected_block_text: string;
  page_text_excerpt: string;
  error_reason: string | null;
  extraction_confidence: "high" | "medium" | "low";
}

// Detector regexes. Discount/coupon wording vs member-restricted pricing are
// kept separate so the classifier can apply different policies.
//
// IMPORTANT: every Jalan plan card embeds generic loyalty-program chrome
// ("加算予定ポイント", "スコアをためるとステージがアップし、お得な特典が受けられる",
// "じゃらんステージプログラム", earned-point figures). That chrome is present on
// EVERY block and is NOT a price-affecting discount, so it must be stripped
// before testing. Only genuine plan-level discounts/coupons and member-restricted
// pricing should count as evidence; otherwise the coupon guard would exclude
// every priced row and defeat the directional-rescue purpose of AUTO03B.
const COUPON_DISCOUNT_RE = /じゃらんスペシャル|直前割|早割|早期割|半額|割引|クーポン|タイムセール|セール|ポイント\s*\d+\s*倍|ポイントアップ/u;
const MEMBER_PRICE_RE = /会員限定|会員価格|会員割|シークレット会員/u;
// Generic Jalan loyalty / score / stage boilerplate stripped before detection.
const LOYALTY_CHROME_RE =
  /加算予定ポイント|加算予定スコア|スコアとは[^。]*。?|スコアをためると[^。]*。?|じゃらんステージプログラム(?:の説明をみる)?|国内宿・ホテル予約で1円につき1スコア(?:たまります)?|お得な特典が受けられる[^。]*。?/gu;

function stripLoyaltyChrome(text: string): string {
  return text.replace(LOYALTY_CHROME_RE, " ");
}

export function detectCouponEvidence(input: { selectedBlockText: string; pageText: string; roomOrPlanName: string | null }): {
  selected_plan_coupon_or_discount_evidence: boolean;
  selected_plan_member_or_point_evidence: boolean;
  page_chrome_coupon_or_discount_evidence: boolean;
  page_chrome_member_or_point_evidence: boolean;
} {
  const selectedText = stripLoyaltyChrome(`${input.selectedBlockText}\n${input.roomOrPlanName ?? ""}`);
  const pageText = stripLoyaltyChrome(input.pageText);
  const selectedCoupon = COUPON_DISCOUNT_RE.test(selectedText);
  const selectedMember = MEMBER_PRICE_RE.test(selectedText);
  // Page-chrome evidence only counts when the same signal is NOT already tied to
  // the selected price block, so generic campaign chrome does not masquerade as
  // a selected-plan disqualifier.
  const pageCoupon = COUPON_DISCOUNT_RE.test(pageText) && !selectedCoupon;
  const pageMember = MEMBER_PRICE_RE.test(pageText) && !selectedMember;
  return {
    selected_plan_coupon_or_discount_evidence: selectedCoupon,
    selected_plan_member_or_point_evidence: selectedMember,
    page_chrome_coupon_or_discount_evidence: pageCoupon,
    page_chrome_member_or_point_evidence: pageMember
  };
}

// A 2-adult / 1-room / 1-night tax-included total outside this band is treated
// as suspicious (likely a per-person fragment, a typo, or a non-stay figure).
export function isSuspiciousPrice(price: number | null): boolean {
  if (price === null) return false;
  return price < 4000 || price > 600000;
}

export function buildEvidenceFlags(candidate: JalanImprovedExtractionCandidate): JalanEvidenceFlags {
  const coupon = detectCouponEvidence({
    selectedBlockText: candidate.selected_block_text,
    pageText: candidate.page_text_excerpt,
    roomOrPlanName: candidate.room_or_plan_name
  });
  return {
    tax_included_total_visible: candidate.tax_included_evidence && candidate.price_total_tax_included !== null,
    date_condition_confirmed: candidate.date_condition_evidence,
    stay_scope_confirmed: candidate.stay_scope_evidence,
    property_identity_confirmed: candidate.property_identity_confirmed,
    screenshot_saved: candidate.screenshot_path !== null,
    selected_plan_name_visible: (candidate.plan_name ?? candidate.room_or_plan_name ?? "") !== "",
    room_name_visible: (candidate.room_name ?? "") !== "",
    meal_condition_visible: candidate.meal_condition !== null && candidate.meal_condition !== "",
    selected_plan_coupon_or_discount_evidence: coupon.selected_plan_coupon_or_discount_evidence,
    selected_plan_member_or_point_evidence: coupon.selected_plan_member_or_point_evidence,
    page_chrome_coupon_or_discount_evidence: coupon.page_chrome_coupon_or_discount_evidence,
    page_chrome_member_or_point_evidence: coupon.page_chrome_member_or_point_evidence,
    suspicious_price_evidence: isSuspiciousPrice(candidate.price_total_tax_included),
    price_inferred: false
  };
}

// ---------------------------------------------------------------------------
// Classification (Sections 7 & 9 of the AUTO03B spec)
// ---------------------------------------------------------------------------

export interface JalanImprovedClassification {
  availability_status: ProbeAvailabilityStatus;
  basis_confidence: ProbeBasisConfidence;
  dp_usage: ProbeDpUsage;
  source_classification: string;
  basis_note: string;
  hard_exclusion_reason: string;
  direct_downgrade_reason: string;
  directional_downgrade_reason: string;
  evidence_flags: JalanEvidenceFlags;
  warning_flags: string[];
}

export function classifyImprovedCandidate(candidate: JalanImprovedExtractionCandidate): JalanImprovedClassification {
  const flags = buildEvidenceFlags(candidate);
  const warnings = collectWarnings(candidate, flags);
  const price = candidate.price_total_tax_included;

  // --- Rows with no usable price: always excluded (hard). ---
  if (price === null) {
    const hard =
      candidate.availability_status === "not_found"
        ? "not_found"
        : candidate.availability_status === "sold_out"
          ? "sold_out_without_price"
          : candidate.availability_status === "failed"
            ? candidate.error_reason ?? "page_failed"
            : "price_missing_or_basis_unclear";
    return {
      availability_status: candidate.availability_status,
      basis_confidence: candidate.availability_status === "available" ? "C" : "insufficient",
      dp_usage: "excluded",
      source_classification: `jalan_${candidate.availability_status}_excluded`,
      basis_note: candidate.error_reason ?? "No clear tax-included price extracted.",
      hard_exclusion_reason: hard,
      direct_downgrade_reason: "",
      directional_downgrade_reason: "",
      evidence_flags: flags,
      warning_flags: warnings
    };
  }

  // --- Meal-basis gate (confirmed policy): a priced Jalan row is DP-usable only
  //     when the selected plan is CONFIRMED room-only. meal_included / unknown
  //     meal basis are excluded from DP (price retained for audit, dp flags off).
  //     Encoded via existing v1 columns only — no history schema change. ---
  const mealText = [candidate.plan_name, candidate.room_name, candidate.room_or_plan_name, candidate.meal_condition, candidate.selected_block_text]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" \n ");
  const meal = classifyJalanMealBasis(mealText);
  if (meal.mealBasis !== "confirmed_room_only") {
    const reason = meal.mealBasis === "meal_included" ? "meal_included_plan_excluded" : "unknown_meal_basis_excluded";
    const cls = meal.mealBasis === "meal_included" ? "jalan_meal_included_excluded" : "jalan_unknown_meal_basis_excluded";
    return {
      availability_status: "available",
      basis_confidence: "C",
      dp_usage: "excluded",
      source_classification: cls,
      basis_note: `Price visible but meal_basis=${meal.mealBasis} (${meal.reason}); excluded from room-only DP per confirmed policy.`,
      hard_exclusion_reason: reason,
      direct_downgrade_reason: "",
      directional_downgrade_reason: reason,
      evidence_flags: flags,
      warning_flags: [...warnings, reason, `meal_basis=${meal.mealBasis}`]
    };
  }
  // Confirmed room-only: record the marker and continue to direct/directional.
  warnings.push("meal_basis_confirmed_room_only", "meal_basis=confirmed_room_only");

  // --- Room-basis gate (two-person standard room policy): a priced confirmed
  //     room-only Jalan row is DP-usable only when the selected room is a
  //     two-person standard room (twin/double/queen/king/2-beds). Single,
  //     semi-double, triple/large, family/suite, and unknown room types are
  //     excluded from DP (price retained for audit, dp flags off). Encoded via
  //     existing v1 columns only — no history schema change. ---
  const roomText = [candidate.room_name, candidate.plan_name, candidate.room_or_plan_name, candidate.selected_block_text]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" \n ");
  const room = classifyRoomBasis(roomText);
  if (room.roomBasis !== "confirmed_two_person_standard_room") {
    const reason = roomBasisDpExclusionReason(room.roomBasis) ?? "unknown_room_basis_excluded";
    return {
      availability_status: "available",
      basis_confidence: "C",
      dp_usage: "excluded",
      source_classification: "jalan_room_type_excluded",
      basis_note: `Price visible, meal_basis=confirmed_room_only, but room_basis=${room.roomBasis} (${room.reason}); excluded from two-person-standard DP per confirmed policy.`,
      hard_exclusion_reason: reason,
      direct_downgrade_reason: "",
      directional_downgrade_reason: reason,
      evidence_flags: flags,
      warning_flags: [...warnings, reason, `room_basis=${room.roomBasis}`]
    };
  }
  // Confirmed two-person standard room: record the marker and continue.
  warnings.push("room_basis_confirmed_two_person_standard", "room_basis=confirmed_two_person_standard_room");

  // --- Price visible. Compute the reason a row cannot be DIRECT. ---
  const directBlockers: string[] = [];
  if (candidate.extraction_confidence !== "high") directBlockers.push("extraction_confidence_not_high");
  if (!flags.tax_included_total_visible) directBlockers.push("tax_included_total_not_confirmed");
  if (!flags.stay_scope_confirmed) directBlockers.push("stay_scope_not_confirmed");
  if (!flags.date_condition_confirmed) directBlockers.push("date_condition_not_confirmed");
  if (!flags.property_identity_confirmed) directBlockers.push("property_identity_not_confirmed");
  if (!flags.meal_condition_visible) directBlockers.push("meal_condition_missing");
  if (!flags.screenshot_saved) directBlockers.push("missing_screenshot");
  if (flags.selected_plan_coupon_or_discount_evidence) directBlockers.push("selected_plan_coupon_or_discount");
  if (flags.selected_plan_member_or_point_evidence) directBlockers.push("selected_plan_member_or_point");
  if (flags.page_chrome_coupon_or_discount_evidence) directBlockers.push("page_chrome_coupon_or_discount");
  if (flags.page_chrome_member_or_point_evidence) directBlockers.push("page_chrome_member_or_point");
  if (flags.suspicious_price_evidence) directBlockers.push("suspicious_price");

  // --- Hard disqualifiers that also block DIRECTIONAL. ---
  const directionalBlockers: string[] = [];
  if (!flags.screenshot_saved) directionalBlockers.push("missing_screenshot");
  if (!flags.property_identity_confirmed) directionalBlockers.push("property_identity_not_confirmed");
  if (!flags.date_condition_confirmed) directionalBlockers.push("date_condition_not_confirmed");
  if (!flags.stay_scope_confirmed) directionalBlockers.push("stay_scope_not_confirmed");
  if (flags.selected_plan_coupon_or_discount_evidence) directionalBlockers.push("selected_plan_coupon_or_discount_not_comparable");
  if (flags.selected_plan_member_or_point_evidence) directionalBlockers.push("selected_plan_member_or_point_not_comparable");
  if (flags.suspicious_price_evidence) directionalBlockers.push("suspicious_price");

  if (directBlockers.length === 0) {
    return {
      availability_status: "available",
      basis_confidence: "A",
      dp_usage: "direct",
      source_classification: "jalan_direct_tax_included_total",
      basis_note: "A-confidence Jalan tax-included total with screenshot, scope, date, property, meal, and coupon guards all satisfied.",
      hard_exclusion_reason: "",
      direct_downgrade_reason: "",
      directional_downgrade_reason: "",
      evidence_flags: flags,
      warning_flags: warnings
    };
  }

  if (directionalBlockers.length > 0) {
    return {
      availability_status: "available",
      basis_confidence: "C",
      dp_usage: "excluded",
      source_classification: "jalan_price_disqualified",
      basis_note: `Price visible but a hard disqualifier prevents directional use: ${directionalBlockers.join(", ")}.`,
      hard_exclusion_reason: directionalBlockers[0]!,
      direct_downgrade_reason: directBlockers.join(";"),
      directional_downgrade_reason: directionalBlockers.join(";"),
      evidence_flags: flags,
      warning_flags: warnings
    };
  }

  // --- Directional: priced, screenshot + property/date/scope confirmed, only
  //     direct-specific gaps remain (page-chrome coupon, meal/plan gaps). ---
  return {
    availability_status: "available",
    basis_confidence: "B",
    dp_usage: "directional",
    source_classification: "jalan_directional_tax_included_total",
    basis_note: "Visible tax-included total usable as same-property directional price-pressure evidence; direct withheld due to non-hard gaps.",
    hard_exclusion_reason: "",
    direct_downgrade_reason: directBlockers.join(";"),
    directional_downgrade_reason: "",
    evidence_flags: flags,
    warning_flags: warnings
  };
}

function collectWarnings(candidate: JalanImprovedExtractionCandidate, flags: JalanEvidenceFlags): string[] {
  const warnings: string[] = [];
  if (!flags.screenshot_saved) warnings.push("missing_screenshot_path");
  if (flags.page_chrome_coupon_or_discount_evidence) warnings.push("page_chrome_coupon_or_discount_evidence");
  if (flags.page_chrome_member_or_point_evidence) warnings.push("page_chrome_member_or_point_evidence");
  if (flags.selected_plan_coupon_or_discount_evidence) warnings.push("selected_plan_coupon_or_discount_evidence");
  if (flags.selected_plan_member_or_point_evidence) warnings.push("selected_plan_member_or_point_evidence");
  if (flags.suspicious_price_evidence) warnings.push("suspicious_price_evidence");
  if (!flags.date_condition_confirmed) warnings.push("date_condition_not_confirmed");
  if (!flags.stay_scope_confirmed) warnings.push("stay_scope_not_confirmed");
  if (!flags.tax_included_total_visible) warnings.push("tax_included_total_not_confirmed");
  if (!flags.property_identity_confirmed) warnings.push("property_identity_not_confirmed");
  if (!flags.meal_condition_visible) warnings.push("meal_condition_missing");
  return warnings;
}

// ---------------------------------------------------------------------------
// Normalized preview row
// ---------------------------------------------------------------------------

export interface JalanImprovedPreviewRow {
  run_id: string;
  checked_at: string;
  collected_date_jst: string;
  collected_at_jst: string;
  normalized_at_jst: string;
  source: "jalan";
  source_phase: "JALAN-AUTO03B";
  collector_stage: "improved_coupon_aware_bounded_preview";
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
  room_name: string;
  plan_name: string;
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
  hard_exclusion_reason: string;
  direct_downgrade_reason: string;
  directional_downgrade_reason: string;
  evidence_flags: JalanEvidenceFlags;
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

export function buildImprovedPreviewRow(input: {
  runId: string;
  checkedAt: string;
  target: JalanProbeTarget;
  candidate: JalanImprovedExtractionCandidate;
  reportPath: string;
  csvPath: string;
  debugPath: string;
}): JalanImprovedPreviewRow {
  const c = classifyImprovedCandidate(input.candidate);
  const price = input.candidate.price_total_tax_included;
  return {
    run_id: input.runId,
    checked_at: input.checkedAt,
    collected_date_jst: input.checkedAt.slice(0, 10),
    collected_at_jst: input.checkedAt,
    normalized_at_jst: input.checkedAt,
    source: "jalan",
    source_phase: "JALAN-AUTO03B",
    collector_stage: "improved_coupon_aware_bounded_preview",
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
    room_name: input.candidate.room_name ?? "",
    plan_name: input.candidate.plan_name ?? "",
    meal_condition: input.candidate.meal_condition ?? "",
    availability_status: c.availability_status,
    sold_out_status: c.availability_status === "sold_out" ? "sold_out" : "not_sold_out_confirmed",
    normalized_total_price: c.dp_usage === "excluded" && price === null ? null : price,
    normalized_total_price_source: price === null ? "" : "jalan_visible_total_tax_included",
    normalized_total_price_basis: price === null ? "missing_or_unclear" : "tax_included_total",
    normalized_total_price_confidence: c.basis_confidence,
    basis_confidence: c.basis_confidence,
    basis_note: c.basis_note,
    source_primary_price: price,
    source_secondary_price_or_adder: null,
    source_computed_total: price,
    source_tax_or_fee_classification: price === null ? "missing_or_unclear" : "tax_included_total",
    source_classification: c.source_classification,
    dp_usage: c.dp_usage,
    is_price_usable_for_dp_direct: c.dp_usage === "direct",
    is_price_usable_for_dp_directional: c.dp_usage === "direct" || c.dp_usage === "directional",
    is_price_excluded_from_dp: c.dp_usage === "excluded",
    dp_exclusion_reason: c.hard_exclusion_reason,
    hard_exclusion_reason: c.hard_exclusion_reason,
    direct_downgrade_reason: c.direct_downgrade_reason,
    directional_downgrade_reason: c.directional_downgrade_reason,
    evidence_flags: c.evidence_flags,
    warning_flags: c.warning_flags.join(";"),
    error_reason: input.candidate.error_reason ?? "",
    screenshot_path: input.candidate.screenshot_path ?? "",
    source_report_path: input.reportPath,
    source_csv_path: input.csvPath,
    debug_artifact_path: input.debugPath,
    schema_version: "zao_local_history_v1",
    raw_text_excerpt: input.candidate.page_text_excerpt.slice(0, 1200),
    raw_json: JSON.stringify({ target: input.target, candidate: input.candidate, classification: c })
  };
}

// ---------------------------------------------------------------------------
// AUTO03X comparison + rescued rows
// ---------------------------------------------------------------------------

export interface Auto03xPriorRow {
  source_slug_or_code: string;
  checkin: string;
  dp_usage: string;
  normalized_total_price: number | null;
}

export interface Auto03xComparisonSummary {
  auto03x: { direct: number; directional: number; excluded: number; price_detected: number };
  auto03b: { direct: number; directional: number; excluded: number; price_detected: number };
  rows_rescued_from_excluded_to_directional: number;
  rows_kept_excluded_due_to_selected_plan_discount: number;
  rows_kept_excluded_due_to_failed_not_found_sold_out: number;
  rows_with_generic_page_chrome_only: number;
}

export interface RescuedRow {
  canonical_property_name: string;
  source_slug_or_code: string;
  checkin: string;
  auto03x_dp_usage: string;
  auto03b_dp_usage: ProbeDpUsage;
  normalized_total_price: number | null;
  rescue_reason: string;
}

function priorKey(row: { source_slug_or_code: string; checkin: string }): string {
  return `${row.source_slug_or_code}_${row.checkin}`;
}

export function buildAuto03xComparison(input: {
  priorRows: readonly Auto03xPriorRow[];
  rows: readonly JalanImprovedPreviewRow[];
}): Auto03xComparisonSummary {
  const prior = new Map(input.priorRows.map((row) => [priorKey(row), row]));
  const rows = input.rows;
  const dpCount = (list: readonly { dp_usage: string }[], usage: string): number =>
    list.filter((row) => row.dp_usage === usage).length;
  return {
    auto03x: {
      direct: dpCount(input.priorRows, "direct"),
      directional: dpCount(input.priorRows, "directional"),
      excluded: dpCount(input.priorRows, "excluded"),
      price_detected: input.priorRows.filter((row) => row.normalized_total_price !== null).length
    },
    auto03b: {
      direct: dpCount(rows, "direct"),
      directional: dpCount(rows, "directional"),
      excluded: dpCount(rows, "excluded"),
      price_detected: rows.filter((row) => row.normalized_total_price !== null).length
    },
    rows_rescued_from_excluded_to_directional: rows.filter((row) => {
      const before = prior.get(priorKey(row));
      return before?.dp_usage === "excluded" && row.dp_usage === "directional";
    }).length,
    rows_kept_excluded_due_to_selected_plan_discount: rows.filter(
      (row) =>
        row.dp_usage === "excluded" &&
        (row.evidence_flags.selected_plan_coupon_or_discount_evidence ||
          row.evidence_flags.selected_plan_member_or_point_evidence)
    ).length,
    rows_kept_excluded_due_to_failed_not_found_sold_out: rows.filter(
      (row) =>
        row.dp_usage === "excluded" &&
        (row.availability_status === "failed" ||
          row.availability_status === "not_found" ||
          row.availability_status === "sold_out")
    ).length,
    rows_with_generic_page_chrome_only: rows.filter(
      (row) =>
        (row.evidence_flags.page_chrome_coupon_or_discount_evidence ||
          row.evidence_flags.page_chrome_member_or_point_evidence) &&
        !row.evidence_flags.selected_plan_coupon_or_discount_evidence &&
        !row.evidence_flags.selected_plan_member_or_point_evidence
    ).length
  };
}

export function buildRescuedRows(input: {
  priorRows: readonly Auto03xPriorRow[];
  rows: readonly JalanImprovedPreviewRow[];
}): RescuedRow[] {
  const prior = new Map(input.priorRows.map((row) => [priorKey(row), row]));
  return input.rows
    .filter((row) => {
      const before = prior.get(priorKey(row));
      return before?.dp_usage === "excluded" && row.dp_usage === "directional";
    })
    .map((row) => ({
      canonical_property_name: row.canonical_property_name,
      source_slug_or_code: row.source_slug_or_code,
      checkin: row.checkin,
      auto03x_dp_usage: "excluded",
      auto03b_dp_usage: row.dp_usage,
      normalized_total_price: row.normalized_total_price,
      rescue_reason: row.evidence_flags.page_chrome_coupon_or_discount_evidence
        ? "page_chrome_coupon_only_now_directional"
        : "non_disqualified_price_now_directional"
    }));
}

// ---------------------------------------------------------------------------
// Decision + summaries
// ---------------------------------------------------------------------------

export function decideImproved(input: {
  targetCount: number;
  rowCount: number;
  failedCount: number;
  blockedCount: number;
  pricedRows: number;
  directionalCount: number;
  screenshotCount: number;
  artifactWriteFailed?: boolean;
}): JalanImprovedDecision {
  if (input.artifactWriteFailed) return "jalan_bounded_collection_probe_improved_failed";
  if (input.targetCount === 0 || input.targetCount > MAX_PAGES || input.rowCount !== input.targetCount) {
    return "jalan_bounded_collection_probe_improved_not_ready";
  }
  if (input.failedCount / input.targetCount > 0.6 || input.pricedRows === 0) {
    return "jalan_bounded_collection_probe_improved_not_ready";
  }
  // Price detected but nothing usable directionally is the failure mode AUTO03B
  // exists to fix.
  if (input.directionalCount === 0) {
    return "jalan_bounded_collection_probe_improved_not_ready";
  }
  if (input.failedCount > 0 || input.blockedCount > 0 || input.screenshotCount < input.targetCount) {
    return "jalan_bounded_collection_probe_improved_basis_caution";
  }
  return "jalan_bounded_collection_probe_improved_ready";
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export function buildImprovedSummaries(input: {
  targets: readonly JalanProbeTarget[];
  rows: readonly JalanImprovedPreviewRow[];
}): {
  target_matrix_summary: Record<string, unknown>;
  page_results_summary: Record<string, unknown>;
  normalized_preview_rows_summary: Record<string, unknown>;
  direct_directional_excluded_summary: Record<string, number>;
  availability_summary: Record<string, number>;
  confidence_summary: Record<string, number>;
  price_basis_summary: Record<string, number>;
  coupon_discount_evidence_summary: Record<string, number>;
  evidence_flags_summary: Record<string, number>;
  screenshot_summary: Record<string, unknown>;
  failure_summary: Record<string, unknown>;
} {
  const rows = input.rows;
  const failed = rows.filter((row) => row.availability_status === "failed");
  return {
    target_matrix_summary: {
      target_count: input.targets.length,
      property_count: new Set(input.targets.map((target) => target.jalan_yad_id)).size,
      date_count: new Set(input.targets.map((target) => target.checkin)).size,
      max_pages: MAX_PAGES
    },
    page_results_summary: {
      attempted_pages: rows.length,
      priced_rows: rows.filter((row) => row.normalized_total_price !== null).length
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
    coupon_discount_evidence_summary: {
      selected_plan_coupon_or_discount: rows.filter((row) => row.evidence_flags.selected_plan_coupon_or_discount_evidence).length,
      selected_plan_member_or_point: rows.filter((row) => row.evidence_flags.selected_plan_member_or_point_evidence).length,
      page_chrome_coupon_or_discount: rows.filter((row) => row.evidence_flags.page_chrome_coupon_or_discount_evidence).length,
      page_chrome_member_or_point: rows.filter((row) => row.evidence_flags.page_chrome_member_or_point_evidence).length,
      suspicious_price: rows.filter((row) => row.evidence_flags.suspicious_price_evidence).length
    },
    evidence_flags_summary: {
      tax_included_total_visible: rows.filter((row) => row.evidence_flags.tax_included_total_visible).length,
      date_condition_confirmed: rows.filter((row) => row.evidence_flags.date_condition_confirmed).length,
      stay_scope_confirmed: rows.filter((row) => row.evidence_flags.stay_scope_confirmed).length,
      property_identity_confirmed: rows.filter((row) => row.evidence_flags.property_identity_confirmed).length,
      screenshot_saved: rows.filter((row) => row.evidence_flags.screenshot_saved).length,
      meal_condition_visible: rows.filter((row) => row.evidence_flags.meal_condition_visible).length
    },
    screenshot_summary: {
      target_count: input.targets.length,
      screenshot_count: rows.filter((row) => row.screenshot_path !== "").length,
      missing_screenshot_count: rows.filter((row) => row.screenshot_path === "").length
    },
    failure_summary: {
      failed_count: failed.length,
      error_reason_counts: countBy(failed.map((row) => row.error_reason || "unknown"))
    }
  };
}

// ---------------------------------------------------------------------------
// Future plan + safety
// ---------------------------------------------------------------------------

export interface FutureAuto04xPlan {
  phase: "JALAN-AUTO04X";
  objective: string;
  allowed_actions: string[];
  forbidden_actions: string[];
  expected_outputs: string[];
}

export function buildFutureAuto04xPlan(): FutureAuto04xPlan {
  return {
    phase: "JALAN-AUTO04X",
    objective:
      "Read AUTO03B directional preview rows and propose a guarded Jalan .data/history append (directional-only, no direct promotion) without writing history.",
    allowed_actions: [
      "Read AUTO03B artifacts",
      "Compare directional preview rows with .data/history in memory",
      "Produce append/skip/conflict proposal for directional Jalan rows"
    ],
    forbidden_actions: ["No live collection", "No history append", "No DB write", "No AI context refresh", "No pricing/PMS output"],
    expected_outputs: ["Jalan history append proposal", "dedupe/conflict summary", "touched shard plan", "approval gate for AUTO05X"]
  };
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
  price_update: false;
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
    price_update: false,
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

// ---------------------------------------------------------------------------
// CSV + report rendering
// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

export function renderImprovedPreviewRowsCsv(rows: readonly JalanImprovedPreviewRow[]): string {
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
    "hard_exclusion_reason",
    "direct_downgrade_reason",
    "directional_downgrade_reason",
    "selected_plan_coupon_or_discount_evidence",
    "page_chrome_coupon_or_discount_evidence",
    "error_reason",
    "screenshot_path",
    "debug_artifact_path",
    "schema_version"
  ];
  const cellFor = (row: JalanImprovedPreviewRow, key: string): string => {
    if (key === "selected_plan_coupon_or_discount_evidence") return String(row.evidence_flags.selected_plan_coupon_or_discount_evidence);
    if (key === "page_chrome_coupon_or_discount_evidence") return String(row.evidence_flags.page_chrome_coupon_or_discount_evidence);
    return String(row[key as keyof JalanImprovedPreviewRow] ?? "");
  };
  return [header.join(","), ...rows.map((row) => header.map((key) => csvCell(cellFor(row, key))).join(","))].join("\n") + "\n";
}

export function renderImprovedReport(input: {
  generatedAtJst: string;
  decision: JalanImprovedDecision;
  sourceAuto02xArtifact: string;
  sourceAuto03xArtifact: string;
  sourceAuto03rArtifact: string;
  targetMatrixSummary: Record<string, unknown>;
  pageResultsSummary: Record<string, unknown>;
  normalizedPreviewRowsSummary: Record<string, unknown>;
  auto03xComparison: Auto03xComparisonSummary;
  availabilitySummary: Record<string, number>;
  priceBasisSummary: Record<string, number>;
  couponDiscountEvidenceSummary: Record<string, number>;
  directDirectionalExcludedSummary: Record<string, number>;
  rescuedRows: readonly RescuedRow[];
  failureSummary: Record<string, unknown>;
  screenshotSummary: Record<string, unknown>;
  futureAuto04xPlan: FutureAuto04xPlan;
  safetyConfirmation: SafetyConfirmation;
}): string {
  const rescueLines =
    input.rescuedRows.length === 0
      ? "No rows were rescued from excluded to directional."
      : input.rescuedRows
          .map((row) => `- ${row.canonical_property_name} (${row.source_slug_or_code}) ${row.checkin}: ${row.normalized_total_price ?? ""} -> directional (${row.rescue_reason})`)
          .join("\n");
  return `# Improved Jalan Bounded Collection Probe

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary

JALAN-AUTO03B reran the bounded 25-target Jalan preview with a coupon-aware classifier. Booking remains the main directional backbone; Jalan is a supplementary domestic OTA signal. Decision: ${input.decision}.

## 2. Source AUTO02X / AUTO03X / AUTO03R Context

- AUTO02X target matrix: ${input.sourceAuto02xArtifact}
- AUTO03X probe result: ${input.sourceAuto03xArtifact}
- AUTO03R review: ${input.sourceAuto03rArtifact}

## 3. Collection Scope

- Fixed verified Jalan property/date targets only.
- Maximum pages: ${MAX_PAGES}
- Maximum retries per target: ${MAX_RETRIES_PER_TARGET}
- Browser page parallelism: 1
- Summary: ${JSON.stringify(input.targetMatrixSummary)}

## 4. AUTO03X vs AUTO03B Comparison

${JSON.stringify(input.auto03xComparison, null, 2)}

## 5. Page Results Summary

${JSON.stringify(input.pageResultsSummary, null, 2)}

## 6. Normalized Preview Rows

${JSON.stringify(input.normalizedPreviewRowsSummary, null, 2)}

## 7. Availability Summary

${JSON.stringify(input.availabilitySummary, null, 2)}

## 8. Price Basis Summary

${JSON.stringify(input.priceBasisSummary, null, 2)}

## 9. Coupon / Discount Evidence Summary

${JSON.stringify(input.couponDiscountEvidenceSummary, null, 2)}

## 10. Direct / Directional / Excluded Summary

${JSON.stringify(input.directDirectionalExcludedSummary, null, 2)}

## 11. Rescued Rows

${rescueLines}

## 12. Failure / Error Summary

${JSON.stringify(input.failureSummary, null, 2)}

## 13. Screenshot / Evidence Summary

${JSON.stringify(input.screenshotSummary, null, 2)}

## 14. Future AUTO04X Plan

- ${input.futureAuto04xPlan.phase}: ${input.futureAuto04xPlan.objective}
- Expected outputs: ${input.futureAuto04xPlan.expected_outputs.join("; ")}

## 15. Safety Confirmation

${Object.entries(input.safetyConfirmation).map(([key, value]) => `- ${key}: ${String(value)}`).join("\n")}

## 16. Decision

${input.decision}

## 17. Next Phase

${
    input.auto03xComparison.auto03b.directional > 0
      ? "JALAN-AUTO04X — Jalan history append proposal (directional-only). Do not start without explicit instruction."
      : "JALAN-AUTO03C — Jalan extractor/manual evidence refinement. Do not start without explicit instruction."
  }
`;
}

export function stableRowHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(row, Object.keys(row).sort())).digest("hex");
}
