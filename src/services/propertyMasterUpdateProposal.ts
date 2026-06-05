// Phase D04X-P — Property Master Update Proposal / Approval Packet.
//
// Pure, read-only proposal layer. Converts D03X review rows into an explicit,
// approval-gated proposal of what a FUTURE real D04X master update WOULD do:
// which actions, against which master artifacts, why, and how to roll back.
//
// THIS MODULE MUTATES NOTHING AND APPROVES NOTHING. No DB writes. No
// properties-master update. No alias update. No active promotion. No
// price-collection-target update. No GitHub Actions / GitOps / cron. No
// version-control commits or pushes. No paid sources. The approval gate is
// ALWAYS closed here: realUpdateAllowed is false regardless of any env flag.
// D04X is the only phase that may update the master, and only after the
// explicit human approval sentence is given in a separate phase.

import type {
  D02XClassification,
  D02XConfidence,
  MatchEntryType,
  MatchType
} from "./propertyNameNormalization";
import type { D04XAllowedAction, ReviewRecommendedAction, ReviewSeverity } from "./propertyDiscoveryReviewReport";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProposedUpdateAction =
  | "no_action"
  | "mark_out_of_scope"
  | "mark_duplicate"
  | "add_alias"
  | "add_new_property"
  | "mark_closed_or_inactive"
  | "reactivate";

export type D04XPDecision =
  | "property_master_update_proposal_ready"
  | "property_master_update_proposal_basis_caution"
  | "property_master_update_proposal_not_ready";

// Subset of a D03X review row that D04X-P consumes (read-only).
export interface D03XReviewInputRow {
  detectedName: string;
  normalizedDetectedName: string;
  classification: D02XClassification;
  reviewSeverity: ReviewSeverity;
  recommendedActionRefined: ReviewRecommendedAction;
  d04xAllowedAction: D04XAllowedAction;
  matchedCanonicalPropertyName: string;
  matchedEntryType: MatchEntryType | "";
  matchType: MatchType;
  similarity: number;
  confidence: D02XConfidence;
  sourceNames: string[];
  sourceUrls: string[];
  sourceCount: number;
  reason: string;
  warning: string;
  needsHumanReview: boolean;
  sourceD02xRowRef: string;
  debugArtifactPath: string;
}

export interface ProposalRow {
  proposalId: string;
  generatedAtJst: string;
  detectedName: string;
  classification: D02XClassification;
  reviewSeverity: ReviewSeverity;
  recommendedActionRefined: ReviewRecommendedAction;
  d04xAllowedAction: D04XAllowedAction;
  proposedUpdateAction: ProposedUpdateAction;
  targetMasterArtifact: string;
  targetRecordKey: string;
  matchedCanonicalPropertyName: string;
  matchType: MatchType;
  similarity: number;
  sourceNames: string[];
  sourceCount: number;
  reason: string;
  warning: string;
  requiresExplicitApproval: boolean;
  realUpdateAllowed: boolean;
  rollbackStrategy: string;
  humanReviewNote: string;
  sourceD03xRowRef: string;
  debugArtifactPath: string;
}

export const PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS = [
  "proposal_id",
  "generated_at_jst",
  "detected_name",
  "classification",
  "review_severity",
  "recommended_action_refined",
  "d04x_allowed_action",
  "proposed_update_action",
  "target_master_artifact",
  "target_record_key",
  "matched_canonical_property_name",
  "match_type",
  "similarity",
  "source_names",
  "source_count",
  "reason",
  "warning",
  "requires_explicit_approval",
  "real_update_allowed",
  "rollback_strategy",
  "human_review_note",
  "source_d03x_row_ref",
  "debug_artifact_path"
] as const;

// Forbidden column tokens that must never appear in D04X-P output (Beds24/AirHost/PMS).
export const D04XP_FORBIDDEN_COLUMN_TOKENS = [
  "beds24",
  "airhost",
  "pms_",
  "channel_manager",
  "ota_upload"
] as const;

// The exact approval sentence a human must give to unlock a FUTURE real D04X.
// D04X-P renders this for reference; it must NEVER be treated as active approval.
export const FUTURE_APPROVAL_SENTENCE =
  "Approve Phase D04X property master update. You may apply the approved mark_out_of_scope and mark_duplicate changes to the property master artifacts.";

const ROLLBACK_STRATEGY_PER_ROW =
  "Deferred: backup → temp write → validate → atomic rename → restore on failure. No real update performed in D04X-P.";

// ---------------------------------------------------------------------------
// Action + target mapping
// ---------------------------------------------------------------------------

const PROPOSED_ACTION_BY_ALLOWED: Record<D04XAllowedAction, ProposedUpdateAction> = {
  none: "no_action",
  mark_out_of_scope_after_approval: "mark_out_of_scope",
  mark_duplicate_after_approval: "mark_duplicate",
  add_alias_after_approval: "add_alias",
  add_new_property_after_approval: "add_new_property",
  mark_closed_or_inactive_after_approval: "mark_closed_or_inactive",
  reactivate_after_approval: "reactivate"
};

// Which existing master artifact a future real D04X would touch for each action.
const TARGET_ARTIFACT_BY_ACTION: Record<ProposedUpdateAction, string> = {
  no_action: "",
  mark_out_of_scope: "zao_excluded_audit_20260531_231933.csv",
  mark_duplicate: "zao_excluded_audit_20260531_231933.csv",
  add_alias: "zao_alias_map_20260531_231933.json",
  add_new_property: "zao_universe_properties_20260531_231933.csv",
  mark_closed_or_inactive: "zao_universe_properties_20260531_231933.csv",
  reactivate: "zao_universe_properties_20260531_231933.csv"
};

export function proposedActionFor(allowed: D04XAllowedAction): ProposedUpdateAction {
  return PROPOSED_ACTION_BY_ALLOWED[allowed];
}

export function targetArtifactFor(action: ProposedUpdateAction): string {
  return TARGET_ARTIFACT_BY_ACTION[action];
}

function humanReviewNoteFor(row: D03XReviewInputRow, action: ProposedUpdateAction): string {
  if (row.reviewSeverity === "critical") {
    return "Confirm this is a generic informational page (not a lodging) before excluding.";
  }
  if (action === "mark_duplicate") {
    return "Confirm this detected name shares a URL with an already-listed entry before marking duplicate.";
  }
  if (action === "add_alias") return "Confirm this is the same property before adding an alias.";
  if (action === "add_new_property") return "Confirm this is a real, in-area lodging before adding a new property.";
  return "Human reviewer must confirm before any master change.";
}

// ---------------------------------------------------------------------------
// Build proposal rows (approval-gated actions only)
// ---------------------------------------------------------------------------

export function buildProposalRows(input: {
  runId: string;
  generatedAtJst: string;
  rows: D03XReviewInputRow[];
}): ProposalRow[] {
  const gated = input.rows.filter((r) => proposedActionFor(r.d04xAllowedAction) !== "no_action");
  return gated.map((row, index) => {
    const proposedUpdateAction = proposedActionFor(row.d04xAllowedAction);
    return {
      proposalId: `${input.runId}_p${String(index + 1).padStart(3, "0")}`,
      generatedAtJst: input.generatedAtJst,
      detectedName: row.detectedName,
      classification: row.classification,
      reviewSeverity: row.reviewSeverity,
      recommendedActionRefined: row.recommendedActionRefined,
      d04xAllowedAction: row.d04xAllowedAction,
      proposedUpdateAction,
      targetMasterArtifact: targetArtifactFor(proposedUpdateAction),
      targetRecordKey: row.sourceUrls[0] ?? row.normalizedDetectedName ?? row.detectedName,
      matchedCanonicalPropertyName: row.matchedCanonicalPropertyName,
      matchType: row.matchType,
      similarity: row.similarity,
      sourceNames: row.sourceNames,
      sourceCount: row.sourceCount,
      reason: row.reason,
      warning: row.warning,
      requiresExplicitApproval: true,
      realUpdateAllowed: false,
      rollbackStrategy: ROLLBACK_STRATEGY_PER_ROW,
      humanReviewNote: humanReviewNoteFor(row, proposedUpdateAction),
      sourceD03xRowRef: row.sourceD02xRowRef,
      debugArtifactPath: row.debugArtifactPath
    };
  });
}

export function countNoAction(rows: D03XReviewInputRow[]): number {
  return rows.filter((r) => proposedActionFor(r.d04xAllowedAction) === "no_action").length;
}

// ---------------------------------------------------------------------------
// Approval gate (ALWAYS closed in D04X-P)
// ---------------------------------------------------------------------------

export interface ApprovalGate {
  explicitUserApproved: false;
  realUpdateAllowed: false;
  futureApprovalSentence: string;
  envApprovalFlagObserved: string;
  note: string;
}

// The approval gate is intentionally hard-coded closed. Any env flag is OBSERVED
// (echoed for transparency) but NEVER honored — D04X-P can never unlock a real
// master update.
export function buildApprovalGate(input?: { envApprovalFlag?: string | undefined }): ApprovalGate {
  return {
    explicitUserApproved: false,
    realUpdateAllowed: false,
    futureApprovalSentence: FUTURE_APPROVAL_SENTENCE,
    envApprovalFlagObserved: input?.envApprovalFlag ?? "",
    note:
      "D04X-P never performs or approves a master update. An env flag cannot unlock it. " +
      "A future real D04X requires the explicit human approval sentence in a separate, intentional phase."
  };
}

// ---------------------------------------------------------------------------
// Target artifact plan + rollback plan
// ---------------------------------------------------------------------------

export interface TargetArtifactPlanEntry {
  proposedUpdateAction: ProposedUpdateAction;
  targetMasterArtifact: string;
  affectedRecordKeys: string[];
  changeDescription: string;
  willBeModifiedInThisPhase: false;
}

export function buildTargetArtifactPlan(rows: ProposalRow[]): TargetArtifactPlanEntry[] {
  const byAction = new Map<ProposedUpdateAction, ProposalRow[]>();
  for (const row of rows) {
    const list = byAction.get(row.proposedUpdateAction) ?? [];
    list.push(row);
    byAction.set(row.proposedUpdateAction, list);
  }
  const describe = (action: ProposedUpdateAction): string => {
    switch (action) {
      case "mark_out_of_scope":
        return "Append an excluded-audit entry recording the out-of-scope detection (no lodging created).";
      case "mark_duplicate":
        return "Append an excluded-audit entry recording the duplicate detection of an already-listed URL.";
      case "add_alias":
        return "Append an alias under the matched canonical property in the alias map.";
      case "add_new_property":
        return "Append a new canonical property row to the universe properties CSV.";
      case "mark_closed_or_inactive":
        return "Update the matched property's status to closed/inactive in the universe properties CSV.";
      case "reactivate":
        return "Update the matched property's status to active in the universe properties CSV.";
      default:
        return "No change.";
    }
  };
  return [...byAction.entries()].map(([action, list]) => ({
    proposedUpdateAction: action,
    targetMasterArtifact: targetArtifactFor(action),
    affectedRecordKeys: list.map((r) => r.targetRecordKey),
    changeDescription: describe(action),
    willBeModifiedInThisPhase: false
  }));
}

export interface RollbackPlan {
  currentPhaseNote: string;
  backupsCreatedInThisPhase: false;
  futureRealUpdateSteps: string[];
}

export function buildRollbackPlan(): RollbackPlan {
  return {
    currentPhaseNote: "No backups are created because no real update is performed in D04X-P.",
    backupsCreatedInThisPhase: false,
    futureRealUpdateSteps: [
      "Backup every touched master artifact before writing.",
      "Write proposed changes to temp files.",
      "Validate schema and row counts.",
      "Atomic rename temp files to target.",
      "If failure occurs, restore all backups.",
      "Emit diff report."
    ]
  };
}

// ---------------------------------------------------------------------------
// Decision + summaries
// ---------------------------------------------------------------------------

export function decideD04XP(input: {
  d03xArtifactLoaded: boolean;
  proposalRowCount: number;
  realUpdateAllowed: boolean;
  unresolvedCriticalCount: number;
}): D04XPDecision {
  if (!input.d03xArtifactLoaded) return "property_master_update_proposal_not_ready";
  if (input.realUpdateAllowed) return "property_master_update_proposal_not_ready";
  if (input.proposalRowCount === 0) return "property_master_update_proposal_not_ready";
  if (input.unresolvedCriticalCount > 0) return "property_master_update_proposal_basis_caution";
  return "property_master_update_proposal_ready";
}

export function countBy<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export interface ProposalSummary {
  runId: string;
  generatedAt: string;
  sourceD03xArtifact: string;
  d03xDecision: string;
  reviewRowCount: number;
  proposalRowCount: number;
  noActionCount: number;
  proposedActionCounts: Record<string, number>;
  unresolvedCriticalCount: number;
  explicitUserApproved: false;
  realUpdateAllowed: false;
  warnings: string[];
  decision: D04XPDecision;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderProposalCsv(rows: ProposalRow[]): string {
  const body = rows.map((row) =>
    [
      row.proposalId,
      row.generatedAtJst,
      row.detectedName,
      row.classification,
      row.reviewSeverity,
      row.recommendedActionRefined,
      row.d04xAllowedAction,
      row.proposedUpdateAction,
      row.targetMasterArtifact,
      row.targetRecordKey,
      row.matchedCanonicalPropertyName,
      row.matchType,
      String(row.similarity),
      row.sourceNames.join(";"),
      String(row.sourceCount),
      row.reason,
      row.warning,
      bool(row.requiresExplicitApproval),
      bool(row.realUpdateAllowed),
      row.rollbackStrategy,
      row.humanReviewNote,
      row.sourceD03xRowRef,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [PROPERTY_MASTER_UPDATE_PROPOSAL_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderProposalReport(input: {
  summary: ProposalSummary;
  rows: ProposalRow[];
  approvalGate: ApprovalGate;
  targetPlan: TargetArtifactPlanEntry[];
  rollbackPlan: RollbackPlan;
}): string {
  const { summary, rows, approvalGate, targetPlan, rollbackPlan } = input;
  const proposalLine = (r: ProposalRow): string =>
    `- [${r.reviewSeverity}] ${r.detectedName} → ${r.proposedUpdateAction} ` +
    `(target=${r.targetMasterArtifact}, key=${r.targetRecordKey}) ` +
    `[requires_explicit_approval=${r.requiresExplicitApproval}, real_update_allowed=${r.realUpdateAllowed}]` +
    (r.warning ? ` ⚠ ${r.warning}` : "");

  return [
    "# Property Master Update Proposal (Phase D04X-P)",
    "",
    `Generated at: ${summary.generatedAt}`,
    "",
    "## 1. Executive Summary",
    "",
    `- decision=${summary.decision}`,
    `- source_d03x_artifact=${summary.sourceD03xArtifact}`,
    `- review_row_count=${summary.reviewRowCount}`,
    `- proposal_row_count=${summary.proposalRowCount}`,
    `- no_action_count=${summary.noActionCount}`,
    `- unresolved_critical_count=${summary.unresolvedCriticalCount}`,
    `- explicit_user_approved=${summary.explicitUserApproved}`,
    `- real_update_allowed=${summary.realUpdateAllowed}`,
    "- This is a PROPOSAL ONLY. No master artifact was modified.",
    "",
    "## 2. Source D03X Review Basis",
    "",
    `- d03x_decision=${summary.d03xDecision}`,
    `- proposed_action_counts=${JSON.stringify(summary.proposedActionCounts)}`,
    "",
    "## 3. Proposed Update Scope",
    "",
    summary.proposalRowCount === 0 ? "- none" : `- ${summary.proposalRowCount} approval-gated action(s) proposed (none executed).`,
    `- proposed_action_counts=${JSON.stringify(summary.proposedActionCounts)}`,
    "",
    "## 4. Proposal Rows",
    "",
    ...(rows.length === 0 ? ["- none"] : rows.map(proposalLine)),
    "",
    "## 5. Explicit Approval Gate",
    "",
    `- explicit_user_approved=${approvalGate.explicitUserApproved}`,
    `- real_update_allowed=${approvalGate.realUpdateAllowed}`,
    `- env_approval_flag_observed=${approvalGate.envApprovalFlagObserved || "(none)"} (NOT honored)`,
    `- ${approvalGate.note}`,
    "- Future approval sentence (reference only — NOT active approval):",
    `  > ${approvalGate.futureApprovalSentence}`,
    "",
    "## 6. Target Artifacts That Would Be Modified",
    "",
    ...(targetPlan.length === 0
      ? ["- none"]
      : targetPlan.map(
          (t) =>
            `- ${t.proposedUpdateAction} → ${t.targetMasterArtifact} ` +
            `(keys=${t.affectedRecordKeys.join("; ")}) — ${t.changeDescription} ` +
            `[will_be_modified_in_this_phase=${t.willBeModifiedInThisPhase}]`
        )),
    "",
    "## 7. Rollback Plan",
    "",
    `- ${rollbackPlan.currentPhaseNote}`,
    `- backups_created_in_this_phase=${rollbackPlan.backupsCreatedInThisPhase}`,
    "- Future real D04X rollback steps:",
    ...rollbackPlan.futureRealUpdateSteps.map((s) => `  - ${s}`),
    "",
    "## 8. No-Action Items",
    "",
    `- no_action_count=${summary.noActionCount} (active existing / out-of-scope-low / uncertain rows kept as-is; not enumerated).`,
    "",
    "## 9. Safety Confirmation",
    "",
    "- D04X-P did not modify properties master.",
    "- D04X-P did not add aliases.",
    "- D04X-P did not active-promote any property.",
    "- D04X-P did not add price collection targets.",
    "- D04X-P did not write DB.",
    "- D04X-P did not modify .data/history.",
    "- No GitHub Actions/GitOps activation, no version-control commits or pushes, no paid sources.",
    "",
    "## 10. Next Steps",
    "",
    "- A human reviewer must confirm the proposed mark_out_of_scope and mark_duplicate actions.",
    "- Only after the explicit approval sentence is given may a future, separate D04X phase apply changes.",
    "- Do not enable GitHub Actions/GitOps, commit, push, or contact paid sources to act on this proposal.",
    ""
  ].join("\n");
}

export function assertNoForbiddenColumns(headerLine: string): void {
  const lower = headerLine.toLowerCase();
  for (const token of D04XP_FORBIDDEN_COLUMN_TOKENS) {
    if (lower.includes(token)) {
      throw new Error(`D04X-P output must not include forbidden column token: ${token}`);
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
