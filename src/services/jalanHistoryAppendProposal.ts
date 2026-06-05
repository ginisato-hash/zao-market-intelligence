// Phase JALAN-AUTO04X — Jalan history append proposal (proposal-only).
//
// Pure planning logic for proposing which JALAN-AUTO03B improved preview rows
// could later be appended to .data/history. This module MUTATES NOTHING: it
// never appends history, never writes or syncs the DB, never refreshes AI
// context, never runs a live Jalan request or browser automation, never runs a
// collector, never emits channel-manager / PMS output, never applies a price
// update, and applies no synthetic tax multiplier.
//
// The primary-source directional backbone is unchanged; Jalan stays a
// supplementary domestic OTA signal. Directional rows are price-pressure
// evidence only (never direct). Excluded rows are audit-only evidence.
//
// Row identity reuses the canonical v1 helpers from localHistorySchemaDesign —
// no new identity model is invented here. Conflicts are reported, not resolved.

import {
  buildRowHash,
  buildRowId,
  futureShardPath,
  shardMonthFromCheckin
} from "./localHistorySchemaDesign";
import { type JalanImprovedPreviewRow } from "./jalanBoundedCollectionProbeImproved";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JalanAppendDecision =
  | "jalan_history_append_proposal_ready"
  | "jalan_history_append_proposal_basis_caution"
  | "jalan_history_append_proposal_not_ready";

export type JalanHistoryAction =
  | "append_directional"
  | "append_excluded_audit"
  | "skip_identical"
  | "block_conflict"
  | "manual_review";

export interface ExistingHistoryKey {
  row_id: string;
  row_hash: string;
  shard_month: string;
}

export interface CurrentHistorySummary {
  total_rows: number;
  rows_by_shard: Record<string, number>;
  source_files: string[];
}

export interface JalanAppendProposalRow {
  source: string;
  canonical_property_name: string;
  source_property_id: string;
  source_slug_or_code: string;
  checkin: string;
  checkout: string;
  stay_scope: string;
  availability_status: string;
  sold_out_status: string;
  normalized_total_price: number | null;
  basis_confidence: string;
  dp_usage: string;
  source_classification: string;
  history_action: JalanHistoryAction;
  price_pressure_usable: boolean;
  dp_usable: false;
  audit_evidence_kind: string;
  hard_exclusion_reason: string;
  manual_review_reasons: string[];
  row_id: string;
  row_hash: string;
  shard_month: string;
  existing_row_id: string;
  existing_row_hash: string;
  reason: string;
}

export interface JalanAppendProposalSummary {
  total_preview_rows: number;
  directional_preview_rows: number;
  excluded_preview_rows: number;
  selected_for_directional_append: number;
  selected_for_excluded_audit_append: number;
  skip_identical_count: number;
  conflict_count: number;
  manual_review_count: number;
  total_appendable_count: number;
  existing_history_row_count: number;
  expected_total_after_append_if_no_conflicts: number;
  touched_shards: string[];
  action_breakdown: Record<string, number>;
}

export interface TouchedShardSummary {
  shard_month: string;
  future_shard_path: string;
  existing_rows: number;
  append_directional: number;
  append_excluded_audit: number;
  skip_identical: number;
  block_conflict: number;
  manual_review: number;
  expected_after: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function s(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value.trim());
}

function existingKeyOf(shardMonth: string, rowId: string): string {
  return `${shardMonth}::${rowId}`;
}

// Canonical v1 identity for an AUTO03B preview row. Reuses buildRowId /
// buildRowHash unchanged — does not invent a new identity model.
export function deriveIdentity(row: JalanImprovedPreviewRow): {
  row_id: string;
  row_hash: string;
  shard_month: string;
} {
  const collectedDateJst = s(row.collected_date_jst);
  const row_id = buildRowId({
    collectedDateJst,
    source: s(row.source),
    canonicalPropertyName: s(row.canonical_property_name),
    sourceSlugOrCode: s(row.source_slug_or_code),
    sourcePropertyId: s(row.source_property_id),
    checkin: s(row.checkin),
    checkout: s(row.checkout),
    stayScope: s(row.stay_scope)
  });
  const row_hash = buildRowHash({
    source: s(row.source),
    sourcePhase: s(row.source_phase),
    collectorStage: s(row.collector_stage),
    canonicalPropertyName: s(row.canonical_property_name),
    sourceSlugOrCode: s(row.source_slug_or_code),
    sourcePropertyId: s(row.source_property_id),
    checkin: s(row.checkin),
    checkout: s(row.checkout),
    stayScope: s(row.stay_scope),
    collectedDateJst,
    availabilityStatus: s(row.availability_status),
    soldOutStatus: s(row.sold_out_status),
    normalizedTotalPrice: row.normalized_total_price,
    basisConfidence: s(row.basis_confidence),
    sourceClassification: s(row.source_classification),
    isPriceUsableForDpDirect: row.is_price_usable_for_dp_direct,
    isPriceUsableForDpDirectional: row.is_price_usable_for_dp_directional,
    isPriceExcludedFromDp: row.is_price_excluded_from_dp
  });
  return { row_id, row_hash, shard_month: shardMonthFromCheckin(s(row.checkin)) };
}

// Structural / identity problems that force manual_review regardless of price.
export function manualReviewReasons(row: JalanImprovedPreviewRow): string[] {
  const reasons: string[] = [];
  if (s(row.source) !== "jalan") reasons.push("source_not_jalan");
  if (s(row.canonical_property_name) === "") reasons.push("missing_canonical_property_name");
  if (!isValidDate(s(row.checkin))) reasons.push("invalid_checkin");
  if (!isValidDate(s(row.checkout))) reasons.push("invalid_checkout");
  if (s(row.stay_scope) === "") reasons.push("missing_stay_scope");
  if (s(row.schema_version) !== "zao_local_history_v1") reasons.push("invalid_schema_version");
  if (s(row.source_slug_or_code) === "" && s(row.source_property_id) === "") reasons.push("identity_unclear");
  if (row.evidence_flags.price_inferred) reasons.push("price_inferred");
  return reasons;
}

// §7 directional append gate. Strict: directional, B-confidence, priced,
// directional-usable but NOT direct-usable, screenshot present, price not
// inferred, and no hard exclusion reason.
export function isDirectionalAppendable(row: JalanImprovedPreviewRow): boolean {
  return (
    s(row.source) === "jalan" &&
    s(row.dp_usage) === "directional" &&
    s(row.basis_confidence) === "B" &&
    row.normalized_total_price !== null &&
    row.is_price_usable_for_dp_directional === true &&
    row.is_price_usable_for_dp_direct === false &&
    s(row.screenshot_path) !== "" &&
    row.evidence_flags.price_inferred === false &&
    s(row.hard_exclusion_reason) === ""
  );
}

// §7 excluded-audit append gate. Excluded, C/insufficient confidence, with
// useful audit evidence (sold_out / not_found / failed / selected-plan discount
// / a saved screenshot). These are audit-only: never price-pressure, never dp.
export function excludedAuditEvidenceKind(row: JalanImprovedPreviewRow): string {
  if (s(row.dp_usage) !== "excluded") return "";
  const conf = s(row.basis_confidence);
  if (conf !== "C" && conf !== "insufficient") return "";
  const avail = s(row.availability_status);
  if (avail === "sold_out") return "sold_out";
  if (avail === "not_found") return "not_found";
  if (avail === "failed") return "failed";
  if (
    row.evidence_flags.selected_plan_coupon_or_discount_evidence ||
    row.evidence_flags.selected_plan_member_or_point_evidence
  ) {
    return "selected_plan_discount";
  }
  if (s(row.screenshot_path) !== "") return "screenshot_evidence";
  return "";
}

// ---------------------------------------------------------------------------
// Proposal row construction
// ---------------------------------------------------------------------------

export function buildProposalRows(
  rows: readonly JalanImprovedPreviewRow[],
  existingKeys: readonly ExistingHistoryKey[]
): JalanAppendProposalRow[] {
  const existing = new Map<string, string>();
  for (const key of existingKeys) existing.set(existingKeyOf(key.shard_month, key.row_id), key.row_hash);
  return rows.map((row) => buildProposalRow(row, existing));
}

function buildProposalRow(
  row: JalanImprovedPreviewRow,
  existing: Map<string, string>
): JalanAppendProposalRow {
  const id = deriveIdentity(row);
  const base = {
    source: s(row.source) || "jalan",
    canonical_property_name: s(row.canonical_property_name),
    source_property_id: s(row.source_property_id),
    source_slug_or_code: s(row.source_slug_or_code),
    checkin: s(row.checkin),
    checkout: s(row.checkout),
    stay_scope: s(row.stay_scope),
    availability_status: s(row.availability_status),
    sold_out_status: s(row.sold_out_status),
    normalized_total_price: row.normalized_total_price,
    basis_confidence: s(row.basis_confidence),
    dp_usage: s(row.dp_usage),
    source_classification: s(row.source_classification),
    dp_usable: false as const,
    hard_exclusion_reason: s(row.hard_exclusion_reason),
    row_id: id.row_id,
    row_hash: id.row_hash,
    shard_month: id.shard_month
  };

  const existingHash = existing.get(existingKeyOf(id.shard_month, id.row_id));

  // Identity preflight first: skip_identical / block_conflict take precedence.
  if (existingHash !== undefined) {
    if (existingHash === id.row_hash) {
      return {
        ...base,
        history_action: "skip_identical",
        price_pressure_usable: false,
        audit_evidence_kind: "",
        manual_review_reasons: [],
        existing_row_id: id.row_id,
        existing_row_hash: existingHash,
        reason: "row_id and row_hash already present in history; identical observation, skip."
      };
    }
    return {
      ...base,
      history_action: "block_conflict",
      price_pressure_usable: false,
      audit_evidence_kind: "",
      manual_review_reasons: ["row_hash_differs_from_existing"],
      existing_row_id: id.row_id,
      existing_row_hash: existingHash,
      reason: "row_id collides with an existing history row but row_hash differs; conflict reported, not resolved."
    };
  }

  // No existing row → classify the new observation.
  const reviewReasons = manualReviewReasons(row);
  if (reviewReasons.length > 0) {
    return {
      ...base,
      history_action: "manual_review",
      price_pressure_usable: false,
      audit_evidence_kind: "",
      manual_review_reasons: reviewReasons,
      existing_row_id: "",
      existing_row_hash: "",
      reason: `Required fields / identity problems prevent classification: ${reviewReasons.join(", ")}.`
    };
  }

  if (isDirectionalAppendable(row)) {
    return {
      ...base,
      history_action: "append_directional",
      price_pressure_usable: true,
      audit_evidence_kind: "",
      manual_review_reasons: [],
      existing_row_id: "",
      existing_row_hash: "",
      reason: "B-confidence directional tax-included total; same-property price-pressure evidence, dp_usable=false."
    };
  }

  const auditKind = excludedAuditEvidenceKind(row);
  if (auditKind !== "") {
    return {
      ...base,
      history_action: "append_excluded_audit",
      price_pressure_usable: false,
      audit_evidence_kind: auditKind,
      manual_review_reasons: [],
      existing_row_id: "",
      existing_row_hash: "",
      reason: `Excluded row carries useful audit evidence (${auditKind}); audit-only, price_pressure_usable=false, dp_usable=false.`
    };
  }

  return {
    ...base,
    history_action: "manual_review",
    price_pressure_usable: false,
    audit_evidence_kind: "",
    manual_review_reasons: ["weak_or_unclassifiable_evidence"],
    existing_row_id: "",
    existing_row_hash: "",
    reason: "Row is neither a clean directional append nor a useful excluded-audit append; needs manual review."
  };
}

// ---------------------------------------------------------------------------
// Summary + touched shards
// ---------------------------------------------------------------------------

export function summarizeProposal(
  previewRows: readonly JalanImprovedPreviewRow[],
  proposalRows: readonly JalanAppendProposalRow[],
  currentHistory: CurrentHistorySummary
): JalanAppendProposalSummary {
  const actionBreakdown: Record<string, number> = {};
  for (const r of proposalRows) actionBreakdown[r.history_action] = (actionBreakdown[r.history_action] ?? 0) + 1;

  const directionalAppend = actionBreakdown["append_directional"] ?? 0;
  const excludedAuditAppend = actionBreakdown["append_excluded_audit"] ?? 0;
  const appendable = directionalAppend + excludedAuditAppend;

  const touchedShards = [
    ...new Set(
      proposalRows
        .filter((r) => r.history_action === "append_directional" || r.history_action === "append_excluded_audit")
        .map((r) => r.shard_month)
    )
  ].sort((a, b) => a.localeCompare(b));

  return {
    total_preview_rows: previewRows.length,
    directional_preview_rows: previewRows.filter((r) => s(r.dp_usage) === "directional").length,
    excluded_preview_rows: previewRows.filter((r) => s(r.dp_usage) === "excluded").length,
    selected_for_directional_append: directionalAppend,
    selected_for_excluded_audit_append: excludedAuditAppend,
    skip_identical_count: actionBreakdown["skip_identical"] ?? 0,
    conflict_count: actionBreakdown["block_conflict"] ?? 0,
    manual_review_count: actionBreakdown["manual_review"] ?? 0,
    total_appendable_count: appendable,
    existing_history_row_count: currentHistory.total_rows,
    expected_total_after_append_if_no_conflicts: currentHistory.total_rows + appendable,
    touched_shards: touchedShards,
    action_breakdown: actionBreakdown
  };
}

export function buildTouchedShards(
  proposalRows: readonly JalanAppendProposalRow[],
  currentHistory: CurrentHistorySummary
): TouchedShardSummary[] {
  const byShard = new Map<string, JalanAppendProposalRow[]>();
  for (const r of proposalRows) {
    const bucket = byShard.get(r.shard_month) ?? [];
    bucket.push(r);
    byShard.set(r.shard_month, bucket);
  }
  const out: TouchedShardSummary[] = [];
  for (const [shardMonth, bucket] of byShard) {
    const count = (action: JalanHistoryAction): number => bucket.filter((r) => r.history_action === action).length;
    const existingRows = currentHistory.rows_by_shard[shardMonth] ?? 0;
    const appendDirectional = count("append_directional");
    const appendExcludedAudit = count("append_excluded_audit");
    out.push({
      shard_month: shardMonth,
      future_shard_path: futureShardPath(shardMonth),
      existing_rows: existingRows,
      append_directional: appendDirectional,
      append_excluded_audit: appendExcludedAudit,
      skip_identical: count("skip_identical"),
      block_conflict: count("block_conflict"),
      manual_review: count("manual_review"),
      expected_after: existingRows + appendDirectional + appendExcludedAudit
    });
  }
  return out.sort((a, b) => a.shard_month.localeCompare(b.shard_month));
}

// ---------------------------------------------------------------------------
// Decision (§14)
// ---------------------------------------------------------------------------

export function decideAppendProposal(input: {
  sourceLoaded: boolean;
  historyParsed: boolean;
  summary: JalanAppendProposalSummary;
}): JalanAppendDecision {
  if (!input.sourceLoaded || !input.historyParsed) return "jalan_history_append_proposal_not_ready";
  if (input.summary.selected_for_directional_append === 0) return "jalan_history_append_proposal_not_ready";
  if (input.summary.conflict_count > 0) return "jalan_history_append_proposal_not_ready";
  // Directional rows exist, no conflicts. If only clean directional appends
  // remain it is ready; if excluded-audit or manual-review rows also remain,
  // proceed with basis_caution.
  if (input.summary.selected_for_excluded_audit_append > 0 || input.summary.manual_review_count > 0) {
    return "jalan_history_append_proposal_basis_caution";
  }
  return "jalan_history_append_proposal_ready";
}

// ---------------------------------------------------------------------------
// Future AUTO05X plan + safety (§10)
// ---------------------------------------------------------------------------

export interface FutureAuto05xPlan {
  phase: "JALAN-AUTO05X";
  status: "proposed_not_executed";
  approved_directional_append_rows: number;
  approved_excluded_audit_append_rows: number;
  total_appendable_rows: number;
  expected_total_after_append_if_no_conflicts: number;
  touched_shards: string[];
  approval_gate: {
    explicit_approval_sentence: string;
    env_flag: string;
  };
  db_sync_and_ai_context: string;
  guardrails: string[];
}

export function buildFutureAuto05xPlan(summary: JalanAppendProposalSummary): FutureAuto05xPlan {
  return {
    phase: "JALAN-AUTO05X",
    status: "proposed_not_executed",
    approved_directional_append_rows: summary.selected_for_directional_append,
    approved_excluded_audit_append_rows: summary.selected_for_excluded_audit_append,
    total_appendable_rows: summary.total_appendable_count,
    expected_total_after_append_if_no_conflicts: summary.expected_total_after_append_if_no_conflicts,
    touched_shards: summary.touched_shards,
    approval_gate: {
      explicit_approval_sentence:
        "Approve Phase JALAN-AUTO05X append approved Jalan AUTO03B rows. You may append the approved Jalan rows to .data/history.",
      env_flag: "JALAN_HISTORY_APPEND=1"
    },
    db_sync_and_ai_context:
      "DB sync and AI context refresh are NOT part of AUTO05X; they remain a separate later phase JALAN-AUTO05B.",
    guardrails: [
      "No history append in AUTO04X.",
      "No DB write or DB sync in AUTO04X.",
      "No AI context refresh in AUTO04X.",
      "Directional rows stay price-pressure-only (dp_usable=false); excluded rows stay audit-only.",
      "Conflicts are reported, not resolved; existing rows are never overwritten.",
      "AUTO05X must not start without explicit instruction."
    ]
  };
}

export interface SafetyConfirmation {
  history_appended: false;
  history_modified: false;
  db_written: false;
  db_synced: false;
  ai_context_refreshed: false;
  live_jalan_fetch: false;
  playwright_used: false;
  browser_automation: false;
  external_fetch: false;
  collector_run: false;
  query_smoke_run: false;
  pricing_csv_generated: false;
  pms_beds24_airhost_output: false;
  price_update: false;
  other_source_collection: false;
  github_actions_or_cron_activated: false;
  paid_apis_or_proxies: false;
  captcha_bypass_or_stealth: false;
  login_or_cookies: false;
  existing_rows_overwritten: false;
  started_auto05x: false;
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    history_appended: false,
    history_modified: false,
    db_written: false,
    db_synced: false,
    ai_context_refreshed: false,
    live_jalan_fetch: false,
    playwright_used: false,
    browser_automation: false,
    external_fetch: false,
    collector_run: false,
    query_smoke_run: false,
    pricing_csv_generated: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    other_source_collection: false,
    github_actions_or_cron_activated: false,
    paid_apis_or_proxies: false,
    captcha_bypass_or_stealth: false,
    login_or_cookies: false,
    existing_rows_overwritten: false,
    started_auto05x: false
  };
}

// ---------------------------------------------------------------------------
// CSV + report rendering
// ---------------------------------------------------------------------------

export const PROPOSAL_CSV_HEADERS = [
  "row_id",
  "row_hash",
  "shard_month",
  "source",
  "canonical_property_name",
  "source_property_id",
  "source_slug_or_code",
  "checkin",
  "checkout",
  "stay_scope",
  "availability_status",
  "normalized_total_price",
  "basis_confidence",
  "dp_usage",
  "history_action",
  "price_pressure_usable",
  "dp_usable",
  "audit_evidence_kind",
  "hard_exclusion_reason",
  "existing_row_hash",
  "reason"
] as const;

function csvCell(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, '""')}"`;
  return value;
}

export function renderProposalCsv(rows: readonly JalanAppendProposalRow[]): string {
  const body = rows.map((row) =>
    [
      row.row_id,
      row.row_hash,
      row.shard_month,
      row.source,
      row.canonical_property_name,
      row.source_property_id,
      row.source_slug_or_code,
      row.checkin,
      row.checkout,
      row.stay_scope,
      row.availability_status,
      row.normalized_total_price === null ? "" : String(row.normalized_total_price),
      row.basis_confidence,
      row.dp_usage,
      row.history_action,
      String(row.price_pressure_usable),
      String(row.dp_usable),
      row.audit_evidence_kind,
      row.hard_exclusion_reason,
      row.existing_row_hash,
      row.reason
    ]
      .map(csvCell)
      .join(",")
  );
  return [PROPOSAL_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: JalanAppendDecision;
  sourceAuto03bArtifact: string;
  sourceAuto03bSummary: Record<string, unknown>;
  summary: JalanAppendProposalSummary;
  touchedShards: readonly TouchedShardSummary[];
  proposalRows: readonly JalanAppendProposalRow[];
  futureAuto05xPlan: FutureAuto05xPlan;
  safetyConfirmation: SafetyConfirmation;
  nextPhase: string;
}): string {
  const directional = input.proposalRows.filter((r) => r.history_action === "append_directional");
  const excludedAudit = input.proposalRows.filter((r) => r.history_action === "append_excluded_audit");
  const manualReview = input.proposalRows.filter((r) => r.history_action === "manual_review");
  const conflicts = input.proposalRows.filter((r) => r.history_action === "block_conflict");
  const skips = input.proposalRows.filter((r) => r.history_action === "skip_identical");

  const rowLine = (r: JalanAppendProposalRow): string =>
    `- ${r.canonical_property_name} (${r.source_slug_or_code}) ${r.checkin} [${r.shard_month}] price=${
      r.normalized_total_price ?? ""
    } conf=${r.basis_confidence} ${r.audit_evidence_kind ? `kind=${r.audit_evidence_kind} ` : ""}row_id=${r.row_id}`;

  return `# Jalan History Append Proposal (Phase JALAN-AUTO04X)

Generated at JST: ${input.generatedAtJst}

## 1. Executive Summary

JALAN-AUTO04X is a proposal-only planning phase. It reads the JALAN-AUTO03B improved preview rows and proposes which rows could later be appended to .data/history. NOTHING is appended, written, synced, or refreshed here. The primary-source directional backbone is unchanged; Jalan stays a supplementary domestic OTA signal. Decision: ${input.decision}.

- directional appends proposed: ${input.summary.selected_for_directional_append}
- excluded-audit appends proposed: ${input.summary.selected_for_excluded_audit_append}
- skip_identical: ${input.summary.skip_identical_count}
- conflicts: ${input.summary.conflict_count}
- manual_review: ${input.summary.manual_review_count}

## 2. Source AUTO03B Result

- artifact: ${input.sourceAuto03bArtifact}
- summary: ${JSON.stringify(input.sourceAuto03bSummary)}

## 3. Proposal Summary

${JSON.stringify(input.summary, null, 2)}

## 4. Directional Append Rows

${directional.length === 0 ? "None." : directional.map(rowLine).join("\n")}

## 5. Excluded Audit Rows

${excludedAudit.length === 0 ? "None." : excludedAudit.map(rowLine).join("\n")}

## 6. Manual Review Rows

${manualReview.length === 0 ? "None." : manualReview.map((r) => `${rowLine(r)} reasons=${r.manual_review_reasons.join("|")}`).join("\n")}

## 7. Conflict / Skip Summary

- skip_identical (${skips.length}):
${skips.length === 0 ? "  - none" : skips.map((r) => `  - ${r.row_id}`).join("\n")}
- block_conflict (${conflicts.length}):
${conflicts.length === 0 ? "  - none" : conflicts.map((r) => `  - ${r.row_id} existing_hash=${r.existing_row_hash}`).join("\n")}

## 8. Touched Shards

| shard_month | future_path | existing | +directional | +excluded_audit | skip | conflict | manual | expected_after |
|---|---|---|---|---|---|---|---|---|
${input.touchedShards
    .map(
      (sh) =>
        `| ${sh.shard_month} | ${sh.future_shard_path} | ${sh.existing_rows} | ${sh.append_directional} | ${sh.append_excluded_audit} | ${sh.skip_identical} | ${sh.block_conflict} | ${sh.manual_review} | ${sh.expected_after} |`
    )
    .join("\n")}

## 9. Future AUTO05X Plan

- ${input.futureAuto05xPlan.phase} (${input.futureAuto05xPlan.status})
- appendable rows: ${input.futureAuto05xPlan.total_appendable_rows} (directional=${input.futureAuto05xPlan.approved_directional_append_rows}, excluded_audit=${input.futureAuto05xPlan.approved_excluded_audit_append_rows})
- expected total after append (no conflicts): ${input.futureAuto05xPlan.expected_total_after_append_if_no_conflicts}
- approval sentence: "${input.futureAuto05xPlan.approval_gate.explicit_approval_sentence}"
- env flag: ${input.futureAuto05xPlan.approval_gate.env_flag}
- ${input.futureAuto05xPlan.db_sync_and_ai_context}
- guardrails:
${input.futureAuto05xPlan.guardrails.map((g) => `  - ${g}`).join("\n")}

## 10. Safety Confirmation

${Object.entries(input.safetyConfirmation)
    .map(([key, value]) => `- ${key}: ${String(value)}`)
    .join("\n")}

## 11. Decision

${input.decision}

## 12. Next Phase

${input.nextPhase}
`;
}
