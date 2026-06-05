// Phase D05X — Property Discovery Regression / Re-run Check.
//
// Pure, read-only verification layer. Replays the D02X/D03X matching against
// the UPDATED excluded-audit artifact (now containing the two approved D04X
// rows) to confirm the approved exclusions are respected: "蔵王温泉とは" and
// "蔵王温泉について" must no longer surface as actionable new/duplicate
// candidates.
//
// THIS MODULE MUTATES NOTHING. It performs a LOCAL artifact replay only — it
// NEVER live-fetches external pages. No DB writes. No properties-master update.
// No alias update. No active promotion. No price-collection-target update. No
// GitHub Actions / GitOps / cron. No version-control commits or pushes. No
// paid sources. No Beds24 / AirHost / PMS / OTA export.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegressionStatus = "resolved" | "still_actionable" | "not_found_in_replay" | "unexpected";

export type D05XDecision =
  | "property_discovery_regression_ready"
  | "property_discovery_regression_basis_caution"
  | "property_discovery_regression_not_ready";

// Before-state for one approved item, taken from the D03X review artifact (read-only).
export interface BeforeStateRow {
  detectedName: string;
  sourceUrl: string;
  classification: string; // e.g. new_candidate / duplicate_candidate
  reviewSeverity: string; // e.g. critical / high
  d04xAllowedAction: string; // e.g. mark_out_of_scope_after_approval
}

// The approved D04X action for one item (read from the D04X artifact).
export interface ApprovedD04XItem {
  detectedName: string;
  sourceUrl: string;
  approvedAction: "mark_out_of_scope" | "mark_duplicate";
}

// One row of the UPDATED excluded-audit artifact (read-only).
export interface ExcludedAuditEntry {
  property_name_raw: string;
  property_url: string;
  exclusion_reason: string;
  review_decision: string;
}

export interface RegressionRow {
  runId: string;
  checkedAtJst: string;
  detectedName: string;
  sourceUrl: string;
  beforeClassification: string;
  beforeReviewSeverity: string;
  beforeD04xAllowedAction: string;
  approvedD04xAction: string;
  afterMatchType: string;
  afterClassification: string;
  afterRecommendedAction: string;
  afterD04xAllowedAction: string;
  excludedAuditMatchFound: boolean;
  excludedAuditReviewDecision: string;
  regressionStatus: RegressionStatus;
  resolved: boolean;
  reason: string;
  sourceBeforeArtifact: string;
  sourceAfterArtifactOrReplay: string;
  debugArtifactPath: string;
}

export const PROPERTY_DISCOVERY_REGRESSION_CSV_HEADERS = [
  "run_id",
  "checked_at_jst",
  "detected_name",
  "source_url",
  "before_classification",
  "before_review_severity",
  "before_d04x_allowed_action",
  "approved_d04x_action",
  "after_match_type",
  "after_classification",
  "after_recommended_action",
  "after_d04x_allowed_action",
  "excluded_audit_match_found",
  "excluded_audit_review_decision",
  "regression_status",
  "resolved",
  "reason",
  "source_before_artifact",
  "source_after_artifact_or_replay",
  "debug_artifact_path"
] as const;

export const D05X_FORBIDDEN_COLUMN_TOKENS = ["beds24", "airhost", "pms_", "channel_manager", "ota_upload"] as const;

// After-state classifications that are considered non-actionable (the exclusion took effect).
const NON_ACTIONABLE_AFTER_CLASSIFICATIONS = new Set([
  "out_of_scope_candidate",
  "duplicate_candidate_if_audit_covered",
  "excluded_match",
  "audit_covered"
]);

// ---------------------------------------------------------------------------
// Excluded-audit lookup (NFKC, match by name AND url)
// ---------------------------------------------------------------------------

function norm(value: string): string {
  return value.normalize("NFKC").trim();
}

export function findExcludedAuditMatch(
  audit: ExcludedAuditEntry[],
  detectedName: string,
  sourceUrl: string
): ExcludedAuditEntry | undefined {
  const name = norm(detectedName);
  const url = norm(sourceUrl);
  return audit.find((e) => norm(e.property_name_raw) === name && norm(e.property_url) === url);
}

// ---------------------------------------------------------------------------
// Replay the after-state for one item against the updated excluded audit
// ---------------------------------------------------------------------------

export interface AfterState {
  afterMatchType: string;
  afterClassification: string;
  afterRecommendedAction: string;
  afterD04xAllowedAction: string;
  excludedAuditMatchFound: boolean;
  excludedAuditReviewDecision: string;
}

export function replayAfterState(auditMatch: ExcludedAuditEntry | undefined): AfterState {
  if (!auditMatch) {
    // No exclusion present in the replay — the candidate would still surface as
    // it did before. We re-flag it as an actionable new candidate.
    return {
      afterMatchType: "no_match",
      afterClassification: "new_candidate",
      afterRecommendedAction: "manual_review",
      afterD04xAllowedAction: "add_new_property_after_approval",
      excludedAuditMatchFound: false,
      excludedAuditReviewDecision: ""
    };
  }
  const isOutOfScope = auditMatch.exclusion_reason === "out_of_scope";
  return {
    afterMatchType: "excluded_match",
    afterClassification: isOutOfScope ? "out_of_scope_candidate" : "duplicate_candidate_if_audit_covered",
    afterRecommendedAction: "no_action_excluded",
    afterD04xAllowedAction: "none",
    excludedAuditMatchFound: true,
    excludedAuditReviewDecision: auditMatch.review_decision
  };
}

// ---------------------------------------------------------------------------
// Classify the regression outcome for one item
// ---------------------------------------------------------------------------

export function classifyRegression(input: {
  before: BeforeStateRow | undefined;
  after: AfterState;
}): { status: RegressionStatus; resolved: boolean; reason: string } {
  const { before, after } = input;

  if (!before) {
    return {
      status: "not_found_in_replay",
      resolved: false,
      reason: "Approved item not found in the before-state (D03X) replay set."
    };
  }

  const nonActionable = after.afterD04xAllowedAction === "none";
  const allowedAfterClass = NON_ACTIONABLE_AFTER_CLASSIFICATIONS.has(after.afterClassification);

  if (after.excludedAuditMatchFound && nonActionable && allowedAfterClass) {
    return {
      status: "resolved",
      resolved: true,
      reason: "Approved exclusion is now present in the excluded audit; item no longer surfaces as an actionable candidate."
    };
  }

  if (!after.excludedAuditMatchFound) {
    return {
      status: "still_actionable",
      resolved: false,
      reason: "No excluded-audit match found on replay; item would still surface as an actionable candidate."
    };
  }

  // Audit match present but still proposing an actionable D04X action.
  return {
    status: "unexpected",
    resolved: false,
    reason: `Excluded-audit match found but after-state is still actionable (after_d04x_allowed_action=${after.afterD04xAllowedAction}).`
  };
}

// ---------------------------------------------------------------------------
// Build regression rows
// ---------------------------------------------------------------------------

export function buildRegressionRows(input: {
  runId: string;
  checkedAtJst: string;
  approved: ApprovedD04XItem[];
  beforeRows: BeforeStateRow[];
  audit: ExcludedAuditEntry[];
  sourceBeforeArtifact: string;
  sourceAfterArtifactOrReplay: string;
  debugArtifactPath: string;
}): RegressionRow[] {
  return input.approved.map((item) => {
    const before = input.beforeRows.find(
      (b) => norm(b.detectedName) === norm(item.detectedName) && norm(b.sourceUrl) === norm(item.sourceUrl)
    );
    const auditMatch = findExcludedAuditMatch(input.audit, item.detectedName, item.sourceUrl);
    const after = replayAfterState(auditMatch);
    const { status, resolved, reason } = classifyRegression({ before, after });

    return {
      runId: input.runId,
      checkedAtJst: input.checkedAtJst,
      detectedName: item.detectedName,
      sourceUrl: item.sourceUrl,
      beforeClassification: before?.classification ?? "",
      beforeReviewSeverity: before?.reviewSeverity ?? "",
      beforeD04xAllowedAction: before?.d04xAllowedAction ?? "",
      approvedD04xAction: item.approvedAction,
      afterMatchType: after.afterMatchType,
      afterClassification: after.afterClassification,
      afterRecommendedAction: after.afterRecommendedAction,
      afterD04xAllowedAction: after.afterD04xAllowedAction,
      excludedAuditMatchFound: after.excludedAuditMatchFound,
      excludedAuditReviewDecision: after.excludedAuditReviewDecision,
      regressionStatus: status,
      resolved,
      reason,
      sourceBeforeArtifact: input.sourceBeforeArtifact,
      sourceAfterArtifactOrReplay: input.sourceAfterArtifactOrReplay,
      debugArtifactPath: input.debugArtifactPath
    };
  });
}

// ---------------------------------------------------------------------------
// Summary + decision
// ---------------------------------------------------------------------------

export interface RegressionCounts {
  regressionRowCount: number;
  resolvedCount: number;
  stillActionableCount: number;
  notFoundCount: number;
  unexpectedCount: number;
}

export function countRegression(rows: RegressionRow[]): RegressionCounts {
  return {
    regressionRowCount: rows.length,
    resolvedCount: rows.filter((r) => r.regressionStatus === "resolved").length,
    stillActionableCount: rows.filter((r) => r.regressionStatus === "still_actionable").length,
    notFoundCount: rows.filter((r) => r.regressionStatus === "not_found_in_replay").length,
    unexpectedCount: rows.filter((r) => r.regressionStatus === "unexpected").length
  };
}

export function decideD05X(counts: RegressionCounts): D05XDecision {
  if (counts.regressionRowCount === 0) return "property_discovery_regression_not_ready";
  if (counts.stillActionableCount > 0 || counts.unexpectedCount > 0 || counts.notFoundCount > 0) {
    return "property_discovery_regression_basis_caution";
  }
  return "property_discovery_regression_ready";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RegressionSummary {
  runId: string;
  generatedAt: string;
  sourceD01xArtifact: string;
  sourceD04xArtifact: string;
  sourceBeforeArtifact: string;
  excludedAuditArtifact: string;
  liveFetchPerformed: false;
  counts: RegressionCounts;
  decision: D05XDecision;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

export function renderRegressionCsv(rows: RegressionRow[]): string {
  const body = rows.map((row) =>
    [
      row.runId,
      row.checkedAtJst,
      row.detectedName,
      row.sourceUrl,
      row.beforeClassification,
      row.beforeReviewSeverity,
      row.beforeD04xAllowedAction,
      row.approvedD04xAction,
      row.afterMatchType,
      row.afterClassification,
      row.afterRecommendedAction,
      row.afterD04xAllowedAction,
      bool(row.excludedAuditMatchFound),
      row.excludedAuditReviewDecision,
      row.regressionStatus,
      bool(row.resolved),
      row.reason,
      row.sourceBeforeArtifact,
      row.sourceAfterArtifactOrReplay,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [PROPERTY_DISCOVERY_REGRESSION_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderRegressionReport(input: { summary: RegressionSummary; rows: RegressionRow[] }): string {
  const { summary, rows } = input;
  const resolved = rows.filter((r) => r.regressionStatus === "resolved");
  const stillActionable = rows.filter((r) => r.regressionStatus === "still_actionable");
  const unexpected = rows.filter((r) => r.regressionStatus === "unexpected" || r.regressionStatus === "not_found_in_replay");
  const beforeAfter = (r: RegressionRow): string =>
    `- ${r.detectedName} | before: ${r.beforeClassification}/${r.beforeReviewSeverity}/${r.beforeD04xAllowedAction} ` +
    `→ after: ${r.afterClassification}/${r.afterD04xAllowedAction} (audit_match=${bool(r.excludedAuditMatchFound)}, ` +
    `review_decision=${r.excludedAuditReviewDecision || "-"}) [${r.regressionStatus}]`;
  const listOrNone = (items: RegressionRow[]): string[] => (items.length === 0 ? ["- none"] : items.map(beforeAfter));

  return [
    "# Property Discovery Regression / Re-run Check (Phase D05X)",
    "",
    `Generated at: ${summary.generatedAt}`,
    "",
    "## 1. Executive Summary",
    "",
    `- decision=${summary.decision}`,
    `- regression_row_count=${summary.counts.regressionRowCount}`,
    `- resolved=${summary.counts.resolvedCount}`,
    `- still_actionable=${summary.counts.stillActionableCount}`,
    `- not_found_in_replay=${summary.counts.notFoundCount}`,
    `- unexpected=${summary.counts.unexpectedCount}`,
    summary.decision === "property_discovery_regression_ready"
      ? "- All approved D04X exclusions are now respected by the local replay; nothing remains actionable."
      : "- ATTENTION: one or more approved exclusions did not take effect on replay; human review required.",
    "",
    "## 2. Source Artifacts Used (read-only)",
    "",
    `- d01x_inventory_artifact=${summary.sourceD01xArtifact}`,
    `- before_state_artifact (D03X review)=${summary.sourceBeforeArtifact}`,
    `- d04x_approved_update_artifact=${summary.sourceD04xArtifact}`,
    `- updated_excluded_audit_artifact=${summary.excludedAuditArtifact}`,
    "",
    "## 3. D04X Approved Updates (verified against)",
    "",
    ...rows.map((r) => `- ${r.detectedName} → ${r.approvedD04xAction} (${r.sourceUrl})`),
    "",
    "## 4. Before vs After Regression Table",
    "",
    ...listOrNone(rows),
    "",
    "## 5. Resolved Items",
    "",
    ...listOrNone(resolved),
    "",
    "## 6. Still Actionable Items",
    "",
    ...listOrNone(stillActionable),
    "",
    "## 7. Unexpected / Not-Found Items",
    "",
    ...listOrNone(unexpected),
    "",
    "## 8. Safety Confirmation",
    "",
    "- D05X performed a LOCAL artifact replay only.",
    "- D05X did not live-fetch external pages.",
    "- D05X did not modify the properties master or any master artifact.",
    "- D05X did not modify the excluded audit.",
    "- D05X did not add aliases, active-promote, or add price collection targets.",
    "- D05X did not write DB.",
    "- D05X did not modify .data/history.",
    "- No GitHub Actions/GitOps activation, no version-control commits or pushes, no paid sources.",
    "",
    "## 9. Decision",
    "",
    `- decision=${summary.decision}`,
    `- resolved=${summary.counts.resolvedCount}, still_actionable=${summary.counts.stillActionableCount}`,
    "",
    "## 10. Next Steps",
    "",
    summary.decision === "property_discovery_regression_ready"
      ? "- Regression confirmed via local replay. A separately-approved live re-fetch could optionally re-verify against fresh pages, but is NOT performed here."
      : "- Investigate the still-actionable / unexpected items before any further action; do not enable Actions/GitOps, commit, push, or contact paid sources.",
    `- report_path=${summary.reportPath}`,
    `- csv_path=${summary.csvPath}`,
    `- json_summary_path=${summary.jsonPath}`,
    `- debug_artifact_path=${summary.debugRootPath}`,
    ""
  ].join("\n");
}

export function assertNoForbiddenColumns(headerLine: string): void {
  const lower = headerLine.toLowerCase();
  for (const token of D05X_FORBIDDEN_COLUMN_TOKENS) {
    if (lower.includes(token)) {
      throw new Error(`D05X output must not include forbidden column token: ${token}`);
    }
  }
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
