// Phase BOOKING-B06X — Booking Normalized History Append Proposal (pure).
//
// PROPOSAL ONLY. This module is a pure, read-only transformation layer. It takes
// the B05X normalized Booking row previews + a snapshot of the existing
// .data/history row identities and produces an APPEND PROPOSAL: which rows are
// directional price-pressure signals, which are excluded audit signals, what the
// per-row history_action would be (append_new / skip_identical / block_conflict),
// which shards would be touched, and what a future approved B07X append should do.
//
// This module MUTATES NOTHING: no history append, no DB write, no AI context
// refresh, no live Booking fetch, no Playwright, no PMS/Beds24/AirHost output,
// no price update, no Booking base × 1.1. Totals are carried verbatim from B05X
// (official base + visible adder); B06X never recomputes a price.

import { buildRowId } from "./localHistorySchemaDesign";

export const BOOKING_B06X_PHASE = "B06X";
export const BOOKING_B06X_PRICE_POLICY_VERSION = "booking_official_visible_adder_v1";
export const BOOKING_B06X_SCHEMA_VERSION = "zao_local_history_v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type B06XDecision =
  | "booking_history_append_proposal_ready"
  | "booking_history_append_proposal_basis_caution"
  | "booking_history_append_proposal_not_ready";

export type HistoryAction =
  | "append_new"
  | "skip_identical"
  | "block_conflict"
  | "exclude_from_append";

export type AppendRecommendation =
  | "append_directional"
  | "append_excluded_audit"
  | "do_not_append"
  | "block_until_review";

// Subset of the B05X normalized row preview consumed here (the shape that lands
// in the B05X JSON `rows[]`).
export interface B05XInputRow {
  row_id: string;
  row_hash: string;
  shard_month: string;
  schema_version: string;
  collected_date_jst: string;
  source: string;
  canonical_property_name: string;
  source_property_id: string;
  source_slug_or_code: string;
  checkin_date: string;
  checkout_date: string;
  stay_scope: string;
  availability_status: string;
  sold_out_flag: number;
  normalized_total_jpy: number | null;
  basis_confidence: string;
  source_primary_price: number | null;
  source_official_tax_fee_adder: number | null;
  source_computed_total_with_tax_fee: number | null;
  classification: string;
  dp_usage: string;
  exclusion_reason: string;
}

// A minimal identity snapshot of an existing .data/history row.
export interface ExistingHistoryKey {
  row_id: string;
  row_hash: string;
  shard_month: string;
}

export interface ProposalRow {
  row_id: string;
  row_hash: string;
  canonical_property_name: string;
  source: string;
  booking_slug: string;
  checkin_date: string;
  checkout_date: string;
  stay_scope: string;
  availability_status: string;
  sold_out_flag: number;
  normalized_total_jpy: number | null;
  primary_price_numeric: number | null;
  official_tax_fee_adder_numeric: number | null;
  computed_total_with_tax_fee: number | null;
  basis_confidence: string;
  dp_usage: string;
  classification: string;
  exclusion_reason: string;
  shard_month: string;
  history_action: HistoryAction;
  price_pressure_usable: boolean;
  dp_usable: boolean;
  append_recommendation: AppendRecommendation;
  reason: string;
}

// ---------------------------------------------------------------------------
// Row identity helper (genuine re-derivation for validation)
// ---------------------------------------------------------------------------

// Re-derive the canonical row_id from a B05X row's identity fields. Used to
// validate that the carried-forward row_id matches the canonical helper.
export function deriveRowId(input: B05XInputRow): string {
  return buildRowId({
    collectedDateJst: input.collected_date_jst,
    source: input.source,
    canonicalPropertyName: input.canonical_property_name,
    sourceSlugOrCode: input.source_slug_or_code,
    sourcePropertyId: input.source_property_id,
    checkin: input.checkin_date,
    checkout: input.checkout_date,
    stayScope: input.stay_scope
  });
}

// ---------------------------------------------------------------------------
// Per-row classification (price-pressure policy)
// ---------------------------------------------------------------------------

interface RowClassification {
  price_pressure_usable: boolean;
  dp_usable: boolean;
  append_recommendation: AppendRecommendation;
  reason: string;
}

// 4.1 directional priced row | 4.2 excluded audit row | 4.3 never direct.
export function classifyProposalRow(input: B05XInputRow): RowClassification {
  const isDirectionalPriced =
    input.basis_confidence === "B" &&
    input.dp_usage === "directional" &&
    input.source_computed_total_with_tax_fee !== null;

  if (isDirectionalPriced) {
    return {
      price_pressure_usable: true,
      dp_usable: false,
      append_recommendation: "append_directional",
      reason:
        "B-confidence directional row with official base+visible-adder total; usable for market price-pressure scoring only, never for unattended DP / PMS price update."
    };
  }

  const isExcludedAudit =
    input.basis_confidence === "C" &&
    input.dp_usage === "excluded" &&
    input.exclusion_reason === "missing_official_tax_fee_adder";

  if (isExcludedAudit) {
    return {
      price_pressure_usable: false,
      dp_usable: false,
      append_recommendation: "append_excluded_audit",
      reason:
        "C-confidence excluded row (missing_official_tax_fee_adder); appended as an audit signal only, with null total and no price-pressure contribution."
    };
  }

  // Defensive: any Booking row that is neither a clean directional priced row
  // nor a recognized excluded-audit row is held back for human review.
  return {
    price_pressure_usable: false,
    dp_usable: false,
    append_recommendation: "block_until_review",
    reason:
      "Row does not match the B-directional or C-excluded-audit pattern; held back until manually reviewed."
  };
}

// ---------------------------------------------------------------------------
// Preflight (append simulation vs existing history)
// ---------------------------------------------------------------------------

export interface PreflightSummary {
  existing_history_row_count: number;
  proposed_append_row_count: number;
  directional_append_count: number;
  excluded_append_count: number;
  new_row_count: number;
  skip_identical_count: number;
  conflict_count: number;
  touched_shards: string[];
  expected_total_after_append: number;
}

// Decide a row's history_action by comparing (shard_month, row_id, row_hash)
// against the existing-history snapshot. Mirrors M03X simulateAppend semantics:
//   new row_id                       -> append_new
//   same row_id + same row_hash      -> skip_identical
//   same row_id + different row_hash -> block_conflict
function resolveHistoryAction(row: B05XInputRow, existingByKey: Map<string, string>): HistoryAction {
  const key = `${row.shard_month}::${row.row_id}`;
  const existingHash = existingByKey.get(key);
  if (existingHash === undefined) return "append_new";
  if (existingHash === row.row_hash) return "skip_identical";
  return "block_conflict";
}

export function buildProposalRows(
  inputs: B05XInputRow[],
  existingKeys: ExistingHistoryKey[]
): ProposalRow[] {
  const existingByKey = new Map<string, string>();
  for (const k of existingKeys) existingByKey.set(`${k.shard_month}::${k.row_id}`, k.row_hash);

  return inputs.map((input) => {
    const cls = classifyProposalRow(input);
    const historyAction = resolveHistoryAction(input, existingByKey);
    // A conflict overrides the append recommendation: never silently overwrite.
    const appendRecommendation: AppendRecommendation =
      historyAction === "block_conflict" ? "block_until_review" : cls.append_recommendation;
    const reason =
      historyAction === "block_conflict"
        ? "row_id already present with a different row_hash; blocked until the conflict is manually reviewed."
        : historyAction === "skip_identical"
          ? "row_id+row_hash already present; identical row would be skipped on append."
          : cls.reason;

    return {
      row_id: input.row_id,
      row_hash: input.row_hash,
      canonical_property_name: input.canonical_property_name,
      source: input.source,
      booking_slug: input.source_slug_or_code || input.source_property_id,
      checkin_date: input.checkin_date,
      checkout_date: input.checkout_date,
      stay_scope: input.stay_scope,
      availability_status: input.availability_status,
      sold_out_flag: input.sold_out_flag,
      normalized_total_jpy: input.normalized_total_jpy,
      primary_price_numeric: input.source_primary_price,
      official_tax_fee_adder_numeric: input.source_official_tax_fee_adder,
      computed_total_with_tax_fee: input.source_computed_total_with_tax_fee,
      basis_confidence: input.basis_confidence,
      dp_usage: input.dp_usage,
      classification: input.classification,
      exclusion_reason: input.exclusion_reason,
      shard_month: input.shard_month,
      history_action: historyAction,
      price_pressure_usable: cls.price_pressure_usable,
      dp_usable: cls.dp_usable,
      append_recommendation: appendRecommendation,
      reason
    };
  });
}

export function computePreflight(rows: ProposalRow[], existingHistoryRowCount: number): PreflightSummary {
  const newRows = rows.filter((r) => r.history_action === "append_new");
  const skipIdentical = rows.filter((r) => r.history_action === "skip_identical");
  const conflicts = rows.filter((r) => r.history_action === "block_conflict");

  const directionalAppend = newRows.filter((r) => r.append_recommendation === "append_directional");
  const excludedAppend = newRows.filter((r) => r.append_recommendation === "append_excluded_audit");

  const touched = Array.from(new Set(newRows.map((r) => r.shard_month))).sort();

  const proposedAppend = newRows.length;

  return {
    existing_history_row_count: existingHistoryRowCount,
    proposed_append_row_count: proposedAppend,
    directional_append_count: directionalAppend.length,
    excluded_append_count: excludedAppend.length,
    new_row_count: newRows.length,
    skip_identical_count: skipIdentical.length,
    conflict_count: conflicts.length,
    touched_shards: touched,
    expected_total_after_append: existingHistoryRowCount + proposedAppend
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideB06X(preflight: PreflightSummary): B06XDecision {
  if (preflight.conflict_count > 0) return "booking_history_append_proposal_basis_caution";
  if (preflight.proposed_append_row_count === 0) return "booking_history_append_proposal_not_ready";
  if (preflight.directional_append_count < 1) return "booking_history_append_proposal_not_ready";
  return "booking_history_append_proposal_ready";
}

// ---------------------------------------------------------------------------
// Future B07X plan (produced, NOT executed)
// ---------------------------------------------------------------------------

export interface FutureB07XPlan {
  phase: string;
  approval_gate: {
    explicit_approval_sentence: string;
    env_flag: string;
  };
  append_steps: string[];
  validations: string[];
  refresh_phase_steps: string[];
  not_executed_in_b06x: true;
}

export function buildFutureB07XPlan(): FutureB07XPlan {
  return {
    phase: "BOOKING-B07X — Approved Booking normalized history append",
    approval_gate: {
      explicit_approval_sentence:
        "I approve appending the B06X Booking normalized rows to .data/history (Phase BOOKING-B07X).",
      env_flag: "BOOKING_HISTORY_APPEND=1"
    },
    append_steps: [
      "Require the exact explicit approval sentence AND env flag BOOKING_HISTORY_APPEND=1 before any write.",
      "Read this B06X proposal artifact (JSON) as the source of approved rows.",
      "Back up every touched shard before modifying it (.data/history/.backup/<timestamp>).",
      "Append only rows whose history_action=append_new and append_recommendation in {append_directional, append_excluded_audit}.",
      "Skip rows with history_action=skip_identical; abort the whole append if any history_action=block_conflict.",
      "Use temp-file write + post-validate + atomic rename; rollback on any failure."
    ],
    validations: [
      "Validate row_id, row_hash, schema_version=zao_local_history_v1, and shard_month for every appended row.",
      "Validate basis_confidence=B rows are directional and basis_confidence=C rows are excluded.",
      "Set price_pressure_usable=true ONLY for rows with a valid official base+visible-adder total.",
      "Keep dp_usable=false for ALL Booking rows in this phase (no direct, no unattended DP).",
      "No Booking base × 1.1; totals are carried verbatim from B05X."
    ],
    refresh_phase_steps: [
      "SEPARATE, explicitly-scoped step: run history-to-DB sync (HISTORY_TO_DB_SYNC=1) to mirror appended rows.",
      "SEPARATE step: rebuild AI context packs from the DB mirror.",
      "SEPARATE step: run a query smoke test and verify directional rows feed price-pressure while excluded rows do not.",
      "No DB write, no AI context refresh, and no GitHub Actions/cron are enabled unless each is explicitly approved."
    ],
    not_executed_in_b06x: true
  };
}

// ---------------------------------------------------------------------------
// CSV / report rendering
// ---------------------------------------------------------------------------

export const PROPOSAL_CSV_HEADERS = [
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

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

function numOrEmpty(n: number | null): string {
  return n === null ? "" : String(n);
}

export function renderProposalCsv(rows: ProposalRow[]): string {
  const body = rows.map((r) =>
    [
      r.row_id,
      r.row_hash,
      r.canonical_property_name,
      r.source,
      r.booking_slug,
      r.checkin_date,
      r.checkout_date,
      r.stay_scope,
      r.availability_status,
      String(r.sold_out_flag),
      numOrEmpty(r.normalized_total_jpy),
      numOrEmpty(r.primary_price_numeric),
      numOrEmpty(r.official_tax_fee_adder_numeric),
      numOrEmpty(r.computed_total_with_tax_fee),
      r.basis_confidence,
      r.dp_usage,
      r.classification,
      r.exclusion_reason,
      r.shard_month,
      r.history_action,
      String(r.price_pressure_usable),
      String(r.dp_usable),
      r.append_recommendation,
      r.reason
    ]
      .map(csvEscape)
      .join(",")
  );
  return [PROPOSAL_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export interface ProposalReportInput {
  generatedAtJst: string;
  runId: string;
  decision: B06XDecision;
  sourceB05XJsonPath: string;
  preflight: PreflightSummary;
  rows: ProposalRow[];
  futurePlan: FutureB07XPlan;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

export function recommendedNextActionForB06X(decision: B06XDecision): string {
  if (decision === "booking_history_append_proposal_ready") {
    return "- Proposal is clean (zero conflicts, directional rows present). The next likely phase is BOOKING-B07X (Approved Booking normalized history append). Do NOT start B07X without the exact explicit approval sentence + BOOKING_HISTORY_APPEND=1.";
  }
  if (decision === "booking_history_append_proposal_basis_caution") {
    return "- One or more row_id conflicts (same row_id, different row_hash) were detected. Resolve the conflicting row(s) before proposing an append. Do NOT append.";
  }
  return "- No rows are eligible for append (or no directional rows present). Re-run B05X collection before proposing an append. Do NOT append.";
}

export function renderProposalReport(input: ProposalReportInput): string {
  const p = input.preflight;
  return [
    "# Booking Normalized History Append Proposal (Phase BOOKING-B06X)",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Policy & safety",
    "",
    "- B06X is PROPOSAL ONLY: no history append, no DB write, no AI context refresh, no live Booking probe, no Playwright.",
    "- Totals are carried verbatim from B05X (official base + visible adder). No Booking base × 1.1.",
    "- Booking rows are directional or excluded-audit only; dp_usable=false for ALL rows (direct=0).",
    "- No PMS/Beds24/AirHost/OTA output, no price update, no GitHub Actions/cron, no paid sources.",
    "",
    "## 2. Decision",
    "",
    `- decision=${input.decision}`,
    "",
    "## 3. Source B05X artifact",
    "",
    `- source_b05x_json=${input.sourceB05XJsonPath}`,
    `- price_policy_version=${BOOKING_B06X_PRICE_POLICY_VERSION}`,
    `- schema_version=${BOOKING_B06X_SCHEMA_VERSION}`,
    "",
    "## 4. Preflight summary",
    "",
    `- existing_history_row_count=${p.existing_history_row_count}`,
    `- proposed_append_row_count=${p.proposed_append_row_count}`,
    `- directional_append_count=${p.directional_append_count}`,
    `- excluded_append_count=${p.excluded_append_count}`,
    `- new_row_count=${p.new_row_count}`,
    `- skip_identical_count=${p.skip_identical_count}`,
    `- conflict_count=${p.conflict_count}`,
    `- touched_shards=${JSON.stringify(p.touched_shards)}`,
    `- expected_total_after_append=${p.expected_total_after_append}`,
    "",
    "## 5. Price-pressure policy",
    "",
    "- append_directional (B / directional / official total present): price_pressure_usable=true, dp_usable=false.",
    "  Usable for market price-pressure scoring, comparison, inbound directional signal, AI reports, human pricing support.",
    "  MUST NOT be used for automatic PMS/Beds24/AirHost price update, direct price overwrite, or unattended DP action.",
    "- append_excluded_audit (C / excluded / missing_official_tax_fee_adder): price_pressure_usable=false, dp_usable=false.",
    "  Appended as an audit signal only; contributes no price-pressure value.",
    "- direct=0 for all Booking rows in this phase.",
    "",
    "## 6. Proposal rows",
    "",
    "| canonical_property | checkin | shard | total | conf | dp_usage | history_action | pp_usable | dp_usable | recommendation |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...input.rows.map(
      (r) =>
        `| ${r.canonical_property_name} | ${r.checkin_date} | ${r.shard_month} | ${numOrEmpty(r.normalized_total_jpy)} | ${r.basis_confidence} | ${r.dp_usage} | ${r.history_action} | ${r.price_pressure_usable} | ${r.dp_usable} | ${r.append_recommendation} |`
    ),
    "",
    "## 7. Future B07X plan (produced, NOT executed)",
    "",
    `- phase=${input.futurePlan.phase}`,
    `- explicit_approval_sentence="${input.futurePlan.approval_gate.explicit_approval_sentence}"`,
    `- env_flag=${input.futurePlan.approval_gate.env_flag}`,
    "- append_steps:",
    ...input.futurePlan.append_steps.map((s) => `  - ${s}`),
    "- validations:",
    ...input.futurePlan.validations.map((s) => `  - ${s}`),
    "- refresh_phase_steps:",
    ...input.futurePlan.refresh_phase_steps.map((s) => `  - ${s}`),
    "",
    "## 8. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 9. Recommended next action",
    "",
    recommendedNextActionForB06X(input.decision),
    ""
  ].join("\n");
}
