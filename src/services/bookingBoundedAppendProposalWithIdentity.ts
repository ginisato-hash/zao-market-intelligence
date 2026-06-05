// Phase BOOKING-B10Z — Booking bounded append proposal under the ID02X
// observation-identity policy.
//
// Pure, proposal-only logic. This module MUTATES NOTHING: it never appends
// history, never writes or syncs the DB, never refreshes AI context, never runs
// a live Booking request or browser automation, never runs a collector, never
// emits any channel-manager push output, never applies a price update, and
// applies no synthetic Booking tax multiplier. It re-classifies the B09X rows against
// the current .data/history identity snapshot using the ID02X conflict policy so
// that legacy v1 row_id collisions become new observations rather than blocks,
// and existing rows are never overwritten or superseded.

import {
  deriveIdentity,
  reclassifyB10YConflict,
  type B10YConflictRow,
  type BookingLikeHistoryRow,
  type ConflictClassification,
  type RecommendedAction
} from "./bookingObservationIdentity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type B10ZDecision =
  | "booking_bounded_append_with_identity_proposal_ready"
  | "booking_bounded_append_with_identity_proposal_basis_caution"
  | "booking_bounded_append_with_identity_proposal_not_ready";

export type B10ZHistoryAction =
  | "append_new"
  | "skip_identical"
  | "skip_benign_duplicate"
  | "append_new_observation_after_identity_fix"
  | "block_true_conflict"
  | "manual_review";

export type B10ZAppendRecommendation =
  | "append_directional"
  | "append_excluded_audit"
  | "skip"
  | "block_until_manual_review";

// A B09X normalized preview row. It already uses the canonical history field
// names, so it doubles as a BookingLikeHistoryRow for identity derivation.
export interface B09XIdentityPreviewRow extends BookingLikeHistoryRow {
  row_id: string;
  row_hash: string;
  shard_month: string;
  source_property_id?: string | null;
  normalized_total_jpy?: number | null;
  dp_usage?: string | null;
  price_pressure_usable?: boolean | null;
  dp_usable?: boolean | null;
  checkin_date?: string | null;
  checkout_date?: string | null;
}

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

export interface B10ZProposalRow {
  source: string;
  canonical_property_name: string;
  booking_slug: string;
  checkin_date: string;
  checkout_date: string;
  stay_scope: string;
  availability_status: string;
  normalized_total_jpy: number | null;
  basis_confidence: string;
  dp_usage: string;
  price_pressure_usable: boolean;
  dp_usable: false;
  history_action: B10ZHistoryAction;
  append_recommendation: B10ZAppendRecommendation;
  conflict_classification: ConflictClassification | "no_conflict";
  difference_types: string[];
  market_value_changed_fields: string[];
  metadata_changed_fields: string[];
  market_identity_key: string;
  market_identity_plain_key: string;
  observation_id: string;
  observation_id_basis: string;
  observation_id_degraded: boolean;
  market_value_hash: string;
  observation_hash: string;
  existing_row_id: string;
  existing_row_hash: string;
  new_row_id: string;
  new_row_hash: string;
  shard_month: string;
  reason: string;
}

export interface B10ZProposalSummary {
  proposal_row_count: number;
  existing_history_row_count: number;
  append_new_count: number;
  skip_identical_count: number;
  skip_benign_duplicate_count: number;
  append_new_observation_after_identity_fix_count: number;
  block_true_conflict_count: number;
  manual_review_count: number;
  append_directional_count: number;
  append_excluded_audit_count: number;
  total_appendable_count: number;
  expected_total_after_append: number;
  action_breakdown: Record<string, number>;
  classification_breakdown: Record<string, number>;
}

// Expected B10Z classification (from B10X preflight + B10Y reclassification).
export const EXPECTED_APPEND_NEW = 15;
export const EXPECTED_SKIP_BENIGN_DUPLICATE = 5;
export const EXPECTED_APPEND_AFTER_IDENTITY_FIX = 10;
export const EXPECTED_BLOCK_TRUE_CONFLICT = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function s(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function existingKey(shardMonth: string, rowId: string): string {
  return `${shardMonth}::${rowId}`;
}

// Map a B09X-confidence row to its append recommendation. B-confidence
// directional rows are price-pressure evidence; C-confidence excluded rows are
// audit-only evidence. Never proposes a direct row, never a synthetic multiplier.
function appendRecommendationForRow(row: B09XIdentityPreviewRow): {
  recommendation: "append_directional" | "append_excluded_audit";
  price_pressure_usable: boolean;
} {
  if (s(row.dp_usage) === "excluded" || s(row.basis_confidence) === "C") {
    return { recommendation: "append_excluded_audit", price_pressure_usable: false };
  }
  return { recommendation: "append_directional", price_pressure_usable: true };
}

function actionFromId02x(action: RecommendedAction): {
  history_action: B10ZHistoryAction;
  appendable: boolean;
} {
  switch (action) {
    case "skip_benign_duplicate":
      return { history_action: "skip_benign_duplicate", appendable: false };
    case "skip_identical":
      return { history_action: "skip_identical", appendable: false };
    case "append_new_observation":
    case "append_new_observation_price_changed":
    case "append_new_observation_basis_changed":
    case "append_new_observation_availability_changed":
    case "append_new_observation_after_identity_fix":
      return { history_action: "append_new_observation_after_identity_fix", appendable: true };
    case "block_true_conflict":
      return { history_action: "block_true_conflict", appendable: false };
    case "manual_review":
    default:
      return { history_action: "manual_review", appendable: false };
  }
}

// ---------------------------------------------------------------------------
// Proposal row construction
// ---------------------------------------------------------------------------

export function buildProposalRows(
  rows: readonly B09XIdentityPreviewRow[],
  existingKeys: readonly ExistingHistoryKey[],
  b10yConflicts: readonly B10YConflictRow[]
): B10ZProposalRow[] {
  const existing = new Map<string, string>();
  for (const key of existingKeys) existing.set(existingKey(key.shard_month, key.row_id), key.row_hash);

  const conflictByRowId = new Map<string, B10YConflictRow>();
  for (const c of b10yConflicts) conflictByRowId.set(c.row_id, c);

  return rows.map((row) => buildProposalRow(row, existing, conflictByRowId));
}

function buildProposalRow(
  row: B09XIdentityPreviewRow,
  existing: Map<string, string>,
  conflictByRowId: Map<string, B10YConflictRow>
): B10ZProposalRow {
  const derived = deriveIdentity(row);
  const rec = appendRecommendationForRow(row);
  const base = {
    source: s(row.source) || "booking",
    canonical_property_name: s(row.canonical_property_name),
    booking_slug: s(row.source_slug_or_code) || s(row.source_property_id),
    checkin_date: s(row.checkin_date) || s(row.checkin),
    checkout_date: s(row.checkout_date) || s(row.checkout),
    stay_scope: s(row.stay_scope),
    availability_status: s(row.availability_status),
    normalized_total_jpy: (row.normalized_total_jpy ?? (row.normalized_total_price as number | null)) ?? null,
    basis_confidence: s(row.basis_confidence),
    dp_usage: s(row.dp_usage),
    dp_usable: false as const,
    market_identity_key: derived.market_identity_key,
    market_identity_plain_key: derived.market_identity_plain_key,
    observation_id: derived.observation_id,
    observation_id_basis: derived.observation_id_basis,
    observation_id_degraded: derived.observation_id_degraded,
    market_value_hash: derived.market_value_hash,
    observation_hash: derived.observation_hash,
    new_row_id: row.row_id,
    new_row_hash: row.row_hash,
    shard_month: row.shard_month
  };

  const existingHash = existing.get(existingKey(row.shard_month, row.row_id));

  // Case A — new row_id not present in history → append_new.
  if (existingHash === undefined) {
    return {
      ...base,
      price_pressure_usable: rec.price_pressure_usable,
      history_action: "append_new",
      append_recommendation: rec.recommendation,
      conflict_classification: "no_conflict",
      difference_types: [],
      market_value_changed_fields: [],
      metadata_changed_fields: [],
      existing_row_id: "",
      existing_row_hash: "",
      reason:
        rec.recommendation === "append_excluded_audit"
          ? "New market observation; C-confidence excluded audit evidence only."
          : "New market observation; B-confidence directional price-pressure evidence, dp_usable=false."
    };
  }

  // Case B — same row_id + same row_hash → skip_identical.
  if (existingHash === row.row_hash) {
    return {
      ...base,
      price_pressure_usable: false,
      history_action: "skip_identical",
      append_recommendation: "skip",
      conflict_classification: "exact_duplicate_observation",
      difference_types: [],
      market_value_changed_fields: [],
      metadata_changed_fields: [],
      existing_row_id: row.row_id,
      existing_row_hash: existingHash,
      reason: "row_id and row_hash already present in history; identical observation, skip."
    };
  }

  // Case C — same row_id + different row_hash. Do NOT auto-block. Apply the
  // ID02X conflict policy via the B10Y comparison values.
  const conflict = conflictByRowId.get(row.row_id);
  if (!conflict) {
    return {
      ...base,
      price_pressure_usable: false,
      history_action: "manual_review",
      append_recommendation: "block_until_manual_review",
      conflict_classification: "unknown_conflict",
      difference_types: ["legacy_row_hash_changed_without_b10y_comparison"],
      market_value_changed_fields: [],
      metadata_changed_fields: [],
      existing_row_id: row.row_id,
      existing_row_hash: existingHash,
      reason: "row_id collides with existing history but no B10Y comparison row was found; needs manual review."
    };
  }

  const reclass = reclassifyB10YConflict(conflict);
  const mapped = actionFromId02x(reclass.id02x_recommended_action);
  const appendRec: B10ZAppendRecommendation = mapped.appendable
    ? rec.recommendation
    : mapped.history_action === "skip_benign_duplicate"
      ? "skip"
      : "block_until_manual_review";

  return {
    ...base,
    price_pressure_usable: mapped.appendable ? rec.price_pressure_usable : false,
    history_action: mapped.history_action,
    append_recommendation: appendRec,
    conflict_classification: reclass.id02x_classification,
    difference_types: conflict.difference_types,
    market_value_changed_fields: conflict.market_value_changed_fields,
    metadata_changed_fields: conflict.metadata_changed_fields,
    existing_row_id: row.row_id,
    existing_row_hash: conflict.existing_row_hash || existingHash,
    reason: reclass.reason
  };
}

// ---------------------------------------------------------------------------
// Summary + decision
// ---------------------------------------------------------------------------

export function summarizeProposal(
  rows: readonly B10ZProposalRow[],
  currentHistory: CurrentHistorySummary
): B10ZProposalSummary {
  const actionBreakdown: Record<string, number> = {};
  const classBreakdown: Record<string, number> = {};
  for (const r of rows) {
    actionBreakdown[r.history_action] = (actionBreakdown[r.history_action] ?? 0) + 1;
    classBreakdown[r.conflict_classification] = (classBreakdown[r.conflict_classification] ?? 0) + 1;
  }
  const appendNew = actionBreakdown["append_new"] ?? 0;
  const appendAfterFix = actionBreakdown["append_new_observation_after_identity_fix"] ?? 0;
  const appendable = rows.filter(
    (r) => r.history_action === "append_new" || r.history_action === "append_new_observation_after_identity_fix"
  );
  return {
    proposal_row_count: rows.length,
    existing_history_row_count: currentHistory.total_rows,
    append_new_count: appendNew,
    skip_identical_count: actionBreakdown["skip_identical"] ?? 0,
    skip_benign_duplicate_count: actionBreakdown["skip_benign_duplicate"] ?? 0,
    append_new_observation_after_identity_fix_count: appendAfterFix,
    block_true_conflict_count: actionBreakdown["block_true_conflict"] ?? 0,
    manual_review_count: actionBreakdown["manual_review"] ?? 0,
    append_directional_count: appendable.filter((r) => r.append_recommendation === "append_directional").length,
    append_excluded_audit_count: appendable.filter((r) => r.append_recommendation === "append_excluded_audit").length,
    total_appendable_count: appendable.length,
    expected_total_after_append: currentHistory.total_rows + appendable.length,
    action_breakdown: actionBreakdown,
    classification_breakdown: classBreakdown
  };
}

export function decideB10Z(input: {
  b09xLoaded: boolean;
  id02xLoaded: boolean;
  historyParsed: boolean;
  summary: B10ZProposalSummary;
  anyObservationIdDegraded: boolean;
}): B10ZDecision {
  if (!input.b09xLoaded) return "booking_bounded_append_with_identity_proposal_not_ready";
  if (!input.id02xLoaded) return "booking_bounded_append_with_identity_proposal_not_ready";
  if (!input.historyParsed) return "booking_bounded_append_with_identity_proposal_not_ready";
  if (input.summary.block_true_conflict_count > 0) return "booking_bounded_append_with_identity_proposal_not_ready";
  if (input.summary.manual_review_count > 0) return "booking_bounded_append_with_identity_proposal_not_ready";
  if (input.anyObservationIdDegraded) return "booking_bounded_append_with_identity_proposal_basis_caution";
  return "booking_bounded_append_with_identity_proposal_ready";
}

// ---------------------------------------------------------------------------
// Static report sections
// ---------------------------------------------------------------------------

export function buildIdentityPolicy() {
  return {
    policy: "ID02X Option C — preserve legacy v1 row_id; classify with derived market_identity_key / observation_id / market_value_hash / observation_hash.",
    legacy_row_id_collision_rule:
      "Same legacy row_id with a changed market value becomes a NEW observation (append_new_observation_after_identity_fix); metadata-only collisions become skip_benign_duplicate.",
    never_overwrites_existing_rows: true,
    never_supersedes_existing_rows: true,
    observation_id_rule:
      "Prefer collected_run_id, fall back to collected_at_jst; never invent a wall-clock timestamp or use generated_at_jst.",
    no_booking_base_times_1_1: true
  };
}

export function buildPricePressurePolicy() {
  return {
    valid_official_total_rows: {
      computed_total_rule: "primary_price_numeric + official_tax_fee_adder_numeric",
      basis_confidence: "B",
      dp_usage: "directional",
      append_recommendation: "append_directional",
      price_pressure_usable: true,
      dp_usable: false
    },
    missing_or_unclear_rows: {
      basis_confidence: "C",
      dp_usage: "excluded",
      append_recommendation: "append_excluded_audit",
      price_pressure_usable: false,
      dp_usable: false
    },
    forbidden_rule: "primary_price_numeric times 1.1 synthetic tax multiplier (never used)",
    booking_direct_rows_allowed: 0,
    pms_ota_price_action_allowed: false
  };
}

export function buildFutureB11XPlan(summary: B10ZProposalSummary) {
  return {
    phase: "BOOKING-B11X — Approved Booking bounded append with identity policy",
    status: "proposed_not_executed",
    appendable_rows: summary.total_appendable_count,
    append_new_rows: summary.append_new_count,
    append_new_observation_after_identity_fix_rows: summary.append_new_observation_after_identity_fix_count,
    skip_benign_duplicate_rows: summary.skip_benign_duplicate_count,
    expected_total_after_append: summary.expected_total_after_append,
    approval_gate: {
      explicit_approval_sentence:
        "Approve Phase BOOKING-B11X Booking bounded append with identity policy. You may append the approved B10Z Booking observations to .data/history.",
      env_flag: "BOOKING_BOUNDED_APPEND_WITH_IDENTITY=1"
    },
    guardrails: [
      "No history append in B10Z.",
      "No DB write or DB sync in B10Z.",
      "No AI context refresh in B10Z.",
      "Existing rows are never overwritten or superseded.",
      "B11X must not start without explicit instruction."
    ]
  };
}

export function buildSafetyConfirmation() {
  return {
    history_modified: false,
    db_written: false,
    db_sync_run: false,
    ai_context_refreshed: false,
    live_booking_fetch: false,
    playwright_used: false,
    collector_run: false,
    existing_rows_overwritten: false,
    existing_rows_superseded: false,
    price_update: false,
    pms_beds24_airhost_ota_output: false,
    booking_base_times_1_1: false,
    github_actions_or_cron_activated: false,
    paid_sources_or_proxies: false,
    started_b11x: false
  };
}

// ---------------------------------------------------------------------------
// CSV rendering
// ---------------------------------------------------------------------------

export const B10Z_CSV_HEADERS = [
  "new_row_id",
  "canonical_property_name",
  "booking_slug",
  "checkin_date",
  "checkout_date",
  "stay_scope",
  "history_action",
  "append_recommendation",
  "conflict_classification",
  "basis_confidence",
  "dp_usage",
  "price_pressure_usable",
  "dp_usable",
  "normalized_total_jpy",
  "market_identity_key",
  "observation_id",
  "market_value_hash",
  "observation_hash",
  "existing_row_hash",
  "new_row_hash",
  "shard_month"
] as const;

export function renderProposalCsv(rows: readonly B10ZProposalRow[]): string {
  const body = rows.map((row) =>
    [
      row.new_row_id,
      row.canonical_property_name,
      row.booking_slug,
      row.checkin_date,
      row.checkout_date,
      row.stay_scope,
      row.history_action,
      row.append_recommendation,
      row.conflict_classification,
      row.basis_confidence,
      row.dp_usage,
      String(row.price_pressure_usable),
      String(row.dp_usable),
      row.normalized_total_jpy === null ? "" : String(row.normalized_total_jpy),
      row.market_identity_key,
      row.observation_id,
      row.market_value_hash,
      row.observation_hash,
      row.existing_row_hash,
      row.new_row_hash,
      row.shard_month
    ]
      .map(csvEscape)
      .join(",")
  );
  return [B10Z_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

function csvEscape(v: string): string {
  if (/[",\n\r]/u.test(v)) return `"${v.replace(/"/gu, '""')}"`;
  return v;
}
