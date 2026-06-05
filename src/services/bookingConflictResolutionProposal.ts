// Phase BOOKING-B10Y — Booking row conflict resolution proposal.
//
// Proposal-only analysis of B10X row_id/hash conflicts. Compares existing
// history rows to B09X re-collected rows field-by-field and recommends whether
// conflicts are benign duplicates, market-value changes needing a revised
// observation model, or manual-review blockers. No writes, no live fetches.

export type BookingB10YDecision =
  | "booking_conflict_resolution_proposal_ready"
  | "booking_conflict_resolution_proposal_basis_caution"
  | "booking_conflict_resolution_proposal_not_ready";

export type DifferenceType =
  | "price_changed"
  | "availability_changed"
  | "basis_changed"
  | "metadata_only_changed"
  | "phase_or_stage_changed"
  | "debug_path_only_changed"
  | "true_conflict"
  | "expected_time_series_change"
  | "unknown_conflict";

export type RowRecommendedAction =
  | "skip_benign_duplicate"
  | "append_as_new_observation_after_identity_fix"
  | "block_until_manual_review"
  | "supersede_existing_after_approval"
  | "do_not_append";

export interface B10XArtifactLike {
  decision: string;
  preflight_summary: {
    conflict_count: number;
    conflict_row_ids: string[];
  };
  proposal_rows: Array<{
    row_id: string;
    row_hash: string;
    history_action: string;
    canonical_property_name: string;
    booking_slug: string;
    checkin_date: string;
    checkout_date: string;
  }>;
}

export interface B09XArtifactLike {
  decision: string;
  normalized_rows_preview: Array<Record<string, unknown>>;
}

export interface ConflictComparisonRow {
  row_id: string;
  existing_row_hash: string;
  new_b09x_row_hash: string;
  canonical_property_name: string;
  source_slug_or_code: string;
  checkin: string;
  checkout: string;
  existing_values: Record<string, string | null>;
  new_values: Record<string, string | null>;
  changed_fields: string[];
  market_value_changed_fields: string[];
  metadata_changed_fields: string[];
  difference_types: DifferenceType[];
  recommended_action: RowRecommendedAction;
  recommendation_reason: string;
}

export interface DifferenceSummary {
  conflict_count: number;
  matched_existing_count: number;
  matched_new_count: number;
  metadata_only_conflict_count: number;
  market_value_conflict_count: number;
  price_changed_count: number;
  availability_changed_count: number;
  basis_changed_count: number;
  phase_or_stage_changed_count: number;
  debug_path_only_changed_count: number;
  unknown_conflict_count: number;
}

export interface PolicyOption {
  option: "A" | "B" | "C" | "D";
  title: string;
  summary: string;
  pros: string[];
  cons: string[];
  recommendation: "short_term" | "medium_term" | "not_recommended_initially";
}

export const COMPARE_FIELDS = [
  "canonical_property_name",
  "source_slug_or_code",
  "checkin",
  "checkout",
  "collected_date_jst",
  "collected_at_jst",
  "normalized_at_jst",
  "availability_status",
  "normalized_total_price",
  "basis_confidence",
  "dp_usage",
  "source_primary_price",
  "source_secondary_price_or_adder",
  "source_computed_total",
  "source_tax_or_fee_classification",
  "source_classification",
  "warning_flags",
  "source_phase",
  "collector_stage",
  "debug_artifact_path"
] as const;

const MARKET_VALUE_FIELDS = new Set<string>([
  "availability_status",
  "normalized_total_price",
  "basis_confidence",
  "dp_usage",
  "source_primary_price",
  "source_secondary_price_or_adder",
  "source_computed_total",
  "source_tax_or_fee_classification",
  "source_classification",
  "warning_flags"
]);

const METADATA_FIELDS = new Set<string>([
  "collected_at_jst",
  "normalized_at_jst",
  "source_phase",
  "collector_stage",
  "debug_artifact_path"
]);

export function validateB10XArtifact(input: B10XArtifactLike): { valid: boolean; reasons: string[]; conflictRowIds: string[] } {
  const conflictRowIds = input.preflight_summary?.conflict_row_ids ?? [];
  const reasons: string[] = [];
  if (input.decision !== "booking_bounded_history_append_proposal_not_ready") {
    reasons.push("b10x_decision_not_not_ready");
  }
  if (input.preflight_summary?.conflict_count !== 15) reasons.push("unexpected_conflict_count");
  if (conflictRowIds.length !== 15) reasons.push("unexpected_conflict_row_id_count");
  return { valid: reasons.length === 0, reasons, conflictRowIds };
}

export function buildConflictComparisons(input: {
  conflictRowIds: readonly string[];
  existingHistoryRowsById: ReadonlyMap<string, Record<string, string>>;
  b09xRowsById: ReadonlyMap<string, Record<string, unknown>>;
}): ConflictComparisonRow[] {
  return input.conflictRowIds.map((rowId) => {
    const existing = input.existingHistoryRowsById.get(rowId);
    const newer = input.b09xRowsById.get(rowId);
    if (!existing || !newer) {
      return missingComparison(rowId, existing, newer);
    }
    const existingValues = comparableValues(existing);
    const newValues = comparableValues(newer);
    const changedFields = COMPARE_FIELDS.filter((field) => existingValues[field] !== newValues[field]);
    const marketValueChangedFields = changedFields.filter((field) => MARKET_VALUE_FIELDS.has(field));
    const metadataChangedFields = changedFields.filter((field) => METADATA_FIELDS.has(field));
    const differenceTypes = classifyDifferenceTypes({
      changedFields,
      marketValueChangedFields,
      metadataChangedFields
    });
    const action = recommendAction(differenceTypes);
    return {
      row_id: rowId,
      existing_row_hash: existing["row_hash"] ?? "",
      new_b09x_row_hash: stringValue(newer["row_hash"]),
      canonical_property_name: newValues.canonical_property_name ?? existingValues.canonical_property_name ?? "",
      source_slug_or_code: newValues.source_slug_or_code ?? existingValues.source_slug_or_code ?? "",
      checkin: newValues.checkin ?? existingValues.checkin ?? "",
      checkout: newValues.checkout ?? existingValues.checkout ?? "",
      existing_values: existingValues,
      new_values: newValues,
      changed_fields: changedFields,
      market_value_changed_fields: marketValueChangedFields,
      metadata_changed_fields: metadataChangedFields,
      difference_types: differenceTypes,
      recommended_action: action.action,
      recommendation_reason: action.reason
    };
  });
}

function missingComparison(
  rowId: string,
  existing: Record<string, string> | undefined,
  newer: Record<string, unknown> | undefined
): ConflictComparisonRow {
  return {
    row_id: rowId,
    existing_row_hash: existing?.["row_hash"] ?? "",
    new_b09x_row_hash: stringValue(newer?.["row_hash"]),
    canonical_property_name: stringValue(newer?.["canonical_property_name"] ?? existing?.["canonical_property_name"]),
    source_slug_or_code: stringValue(newer?.["source_slug_or_code"] ?? existing?.["source_slug_or_code"]),
    checkin: stringValue(newer?.["checkin"] ?? existing?.["checkin"]),
    checkout: stringValue(newer?.["checkout"] ?? existing?.["checkout"]),
    existing_values: existing ? comparableValues(existing) : {},
    new_values: newer ? comparableValues(newer) : {},
    changed_fields: [],
    market_value_changed_fields: [],
    metadata_changed_fields: [],
    difference_types: ["unknown_conflict"],
    recommended_action: "block_until_manual_review",
    recommendation_reason: "Could not match both existing history row and B09X preview row."
  };
}

function comparableValues(row: Record<string, unknown>): Record<string, string | null> {
  return {
    canonical_property_name: stringOrNull(row["canonical_property_name"]),
    source_slug_or_code: stringOrNull(row["source_slug_or_code"]),
    checkin: stringOrNull(row["checkin"] ?? row["checkin_date"]),
    checkout: stringOrNull(row["checkout"] ?? row["checkout_date"]),
    collected_date_jst: stringOrNull(row["collected_date_jst"]),
    collected_at_jst: stringOrNull(row["collected_at_jst"]),
    normalized_at_jst: stringOrNull(row["normalized_at_jst"]),
    availability_status: stringOrNull(row["availability_status"]),
    normalized_total_price: normalizeNullableNumber(row["normalized_total_price"] ?? row["normalized_total_jpy"]),
    basis_confidence: stringOrNull(row["basis_confidence"]),
    dp_usage: deriveDpUsage(row),
    source_primary_price: normalizeNullableNumber(row["source_primary_price"]),
    source_secondary_price_or_adder: normalizeNullableNumber(row["source_secondary_price_or_adder"]),
    source_computed_total: normalizeNullableNumber(row["source_computed_total"]),
    source_tax_or_fee_classification: stringOrNull(row["source_tax_or_fee_classification"]),
    source_classification: stringOrNull(row["source_classification"] ?? row["classification"]),
    warning_flags: stringOrNull(row["warning_flags"]),
    source_phase: stringOrNull(row["source_phase"]),
    collector_stage: stringOrNull(row["collector_stage"]),
    debug_artifact_path: stringOrNull(row["debug_artifact_path"])
  };
}

function classifyDifferenceTypes(input: {
  changedFields: readonly string[];
  marketValueChangedFields: readonly string[];
  metadataChangedFields: readonly string[];
}): DifferenceType[] {
  if (input.changedFields.length === 0) return ["metadata_only_changed"];
  const types = new Set<DifferenceType>();
  if (input.changedFields.some((field) => ["normalized_total_price", "source_primary_price", "source_secondary_price_or_adder", "source_computed_total"].includes(field))) {
    types.add("price_changed");
  }
  if (input.changedFields.includes("availability_status")) types.add("availability_changed");
  if (
    input.changedFields.some((field) =>
      ["basis_confidence", "dp_usage", "source_tax_or_fee_classification", "source_classification", "warning_flags"].includes(field)
    )
  ) {
    types.add("basis_changed");
  }
  if (input.changedFields.some((field) => field === "source_phase" || field === "collector_stage")) {
    types.add("phase_or_stage_changed");
  }
  if (input.changedFields.length === 1 && input.changedFields[0] === "debug_artifact_path") {
    types.add("debug_path_only_changed");
  }
  if (input.marketValueChangedFields.length === 0) types.add("metadata_only_changed");
  if (input.marketValueChangedFields.length > 0) types.add("expected_time_series_change");
  if (input.marketValueChangedFields.length > 0 && input.metadataChangedFields.length === 0) types.add("true_conflict");
  return [...types];
}

function recommendAction(types: readonly DifferenceType[]): { action: RowRecommendedAction; reason: string } {
  if (types.includes("unknown_conflict")) {
    return { action: "block_until_manual_review", reason: "Missing row evidence prevents automated resolution." };
  }
  if (types.includes("metadata_only_changed") && !types.includes("expected_time_series_change")) {
    return {
      action: "skip_benign_duplicate",
      reason: "Only metadata/debug/phase fields changed; market-value fields are unchanged."
    };
  }
  if (types.includes("expected_time_series_change")) {
    return {
      action: "append_as_new_observation_after_identity_fix",
      reason: "Market-value fields changed; preserve as a new observation after row identity policy is revised."
    };
  }
  return { action: "block_until_manual_review", reason: "Difference type is not safely resolvable automatically." };
}

export function summarizeDifferences(rows: readonly ConflictComparisonRow[]): DifferenceSummary {
  return {
    conflict_count: rows.length,
    matched_existing_count: rows.filter((row) => row.existing_row_hash).length,
    matched_new_count: rows.filter((row) => row.new_b09x_row_hash).length,
    metadata_only_conflict_count: rows.filter((row) => row.difference_types.includes("metadata_only_changed") && !row.difference_types.includes("expected_time_series_change")).length,
    market_value_conflict_count: rows.filter((row) => row.difference_types.includes("expected_time_series_change")).length,
    price_changed_count: rows.filter((row) => row.difference_types.includes("price_changed")).length,
    availability_changed_count: rows.filter((row) => row.difference_types.includes("availability_changed")).length,
    basis_changed_count: rows.filter((row) => row.difference_types.includes("basis_changed")).length,
    phase_or_stage_changed_count: rows.filter((row) => row.difference_types.includes("phase_or_stage_changed")).length,
    debug_path_only_changed_count: rows.filter((row) => row.difference_types.includes("debug_path_only_changed")).length,
    unknown_conflict_count: rows.filter((row) => row.difference_types.includes("unknown_conflict")).length
  };
}

export function buildRowIdentityPolicyEvaluation(): PolicyOption[] {
  return [
    {
      option: "A",
      title: "Existing policy: conflict blocks append",
      summary: "Keep row_id as market identity and treat same row_id/different hash as a conflict.",
      pros: ["Prevents accidental overwrite.", "Simple and already implemented."],
      cons: ["Blocks legitimate same-day re-observations.", "Hard to accumulate repeated intra-day observations."],
      recommendation: "short_term"
    },
    {
      option: "B",
      title: "Observation key includes run_id or collected_at",
      summary: "Let repeated property/date observations have unique observation IDs.",
      pros: ["Captures price movement.", "Avoids false conflicts for legitimate re-collection."],
      cons: ["More rows.", "Requires stable grouping key and view updates."],
      recommendation: "medium_term"
    },
    {
      option: "C",
      title: "market_identity_key plus observation version",
      summary: "Separate stable market identity from versioned observation records.",
      pros: ["Clean latest-vs-history model.", "Best long-term analytical semantics."],
      cons: ["Larger schema and append logic change."],
      recommendation: "medium_term"
    },
    {
      option: "D",
      title: "Skip benign metadata-only conflicts",
      summary: "Skip conflicts when only metadata/debug fields changed; block market-value changes.",
      pros: ["Low-risk improvement.", "Resolves false conflicts without schema change."],
      cons: ["Still cannot store same-day market-value changes."],
      recommendation: "short_term"
    }
  ];
}

export function buildRecommendedPolicy(summary: DifferenceSummary): {
  short_term: string;
  medium_term: string;
  b11x_recommendation: string;
} {
  if (summary.market_value_conflict_count === 0 && summary.unknown_conflict_count === 0) {
    return {
      short_term: "Apply Option D: skip benign metadata-only conflicts, then re-run append proposal for append_new rows.",
      medium_term: "Design observation_id / market_identity_key before heavy same-day re-collection.",
      b11x_recommendation: "B11X may proceed only after B10Z applies benign-conflict skip policy."
    };
  }
  return {
    short_term: "Keep Option A blocking behavior for market-value conflicts; do not append conflicting B09X rows.",
    medium_term: "Implement Option B or C: add market_identity_key plus observation_id/run_id so repeated Booking observations are stored as time-series observations.",
    b11x_recommendation: "B11X remains blocked until row identity policy is fixed or conflicts are manually resolved."
  };
}

export function buildFuturePhasePlan(summary: DifferenceSummary): string[] {
  if (summary.market_value_conflict_count === 0 && summary.unknown_conflict_count === 0) {
    return [
      "BOOKING-B10Z — Re-run append proposal with benign-conflict skip policy.",
      "BOOKING-B11X — Approved append only after B10Z confirms zero market-value conflicts."
    ];
  }
  return [
    "BOOKING-ID01X — Row Identity / Observation Model Design.",
    "BOOKING-ID02X — Conflict resolver implementation proposal.",
    "BOOKING-B10Z — Re-run append proposal with conflict policy applied.",
    "BOOKING-B11X — Approved append only after conflicts are resolved."
  ];
}

export function decideB10Y(input: { validB10x: boolean; summary: DifferenceSummary }): BookingB10YDecision {
  if (!input.validB10x || input.summary.matched_existing_count !== input.summary.conflict_count || input.summary.matched_new_count !== input.summary.conflict_count) {
    return "booking_conflict_resolution_proposal_not_ready";
  }
  if (input.summary.market_value_conflict_count > 0 || input.summary.unknown_conflict_count > 0) {
    return "booking_conflict_resolution_proposal_basis_caution";
  }
  return "booking_conflict_resolution_proposal_ready";
}

export function buildSafetyConfirmation() {
  return {
    history_append: false,
    db_writes: false,
    db_sync: false,
    ai_context_refresh: false,
    live_booking_fetch: false,
    playwright_used: false,
    booking_search_scraping: false,
    pms_beds24_airhost_ota_output: false,
    price_update: false,
    paid_source_tooling: false,
    captcha_bypass: false,
    stealth_plugin: false,
    login: false,
    cookie_injection: false,
    booking_base_times_1_1: false,
    rakuten_restart: false,
    jalan_automation_start: false,
    started_next_phase: false
  };
}

export function renderConflictCsv(rows: readonly ConflictComparisonRow[]): string {
  const headers = [
    "row_id",
    "canonical_property_name",
    "source_slug_or_code",
    "checkin",
    "checkout",
    "existing_row_hash",
    "new_b09x_row_hash",
    "changed_fields",
    "market_value_changed_fields",
    "difference_types",
    "recommended_action",
    "recommendation_reason"
  ];
  const body = rows.map((row) =>
    [
      row.row_id,
      row.canonical_property_name,
      row.source_slug_or_code,
      row.checkin,
      row.checkout,
      row.existing_row_hash,
      row.new_b09x_row_hash,
      row.changed_fields.join(";"),
      row.market_value_changed_fields.join(";"),
      row.difference_types.join(";"),
      row.recommended_action,
      row.recommendation_reason
    ]
      .map(csvEscape)
      .join(",")
  );
  return [headers.join(","), ...body].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: BookingB10YDecision;
  sourceB10xArtifactPath: string;
  sourceB09xArtifactPath: string;
  summary: DifferenceSummary;
  recommendedPolicy: ReturnType<typeof buildRecommendedPolicy>;
  futurePhasePlan: string[];
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
}): string {
  return [
    "# Booking Conflict Resolution Proposal",
    "",
    `Generated at JST: ${input.generatedAtJst}`,
    `Decision: ${input.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    `- conflict_count=${input.summary.conflict_count}`,
    `- market_value_conflict_count=${input.summary.market_value_conflict_count}`,
    `- metadata_only_conflict_count=${input.summary.metadata_only_conflict_count}`,
    "",
    "## 2. Source B10X Conflict Summary",
    "",
    `- source_b10x_artifact=${input.sourceB10xArtifactPath}`,
    `- source_b09x_artifact=${input.sourceB09xArtifactPath}`,
    "",
    "## 3. Conflict Comparison",
    "",
    "- See CSV/JSON artifacts for per-row field-level comparisons.",
    "",
    "## 4. Difference Summary",
    "",
    `- price_changed=${input.summary.price_changed_count}`,
    `- availability_changed=${input.summary.availability_changed_count}`,
    `- basis_changed=${input.summary.basis_changed_count}`,
    `- phase_or_stage_changed=${input.summary.phase_or_stage_changed_count}`,
    "",
    "## 5. Per-row Recommended Actions",
    "",
    "- Market-value changes: append_as_new_observation_after_identity_fix.",
    "- Metadata-only changes: skip_benign_duplicate.",
    "",
    "## 6. Row Identity Policy Evaluation",
    "",
    "- Option A remains safe as a blocker.",
    "- Option D is useful only for metadata-only conflicts.",
    "- Option B/C is needed for repeated Booking observations over time.",
    "",
    "## 7. Recommended Policy",
    "",
    `- short_term=${input.recommendedPolicy.short_term}`,
    `- medium_term=${input.recommendedPolicy.medium_term}`,
    "",
    "## 8. B11X Blocker Status",
    "",
    `- ${input.recommendedPolicy.b11x_recommendation}`,
    "",
    "## 9. Future Phase Plan",
    "",
    ...input.futurePhasePlan.map((phase) => `- ${phase}`),
    "",
    "## 10. Safety Confirmation",
    "",
    "- Proposal only: no history append, no DB writes, no AI context refresh.",
    "- No live Booking fetch, no Playwright, no Booking search scraping.",
    "- No paid APIs/proxies, no CAPTCHA bypass, no stealth/login/cookies.",
    "",
    "## 11. Decision",
    "",
    `- ${input.decision}`,
    "",
    "## 12. Next Step",
    "",
    "- Do not start B11X while market-value conflicts remain. Proceed to BOOKING-ID01X only with explicit instruction.",
    "",
    "## Output Paths",
    "",
    `- report_path=${input.reportPath}`,
    `- json_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugPath}`,
    ""
  ].join("\n");
}

function deriveDpUsage(row: Record<string, unknown>): string | null {
  const explicit = stringOrNull(row["dp_usage"]);
  if (explicit) return explicit;
  const direct = stringOrNull(row["is_price_usable_for_dp_direct"]);
  const directional = stringOrNull(row["is_price_usable_for_dp_directional"]);
  if (direct === "true") return "direct";
  if (directional === "true") return "directional";
  return "excluded";
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function stringOrNull(value: unknown): string | null {
  const out = stringValue(value);
  return out === "" ? null : out;
}

function normalizeNullableNumber(value: unknown): string | null {
  const out = stringValue(value);
  if (out === "") return null;
  const num = Number(out);
  return Number.isFinite(num) ? String(num) : out;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
