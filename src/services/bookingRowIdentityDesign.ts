// Phase BOOKING-ID01X - Booking row identity / observation model design.
//
// Design-only artifact for separating stable market identity from repeated
// Booking.com observation events. This module performs no history writes,
// database writes, migrations, live collection, or context refresh.

export type BookingRowIdentityDesignDecision =
  | "booking_row_identity_design_ready"
  | "booking_row_identity_design_basis_caution"
  | "booking_row_identity_design_not_ready";

export interface B10YArtifactLike {
  decision: string;
  conflict_count: number;
  difference_summary: {
    conflict_count: number;
    matched_existing_count: number;
    matched_new_count: number;
    metadata_only_conflict_count: number;
    market_value_conflict_count: number;
    price_changed_count: number;
    availability_changed_count: number;
    basis_changed_count: number;
    phase_or_stage_changed_count: number;
    unknown_conflict_count: number;
  };
  per_row_recommended_actions?: Array<{
    row_id: string;
    recommended_action: string;
    reason: string;
  }>;
}

export interface CurrentProblemSummary {
  b10y_decision: string;
  total_conflicts: number;
  existing_history_rows_matched: number;
  new_b09x_rows_matched: number;
  metadata_only_conflicts: number;
  market_value_conflicts: number;
  price_changed_conflicts: number;
  basis_changed_conflicts: number;
  availability_changed_conflicts: number;
  current_row_id_behavior: string;
  problem_statement: string;
  b11x_status: string;
}

export interface IdentityComponent {
  name: string;
  purpose: string;
  fields: string[];
  excludes: string[];
  formula: string;
  notes: string[];
}

export interface IdentityModel {
  market_identity_key: IdentityComponent;
  observation_id: IdentityComponent;
  row_id_compatibility: {
    short_term_policy: string;
    medium_term_policy: string;
    evaluated_options: string[];
  };
  market_value_hash: IdentityComponent;
  observation_hash: IdentityComponent;
}

export interface IdentityOption {
  option: "A" | "B" | "C" | "D";
  title: string;
  summary: string;
  pros: string[];
  cons: string[];
  recommendation: "not_recommended" | "temporary_only" | "recommended_short_term" | "recommended_medium_term";
}

export interface RecommendedPolicy {
  short_term: string;
  medium_term: string;
  immediate_next_phase: string;
  then_phase: string;
  b10z_expected_policy: {
    metadata_only_conflicts: string;
    market_value_conflicts: string;
    new_rows: string;
  };
  b11x_status: string;
}

export interface ConflictPolicyRule {
  case: string;
  action: string;
  reason: string;
}

export interface DbAiViewDesign {
  view_name: string;
  purpose: string;
  key_columns: string[];
  ai_context_usage: string;
}

export interface MigrationStep {
  step: number;
  action: string;
  rationale: string;
  mutates_history_in_id01x: false;
  writes_db_in_id01x: false;
}

export interface FuturePhase {
  phase: string;
  goal: string;
  start_condition: string;
}

export interface SafetyConfirmation {
  history_modification: false;
  history_append: false;
  db_writes: false;
  db_schema_migration_execution: false;
  db_sync: false;
  ai_context_refresh: false;
  live_booking_fetch: false;
  playwright_used: false;
  collector_run: false;
  pms_beds24_airhost_ota_output: false;
  price_update: false;
  paid_source_tooling: false;
  booking_synthetic_multiplier: false;
  rakuten_restart: false;
  jalan_automation_start: false;
  started_next_phase: false;
}

export function validateB10YArtifact(input: B10YArtifactLike): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.decision !== "booking_conflict_resolution_proposal_basis_caution") {
    reasons.push("b10y_decision_not_basis_caution");
  }
  if (input.conflict_count !== 15 || input.difference_summary?.conflict_count !== 15) {
    reasons.push("unexpected_conflict_count");
  }
  if (input.difference_summary?.market_value_conflict_count !== 10) {
    reasons.push("unexpected_market_value_conflict_count");
  }
  if (input.difference_summary?.metadata_only_conflict_count !== 5) {
    reasons.push("unexpected_metadata_only_conflict_count");
  }
  if (input.difference_summary?.matched_existing_count !== 15 || input.difference_summary?.matched_new_count !== 15) {
    reasons.push("conflict_rows_not_fully_matched");
  }
  return { valid: reasons.length === 0, reasons };
}

export function buildCurrentProblemSummary(input: B10YArtifactLike): CurrentProblemSummary {
  const summary = input.difference_summary;
  return {
    b10y_decision: input.decision,
    total_conflicts: summary.conflict_count,
    existing_history_rows_matched: summary.matched_existing_count,
    new_b09x_rows_matched: summary.matched_new_count,
    metadata_only_conflicts: summary.metadata_only_conflict_count,
    market_value_conflicts: summary.market_value_conflict_count,
    price_changed_conflicts: summary.price_changed_count,
    basis_changed_conflicts: summary.basis_changed_count,
    availability_changed_conflicts: summary.availability_changed_count,
    current_row_id_behavior:
      "Current v1 row_id behaves like collected_date_jst|source|canonical_property_name|source_slug_or_code|checkin|checkout|stay_scope.",
    problem_statement:
      "Repeated Booking.com observations for the same property/date/stay object on the same collection date can share row_id. When price or basis changes, row_hash changes and legitimate market movement is blocked as a conflict.",
    b11x_status: "B11X remains blocked until identity semantics distinguish market object identity from observation event identity."
  };
}

export function buildIdentityModel(): IdentityModel {
  return {
    market_identity_key: {
      name: "market_identity_key",
      purpose: "Group all observations for the same source/property/stay search object.",
      fields: [
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
      ],
      excludes: ["collected_at_jst", "collected_run_id", "source_phase", "collector_stage", "debug_artifact_path", "source_report_path", "source_csv_path"],
      formula:
        "sha256(source|canonical_property_name|source_slug_or_code|checkin|checkout|stay_scope|group_adults|no_rooms|group_children|currency|language)",
      notes: [
        "This key is stable across repeated observations of the same Booking page/search condition.",
        "It should be used for grouping latest-state views and price movement views."
      ]
    },
    observation_id: {
      name: "observation_id",
      purpose: "Uniquely identify one collection event for a market_identity_key.",
      fields: ["market_identity_key", "collected_at_jst", "collected_run_id", "source_phase", "collector_stage"],
      excludes: ["debug_artifact_path", "source_report_path", "source_csv_path"],
      formula: "sha256(market_identity_key|collected_at_jst_or_collected_run_id|source_phase|collector_stage)",
      notes: [
        "If a stable collected_run_id exists, prefer it over timestamp-only identity.",
        "For Booking v2 rows, observation_id should become the primary observation identity."
      ]
    },
    row_id_compatibility: {
      short_term_policy:
        "Keep v1 row_id readable and present for compatibility, but stop using it alone to decide whether repeated Booking observations are conflicts.",
      medium_term_policy:
        "In history v2, use observation_id as the primary row identity and market_identity_key as the grouping key.",
      evaluated_options: [
        "Option 1: keep row_id as current market identity and add observation_id.",
        "Option 2: redefine row_id as observation_id and add market_identity_key.",
        "Option 3: keep row_id for v1 compatibility, add observation_id and market_identity_key to derived rows and future v2."
      ]
    },
    market_value_hash: {
      name: "market_value_hash",
      purpose: "Detect market-value changes without being disturbed by debug/report metadata.",
      fields: [
        "availability_status",
        "sold_out_status",
        "normalized_total_price",
        "basis_confidence",
        "dp_usage",
        "source_primary_price",
        "source_secondary_price_or_adder",
        "source_computed_total",
        "source_tax_or_fee_classification",
        "source_classification",
        "warning_flags"
      ],
      excludes: ["debug_artifact_path", "source_report_path", "source_csv_path", "generated_at_jst", "normalized_at_jst"],
      formula:
        "sha256(availability_status|sold_out_status|normalized_total_price|basis_confidence|dp_usage|source_primary_price|source_secondary_price_or_adder|source_computed_total|source_tax_or_fee_classification|source_classification|warning_flags)",
      notes: [
        "Same market_value_hash under a later observation usually means no market movement was detected.",
        "Different market_value_hash under a later observation is the price/basis/availability movement the system should preserve."
      ]
    },
    observation_hash: {
      name: "observation_hash",
      purpose: "Detect exact duplicate normalized observations while excluding path churn.",
      fields: [
        "market_identity_key",
        "observation_id",
        "market_value_hash",
        "source",
        "canonical_property_name",
        "source_slug_or_code",
        "checkin",
        "checkout",
        "stay_scope",
        "collected_at_jst",
        "source_phase",
        "collector_stage",
        "schema_version"
      ],
      excludes: ["debug_artifact_path", "source_report_path", "source_csv_path", "generated_at_jst"],
      formula: "sha256(full_normalized_observation_excluding_debug_report_and_generated_paths)",
      notes: ["Use observation_hash with observation_id for idempotency of repeated append attempts."]
    }
  };
}

export function buildOptionComparison(): IdentityOption[] {
  return [
    {
      option: "A",
      title: "Keep current row_id conflict policy",
      summary: "same row_id plus different row_hash remains a blocking conflict.",
      pros: ["Maximum safety against accidental overwrite.", "No schema migration."],
      cons: ["Cannot store repeated same-day observations.", "Blocks legitimate Booking price movement.", "Not adequate for time-series market intelligence."],
      recommendation: "not_recommended"
    },
    {
      option: "B",
      title: "Redefine row_id to include collected_at_jst",
      summary: "row_id becomes the observation identity.",
      pros: ["Simple mental model.", "Allows repeated observations."],
      cons: ["Breaks backward compatibility.", "Requires a separate grouping key for latest market state."],
      recommendation: "recommended_medium_term"
    },
    {
      option: "C",
      title: "Add market_identity_key plus observation_id",
      summary: "Keep v1 row_id compatibility while adding market_identity_key for grouping and observation_id for observation events.",
      pros: ["Safe migration.", "Supports time-series price pressure.", "Supports latest-view and observation-history views.", "Minimal disruption to existing v1 history."],
      cons: ["Requires schema/view updates.", "Append preflight becomes more nuanced."],
      recommendation: "recommended_short_term"
    },
    {
      option: "D",
      title: "Metadata-only skip policy",
      summary: "Keep current row_id and skip conflicts only when market-value fields are unchanged.",
      pros: ["Low implementation cost.", "Resolves benign rerun/path churn."],
      cons: ["Still blocks price changes.", "Insufficient for Booking.com price movement tracking."],
      recommendation: "temporary_only"
    }
  ];
}

export function buildRecommendedPolicy(summary: CurrentProblemSummary): RecommendedPolicy {
  return {
    short_term:
      "Adopt Option C design: preserve v1 row_id compatibility, add derived market_identity_key and observation_id, and use B10Y field-difference logic for current conflicts.",
    medium_term:
      "Move Booking history v2 toward observation_id as the primary row identity and market_identity_key as the grouping key.",
    immediate_next_phase:
      "BOOKING-ID02X - implement derived identity helpers and conflict-classification utilities without migrating history.",
    then_phase:
      "BOOKING-B10Z - re-run B10X proposal with the new conflict policy after ID02X helpers exist.",
    b10z_expected_policy: {
      metadata_only_conflicts: `${summary.metadata_only_conflicts} metadata-only conflicts -> skip_benign_duplicate`,
      market_value_conflicts: `${summary.market_value_conflicts} market-value conflicts -> append_as_new_observation_after_identity_fix`,
      new_rows: "15 new rows -> append_new"
    },
    b11x_status: "B11X remains blocked until B10Z confirms zero unresolved conflicts under the new identity policy."
  };
}

export function buildConflictPolicyMatrix(): ConflictPolicyRule[] {
  return [
    {
      case: "same observation_id + same observation_hash",
      action: "skip_identical",
      reason: "Exact same observation event and normalized content already exists."
    },
    {
      case: "same observation_id + different observation_hash",
      action: "true_conflict",
      reason: "The same observation event was normalized differently and requires blocking review."
    },
    {
      case: "same market_identity_key + different observation_id + same market_value_hash",
      action: "append_new_observation_or_skip_by_policy",
      reason: "A later observation saw the same market value; retain if observation history is desired, otherwise skip as a benign duplicate."
    },
    {
      case: "same market_identity_key + different observation_id + different market_value_hash",
      action: "append_new_observation_price_changed",
      reason: "A later observation found price, basis, or availability movement and should be preserved as time-series evidence."
    },
    {
      case: "same current v1 row_id + different row_hash",
      action: "classify_with_b10y_field_comparison",
      reason: "Legacy v1 rows need field-level comparison to separate metadata-only changes from market-value movement."
    }
  ];
}

export function buildDbAiViewDesign(): DbAiViewDesign[] {
  return [
    {
      view_name: "v_ai_market_latest_observation",
      purpose: "Expose the latest observation per market_identity_key for AI market reports and pricing support context.",
      key_columns: ["market_identity_key", "observation_id", "collected_at_jst", "normalized_total_price", "market_value_hash", "basis_confidence", "dp_usage"],
      ai_context_usage: "latest observation"
    },
    {
      view_name: "v_ai_market_observation_history",
      purpose: "Expose all observations for a market_identity_key in collection order.",
      key_columns: ["market_identity_key", "observation_id", "collected_at_jst", "source_phase", "collector_stage", "observation_hash"],
      ai_context_usage: "previous observation and observation count"
    },
    {
      view_name: "v_ai_price_movement_by_market_identity",
      purpose: "Compare consecutive market_value_hash and price values for the same market_identity_key.",
      key_columns: ["market_identity_key", "current_observation_id", "previous_observation_id", "price_delta_jpy", "basis_delta", "market_value_changed"],
      ai_context_usage: "price delta and basis delta"
    },
    {
      view_name: "v_ai_booking_price_pressure_latest",
      purpose: "Expose Booking directional price pressure while keeping Booking dp_usable false and direct rows at zero.",
      key_columns: ["market_identity_key", "canonical_property_name", "checkin", "checkout", "normalized_total_price", "price_pressure_usable", "dp_usable"],
      ai_context_usage: "source confidence and directional price-pressure context"
    }
  ];
}

export function buildMigrationPlan(): MigrationStep[] {
  return [
    {
      step: 1,
      action: "Keep existing .data/history v1 rows unchanged.",
      rationale: "The current canonical history remains readable and auditable.",
      mutates_history_in_id01x: false,
      writes_db_in_id01x: false
    },
    {
      step: 2,
      action: "Derive market_identity_key, observation_id, market_value_hash, and observation_hash during future DB mirror sync or context-pack generation.",
      rationale: "Identity semantics can be tested without rewriting canonical history.",
      mutates_history_in_id01x: false,
      writes_db_in_id01x: false
    },
    {
      step: 3,
      action: "Introduce a v2 Booking append proposal format that carries both v1 row_id and new observation fields.",
      rationale: "B10Z can resolve B09X conflicts without immediate migration.",
      mutates_history_in_id01x: false,
      writes_db_in_id01x: false
    },
    {
      step: 4,
      action: "Once stable, propose either .data/history_v2 or a controlled new-column migration for canonical history.",
      rationale: "A separate approved migration phase can manage compatibility and rollback.",
      mutates_history_in_id01x: false,
      writes_db_in_id01x: false
    }
  ];
}

export function buildFuturePhasePlan(): FuturePhase[] {
  return [
    {
      phase: "BOOKING-ID02X",
      goal: "Implement derived identity helpers and conflict-classification utilities.",
      start_condition: "ID01X design is accepted."
    },
    {
      phase: "BOOKING-B10Z",
      goal: "Re-run bounded Booking append proposal using the new conflict policy.",
      start_condition: "ID02X utilities pass tests and remain proposal-only."
    },
    {
      phase: "BOOKING-B11X",
      goal: "Approved Booking bounded expanded history append after conflicts are resolved.",
      start_condition: "B10Z shows no unresolved conflicts and user provides explicit approval."
    },
    {
      phase: "AUTO-DB-VIEWS-ID",
      goal: "Design and implement DB/AI views for latest observations, observation history, and price movement.",
      start_condition: "Observation fields are available in DB mirror sync or derived context generation."
    }
  ];
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    history_modification: false,
    history_append: false,
    db_writes: false,
    db_schema_migration_execution: false,
    db_sync: false,
    ai_context_refresh: false,
    live_booking_fetch: false,
    playwright_used: false,
    collector_run: false,
    pms_beds24_airhost_ota_output: false,
    price_update: false,
    paid_source_tooling: false,
    booking_synthetic_multiplier: false,
    rakuten_restart: false,
    jalan_automation_start: false,
    started_next_phase: false
  };
}

export function decideBookingRowIdentityDesign(input: {
  b10yValid: boolean;
  problemSummary: CurrentProblemSummary;
  optionComparison: readonly IdentityOption[];
  identityModel: IdentityModel;
}): BookingRowIdentityDesignDecision {
  if (!input.b10yValid) return "booking_row_identity_design_not_ready";
  const recommendsC = input.optionComparison.some(
    (option) => option.option === "C" && option.recommendation === "recommended_short_term"
  );
  if (!recommendsC || input.problemSummary.total_conflicts !== 15 || !input.identityModel.observation_id.fields.includes("collected_at_jst")) {
    return "booking_row_identity_design_basis_caution";
  }
  return "booking_row_identity_design_ready";
}

export function renderIdentityCsv(input: {
  optionComparison: readonly IdentityOption[];
  conflictPolicyMatrix: readonly ConflictPolicyRule[];
}): string {
  const optionRows = input.optionComparison.map((option) =>
    ["option", option.option, option.title, option.summary, option.recommendation].map(csvEscape).join(",")
  );
  const matrixRows = input.conflictPolicyMatrix.map((rule) =>
    ["conflict_policy", rule.case, rule.action, rule.reason, ""].map(csvEscape).join(",")
  );
  return ["section,key,title_or_action,summary_or_reason,recommendation", ...optionRows, ...matrixRows].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: BookingRowIdentityDesignDecision;
  sourceB10yArtifactPath: string;
  currentProblemSummary: CurrentProblemSummary;
  identityModel: IdentityModel;
  optionComparison: readonly IdentityOption[];
  recommendedPolicy: RecommendedPolicy;
  conflictPolicyMatrix: readonly ConflictPolicyRule[];
  dbAiViewDesign: readonly DbAiViewDesign[];
  migrationPlan: readonly MigrationStep[];
  futurePhasePlan: readonly FuturePhase[];
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
}): string {
  return [
    "# Booking Row Identity / Observation Model Design",
    "",
    `Generated at JST: ${input.generatedAtJst}`,
    `Decision: ${input.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    "- Booking repeated observations need separate market_identity_key and observation_id fields.",
    `- B10Y found ${input.currentProblemSummary.market_value_conflicts} market-value conflicts and ${input.currentProblemSummary.metadata_only_conflicts} metadata-only conflicts.`,
    "- Recommended short-term policy is Option C: preserve v1 row_id compatibility while deriving observation keys.",
    "",
    "## 2. Current Problem",
    "",
    `- ${input.currentProblemSummary.current_row_id_behavior}`,
    `- ${input.currentProblemSummary.problem_statement}`,
    "",
    "## 3. Lessons from B10Y",
    "",
    `- total_conflicts=${input.currentProblemSummary.total_conflicts}`,
    `- price_changed=${input.currentProblemSummary.price_changed_conflicts}`,
    `- basis_changed=${input.currentProblemSummary.basis_changed_conflicts}`,
    `- metadata_only=${input.currentProblemSummary.metadata_only_conflicts}`,
    "",
    "## 4. Identity Concepts",
    "",
    `- market_identity_key fields: ${input.identityModel.market_identity_key.fields.join(", ")}`,
    `- market_identity_key excludes: ${input.identityModel.market_identity_key.excludes.join(", ")}`,
    `- observation_id fields: ${input.identityModel.observation_id.fields.join(", ")}`,
    `- market_value_hash fields: ${input.identityModel.market_value_hash.fields.join(", ")}`,
    `- observation_hash excludes: ${input.identityModel.observation_hash.excludes.join(", ")}`,
    "",
    "## 5. Option Comparison",
    "",
    ...input.optionComparison.map((option) => `- Option ${option.option}: ${option.title} - ${option.recommendation}`),
    "",
    "## 6. Recommended Identity Model",
    "",
    `- short_term=${input.recommendedPolicy.short_term}`,
    `- medium_term=${input.recommendedPolicy.medium_term}`,
    "",
    "## 7. Conflict Policy Matrix",
    "",
    ...input.conflictPolicyMatrix.map((rule) => `- ${rule.case}: ${rule.action}`),
    "",
    "## 8. DB / AI Context Impact",
    "",
    ...input.dbAiViewDesign.map((view) => `- ${view.view_name}: ${view.ai_context_usage}`),
    "",
    "## 9. Migration / Compatibility Plan",
    "",
    ...input.migrationPlan.map((step) => `- Step ${step.step}: ${step.action}`),
    "",
    "## 10. Future Phase Plan",
    "",
    ...input.futurePhasePlan.map((phase) => `- ${phase.phase}: ${phase.goal}`),
    "",
    "## 11. Safety Confirmation",
    "",
    "- Design only: no history modification, no DB write, no migration execution, no AI context refresh.",
    "- No live Booking fetch, no Playwright, no collector run, no PMS/Beds24/AirHost/OTA output.",
    "",
    "## 12. Decision",
    "",
    `- ${input.decision}`,
    "",
    "## 13. Next Step",
    "",
    "- Recommended next action: BOOKING-ID02X - Derived Identity Helpers + Conflict Policy Utilities.",
    "",
    "Artifacts:",
    "",
    `- report=${input.reportPath}`,
    `- json=${input.jsonPath}`,
    `- csv=${input.csvPath}`,
    `- debug=${input.debugPath}`,
    ""
  ].join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n]/u.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
