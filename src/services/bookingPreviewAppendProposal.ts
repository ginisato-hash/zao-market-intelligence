// Phase AUTO-RUNNER08Y - Booking preview history append proposal (proposal-only).
//
// Reviews AUTO-RUNNER08X preview rows and proposes future local-history append
// actions. This module performs no live collection, no history append, no DB
// write/sync, no AI context refresh, and no pricing/PMS output.

import {
  buildRowHash,
  buildRowId,
  futureShardPath,
  HISTORY_SCHEMA_VERSION,
  shardMonthFromCheckin,
  type HistoryRow
} from "./localHistorySchemaDesign";
import { type PreviewRow } from "./autoRunnerBookingPreview";
import { roomBasisDpExclusionReason } from "./roomBasisClassification";

export type BookingPreviewAppendDecision =
  | "booking_preview_append_proposal_ready"
  | "booking_preview_append_proposal_basis_caution"
  | "booking_preview_append_proposal_not_ready";

export type BookingPreviewAppendAction =
  | "append_directional"
  | "skip_identical"
  | "block_conflict"
  | "manual_review"
  | "exclude_audit";

export interface ExistingHistoryKey {
  row_id: string;
  row_hash: string;
  shard_month: string;
  source?: string;
}

export interface CurrentHistorySummary {
  total_rows: number;
  booking_rows: number;
  jalan_rows: number;
  rakuten_rows: number;
  duplicate_row_id_count: number;
  rows_by_shard: Record<string, number>;
  source_files: string[];
}

export interface BookingPreviewReviewRow {
  source: string;
  property_slug: string;
  canonical_property_name: string;
  checkin: string;
  checkout: string;
  stay_scope: string;
  preview_classification: string;
  append_action: BookingPreviewAppendAction;
  price_policy: "booking_directional_visible_price_only" | "not_appendable";
  dp_usage: "directional" | "excluded";
  price_pressure_usable: boolean;
  direct_pricing_usable: false;
  basis_confidence: "B" | "insufficient";
  basis_note: string;
  normalized_total_price: number | null;
  source_primary_price: number | null;
  official_tax_fee_adder_numeric: number | null;
  computed_total_with_tax_fee: number | null;
  screenshot_path: string;
  debug_path: string;
  row_id: string;
  row_hash: string;
  shard_month: string;
  existing_row_hash: string;
  manual_review_reasons: string[];
  reason: string;
  proposed_history_row: HistoryRow;
}

export interface AppendActionSummary {
  total_preview_rows: number;
  booking_rows: number;
  non_booking_rows: number;
  append_directional: number;
  skip_identical: number;
  block_conflict: number;
  manual_review: number;
  exclude_audit: number;
  direct_rows: 0;
  conflicts: number;
  expected_total_after_append_if_approved: number;
  touched_shards: string[];
  action_breakdown: Record<string, number>;
}

export interface TouchedShardPlan {
  shard_month: string;
  future_shard_path: string;
  existing_rows: number;
  append_directional: number;
  skip_identical: number;
  block_conflict: number;
  manual_review: number;
  exclude_audit: number;
  expected_after_if_approved: number;
}

export interface PreviewArtifactLike {
  decision?: string;
  source_phase?: string;
  preview_rows?: PreviewRow[];
  classification_summary?: {
    total?: number;
    directional?: number;
    excluded?: number;
    direct?: number;
  };
  safety_confirmation?: Record<string, unknown>;
  report_path?: string;
  csv_path?: string;
  debug_artifact_path?: string;
}

function s(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function validIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function existingKey(shardMonth: string, rowId: string): string {
  return `${shardMonth}::${rowId}`;
}

export function manualReviewReasons(row: PreviewRow): string[] {
  const reasons: string[] = [];
  if (row.source !== "booking") reasons.push("source_not_booking");
  if (s(row.property_slug) === "") reasons.push("missing_property_slug");
  if (s(row.canonical_property_name) === "") reasons.push("missing_canonical_property_name");
  if (!validIsoDate(s(row.checkin))) reasons.push("invalid_checkin");
  if (!validIsoDate(s(row.checkout))) reasons.push("invalid_checkout");
  if (s(row.stay_scope) !== "2_adults_1_room_1_night") reasons.push("invalid_stay_scope");
  if (s(row.screenshot_path) === "") reasons.push("missing_screenshot");
  if (s(row.debug_path) === "") reasons.push("missing_debug");
  if (row.classification === "not_ready") reasons.push("preview_not_ready");
  if (row.classification === "directional" && row.primary_price_numeric === null) reasons.push("directional_missing_price");
  if (row.dp_usage !== "directional_only" && row.dp_usage !== "audit_only") reasons.push("invalid_dp_usage");
  if (row.warning_flags.some((flag) => /captcha|security|login|required|blocked/iu.test(flag))) {
    reasons.push("blocked_or_login_warning");
  }
  return reasons;
}

export function isDirectionalAppendable(row: PreviewRow): boolean {
  return (
    manualReviewReasons(row).length === 0 &&
    row.source === "booking" &&
    row.classification === "directional" &&
    row.dp_usage === "directional_only" &&
    row.primary_price_numeric !== null &&
    row.official_tax_fee_adder_numeric === null &&
    row.computed_total_with_tax_fee === null
  );
}

interface RoomBasisMarker {
  sourceClassification: string;
  basisNote: string;
  warningFlags: string;
  isPriceUsableForDpDirectional: boolean;
  isPriceExcludedFromDp: boolean;
  dpExclusionReason: string | null;
}

// Encode room basis into existing v1 columns (no schema widening).
//  - No room context (legacy/proposal replay) → unchanged directional behavior.
//  - confirmed_two_person_standard_room → directional + positive markers (BI
//    counts it as a two-person standard sample).
//  - any excluded/unknown room basis → DP-excluded audit row (kept for
//    availability, never a two-person DP sample).
function deriveRoomBasisMarker(row: PreviewRow): RoomBasisMarker {
  const existingFlags = row.warning_flags.join(";");
  const roomBasis = row.room_basis;
  if (roomBasis === undefined) {
    return {
      sourceClassification: "booking_directional_visible_price_only",
      basisNote: "directional visible price signal; not all-in official total",
      warningFlags: existingFlags,
      isPriceUsableForDpDirectional: true,
      isPriceExcludedFromDp: false,
      dpExclusionReason: null
    };
  }
  if (roomBasis === "confirmed_two_person_standard_room") {
    return {
      sourceClassification: "booking_assumed_room_only_two_person_standard",
      basisNote: "meal_basis=assumed_room_only;room_basis=confirmed_two_person_standard_room;directional visible price signal",
      warningFlags: [existingFlags, "room_basis_confirmed_two_person_standard", "room_basis=confirmed_two_person_standard_room"]
        .filter((f) => f.length > 0)
        .join(";"),
      isPriceUsableForDpDirectional: true,
      isPriceExcludedFromDp: false,
      dpExclusionReason: null
    };
  }
  // Wrong or unknown room type: excluded audit row.
  return {
    sourceClassification: "booking_room_type_excluded",
    basisNote: `room_basis=${roomBasis};booking_room_type_excluded_from_two_person_dp`,
    warningFlags: [existingFlags, `room_basis=${roomBasis}`, "room_basis_unknown_or_excluded"]
      .filter((f) => f.length > 0)
      .join(";"),
    isPriceUsableForDpDirectional: false,
    isPriceExcludedFromDp: true,
    dpExclusionReason: roomBasisDpExclusionReason(roomBasis)
  };
}

export function buildProposedHistoryRow(input: {
  row: PreviewRow;
  sourceReportPath: string;
  sourceCsvPath: string;
}): HistoryRow {
  const collectedAtJst = s(input.row.collected_at_jst);
  const collectedDateJst = collectedAtJst.slice(0, 10);
  const shardMonth = shardMonthFromCheckin(input.row.checkin);
  const normalizedTotalPrice = input.row.primary_price_numeric;
  // Room-basis markers (Phase ROOM-LIVE): when the live preview carried room
  // context, encode the room basis into the existing v1 columns so BI can count
  // confirmed two-person standard rooms and exclude wrong/unknown room types.
  // Rows WITHOUT room context (legacy/proposal replays) keep the old behavior.
  const marker = deriveRoomBasisMarker(input.row);
  const sourceClassification = marker.sourceClassification;
  const rowId = buildRowId({
    collectedDateJst,
    source: "booking",
    canonicalPropertyName: input.row.canonical_property_name,
    sourceSlugOrCode: input.row.property_slug,
    sourcePropertyId: input.row.property_slug,
    checkin: input.row.checkin,
    checkout: input.row.checkout,
    stayScope: input.row.stay_scope
  });
  const hashInput = {
    source: "booking",
    sourcePhase: input.row.source_phase,
    collectorStage: "booking_preview_gated_live",
    canonicalPropertyName: input.row.canonical_property_name,
    sourceSlugOrCode: input.row.property_slug,
    sourcePropertyId: input.row.property_slug,
    checkin: input.row.checkin,
    checkout: input.row.checkout,
    stayScope: input.row.stay_scope,
    collectedDateJst,
    availabilityStatus: input.row.availability_status,
    soldOutStatus: "not_sold_out",
    normalizedTotalPrice,
    basisConfidence: "B",
    sourceClassification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: marker.isPriceUsableForDpDirectional,
    isPriceExcludedFromDp: marker.isPriceExcludedFromDp
  };
  const rowHash = buildRowHash(hashInput);
  return {
    rowId,
    rowHash,
    shardMonth,
    collectedDateJst,
    collectedAtJst,
    normalizedAtJst: collectedAtJst,
    source: "booking",
    sourcePhase: input.row.source_phase,
    collectorStage: "booking_preview_gated_live",
    canonicalPropertyName: input.row.canonical_property_name,
    sourcePropertyName: input.row.canonical_property_name,
    propertyIdentityMatch: true,
    sourcePropertyId: input.row.property_slug,
    sourceSlugOrCode: input.row.property_slug,
    checkin: input.row.checkin,
    checkout: input.row.checkout,
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: input.row.stay_scope,
    availabilityStatus: input.row.availability_status,
    soldOutStatus: "not_sold_out",
    normalizedTotalPrice,
    normalizedTotalPriceSource: "booking_visible_price_candidate",
    normalizedTotalPriceBasis: "visible_booking_price_directional_only",
    normalizedTotalPriceConfidence: "B",
    basisConfidence: "B",
    basisNote: marker.basisNote,
    sourcePrimaryPrice: input.row.primary_price_numeric,
    sourceSecondaryPriceOrAdder: input.row.official_tax_fee_adder_numeric,
    sourceComputedTotal: input.row.computed_total_with_tax_fee,
    sourceTaxOrFeeClassification: "official_visible_adder_not_available",
    sourceClassification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: marker.isPriceUsableForDpDirectional,
    isPriceExcludedFromDp: marker.isPriceExcludedFromDp,
    dpExclusionReason: marker.dpExclusionReason,
    warningFlags: marker.warningFlags,
    sourceReportPath: input.sourceReportPath,
    sourceCsvPath: input.sourceCsvPath,
    debugArtifactPath: input.row.debug_path,
    schemaVersion: HISTORY_SCHEMA_VERSION
  };
}

export function buildReviewRows(input: {
  previewRows: readonly PreviewRow[];
  existingKeys: readonly ExistingHistoryKey[];
  sourceReportPath: string;
  sourceCsvPath: string;
}): BookingPreviewReviewRow[] {
  const existing = new Map<string, string>();
  for (const key of input.existingKeys) existing.set(existingKey(key.shard_month, key.row_id), key.row_hash);

  return input.previewRows.map((row) => {
    const proposed = buildProposedHistoryRow({
      row,
      sourceReportPath: input.sourceReportPath,
      sourceCsvPath: input.sourceCsvPath
    });
    const manualReasons = manualReviewReasons(row);
    const existingHash = existing.get(existingKey(proposed.shardMonth, proposed.rowId)) ?? "";
    let appendAction: BookingPreviewAppendAction = "manual_review";
    let reason = "";

    if (existingHash !== "") {
      appendAction = existingHash === proposed.rowHash ? "skip_identical" : "block_conflict";
      reason =
        appendAction === "skip_identical"
          ? "row_id and row_hash already exist in local history; skip identical observation."
          : "row_id exists in local history with a different row_hash; conflict reported, not resolved.";
    } else if (manualReasons.length > 0) {
      appendAction = "manual_review";
      reason = `Required evidence or structural checks failed: ${manualReasons.join(", ")}.`;
    } else if (isDirectionalAppendable(row)) {
      appendAction = "append_directional";
      reason =
        "B-confidence Booking visible-price row; propose as directional price-pressure evidence only, direct_pricing_usable=false.";
    } else {
      appendAction = "exclude_audit";
      reason = "Booking row is not a clean directional append; keep as audit-only preview evidence.";
    }

    return {
      source: row.source,
      property_slug: row.property_slug,
      canonical_property_name: row.canonical_property_name,
      checkin: row.checkin,
      checkout: row.checkout,
      stay_scope: row.stay_scope,
      preview_classification: row.classification,
      append_action: appendAction,
      price_policy:
        appendAction === "append_directional"
          ? "booking_directional_visible_price_only"
          : "not_appendable",
      dp_usage: appendAction === "append_directional" ? "directional" : "excluded",
      price_pressure_usable: appendAction === "append_directional",
      direct_pricing_usable: false,
      basis_confidence: appendAction === "append_directional" ? "B" : "insufficient",
      basis_note:
        appendAction === "append_directional"
          ? "directional visible price signal; not all-in official total"
          : "not proposed as directional price evidence",
      normalized_total_price: appendAction === "append_directional" ? row.primary_price_numeric : null,
      source_primary_price: row.primary_price_numeric,
      official_tax_fee_adder_numeric: row.official_tax_fee_adder_numeric,
      computed_total_with_tax_fee: row.computed_total_with_tax_fee,
      screenshot_path: row.screenshot_path,
      debug_path: row.debug_path,
      row_id: proposed.rowId,
      row_hash: proposed.rowHash,
      shard_month: proposed.shardMonth,
      existing_row_hash: existingHash,
      manual_review_reasons: manualReasons,
      reason,
      proposed_history_row: proposed
    };
  });
}

export function summarizeAppendActions(
  previewRows: readonly PreviewRow[],
  reviewRows: readonly BookingPreviewReviewRow[],
  history: CurrentHistorySummary
): AppendActionSummary {
  const actionBreakdown: Record<string, number> = {};
  for (const row of reviewRows) actionBreakdown[row.append_action] = (actionBreakdown[row.append_action] ?? 0) + 1;
  const appendDirectional = actionBreakdown["append_directional"] ?? 0;
  const touchedShards = [
    ...new Set(reviewRows.filter((r) => r.append_action === "append_directional").map((r) => r.shard_month))
  ].sort();
  return {
    total_preview_rows: previewRows.length,
    booking_rows: previewRows.filter((r) => r.source === "booking").length,
    non_booking_rows: previewRows.filter((r) => r.source !== "booking").length,
    append_directional: appendDirectional,
    skip_identical: actionBreakdown["skip_identical"] ?? 0,
    block_conflict: actionBreakdown["block_conflict"] ?? 0,
    manual_review: actionBreakdown["manual_review"] ?? 0,
    exclude_audit: actionBreakdown["exclude_audit"] ?? 0,
    direct_rows: 0,
    conflicts: actionBreakdown["block_conflict"] ?? 0,
    expected_total_after_append_if_approved: history.total_rows + appendDirectional,
    touched_shards: touchedShards,
    action_breakdown: actionBreakdown
  };
}

export function buildTouchedShardPlan(
  reviewRows: readonly BookingPreviewReviewRow[],
  history: CurrentHistorySummary
): TouchedShardPlan[] {
  const shards = [...new Set(reviewRows.map((row) => row.shard_month))].sort();
  return shards.map((shard) => {
    const bucket = reviewRows.filter((row) => row.shard_month === shard);
    const count = (action: BookingPreviewAppendAction): number =>
      bucket.filter((row) => row.append_action === action).length;
    const appendDirectional = count("append_directional");
    return {
      shard_month: shard,
      future_shard_path: futureShardPath(shard),
      existing_rows: history.rows_by_shard[shard] ?? 0,
      append_directional: appendDirectional,
      skip_identical: count("skip_identical"),
      block_conflict: count("block_conflict"),
      manual_review: count("manual_review"),
      exclude_audit: count("exclude_audit"),
      expected_after_if_approved: (history.rows_by_shard[shard] ?? 0) + appendDirectional
    };
  });
}

export function decideBookingPreviewAppendProposal(input: {
  sourceLoaded: boolean;
  historyParsed: boolean;
  summary: AppendActionSummary;
}): BookingPreviewAppendDecision {
  if (!input.sourceLoaded || !input.historyParsed) return "booking_preview_append_proposal_not_ready";
  if (input.summary.non_booking_rows > 0) return "booking_preview_append_proposal_not_ready";
  if (input.summary.conflicts > 0) return "booking_preview_append_proposal_not_ready";
  if (input.summary.append_directional === 0) return "booking_preview_append_proposal_not_ready";
  // AUTO-RUNNER08X prices are visible directional signals, not all-in official totals.
  return "booking_preview_append_proposal_basis_caution";
}

export function buildSafetyConfirmation() {
  return {
    history_appended: false,
    history_modified: false,
    db_written: false,
    db_synced: false,
    ai_context_refreshed: false,
    live_booking_collection: false,
    jalan_collection: false,
    rakuten_collection: false,
    google_hotels_collection: false,
    query_smoke_run: false,
    pricing_csv_generated: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    launchd_collector_install: false,
    paid_proxy: false,
    captcha_bypass: false,
    stealth: false,
    login_or_cookies: false,
    synthetic_tax_multiplier: false,
    existing_history_overwritten: false,
    started_auto_runner08z: false
  };
}

export const BOOKING_PREVIEW_APPEND_CSV_HEADERS = [
  "append_action",
  "row_id",
  "row_hash",
  "shard_month",
  "source",
  "canonical_property_name",
  "property_slug",
  "checkin",
  "checkout",
  "stay_scope",
  "normalized_total_price",
  "source_primary_price",
  "official_tax_fee_adder_numeric",
  "computed_total_with_tax_fee",
  "basis_confidence",
  "price_policy",
  "dp_usage",
  "price_pressure_usable",
  "direct_pricing_usable",
  "screenshot_path",
  "debug_path",
  "reason"
] as const;

export function renderProposalCsv(rows: readonly BookingPreviewReviewRow[]): string {
  const body = rows.map((row) =>
    [
      row.append_action,
      row.row_id,
      row.row_hash,
      row.shard_month,
      row.source,
      row.canonical_property_name,
      row.property_slug,
      row.checkin,
      row.checkout,
      row.stay_scope,
      value(row.normalized_total_price),
      value(row.source_primary_price),
      value(row.official_tax_fee_adder_numeric),
      value(row.computed_total_with_tax_fee),
      row.basis_confidence,
      row.price_policy,
      row.dp_usage,
      String(row.price_pressure_usable),
      String(row.direct_pricing_usable),
      row.screenshot_path,
      row.debug_path,
      row.reason
    ]
      .map(csvEscape)
      .join(",")
  );
  return [BOOKING_PREVIEW_APPEND_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderReport(input: {
  generatedAtJst: string;
  decision: BookingPreviewAppendDecision;
  sourcePreviewArtifact: string;
  historySummary: CurrentHistorySummary;
  appendSummary: AppendActionSummary;
  touchedShards: readonly TouchedShardPlan[];
  reviewRows: readonly BookingPreviewReviewRow[];
  safetyConfirmation: ReturnType<typeof buildSafetyConfirmation>;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
}): string {
  const summary = input.appendSummary;
  return [
    "# Booking Preview Append Proposal",
    "",
    `Generated at JST: ${input.generatedAtJst}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${input.decision}`,
    `- source_preview_artifact=${input.sourcePreviewArtifact}`,
    `- preview_rows=${summary.total_preview_rows}`,
    `- append_directional=${summary.append_directional}`,
    `- skip_identical=${summary.skip_identical}`,
    `- block_conflict=${summary.block_conflict}`,
    `- manual_review=${summary.manual_review}`,
    "- direct_rows=0",
    "",
    "## 2. Existing History Preflight",
    "",
    `- total_rows=${input.historySummary.total_rows}`,
    `- booking_rows=${input.historySummary.booking_rows}`,
    `- jalan_rows=${input.historySummary.jalan_rows}`,
    `- rakuten_rows=${input.historySummary.rakuten_rows}`,
    `- duplicate_row_id_count=${input.historySummary.duplicate_row_id_count}`,
    "",
    "## 3. Price Basis Caution",
    "",
    "- Proposed rows are Booking directional visible price signals only.",
    "- Basis note: directional visible price signal; not all-in official total.",
    "- official_tax_fee_adder_numeric is null and computed_total_with_tax_fee is null.",
    "- No synthetic tax/fee adder is invented. No direct pricing use is proposed.",
    "- price_policy=booking_directional_visible_price_only; basis_confidence=B; dp_usage=directional.",
    "",
    "## 4. Touched Shards",
    "",
    ...input.touchedShards.map(
      (shard) =>
        `- ${shard.shard_month}: append_directional=${shard.append_directional}, expected_after_if_approved=${shard.expected_after_if_approved}, path=${shard.future_shard_path}`
    ),
    "",
    "## 5. Conflict Check",
    "",
    `- conflicts=${summary.conflicts}`,
    `- expected_total_after_append_if_approved=${summary.expected_total_after_append_if_approved}`,
    "",
    "## 6. Safety Confirmation",
    "",
    "- Proposal only: no history append, no DB write/sync, no AI context refresh, no pricing/PMS output.",
    "- No live collection is run in AUTO-RUNNER08Y.",
    "",
    "## 7. Next Step",
    "",
    "- AUTO-RUNNER08Z — approved append of Booking preview rows to history. Do not start without explicit instruction.",
    "",
    "## Output Paths",
    "",
    `- report_path=${input.reportPath}`,
    `- json_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugPath}`,
    "",
    "## Proposal Rows",
    "",
    ...input.reviewRows.map(
      (row) =>
        `- ${row.append_action}: ${row.property_slug} ${row.checkin} price=${value(row.source_primary_price)} row_id=${row.row_id}`
    ),
    ""
  ].join("\n");
}

function csvEscape(v: string): string {
  if (/[",\n\r]/u.test(v)) return `"${v.replace(/"/gu, "\"\"")}"`;
  return v;
}

function value(v: string | number | boolean | null): string {
  return v === null ? "" : String(v);
}
