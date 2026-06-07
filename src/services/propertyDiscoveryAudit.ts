// Phase AUTO-RUNNER-DISCOVERY03 - property discovery candidate audit pack.
//
// Decision-support only. This module never updates property master data,
// collector targets, history, DB, AI context, launchd, or pricing/PMS outputs.

import type { DiscoveryReviewPack, DiscoveryReviewRow, SuggestedHumanDecision } from "./propertyDiscoveryReview";

export type AuditPriority = "urgent" | "high" | "medium" | "low";
export type AuditGroup =
  | "ready_to_review_for_new_property"
  | "alias_review"
  | "already_covered_duplicate"
  | "needs_lodging_status_verification"
  | "likely_exclude_or_hold";
export type ApprovalRisk = "low" | "medium" | "high" | "unknown";
export type CollectorMappingDifficulty = "easy" | "medium" | "hard" | "unknown" | "not_applicable";
export type ActiveReadinessStage =
  | "candidate_only"
  | "inactive_master_candidate"
  | "needs_collector_mapping"
  | "ready_for_dry_run_mapping"
  | "already_covered"
  | "not_applicable";
export type RecommendedNextHumanAction =
  | "approve_new_after_review"
  | "approve_alias_after_review"
  | "reject_duplicate"
  | "hold_for_manual_check"
  | "reject_out_of_scope"
  | "reject_inactive";
export type D05Blocker =
  | "none"
  | "missing_human_decision"
  | "missing_existing_match_for_alias"
  | "missing_collector_mapping"
  | "unclear_lodging_status"
  | "possible_duplicate"
  | "out_of_scope_or_inactive";

export interface PropertyDiscoveryAuditRow extends DiscoveryReviewRow {
  audit_priority: AuditPriority;
  audit_group: AuditGroup;
  approval_risk: ApprovalRisk;
  collector_mapping_difficulty: CollectorMappingDifficulty;
  active_readiness_stage: ActiveReadinessStage;
  recommended_next_human_action: RecommendedNextHumanAction;
  audit_reason: string;
  d05_blocker: D05Blocker;
}

export interface PropertyDiscoveryAuditPack {
  decision: "auto_runner_discovery03_audit_pack_ready";
  run_id: string;
  generated_at_jst: string;
  input_review_pack_artifact_path: string;
  mode: "dry_run_audit_pack";
  rows: PropertyDiscoveryAuditRow[];
  summary: {
    total_candidates: number;
    audit_group_counts: Record<string, number>;
    recommended_human_action_counts: Record<string, number>;
    approval_risk_counts: Record<string, number>;
    collector_mapping_difficulty_counts: Record<string, number>;
    d05_blocker_counts: Record<string, number>;
    d05_ready: false;
    d05_reason: "waiting_for_human_decisions";
    safety_confirmation: {
      network_collection_executed: false;
      live_collector_run: false;
      history_modified: false;
      db_synced: false;
      ai_context_refreshed: false;
      property_master_written: false;
      collector_target_updated: false;
      pricing_or_pms_output_generated: false;
      launchd_inspected_or_modified: false;
    };
  };
  next_recommended_action: "Human reviewer fills human_decision and human_notes in the review pack; no D05 update until decisions are explicit.";
}

export const PROPERTY_DISCOVERY_AUDIT_HEADERS = [
  "candidate_name",
  "normalized_name",
  "classification",
  "confidence",
  "matched_existing_property",
  "matched_existing_key",
  "recommended_action_from_discovery",
  "suggested_human_decision",
  "decision_confidence",
  "review_priority",
  "collector_readiness",
  "source_evidence_count",
  "source_evidence_summary",
  "reason_codes",
  "decision_reason",
  "required_next_step",
  "human_decision",
  "human_notes",
  "audit_priority",
  "audit_group",
  "approval_risk",
  "collector_mapping_difficulty",
  "active_readiness_stage",
  "recommended_next_human_action",
  "audit_reason",
  "d05_blocker"
] as const;

export function buildAuditRow(row: DiscoveryReviewRow): PropertyDiscoveryAuditRow {
  const suggested = row.suggested_human_decision;
  const classification = row.classification;

  if (suggested === "reject_duplicate" || classification === "duplicate_candidate") {
    return withAudit(row, {
      audit_priority: "low",
      audit_group: "already_covered_duplicate",
      approval_risk: "low",
      collector_mapping_difficulty: "not_applicable",
      active_readiness_stage: "already_covered",
      recommended_next_human_action: "reject_duplicate",
      audit_reason: "Already covered or duplicate candidate; reject as duplicate after confirming the listed match.",
      d05_blocker: "none"
    });
  }

  if (suggested === "approve_alias" || classification === "alias_candidate") {
    const missingMatch = row.matched_existing_property.trim() === "";
    return withAudit(row, {
      audit_priority: "medium",
      audit_group: "alias_review",
      approval_risk: missingMatch ? "high" : "medium",
      collector_mapping_difficulty: "not_applicable",
      active_readiness_stage: "candidate_only",
      recommended_next_human_action: "approve_alias_after_review",
      audit_reason: missingMatch
        ? "Alias candidate lacks a matched existing property; human must identify the canonical target before D05."
        : "Likely alias of an existing property; human should confirm before alias approval.",
      d05_blocker: missingMatch ? "missing_existing_match_for_alias" : "missing_human_decision"
    });
  }

  if (suggested === "approve_new") {
    const difficulty = mappingDifficultyForName(row.candidate_name);
    const risk = approvalRiskForNew(row.candidate_name, difficulty);
    return withAudit(row, {
      audit_priority: "high",
      audit_group: "ready_to_review_for_new_property",
      approval_risk: risk,
      collector_mapping_difficulty: difficulty,
      active_readiness_stage: "needs_collector_mapping",
      recommended_next_human_action: "approve_new_after_review",
      audit_reason: `Appears lodging-like by name/evidence but remains inactive-first; collector mapping must be reviewed before active=true. Business hint=${businessValueHint(row.candidate_name)}.`,
      d05_blocker: "missing_human_decision"
    });
  }

  if (suggested === "hold" || classification === "hold_candidate") {
    return withAudit(row, {
      audit_priority: "high",
      audit_group: "needs_lodging_status_verification",
      approval_risk: "unknown",
      collector_mapping_difficulty: "unknown",
      active_readiness_stage: "candidate_only",
      recommended_next_human_action: "hold_for_manual_check",
      audit_reason: "Lodging status or OTA mapping is unclear; human verification is required before D05.",
      d05_blocker: "unclear_lodging_status"
    });
  }

  if (suggested === "reject_inactive" || classification === "closed_or_inactive_candidate") {
    return withAudit(row, {
      audit_priority: "low",
      audit_group: "likely_exclude_or_hold",
      approval_risk: "high",
      collector_mapping_difficulty: "not_applicable",
      active_readiness_stage: "not_applicable",
      recommended_next_human_action: "reject_inactive",
      audit_reason: "Candidate appears inactive or closed from the input artifact; do not add unless new human evidence appears.",
      d05_blocker: "out_of_scope_or_inactive"
    });
  }

  return withAudit(row, {
    audit_priority: "low",
    audit_group: "likely_exclude_or_hold",
    approval_risk: "high",
    collector_mapping_difficulty: "not_applicable",
    active_readiness_stage: "not_applicable",
    recommended_next_human_action: "reject_out_of_scope",
    audit_reason: "Candidate appears out of lodging/target scope from the input artifact.",
    d05_blocker: "out_of_scope_or_inactive"
  });
}

export function buildPropertyDiscoveryAuditPack(input: {
  runId: string;
  generatedAtJst: string;
  inputReviewPackArtifactPath: string;
  reviewPack: DiscoveryReviewPack;
}): PropertyDiscoveryAuditPack {
  const rows = input.reviewPack.rows.map(buildAuditRow).sort(compareAuditRows);
  return {
    decision: "auto_runner_discovery03_audit_pack_ready",
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    input_review_pack_artifact_path: input.inputReviewPackArtifactPath,
    mode: "dry_run_audit_pack",
    rows,
    summary: {
      total_candidates: rows.length,
      audit_group_counts: countBy(rows.map((r) => r.audit_group)),
      recommended_human_action_counts: countBy(rows.map((r) => r.recommended_next_human_action)),
      approval_risk_counts: countBy(rows.map((r) => r.approval_risk)),
      collector_mapping_difficulty_counts: countBy(rows.map((r) => r.collector_mapping_difficulty)),
      d05_blocker_counts: countBy(rows.map((r) => r.d05_blocker)),
      d05_ready: false,
      d05_reason: "waiting_for_human_decisions",
      safety_confirmation: {
        network_collection_executed: false,
        live_collector_run: false,
        history_modified: false,
        db_synced: false,
        ai_context_refreshed: false,
        property_master_written: false,
        collector_target_updated: false,
        pricing_or_pms_output_generated: false,
        launchd_inspected_or_modified: false
      }
    },
    next_recommended_action: "Human reviewer fills human_decision and human_notes in the review pack; no D05 update until decisions are explicit."
  };
}

export function parseReviewPackJson(json: string): DiscoveryReviewPack {
  const parsed = JSON.parse(json) as DiscoveryReviewPack;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rows)) throw new Error("property_discovery_review_pack_missing_rows");
  return {
    ...parsed,
    rows: parsed.rows.map((row) => ({ ...row, human_decision: "", human_notes: "" }))
  };
}

export function selectLatestReviewPackArtifact(paths: readonly string[]): string {
  const latest = [...paths].filter((p) => /property_discovery_review_\d{8}_\d{6}\.json$/u.test(p)).sort().at(-1);
  if (latest) return latest;
  throw new Error("property_discovery_review_pack_missing_run_discover_properties_review_pack_first");
}

export function renderPropertyDiscoveryAuditJson(pack: PropertyDiscoveryAuditPack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

export function renderPropertyDiscoveryAuditCsv(rows: readonly PropertyDiscoveryAuditRow[]): string {
  return [
    PROPERTY_DISCOVERY_AUDIT_HEADERS.join(","),
    ...rows.map((row) => PROPERTY_DISCOVERY_AUDIT_HEADERS.map((h) => csvEscape(h === "reason_codes" ? row.reason_codes.join("|") : String(row[h] ?? ""))).join(","))
  ].join("\n") + "\n";
}

export function renderPropertyDiscoveryAuditMarkdown(pack: PropertyDiscoveryAuditPack): string {
  const byGroup = (group: AuditGroup): PropertyDiscoveryAuditRow[] => pack.rows.filter((r) => r.audit_group === group);
  const byAction = (action: RecommendedNextHumanAction): PropertyDiscoveryAuditRow[] => pack.rows.filter((r) => r.recommended_next_human_action === action);
  const bullets = (rows: readonly PropertyDiscoveryAuditRow[]): string[] =>
    rows.length === 0
      ? ["- none"]
      : rows.map(
          (r) =>
            `- ${r.candidate_name}: action=${r.recommended_next_human_action}, priority=${r.audit_priority}, risk=${r.approval_risk}, mapping=${r.collector_mapping_difficulty}, blocker=${r.d05_blocker}, reason=${r.audit_reason}`
        );

  return [
    "# Property Discovery Candidate Audit Pack",
    "",
    `- run timestamp JST: ${pack.generated_at_jst}`,
    `- input review-pack artifact path: ${pack.input_review_pack_artifact_path}`,
    `- mode: ${pack.mode}`,
    `- decision: ${pack.decision}`,
    `- total candidates: ${pack.summary.total_candidates}`,
    "",
    "## Audit Group Counts",
    ...objectLines(pack.summary.audit_group_counts),
    "",
    "## Recommended Human Action Counts",
    ...objectLines(pack.summary.recommended_human_action_counts),
    "",
    "## Approval Risk Summary",
    ...objectLines(pack.summary.approval_risk_counts),
    "",
    "## Collector Mapping Difficulty Summary",
    ...objectLines(pack.summary.collector_mapping_difficulty_counts),
    "",
    "## D05 Blockers Summary",
    ...objectLines(pack.summary.d05_blocker_counts),
    "",
    "## Top approve_new Candidates",
    ...bullets(byAction("approve_new_after_review").slice(0, 10)),
    "",
    "## Hold Candidates Needing Verification",
    ...bullets(byGroup("needs_lodging_status_verification")),
    "",
    "## Alias Candidates",
    ...bullets(byGroup("alias_review")),
    "",
    "## Duplicates Already Covered",
    ...bullets(byGroup("already_covered_duplicate")),
    "",
    "## Human Review Instructions",
    "- Keep human_decision blank until the reviewer has explicit evidence.",
    "- Keep human_notes blank until the reviewer records rationale.",
    "- Do not apply this audit pack automatically; it is decision support only.",
    "- New properties should be approved inactive-first and require collector mapping before active=true.",
    "",
    "## D05 Readiness Explanation",
    `- d05_ready: ${pack.summary.d05_ready}`,
    `- reason: ${pack.summary.d05_reason}`,
    "- D05 remains blocked until human_decision and human_notes are filled in the review workflow.",
    "",
    "## Safety",
    ...Object.entries(pack.summary.safety_confirmation).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Next Recommended Action",
    `- ${pack.next_recommended_action}`,
    ""
  ].join("\n");
}

function withAudit(row: DiscoveryReviewRow, audit: Omit<PropertyDiscoveryAuditRow, keyof DiscoveryReviewRow>): PropertyDiscoveryAuditRow {
  return { ...row, human_decision: "", human_notes: "", ...audit };
}

function compareAuditRows(a: PropertyDiscoveryAuditRow, b: PropertyDiscoveryAuditRow): number {
  return (
    rankGroup(a) - rankGroup(b) ||
    priorityRank(a.audit_priority) - priorityRank(b.audit_priority) ||
    b.confidence - a.confidence ||
    difficultyRank(a.collector_mapping_difficulty) - difficultyRank(b.collector_mapping_difficulty) ||
    a.candidate_name.localeCompare(b.candidate_name, "ja")
  );
}

function rankGroup(row: PropertyDiscoveryAuditRow): number {
  if (row.recommended_next_human_action === "approve_new_after_review" && businessValueHint(row.candidate_name) === "higher") return 0;
  if (row.audit_group === "needs_lodging_status_verification") return 1;
  if (row.audit_group === "alias_review") return 2;
  if (row.recommended_next_human_action === "approve_new_after_review") return 3;
  if (row.audit_group === "already_covered_duplicate") return 4;
  return 5;
}

function priorityRank(priority: AuditPriority): number {
  return { urgent: 0, high: 1, medium: 2, low: 3 }[priority];
}

function difficultyRank(difficulty: CollectorMappingDifficulty): number {
  return { easy: 0, medium: 1, hard: 2, unknown: 3, not_applicable: 4 }[difficulty];
}

function businessValueHint(name: string): "higher" | "uncertain" {
  return /hotel|ホテル|旅館|lodge|ロッジ|onsen|温泉|base|oakhill|kkr|高原|ペンション/iu.test(name) ? "higher" : "uncertain";
}

function mappingDifficultyForName(name: string): CollectorMappingDifficulty {
  if (/お食事処|お湯処|restaurant|食堂|private|民家|一軒家|別荘/iu.test(name)) return "hard";
  if (/hotel|ホテル|旅館|onsen|温泉|kkr/iu.test(name)) return "medium";
  if (/lodge|ロッジ|base|oakhill|ペンション/iu.test(name)) return "hard";
  return "unknown";
}

function approvalRiskForNew(name: string, difficulty: CollectorMappingDifficulty): ApprovalRisk {
  if (/hotel|ホテル|旅館|onsen|温泉|kkr/iu.test(name)) return "low";
  if (difficulty === "hard" || difficulty === "unknown") return "medium";
  return "medium";
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function objectLines(obj: Record<string, number>): string[] {
  const entries = Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? ["- none"] : entries.map(([k, v]) => `- ${k}: ${v}`);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, '""')}"`;
  return value;
}
