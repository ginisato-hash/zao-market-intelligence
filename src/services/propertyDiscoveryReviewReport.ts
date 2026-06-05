// Phase D03X — Property Discovery Review Report.
//
// Pure, read-only review layer. Converts the D02X normalization artifact
// (classified candidate rows) into a human-readable review packet: per-row
// review severity, a refined (review-only) recommended action, a generic
// informational-page misdetection guard, a descriptive (non-executed) D04X
// allowed-action, and Markdown/CSV/JSON renderers.
//
// THIS MODULE MUTATES NOTHING. No DB writes. No properties-master update. No
// alias update. No active promotion. No price-collection-target update. No
// GitHub Actions / GitOps / cron. No version-control commits or pushes. No
// paid sources. Every "allowed action" emitted here is descriptive only and
// is gated on explicit human approval in a future D04X phase. D04X is the
// only phase that may update the master, and only after explicit approval.

import type {
  D02XClassification,
  D02XConfidence,
  D02XRecommendedAction,
  MatchEntryType,
  MatchType
} from "./propertyNameNormalization";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewSeverity = "none" | "low" | "medium" | "high" | "critical";

// Review-only refined action (NOT executed). Describes what a human reviewer
// should consider doing, not what the system does.
export type ReviewRecommendedAction =
  | "none"
  | "keep_existing"
  | "review_then_add_alias"
  | "review_then_add_new_property"
  | "review_then_reactivate"
  | "mark_duplicate"
  | "mark_out_of_scope"
  | "mark_closed_or_inactive"
  | "manual_review";

// Descriptive (non-executed) D04X action. All of these require explicit human
// approval before D04X may ever act on them. They are labels for a proposal,
// not instructions the system follows.
export type D04XAllowedAction =
  | "none"
  | "add_alias_after_approval"
  | "add_new_property_after_approval"
  | "reactivate_after_approval"
  | "mark_duplicate_after_approval"
  | "mark_out_of_scope_after_approval"
  | "mark_closed_or_inactive_after_approval";

export type D03XDecision =
  | "property_discovery_review_ready"
  | "property_discovery_review_basis_caution"
  | "property_discovery_review_not_ready";

// Subset of the D02X row that D03X consumes (read-only).
export interface D02XInputRow {
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

export interface ReviewRow {
  runId: string;
  reviewedAtJst: string;
  detectedName: string;
  normalizedDetectedName: string;
  sourceNames: string[];
  sourceUrls: string[];
  sourceCount: number;
  bestSourceConfidence: D02XConfidence;
  isLodgingLike: boolean;
  isAreaLikelyZaoOnsen: boolean;
  matchedCanonicalPropertyName: string;
  matchedEntryType: MatchEntryType | "";
  matchType: MatchType;
  similarity: number;
  classification: D02XClassification;
  confidence: D02XConfidence;
  recommendedAction: D02XRecommendedAction;
  recommendedActionRefined: ReviewRecommendedAction;
  reviewSeverity: ReviewSeverity;
  warning: string;
  needsHumanReview: boolean;
  d04xAllowedAction: D04XAllowedAction;
  d04xRequiresExplicitApproval: boolean;
  sourceD02xRowRef: string;
  reason: string;
  debugArtifactPath: string;
}

export const PROPERTY_DISCOVERY_REVIEW_CSV_HEADERS = [
  "run_id",
  "reviewed_at_jst",
  "detected_name",
  "normalized_detected_name",
  "source_names",
  "source_urls",
  "source_count",
  "best_source_confidence",
  "is_lodging_like",
  "is_area_likely_zao_onsen",
  "matched_canonical_property_name",
  "matched_entry_type",
  "match_type",
  "similarity",
  "classification",
  "confidence",
  "recommended_action",
  "recommended_action_refined",
  "review_severity",
  "warning",
  "needs_human_review",
  "d04x_allowed_action",
  "d04x_requires_explicit_approval",
  "source_d02x_row_ref",
  "reason",
  "debug_artifact_path"
] as const;

// Forbidden column tokens that must never appear in D03X output (Beds24/AirHost/PMS).
export const D03X_FORBIDDEN_COLUMN_TOKENS = [
  "beds24",
  "airhost",
  "pms_",
  "channel_manager",
  "ota_upload"
] as const;

// Generic informational page / title terms. If one of these appears in a
// detected name that was classified as a brand-new property, the detection is
// almost certainly a page heading / informational section, not a lodging.
export const GENERIC_INFORMATIONAL_TERMS = [
  "蔵王温泉とは",
  "アクセス",
  "観光",
  "温泉",
  "料金",
  "プラン",
  "口コミ",
  "周辺情報"
] as const;

// ---------------------------------------------------------------------------
// Severity, refined action, D04X allowed action
// ---------------------------------------------------------------------------

export function reviewSeverityFor(row: D02XInputRow): ReviewSeverity {
  switch (row.classification) {
    case "active_existing":
      return "none";
    case "out_of_scope_candidate":
      return "low";
    case "alias_candidate":
      return "medium";
    case "uncertain_candidate":
      // Lodging-like + in-area uncertainty deserves more attention.
      return row.isLodgingLike && row.isAreaLikelyZaoOnsen ? "high" : "medium";
    case "closed_or_inactive_candidate":
      // Affects an existing active property → high if confident, else medium.
      return row.confidence === "C" ? "medium" : "high";
    case "duplicate_candidate":
    case "new_candidate":
    case "reopened_candidate":
      return "high";
    default:
      return "medium";
  }
}

export function refinedActionFor(row: D02XInputRow): ReviewRecommendedAction {
  switch (row.classification) {
    case "active_existing":
      return "keep_existing";
    case "alias_candidate":
      return "review_then_add_alias";
    case "new_candidate":
      return "review_then_add_new_property";
    case "reopened_candidate":
      return "review_then_reactivate";
    case "duplicate_candidate":
      return "mark_duplicate";
    case "closed_or_inactive_candidate":
      return "mark_closed_or_inactive";
    case "out_of_scope_candidate":
      return "mark_out_of_scope";
    case "uncertain_candidate":
      return "manual_review";
    default:
      return "manual_review";
  }
}

export function d04xAllowedActionFor(row: D02XInputRow): D04XAllowedAction {
  switch (row.classification) {
    case "alias_candidate":
      return "add_alias_after_approval";
    case "new_candidate":
      return "add_new_property_after_approval";
    case "reopened_candidate":
      return "reactivate_after_approval";
    case "duplicate_candidate":
      return "mark_duplicate_after_approval";
    case "closed_or_inactive_candidate":
      return "mark_closed_or_inactive_after_approval";
    case "active_existing":
    case "out_of_scope_candidate":
    case "uncertain_candidate":
    default:
      return "none";
  }
}

export function containsGenericInformationalTerm(detectedName: string): boolean {
  const name = detectedName.normalize("NFKC");
  return GENERIC_INFORMATIONAL_TERMS.some((term) => name.includes(term));
}

// ---------------------------------------------------------------------------
// Build review rows
// ---------------------------------------------------------------------------

export function buildReviewRow(input: { runId: string; reviewedAtJst: string; row: D02XInputRow }): ReviewRow {
  const { runId, reviewedAtJst, row } = input;

  let reviewSeverity = reviewSeverityFor(row);
  let recommendedActionRefined = refinedActionFor(row);
  let d04xAllowedAction = d04xAllowedActionFor(row);
  let warning = "";

  // Critical generic-informational-page guard: a "new property" whose name is a
  // generic informational heading is almost certainly a misdetection.
  if (row.classification === "new_candidate" && containsGenericInformationalTerm(row.detectedName)) {
    reviewSeverity = "critical";
    recommendedActionRefined = "mark_out_of_scope";
    d04xAllowedAction = "mark_out_of_scope_after_approval";
    warning = "generic informational page/title likely misdetected as property";
  }

  const d04xRequiresExplicitApproval = d04xAllowedAction !== "none";

  return {
    runId,
    reviewedAtJst,
    detectedName: row.detectedName,
    normalizedDetectedName: row.normalizedDetectedName,
    sourceNames: row.sourceNames,
    sourceUrls: row.sourceUrls,
    sourceCount: row.sourceCount,
    bestSourceConfidence: row.bestSourceConfidence,
    isLodgingLike: row.isLodgingLike,
    isAreaLikelyZaoOnsen: row.isAreaLikelyZaoOnsen,
    matchedCanonicalPropertyName: row.matchedCanonicalPropertyName,
    matchedEntryType: row.matchedEntryType,
    matchType: row.matchType,
    similarity: row.similarity,
    classification: row.classification,
    confidence: row.confidence,
    recommendedAction: row.recommendedAction,
    recommendedActionRefined,
    reviewSeverity,
    warning,
    needsHumanReview: row.needsHumanReview || reviewSeverity === "critical",
    d04xAllowedAction,
    d04xRequiresExplicitApproval,
    sourceD02xRowRef: row.sourceRowIds.join(";"),
    reason: row.reason,
    debugArtifactPath: row.debugArtifactPath
  };
}

export function buildReviewRows(input: { runId: string; reviewedAtJst: string; rows: D02XInputRow[] }): ReviewRow[] {
  return input.rows.map((row) => buildReviewRow({ runId: input.runId, reviewedAtJst: input.reviewedAtJst, row }));
}

// ---------------------------------------------------------------------------
// Decision + summaries
// ---------------------------------------------------------------------------

export function decideD03X(input: {
  reviewRowCount: number;
  criticalCount: number;
  highCount: number;
  humanReviewCount: number;
}): D03XDecision {
  if (input.reviewRowCount === 0) return "property_discovery_review_not_ready";
  if (input.criticalCount > 0) return "property_discovery_review_basis_caution";
  if (input.highCount > 0 || input.humanReviewCount > 0) return "property_discovery_review_basis_caution";
  return "property_discovery_review_ready";
}

export function countBy<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export interface D04XScopeRecommendation {
  note: string;
  requiresExplicitApproval: true;
  willNotExecuteAutomatically: true;
  proposedActions: Array<{
    detectedName: string;
    classification: D02XClassification;
    reviewSeverity: ReviewSeverity;
    d04xAllowedAction: D04XAllowedAction;
    matchedCanonicalPropertyName: string;
  }>;
}

export function buildD04XScopeRecommendation(rows: ReviewRow[]): D04XScopeRecommendation {
  const proposedActions = rows
    .filter((r) => r.d04xAllowedAction !== "none")
    .map((r) => ({
      detectedName: r.detectedName,
      classification: r.classification,
      reviewSeverity: r.reviewSeverity,
      d04xAllowedAction: r.d04xAllowedAction,
      matchedCanonicalPropertyName: r.matchedCanonicalPropertyName
    }));
  return {
    note:
      "Proposed D04X scope only. D03X did NOT execute any of these actions. Each action requires explicit human approval; D04X is the only phase permitted to update the master, and only after approval.",
    requiresExplicitApproval: true,
    willNotExecuteAutomatically: true,
    proposedActions
  };
}

export interface ReviewSummary {
  runId: string;
  generatedAt: string;
  sourceD02xArtifact: string;
  reviewRowCount: number;
  d02xDecision: string;
  classificationCounts: Record<string, number>;
  reviewSeverityCounts: Record<string, number>;
  recommendedActionRefinedCounts: Record<string, number>;
  d04xAllowedActionCounts: Record<string, number>;
  criticalCount: number;
  highCount: number;
  humanReviewCount: number;
  warnings: string[];
  decision: D03XDecision;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderReviewCsv(rows: ReviewRow[]): string {
  const body = rows.map((row) =>
    [
      row.runId,
      row.reviewedAtJst,
      row.detectedName,
      row.normalizedDetectedName,
      row.sourceNames.join(";"),
      row.sourceUrls.join(";"),
      String(row.sourceCount),
      row.bestSourceConfidence,
      bool(row.isLodgingLike),
      bool(row.isAreaLikelyZaoOnsen),
      row.matchedCanonicalPropertyName,
      row.matchedEntryType,
      row.matchType,
      String(row.similarity),
      row.classification,
      row.confidence,
      row.recommendedAction,
      row.recommendedActionRefined,
      row.reviewSeverity,
      row.warning,
      bool(row.needsHumanReview),
      row.d04xAllowedAction,
      bool(row.d04xRequiresExplicitApproval),
      row.sourceD02xRowRef,
      row.reason,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [PROPERTY_DISCOVERY_REVIEW_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

const SEVERITY_ORDER: ReviewSeverity[] = ["critical", "high", "medium", "low", "none"];

export function renderReviewReport(input: { summary: ReviewSummary; rows: ReviewRow[] }): string {
  const { summary, rows } = input;
  const bySeverity = (s: ReviewSeverity): ReviewRow[] => rows.filter((r) => r.reviewSeverity === s);
  const humanReviewItems = rows.filter((r) => r.needsHumanReview);
  const line = (r: ReviewRow): string =>
    `- [${r.reviewSeverity}] ${r.detectedName} → ${r.matchedCanonicalPropertyName || "(no match)"} ` +
    `[${r.classification}, action=${r.recommendedActionRefined}, d04x=${r.d04xAllowedAction}]` +
    (r.warning ? ` ⚠ ${r.warning}` : "");
  const listOrNone = (items: ReviewRow[]): string[] => (items.length === 0 ? ["- none"] : items.slice(0, 80).map(line));

  return [
    "# Property Discovery Review Report (Phase D03X)",
    "",
    `Generated at: ${summary.generatedAt}`,
    "",
    "## 1. Executive Summary",
    "",
    `- decision=${summary.decision}`,
    `- source_d02x_artifact=${summary.sourceD02xArtifact}`,
    `- review_row_count=${summary.reviewRowCount}`,
    `- critical_count=${summary.criticalCount}`,
    `- high_count=${summary.highCount}`,
    `- human_review_count=${summary.humanReviewCount}`,
    summary.criticalCount > 0
      ? "- ATTENTION: one or more rows are critical (likely generic informational-page misdetection); human review required before any D04X action."
      : "- No critical misdetections flagged.",
    "",
    "## 2. Upstream D02X basis",
    "",
    `- d02x_decision=${summary.d02xDecision}`,
    `- classification_counts=${JSON.stringify(summary.classificationCounts)}`,
    "",
    "## 3. Review severity counts",
    "",
    `- ${JSON.stringify(summary.reviewSeverityCounts)}`,
    "",
    "## 4. Refined (review-only) recommended action counts",
    "",
    `- ${JSON.stringify(summary.recommendedActionRefinedCounts)}`,
    "",
    "## 5. Descriptive D04X allowed-action counts (not executed)",
    "",
    `- ${JSON.stringify(summary.d04xAllowedActionCounts)}`,
    "",
    "## 6. Critical items",
    "",
    ...listOrNone(bySeverity("critical")),
    "",
    "## 7. High-severity items",
    "",
    ...listOrNone(bySeverity("high")),
    "",
    "## 8. Medium-severity items",
    "",
    ...listOrNone(bySeverity("medium")),
    "",
    "## 9. Low-severity items",
    "",
    ...listOrNone(bySeverity("low")),
    "",
    "## 10. No-action (active existing) items",
    "",
    `- count=${bySeverity("none").length} (kept as existing active matches; not enumerated)`,
    "",
    "## 11. Human review queue",
    "",
    ...listOrNone(humanReviewItems),
    "",
    "## 12. Generic informational-page guard",
    "",
    `- generic_terms=${JSON.stringify([...GENERIC_INFORMATIONAL_TERMS])}`,
    "- Rule: a new_candidate whose detected name contains a generic term is escalated to critical and proposed mark_out_of_scope.",
    "",
    "## 13. Proposed (non-executed) D04X scope",
    "",
    "- D04X is the ONLY phase that may update the master, and ONLY after explicit human approval.",
    "- D03X did NOT execute any of the actions below; they are proposals for human review.",
    ...(() => {
      const proposals = rows.filter((r) => r.d04xAllowedAction !== "none");
      if (proposals.length === 0) return ["- none"];
      return proposals
        .slice(0, 80)
        .map((r) => `- ${r.detectedName}: ${r.d04xAllowedAction} (requires explicit approval) [${r.classification}]`);
    })(),
    "",
    "## 14. Warnings",
    "",
    summary.warnings.length > 0 ? summary.warnings.map((w) => `- ${w}`).join("\n") : "- none",
    "",
    "## 15. Safety confirmation",
    "",
    "- D03X did not modify the properties master.",
    "- D03X did not add aliases.",
    "- D03X did not active-promote candidates.",
    "- D03X did not add price collection targets.",
    "- D03X did not execute any D04X action; all D04X actions are descriptive and require explicit human approval.",
    "- No DB writes, no GitHub Actions/GitOps activation, no version-control commits or pushes, no paid sources.",
    "",
    "## 16. Output paths",
    "",
    `- report_path=${summary.reportPath}`,
    `- csv_path=${summary.csvPath}`,
    `- json_summary_path=${summary.jsonPath}`,
    `- debug_artifact_path=${summary.debugRootPath}`,
    "",
    "## 17. Next Steps",
    "",
    "- A human reviewer should triage the critical and high-severity items above.",
    "- Only after explicit approval may a future D04X phase apply the proposed master updates.",
    "- Do not enable GitHub Actions/GitOps, commit, push, or contact paid sources to act on this report.",
    ""
  ].join("\n");
}

export function assertNoForbiddenColumns(headerLine: string): void {
  const lower = headerLine.toLowerCase();
  for (const token of D03X_FORBIDDEN_COLUMN_TOKENS) {
    if (lower.includes(token)) {
      throw new Error(`D03X output must not include forbidden column token: ${token}`);
    }
  }
}

// Severity sort helper for callers that want a triage order.
export function sortBySeverity(rows: ReviewRow[]): ReviewRow[] {
  return [...rows].sort((a, b) => SEVERITY_ORDER.indexOf(a.reviewSeverity) - SEVERITY_ORDER.indexOf(b.reviewSeverity));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
