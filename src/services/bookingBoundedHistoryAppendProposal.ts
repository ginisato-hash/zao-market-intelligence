// Phase BOOKING-B10X — Booking bounded expanded history append proposal.
//
// Proposal-only preflight for B09X preview rows. Reads B09X output + current
// .data/history identity snapshot and proposes append_directional /
// append_excluded_audit actions. It writes no history, no DB, no AI context, and
// runs no live Booking/Playwright collection.

export type BookingB10XDecision =
  | "booking_bounded_history_append_proposal_ready"
  | "booking_bounded_history_append_proposal_basis_caution"
  | "booking_bounded_history_append_proposal_not_ready";

export type BookingB10XHistoryAction = "append_new" | "skip_identical" | "block_conflict";
export type BookingB10XAppendRecommendation = "append_directional" | "append_excluded_audit" | "block_until_review";

export interface B09XArtifactLike {
  decision: string;
  normalized_rows_summary?: {
    total_rows: number;
    directional_rows: number;
    excluded_rows: number;
    direct_rows: number;
  };
  schema_compatibility_summary?: {
    compatible: boolean;
    schema_version: string;
  };
  normalized_rows_preview: B09XPreviewRow[];
}

export interface B09XPreviewRow {
  row_id: string;
  row_hash: string;
  shard_month: string;
  collected_date_jst: string;
  source: "booking";
  canonical_property_name: string;
  source_property_id: string;
  source_slug_or_code: string;
  checkin: string;
  checkout: string;
  checkin_date?: string;
  checkout_date?: string;
  stay_scope: string;
  availability_status: string;
  sold_out_flag: number | null;
  normalized_total_price: number | null;
  normalized_total_jpy?: number | null;
  basis_confidence: string;
  source_primary_price: number | null;
  source_secondary_price_or_adder: number | null;
  source_computed_total: number | null;
  classification: string;
  dp_usage: string;
  exclusion_reason: string;
  price_pressure_usable: boolean;
  dp_usable: boolean;
  schema_version: string;
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

export interface ProposalRow {
  row_id: string;
  row_hash: string;
  canonical_property_name: string;
  source: "booking";
  booking_slug: string;
  checkin_date: string;
  checkout_date: string;
  stay_scope: string;
  availability_status: string;
  sold_out_flag: number | null;
  normalized_total_jpy: number | null;
  primary_price_numeric: number | null;
  official_tax_fee_adder_numeric: number | null;
  computed_total_with_tax_fee: number | null;
  basis_confidence: string;
  dp_usage: string;
  classification: string;
  exclusion_reason: string;
  shard_month: string;
  history_action: BookingB10XHistoryAction;
  price_pressure_usable: boolean;
  dp_usable: false;
  append_recommendation: BookingB10XAppendRecommendation;
  reason: string;
}

export interface PreflightSummary {
  existing_history_row_count: number;
  proposal_row_count: number;
  append_new_count: number;
  skip_identical_count: number;
  conflict_count: number;
  append_directional_count: number;
  append_excluded_audit_count: number;
  direct_count: 0;
  expected_total_after_append: number;
  conflict_row_ids: string[];
}

export interface TouchedShardPlan {
  touched_shards: string[];
  rows_by_shard: Record<string, number>;
  existing_rows_by_shard: Record<string, number>;
  expected_rows_by_shard_after_append: Record<string, number>;
}

export const B10X_ALLOWED_B09X_DECISIONS = new Set([
  "booking_bounded_expanded_collection_ready",
  "booking_bounded_expanded_collection_basis_caution"
]);

export function validateB09XArtifact(input: B09XArtifactLike): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!B10X_ALLOWED_B09X_DECISIONS.has(input.decision)) reasons.push("b09x_decision_not_ready");
  if (!Array.isArray(input.normalized_rows_preview)) reasons.push("missing_normalized_rows_preview");
  if ((input.normalized_rows_preview ?? []).length !== 30) reasons.push("unexpected_preview_row_count");
  if (input.schema_compatibility_summary && input.schema_compatibility_summary.compatible !== true) {
    reasons.push("schema_compatibility_failed");
  }
  const rows = input.normalized_rows_preview ?? [];
  if (rows.filter((row) => row.dp_usage === "directional").length !== 28) reasons.push("unexpected_directional_count");
  if (rows.filter((row) => row.dp_usage === "excluded").length !== 2) reasons.push("unexpected_excluded_count");
  if (rows.some((row) => row.dp_usage === "direct" || row.dp_usable === true)) reasons.push("booking_direct_or_dp_usable_detected");
  if (rows.some((row) => row.schema_version !== "zao_local_history_v1")) reasons.push("schema_version_mismatch");
  return { valid: reasons.length === 0, reasons };
}

export function buildProposalRows(rows: readonly B09XPreviewRow[], existingKeys: readonly ExistingHistoryKey[]): ProposalRow[] {
  const existing = new Map<string, string>();
  for (const key of existingKeys) existing.set(`${key.shard_month}::${key.row_id}`, key.row_hash);

  return rows.map((row) => {
    const historyAction = resolveHistoryAction(row, existing);
    const policy = classifyRow(row);
    const appendRecommendation =
      historyAction === "block_conflict" ? "block_until_review" : policy.append_recommendation;
    const reason =
      historyAction === "block_conflict"
        ? "row_id already exists in the same shard with a different row_hash; append must be blocked until reviewed."
        : historyAction === "skip_identical"
          ? "row_id and row_hash already exist; future append should skip identical row."
          : policy.reason;

    return {
      row_id: row.row_id,
      row_hash: row.row_hash,
      canonical_property_name: row.canonical_property_name,
      source: "booking",
      booking_slug: row.source_slug_or_code || row.source_property_id,
      checkin_date: row.checkin_date ?? row.checkin,
      checkout_date: row.checkout_date ?? row.checkout,
      stay_scope: row.stay_scope,
      availability_status: row.availability_status,
      sold_out_flag: row.sold_out_flag,
      normalized_total_jpy: row.normalized_total_jpy ?? row.normalized_total_price,
      primary_price_numeric: row.source_primary_price,
      official_tax_fee_adder_numeric: row.source_secondary_price_or_adder,
      computed_total_with_tax_fee: row.source_computed_total,
      basis_confidence: row.basis_confidence,
      dp_usage: row.dp_usage,
      classification: row.classification,
      exclusion_reason: row.exclusion_reason,
      shard_month: row.shard_month,
      history_action: historyAction,
      price_pressure_usable: policy.price_pressure_usable,
      dp_usable: false,
      append_recommendation: appendRecommendation,
      reason
    };
  });
}

function resolveHistoryAction(row: B09XPreviewRow, existing: Map<string, string>): BookingB10XHistoryAction {
  const existingHash = existing.get(`${row.shard_month}::${row.row_id}`);
  if (existingHash === undefined) return "append_new";
  if (existingHash === row.row_hash) return "skip_identical";
  return "block_conflict";
}

function classifyRow(row: B09XPreviewRow): {
  price_pressure_usable: boolean;
  append_recommendation: BookingB10XAppendRecommendation;
  reason: string;
} {
  if (
    row.basis_confidence === "B" &&
    row.dp_usage === "directional" &&
    row.normalized_total_price !== null &&
    row.price_pressure_usable === true &&
    row.dp_usable === false
  ) {
    return {
      price_pressure_usable: true,
      append_recommendation: "append_directional",
      reason:
        "B-confidence Booking official-total row; append as directional price-pressure evidence only, with dp_usable=false."
    };
  }
  if (row.basis_confidence === "C" && row.dp_usage === "excluded" && row.dp_usable === false) {
    return {
      price_pressure_usable: false,
      append_recommendation: "append_excluded_audit",
      reason: "C-confidence Booking excluded row; append as excluded audit evidence only."
    };
  }
  return {
    price_pressure_usable: false,
    append_recommendation: "block_until_review",
    reason: "Row does not match B10X Booking append policy."
  };
}

export function computePreflight(rows: readonly ProposalRow[], currentHistory: CurrentHistorySummary): PreflightSummary {
  const appendNew = rows.filter((row) => row.history_action === "append_new");
  const conflicts = rows.filter((row) => row.history_action === "block_conflict");
  return {
    existing_history_row_count: currentHistory.total_rows,
    proposal_row_count: rows.length,
    append_new_count: appendNew.length,
    skip_identical_count: rows.filter((row) => row.history_action === "skip_identical").length,
    conflict_count: conflicts.length,
    append_directional_count: appendNew.filter((row) => row.append_recommendation === "append_directional").length,
    append_excluded_audit_count: appendNew.filter((row) => row.append_recommendation === "append_excluded_audit").length,
    direct_count: 0,
    expected_total_after_append: currentHistory.total_rows + appendNew.length,
    conflict_row_ids: conflicts.map((row) => row.row_id)
  };
}

export function computeTouchedShards(rows: readonly ProposalRow[], currentHistory: CurrentHistorySummary): TouchedShardPlan {
  const appendable = rows.filter((row) => row.history_action === "append_new");
  const rowsByShard = countBy(appendable.map((row) => row.shard_month));
  const expected = { ...currentHistory.rows_by_shard };
  for (const [shard, count] of Object.entries(rowsByShard)) expected[shard] = (expected[shard] ?? 0) + count;
  return {
    touched_shards: Object.keys(rowsByShard).sort(),
    rows_by_shard: rowsByShard,
    existing_rows_by_shard: currentHistory.rows_by_shard,
    expected_rows_by_shard_after_append: expected
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
    forbidden_rule: "primary_price_numeric * 1.1",
    booking_direct_rows_allowed: 0,
    pms_ota_price_action_allowed: false
  };
}

export function buildFutureB11XPlan() {
  return {
    phase: "BOOKING-B11X — Approved Booking bounded expanded history append",
    approval_gate: {
      explicit_approval_sentence:
        "Approve Phase BOOKING-B11X Booking bounded expanded history append. You may append the approved B10X Booking rows to .data/history.",
      env_flag: "BOOKING_BOUNDED_HISTORY_APPEND=1"
    },
    steps: [
      "Load B10X proposal.",
      "Fail closed without BOOKING_BOUNDED_HISTORY_APPEND=1.",
      "Back up touched shards.",
      "Write temp files only after conflict preflight passes.",
      "Validate row count, row_hash, schema_version, and shard_month.",
      "Atomic rename validated shard files.",
      "Roll back from backups on failure.",
      "Do not sync DB in B11X.",
      "Do not refresh AI context in B11X."
    ],
    not_executed_in_b10x: true
  };
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

export function decideB10X(input: {
  artifactValid: boolean;
  preflight: PreflightSummary;
  proposalRows: readonly ProposalRow[];
}): BookingB10XDecision {
  if (!input.artifactValid) return "booking_bounded_history_append_proposal_not_ready";
  if (input.preflight.conflict_count > 0) return "booking_bounded_history_append_proposal_not_ready";
  if (input.preflight.append_new_count === 0) return "booking_bounded_history_append_proposal_basis_caution";
  if (input.proposalRows.some((row) => row.append_recommendation === "append_excluded_audit" || row.history_action === "skip_identical")) {
    return "booking_bounded_history_append_proposal_basis_caution";
  }
  return "booking_bounded_history_append_proposal_ready";
}

export const B10X_CSV_HEADERS = [
  "row_id",
  "row_hash",
  "canonical_property_name",
  "source",
  "booking_slug",
  "checkin_date",
  "checkout_date",
  "stay_scope",
  "availability_status",
  "sold_out_flag",
  "normalized_total_jpy",
  "primary_price_numeric",
  "official_tax_fee_adder_numeric",
  "computed_total_with_tax_fee",
  "basis_confidence",
  "dp_usage",
  "classification",
  "exclusion_reason",
  "shard_month",
  "history_action",
  "price_pressure_usable",
  "dp_usable",
  "append_recommendation",
  "reason"
] as const;

export function renderProposalCsv(rows: readonly ProposalRow[]): string {
  const body = rows.map((row) =>
    [
      row.row_id,
      row.row_hash,
      row.canonical_property_name,
      row.source,
      row.booking_slug,
      row.checkin_date,
      row.checkout_date,
      row.stay_scope,
      row.availability_status,
      value(row.sold_out_flag),
      value(row.normalized_total_jpy),
      value(row.primary_price_numeric),
      value(row.official_tax_fee_adder_numeric),
      value(row.computed_total_with_tax_fee),
      row.basis_confidence,
      row.dp_usage,
      row.classification,
      row.exclusion_reason,
      row.shard_month,
      row.history_action,
      String(row.price_pressure_usable),
      String(row.dp_usable),
      row.append_recommendation,
      row.reason
    ]
      .map(csvEscape)
      .join(",")
  );
  return [B10X_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderProposalReport(input: {
  generatedAtJst: string;
  runId: string;
  decision: BookingB10XDecision;
  sourceB09xArtifactPath: string;
  currentHistorySummary: CurrentHistorySummary;
  proposalRows: readonly ProposalRow[];
  preflightSummary: PreflightSummary;
  touchedShards: TouchedShardPlan;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
}): string {
  const p = input.preflightSummary;
  return [
    "# Booking Bounded Expanded History Append Proposal",
    "",
    `Generated at JST: ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Executive Summary",
    "",
    `- decision=${input.decision}`,
    `- proposal_rows=${input.proposalRows.length}`,
    `- append_new=${p.append_new_count}`,
    `- skip_identical=${p.skip_identical_count}`,
    `- conflicts=${p.conflict_count}`,
    "",
    "## 2. Source B09X Collection",
    "",
    `- source_b09x_artifact=${input.sourceB09xArtifactPath}`,
    "- B09X rows are preview-only and are not appended by this proposal.",
    "",
    "## 3. Current History State",
    "",
    `- total_rows=${input.currentHistorySummary.total_rows}`,
    `- rows_by_shard=${JSON.stringify(input.currentHistorySummary.rows_by_shard)}`,
    "",
    "## 4. Proposal Row Summary",
    "",
    `- append_directional=${p.append_directional_count}`,
    `- append_excluded_audit=${p.append_excluded_audit_count}`,
    "- direct=0",
    "",
    "## 5. Dedupe / Conflict Preflight",
    "",
    `- append_new=${p.append_new_count}`,
    `- skip_identical=${p.skip_identical_count}`,
    `- block_conflict=${p.conflict_count}`,
    `- expected_total_after_append=${p.expected_total_after_append}`,
    "",
    "## 6. Touched Shards",
    "",
    `- touched_shards=${JSON.stringify(input.touchedShards.touched_shards)}`,
    `- rows_by_shard=${JSON.stringify(input.touchedShards.rows_by_shard)}`,
    `- expected_rows_by_shard_after_append=${JSON.stringify(input.touchedShards.expected_rows_by_shard_after_append)}`,
    "",
    "## 7. Price Pressure Policy",
    "",
    "- Valid B-confidence Booking rows are append_directional, price_pressure_usable=true, dp_usable=false.",
    "- C-confidence Booking rows are append_excluded_audit, price_pressure_usable=false, dp_usable=false.",
    "- Booking direct rows remain zero. No PMS/Beds24/AirHost/OTA price action is allowed.",
    "- No Booking base x 1.1 calculation is used or proposed.",
    "",
    "## 8. Future B11X Plan",
    "",
    "- Future real append phase requires the exact B11X approval sentence and BOOKING_BOUNDED_HISTORY_APPEND=1.",
    "- B11X must back up touched shards, write temp files, validate, atomic rename, and roll back on failure.",
    "- B11X must not sync DB or refresh AI context.",
    "",
    "## 9. Safety Confirmation",
    "",
    "- Proposal only: no history append, no DB writes, no AI context refresh.",
    "- No live Booking fetch, no Playwright, no Booking search scraping.",
    "- No paid APIs/proxies, no CAPTCHA bypass, no stealth/login/cookies.",
    "",
    "## 10. Decision",
    "",
    `- ${input.decision}`,
    "",
    "## 11. Next Step",
    "",
    "- BOOKING-B11X — Approved Booking bounded expanded history append. Do not start without explicit instruction.",
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

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function csvEscape(v: string): string {
  if (/[",\n\r]/u.test(v)) return `"${v.replace(/"/gu, "\"\"")}"`;
  return v;
}

function value(v: string | number | boolean | null): string {
  return v === null ? "" : String(v);
}
