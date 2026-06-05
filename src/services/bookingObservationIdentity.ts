// Phase BOOKING-ID02X — Derived identity helpers + conflict policy utilities.
//
// Pure functions only. This module MUTATES NOTHING: no DB access, no fs writes,
// no collector run, no external/live Booking fetch, no .data/history or
// property-master mutation, no migration, no channel-manager push output, no
// price update, and no Booking base × 1.1 logic. It implements the ID01X
// "Option C" identity model: keep the legacy v1 row_id for compatibility while
// adding derived market_identity_key, observation_id, market_value_hash and
// observation_hash, plus a conflict classifier that never overwrites or
// supersedes an existing row.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

// A Booking/history-style row. Fields are optional because callers feed partial
// rows (e.g. B10Y conflict-comparison value blobs). Values may arrive as strings
// (CSV / JSON) or native types; everything is normalized to a stable string
// before hashing.
export interface BookingLikeHistoryRow {
  row_id?: string | null;
  row_hash?: string | null;
  // identity (grouping) fields
  source?: string | null;
  canonical_property_name?: string | null;
  source_property_id?: string | null;
  source_slug_or_code?: string | null;
  checkin?: string | null;
  checkout?: string | null;
  stay_scope?: string | null;
  group_adults?: string | number | null;
  no_rooms?: string | number | null;
  group_children?: string | number | null;
  currency?: string | null;
  language?: string | null;
  // observation timing / provenance
  collected_date_jst?: string | null;
  collected_at_jst?: string | null;
  normalized_at_jst?: string | null;
  collected_run_id?: string | null;
  generated_at_jst?: string | null;
  run_id?: string | null;
  source_phase?: string | null;
  collector_stage?: string | null;
  // market-value fields
  availability_status?: string | null;
  sold_out_status?: string | null;
  normalized_total_price?: string | number | null;
  normalized_total_price_source?: string | null;
  normalized_total_price_basis?: string | null;
  normalized_total_price_confidence?: string | null;
  basis_confidence?: string | null;
  basis_note?: string | null;
  source_primary_price?: string | number | null;
  source_secondary_price_or_adder?: string | number | null;
  source_computed_total?: string | number | null;
  source_tax_or_fee_classification?: string | null;
  source_classification?: string | null;
  is_price_usable_for_dp_direct?: string | boolean | null;
  is_price_usable_for_dp_directional?: string | boolean | null;
  is_price_excluded_from_dp?: string | boolean | null;
  dp_exclusion_reason?: string | null;
  warning_flags?: string | null;
  schema_version?: string | null;
  // volatile paths (never hashed into identity)
  source_report_path?: string | null;
  source_csv_path?: string | null;
  debug_artifact_path?: string | null;
}

// ---------------------------------------------------------------------------
// Field groups (single source of truth, exported for the report/tests)
// ---------------------------------------------------------------------------

export const MARKET_IDENTITY_FIELDS = [
  "source",
  "canonical_property_name",
  "source_slug_or_code",
  "checkin",
  "checkout",
  "stay_scope",
  "group_adults",
  "no_rooms",
  "group_children",
  "currency",
  "language"
] as const;

export const MARKET_VALUE_FIELDS = [
  "availability_status",
  "sold_out_status",
  "normalized_total_price",
  "normalized_total_price_source",
  "normalized_total_price_basis",
  "normalized_total_price_confidence",
  "basis_confidence",
  "basis_note",
  "source_primary_price",
  "source_secondary_price_or_adder",
  "source_computed_total",
  "source_tax_or_fee_classification",
  "source_classification",
  "is_price_usable_for_dp_direct",
  "is_price_usable_for_dp_directional",
  "is_price_excluded_from_dp",
  "dp_exclusion_reason",
  "warning_flags",
  "schema_version"
] as const;

export const OBSERVATION_HASH_FIELDS = [
  "market_identity_key",
  "observation_id",
  "market_value_hash",
  "source",
  "source_phase",
  "collector_stage",
  "canonical_property_name",
  "source_slug_or_code",
  "checkin",
  "checkout",
  "stay_scope",
  "collected_date_jst",
  "collected_at_jst",
  "normalized_at_jst"
] as const;

// Fields that must NEVER influence any identity hash.
export const ALWAYS_EXCLUDED_FROM_IDENTITY = [
  "row_id",
  "row_hash",
  "source_report_path",
  "source_csv_path",
  "debug_artifact_path",
  "generated_at_jst",
  "run_id"
] as const;

const PRICE_FIELDS = [
  "normalized_total_price",
  "source_primary_price",
  "source_secondary_price_or_adder",
  "source_computed_total"
] as const;

const BASIS_FIELDS = [
  "basis_confidence",
  "normalized_total_price_basis",
  "normalized_total_price_confidence",
  "source_classification",
  "source_tax_or_fee_classification",
  "basis_note",
  "warning_flags"
] as const;

const AVAILABILITY_FIELDS = ["availability_status", "sold_out_status"] as const;

// ---------------------------------------------------------------------------
// Normalization + canonical hashing
// ---------------------------------------------------------------------------

function s(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

// Deterministic canonical JSON: keys sorted, values normalized to strings. The
// same logical row always produces byte-identical JSON regardless of insertion
// order or value typing.
function canonicalJson(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).sort();
  return JSON.stringify(keys.map((k) => [k, s(fields[k])]));
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function pick(row: BookingLikeHistoryRow, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = (row as Record<string, unknown>)[f];
  return out;
}

function identityToken(row: BookingLikeHistoryRow): string {
  return s(row.source_slug_or_code).trim() || s(row.source_property_id).trim() || "market_aggregate";
}

// ---------------------------------------------------------------------------
// 4.1 market_identity_key
// ---------------------------------------------------------------------------

export function buildMarketIdentityKey(row: BookingLikeHistoryRow): string {
  return sha256(canonicalJson(pick(row, MARKET_IDENTITY_FIELDS)));
}

export function buildMarketIdentityPlainKey(row: BookingLikeHistoryRow): string {
  return [
    s(row.source),
    identityToken(row),
    s(row.checkin),
    s(row.checkout),
    s(row.stay_scope),
    s(row.group_adults),
    s(row.no_rooms),
    s(row.group_children),
    s(row.currency),
    s(row.language)
  ].join("|");
}

// ---------------------------------------------------------------------------
// 4.2 observation_id
// ---------------------------------------------------------------------------

export type ObservationIdentityBasis = "collected_run_id" | "collected_at_jst" | "degraded";

export interface ObservationIdResult {
  observation_id: string;
  identity_basis: ObservationIdentityBasis;
  degraded: boolean;
  warning: string | null;
}

export function buildObservationIdResult(row: BookingLikeHistoryRow): ObservationIdResult {
  const marketIdentityKey = buildMarketIdentityKey(row);
  const runId = s(row.collected_run_id).trim();
  const collectedAt = s(row.collected_at_jst).trim();

  let basis: ObservationIdentityBasis;
  let timeToken: string;
  let warning: string | null = null;
  if (runId !== "") {
    basis = "collected_run_id";
    timeToken = runId;
  } else if (collectedAt !== "") {
    basis = "collected_at_jst";
    timeToken = collectedAt;
  } else {
    // No deterministic observation time available. Do NOT invent a wall-clock
    // timestamp or use generated_at_jst. Produce a deterministic-but-degraded id and warn.
    basis = "degraded";
    timeToken = "";
    warning = "insufficient_observation_identity: neither collected_run_id nor collected_at_jst present";
  }

  const observationId = sha256(
    canonicalJson({
      market_identity_key: marketIdentityKey,
      observation_time_token: timeToken,
      observation_identity_basis: basis,
      source_phase: row.source_phase,
      collector_stage: row.collector_stage
    })
  );

  return { observation_id: observationId, identity_basis: basis, degraded: basis === "degraded", warning };
}

export function buildObservationId(row: BookingLikeHistoryRow): string {
  return buildObservationIdResult(row).observation_id;
}

// ---------------------------------------------------------------------------
// 4.3 market_value_hash
// ---------------------------------------------------------------------------

export function buildMarketValueHash(row: BookingLikeHistoryRow): string {
  return sha256(canonicalJson(pick(row, MARKET_VALUE_FIELDS)));
}

// ---------------------------------------------------------------------------
// 4.4 observation_hash
// ---------------------------------------------------------------------------

export function buildObservationHash(row: BookingLikeHistoryRow): string {
  const marketIdentityKey = buildMarketIdentityKey(row);
  const observationId = buildObservationId(row);
  const marketValueHash = buildMarketValueHash(row);
  const fields: Record<string, unknown> = {
    market_identity_key: marketIdentityKey,
    observation_id: observationId,
    market_value_hash: marketValueHash,
    source: row.source,
    source_phase: row.source_phase,
    collector_stage: row.collector_stage,
    canonical_property_name: row.canonical_property_name,
    source_slug_or_code: row.source_slug_or_code,
    checkin: row.checkin,
    checkout: row.checkout,
    stay_scope: row.stay_scope,
    collected_date_jst: row.collected_date_jst,
    collected_at_jst: row.collected_at_jst,
    normalized_at_jst: row.normalized_at_jst
  };
  return sha256(canonicalJson(fields));
}

// Compute all four derived identity values at once.
export interface DerivedIdentity {
  legacy_row_id: string;
  legacy_row_hash: string;
  market_identity_key: string;
  market_identity_plain_key: string;
  observation_id: string;
  observation_id_basis: ObservationIdentityBasis;
  observation_id_degraded: boolean;
  market_value_hash: string;
  observation_hash: string;
}

export function deriveIdentity(row: BookingLikeHistoryRow): DerivedIdentity {
  const obs = buildObservationIdResult(row);
  return {
    legacy_row_id: s(row.row_id),
    legacy_row_hash: s(row.row_hash),
    market_identity_key: buildMarketIdentityKey(row),
    market_identity_plain_key: buildMarketIdentityPlainKey(row),
    observation_id: obs.observation_id,
    observation_id_basis: obs.identity_basis,
    observation_id_degraded: obs.degraded,
    market_value_hash: buildMarketValueHash(row),
    observation_hash: buildObservationHash(row)
  };
}

// ---------------------------------------------------------------------------
// 5. Conflict policy utility
// ---------------------------------------------------------------------------

export type ConflictClassification =
  | "exact_duplicate_observation"
  | "benign_metadata_duplicate"
  | "new_observation_same_market_same_value"
  | "new_observation_price_changed"
  | "new_observation_basis_changed"
  | "new_observation_availability_changed"
  | "legacy_row_id_conflict_market_changed"
  | "legacy_row_id_conflict_metadata_only"
  | "true_observation_id_conflict"
  | "unknown_conflict";

export type RecommendedAction =
  | "skip_identical"
  | "skip_benign_duplicate"
  | "append_new_observation"
  | "append_new_observation_price_changed"
  | "append_new_observation_basis_changed"
  | "append_new_observation_availability_changed"
  | "append_new_observation_after_identity_fix"
  | "block_true_conflict"
  | "manual_review";

export interface ConflictPolicyResult {
  classification: ConflictClassification;
  recommended_action: RecommendedAction;
  same_legacy_row_id: boolean;
  same_legacy_row_hash: boolean;
  same_market_identity_key: boolean;
  same_observation_id: boolean;
  same_market_value_hash: boolean;
  same_observation_hash: boolean;
  market_value_changed: boolean;
  metadata_only_changed: boolean;
  price_changed: boolean;
  basis_changed: boolean;
  availability_changed: boolean;
  reason: string;
}

function anyFieldDiffers(
  a: BookingLikeHistoryRow,
  b: BookingLikeHistoryRow,
  fields: readonly string[]
): boolean {
  for (const f of fields) {
    if (s((a as Record<string, unknown>)[f]) !== s((b as Record<string, unknown>)[f])) return true;
  }
  return false;
}

export function classifyObservationConflict(
  existingRow: BookingLikeHistoryRow,
  newRow: BookingLikeHistoryRow
): ConflictPolicyResult {
  const ex = deriveIdentity(existingRow);
  const nw = deriveIdentity(newRow);

  const sameLegacyRowId = ex.legacy_row_id !== "" && ex.legacy_row_id === nw.legacy_row_id;
  const sameLegacyRowHash = ex.legacy_row_hash !== "" && ex.legacy_row_hash === nw.legacy_row_hash;
  const sameMarketIdentityKey = ex.market_identity_key === nw.market_identity_key;
  const sameObservationId = ex.observation_id === nw.observation_id;
  const sameMarketValueHash = ex.market_value_hash === nw.market_value_hash;
  const sameObservationHash = ex.observation_hash === nw.observation_hash;

  const marketValueChanged = !sameMarketValueHash;
  const priceChanged = anyFieldDiffers(existingRow, newRow, PRICE_FIELDS);
  const basisChanged = anyFieldDiffers(existingRow, newRow, BASIS_FIELDS);
  const availabilityChanged = anyFieldDiffers(existingRow, newRow, AVAILABILITY_FIELDS);
  const metadataOnlyChanged = !marketValueChanged && !sameObservationHash;

  const base = {
    same_legacy_row_id: sameLegacyRowId,
    same_legacy_row_hash: sameLegacyRowHash,
    same_market_identity_key: sameMarketIdentityKey,
    same_observation_id: sameObservationId,
    same_market_value_hash: sameMarketValueHash,
    same_observation_hash: sameObservationHash,
    market_value_changed: marketValueChanged,
    metadata_only_changed: metadataOnlyChanged,
    price_changed: priceChanged,
    basis_changed: basisChanged,
    availability_changed: availabilityChanged
  };

  const result = (
    classification: ConflictClassification,
    recommended_action: RecommendedAction,
    reason: string
  ): ConflictPolicyResult => ({ ...base, classification, recommended_action, reason });

  // 1. Exact duplicate observation.
  if (sameObservationId && sameObservationHash) {
    return result("exact_duplicate_observation", "skip_identical", "Same observation_id and observation_hash.");
  }
  // 2. Same observation event but different content = integrity conflict.
  if (sameObservationId && !sameObservationHash) {
    return result(
      "true_observation_id_conflict",
      "block_true_conflict",
      "Same observation_id but different observation_hash; cannot append without manual review."
    );
  }
  // 3. Legacy v1 row_id collision (the B10Y case): same legacy row_id, different
  //    legacy row_hash. Under the new identity model these become distinct
  //    observations; never overwrite/supersede.
  if (sameLegacyRowId && !sameLegacyRowHash) {
    if (marketValueChanged) {
      return result(
        "legacy_row_id_conflict_market_changed",
        "append_new_observation_after_identity_fix",
        "Legacy row_id collision with changed market value; preserve as a new observation under the corrected identity model."
      );
    }
    return result(
      "legacy_row_id_conflict_metadata_only",
      "skip_benign_duplicate",
      "Legacy row_id collision with only metadata/phase/stage/timestamp differences; benign duplicate."
    );
  }
  // 4. Same market object, distinct observation event.
  if (sameMarketIdentityKey && !sameObservationId) {
    if (!marketValueChanged) {
      if (s(existingRow.collected_date_jst) !== s(newRow.collected_date_jst)) {
        return result(
          "new_observation_same_market_same_value",
          "append_new_observation",
          "Same market object and value observed on a different collection day; keep as a new time-series observation."
        );
      }
      return result(
        "benign_metadata_duplicate",
        "skip_benign_duplicate",
        "Same market object and value, same collection day, only phase/stage/timestamp differ."
      );
    }
    if (priceChanged) {
      return result(
        "new_observation_price_changed",
        "append_new_observation_price_changed",
        "Same market object, price moved; append as a price-changed observation."
      );
    }
    if (basisChanged) {
      return result(
        "new_observation_basis_changed",
        "append_new_observation_basis_changed",
        "Same market object, basis/confidence moved; append as a basis-changed observation."
      );
    }
    if (availabilityChanged) {
      return result(
        "new_observation_availability_changed",
        "append_new_observation_availability_changed",
        "Same market object, availability moved; append as an availability-changed observation."
      );
    }
    return result(
      "unknown_conflict",
      "manual_review",
      "Market value hash changed but no price/basis/availability field difference detected."
    );
  }
  // 5. Anything else.
  return result("unknown_conflict", "manual_review", "Rows do not share a legacy row_id or market identity key.");
}

// ---------------------------------------------------------------------------
// 6. B10Y reclassification
// ---------------------------------------------------------------------------

export interface B10YConflictRow {
  row_id: string;
  existing_row_hash: string;
  new_b09x_row_hash: string;
  canonical_property_name: string;
  source_slug_or_code: string;
  checkin: string;
  checkout: string;
  existing_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  changed_fields: string[];
  market_value_changed_fields: string[];
  metadata_changed_fields: string[];
  difference_types: string[];
  recommended_action: string;
}

export interface ReclassifiedConflictRow {
  row_id: string;
  market_identity_plain_key: string;
  legacy_row_hash_existing: string;
  legacy_row_hash_new: string;
  id02x_classification: ConflictClassification;
  id02x_recommended_action: RecommendedAction;
  b10y_recommended_action: string;
  market_value_changed: boolean;
  price_changed: boolean;
  basis_changed: boolean;
  availability_changed: boolean;
  same_market_identity_key: boolean;
  same_observation_id: boolean;
  reason: string;
}

// Parse a "checkin|checkout|stay_scope" style stay_scope out of the legacy
// row_id (last segment) so the market identity fields are populated.
function stayScopeFromRowId(rowId: string): string {
  const parts = rowId.split("|");
  return parts.length > 0 ? parts[parts.length - 1]! : "";
}

function sourceFromRowId(rowId: string): string {
  const parts = rowId.split("|");
  return parts.length > 1 ? parts[1]! : "";
}

// Build a BookingLikeHistoryRow from a B10Y value blob + the conflict row's
// shared identity fields (so existing and new share identity but differ in the
// values the blob carries).
function rowFromB10YValues(
  conflict: B10YConflictRow,
  values: Record<string, unknown>,
  legacyRowHash: string
): BookingLikeHistoryRow {
  return {
    row_id: conflict.row_id,
    row_hash: legacyRowHash,
    source: sourceFromRowId(conflict.row_id) || "booking",
    canonical_property_name: conflict.canonical_property_name,
    source_slug_or_code: conflict.source_slug_or_code,
    checkin: conflict.checkin,
    checkout: conflict.checkout,
    stay_scope: stayScopeFromRowId(conflict.row_id),
    ...values
  } as BookingLikeHistoryRow;
}

export function reclassifyB10YConflict(conflict: B10YConflictRow): ReclassifiedConflictRow {
  const existing = rowFromB10YValues(conflict, conflict.existing_values, conflict.existing_row_hash);
  const incoming = rowFromB10YValues(conflict, conflict.new_values, conflict.new_b09x_row_hash);
  const policy = classifyObservationConflict(existing, incoming);
  return {
    row_id: conflict.row_id,
    market_identity_plain_key: buildMarketIdentityPlainKey(existing),
    legacy_row_hash_existing: conflict.existing_row_hash,
    legacy_row_hash_new: conflict.new_b09x_row_hash,
    id02x_classification: policy.classification,
    id02x_recommended_action: policy.recommended_action,
    b10y_recommended_action: conflict.recommended_action,
    market_value_changed: policy.market_value_changed,
    price_changed: policy.price_changed,
    basis_changed: policy.basis_changed,
    availability_changed: policy.availability_changed,
    same_market_identity_key: policy.same_market_identity_key,
    same_observation_id: policy.same_observation_id,
    reason: policy.reason
  };
}

export interface ConflictPolicySummary {
  conflict_count: number;
  metadata_only_conflicts: number;
  market_value_conflicts: number;
  price_changed_conflicts: number;
  basis_changed_conflicts: number;
  availability_changed_conflicts: number;
  skip_benign_duplicate_count: number;
  append_after_identity_fix_count: number;
  block_true_conflict_count: number;
  manual_review_count: number;
  action_breakdown: Record<string, number>;
  classification_breakdown: Record<string, number>;
  b10z_can_proceed: boolean;
}

export function summarizeReclassification(rows: ReclassifiedConflictRow[]): ConflictPolicySummary {
  const actionBreakdown: Record<string, number> = {};
  const classBreakdown: Record<string, number> = {};
  let metadataOnly = 0;
  let marketValue = 0;
  let priceChanged = 0;
  let basisChanged = 0;
  let availabilityChanged = 0;
  for (const r of rows) {
    actionBreakdown[r.id02x_recommended_action] = (actionBreakdown[r.id02x_recommended_action] ?? 0) + 1;
    classBreakdown[r.id02x_classification] = (classBreakdown[r.id02x_classification] ?? 0) + 1;
    if (r.market_value_changed) {
      marketValue += 1;
      if (r.price_changed) priceChanged += 1;
      else if (r.basis_changed) basisChanged += 1;
      else if (r.availability_changed) availabilityChanged += 1;
    } else {
      metadataOnly += 1;
    }
  }
  const skipBenign = actionBreakdown["skip_benign_duplicate"] ?? 0;
  const appendAfterFix = actionBreakdown["append_new_observation_after_identity_fix"] ?? 0;
  const block = actionBreakdown["block_true_conflict"] ?? 0;
  const manual = actionBreakdown["manual_review"] ?? 0;
  return {
    conflict_count: rows.length,
    metadata_only_conflicts: metadataOnly,
    market_value_conflicts: marketValue,
    price_changed_conflicts: priceChanged,
    basis_changed_conflicts: basisChanged,
    availability_changed_conflicts: availabilityChanged,
    skip_benign_duplicate_count: skipBenign,
    append_after_identity_fix_count: appendAfterFix,
    block_true_conflict_count: block,
    manual_review_count: manual,
    action_breakdown: actionBreakdown,
    classification_breakdown: classBreakdown,
    b10z_can_proceed: block === 0 && manual === 0
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type ObservationIdentityDecision =
  | "booking_observation_identity_ready"
  | "booking_observation_identity_basis_caution"
  | "booking_observation_identity_not_ready";

export const EXPECTED_CONFLICT_COUNT = 15;
export const EXPECTED_METADATA_ONLY = 5;
export const EXPECTED_MARKET_VALUE = 10;

export interface IdentityDecisionInput {
  b10y_loaded: boolean;
  summary: ConflictPolicySummary;
  any_observation_id_degraded: boolean;
  safety_all_clean: boolean;
}

export function decideObservationIdentity(input: IdentityDecisionInput): ObservationIdentityDecision {
  const sm = input.summary;
  if (!input.b10y_loaded) return "booking_observation_identity_not_ready";
  if (sm.conflict_count !== EXPECTED_CONFLICT_COUNT) return "booking_observation_identity_not_ready";
  if (sm.skip_benign_duplicate_count !== EXPECTED_METADATA_ONLY) return "booking_observation_identity_not_ready";
  if (sm.append_after_identity_fix_count !== EXPECTED_MARKET_VALUE) return "booking_observation_identity_not_ready";
  if (!input.safety_all_clean) return "booking_observation_identity_not_ready";
  if (input.any_observation_id_degraded) return "booking_observation_identity_basis_caution";
  return "booking_observation_identity_ready";
}
