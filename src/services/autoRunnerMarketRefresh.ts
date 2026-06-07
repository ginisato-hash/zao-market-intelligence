// Phase AUTO-RUNNER10X - integrated market refresh runner helpers.
//
// Pure orchestration helpers for a fail-closed Booking/Jalan refresh pipeline.
// Browser collection, subprocess DB sync, and AI context rebuild live in the
// companion script. This module enforces caps and append policy and never emits
// pricing/PMS output.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildRowHash,
  buildRowId,
  futureShardPath,
  HISTORY_SCHEMA_VERSION,
  renderHistoryCsv,
  shardMonthFromCheckin,
  type HistoryRow
} from "./localHistorySchemaDesign";
import {
  MAX_PAGES as BOOKING_PREVIEW_MAX_PAGES,
  VERIFIED_BOOKING_TARGETS,
  buildTargetMatrix as buildBookingTargetMatrix,
  enforcePageCap as enforceBookingPageCap,
  selectPreviewDates as selectBookingPreviewDates,
  type PreviewRow as BookingPreviewRow
} from "./autoRunnerBookingPreview";
import { buildProposedHistoryRow as buildBookingHistoryRow } from "./bookingPreviewAppendProposal";
import {
  buildJalanProbeTarget,
  type JalanImprovedPreviewRow,
  type JalanProbeTarget
} from "./jalanBoundedCollectionProbeImproved";

export type AutoRunnerMarketRefreshDecision =
  | "auto_runner_market_refresh_ready_not_run"
  | "auto_runner_market_refresh_success"
  | "auto_runner_market_refresh_partial_success"
  | "auto_runner_market_refresh_basis_caution"
  | "auto_runner_market_refresh_not_ready"
  | "auto_runner_market_refresh_append_failed"
  | "auto_runner_market_refresh_db_sync_failed"
  | "auto_runner_market_refresh_context_failed";

export const MARKET_REFRESH_GATES = [
  "ZMI_AUTORUN_ENABLED",
  "COLLECT_BOOKING",
  "COLLECT_JALAN",
  "ALLOW_HISTORY_APPEND",
  "HISTORY_TO_DB_SYNC",
  "BUILD_AI_CONTEXT"
] as const;

export const MAX_BOOKING_PAGES = Math.min(15, BOOKING_PREVIEW_MAX_PAGES);
export const MAX_JALAN_PROPERTIES = 5;
export const MAX_JALAN_DATES_PER_PROPERTY = 3;
export const MAX_JALAN_PAGES = 15;
export const MAX_TOTAL_LIVE_PAGES = 30;
export const STAY_SCOPE = "2_adults_1_room_1_night";
export const SOURCE_PHASE = "AUTO-RUNNER10X";
export const PEAK_DATE = "2026-08-10";

export interface GateEvaluation {
  gate: string;
  value: "0" | "1";
  enabled: boolean;
  source: "env" | "default";
}

export interface GateResult {
  live_mode_authorized: boolean;
  failed_gates: string[];
  gates: GateEvaluation[];
}

export function evaluateMarketRefreshGates(env: Record<string, string | undefined>): GateResult {
  const gates = MARKET_REFRESH_GATES.map((gate) => {
    const raw = env[gate];
    const value = raw === "1" ? "1" : "0";
    return { gate, value, enabled: value === "1", source: raw === undefined ? "default" : "env" } satisfies GateEvaluation;
  });
  const failed = gates.filter((gate) => !gate.enabled).map((gate) => `${gate.gate}!=1`);
  return { live_mode_authorized: failed.length === 0, failed_gates: failed, gates };
}

export interface MarketStateSummary {
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  source_counts: Record<string, number>;
  duplicate_row_id_count: number;
}

export function buildBookingPlan(todayIso: string): {
  dates: string[];
  target_matrix: ReturnType<typeof buildBookingTargetMatrix>;
  selected_targets: ReturnType<typeof enforceBookingPageCap>["selected"];
  max_pages: number;
  page_cap_respected: boolean;
} {
  const dates = selectBookingPreviewDates(todayIso, PEAK_DATE);
  const matrix = buildBookingTargetMatrix(VERIFIED_BOOKING_TARGETS, dates);
  const cap = enforceBookingPageCap(matrix);
  return {
    dates,
    target_matrix: matrix,
    selected_targets: cap.selected.slice(0, MAX_BOOKING_PAGES),
    max_pages: MAX_BOOKING_PAGES,
    page_cap_respected: cap.selected.length <= MAX_BOOKING_PAGES
  };
}

export const VERIFIED_JALAN_TARGETS = [
  { canonicalPropertyName: "ホテル喜らく", facilityTier: "tier_2" as const, jalanYadId: "yad325153", sourceUrl: "https://www.jalan.net/yad325153/" },
  { canonicalPropertyName: "ル・ベール蔵王", facilityTier: "tier_2" as const, jalanYadId: "yad328232", sourceUrl: "https://www.jalan.net/yad328232/" },
  { canonicalPropertyName: "HAMMOND", facilityTier: "tier_2" as const, jalanYadId: "yad348320", sourceUrl: "https://www.jalan.net/yad348320/" },
  { canonicalPropertyName: "吉田屋", facilityTier: "tier_2" as const, jalanYadId: "yad327282", sourceUrl: "https://www.jalan.net/yad327282/" },
  { canonicalPropertyName: "JURIN", facilityTier: "tier_2" as const, jalanYadId: "yad332556", sourceUrl: "https://www.jalan.net/yad332556/" }
] as const;

export function selectMarketRefreshDates(todayIso: string, peakDateIso = PEAK_DATE): string[] {
  const dates = [...nextSaturdays(todayIso, 2), peakDateIso];
  return [...new Set(dates)].slice(0, MAX_JALAN_DATES_PER_PROPERTY);
}

export function buildJalanTargetMatrix(todayIso: string): JalanProbeTarget[] {
  const dates = selectMarketRefreshDates(todayIso);
  const targets: JalanProbeTarget[] = [];
  for (const property of VERIFIED_JALAN_TARGETS.slice(0, MAX_JALAN_PROPERTIES)) {
    for (const checkin of dates) {
      targets.push(buildJalanProbeTarget({ ...property, checkin }));
    }
  }
  return targets.slice(0, MAX_JALAN_PAGES);
}

export function totalPageCapRespected(input: { bookingPages: number; jalanPages: number }): boolean {
  return input.bookingPages + input.jalanPages <= MAX_TOTAL_LIVE_PAGES;
}

export interface SourceLevelCheck {
  source: "booking" | "jalan";
  executed_pages: number;
  source_cap: number;
  screenshots_count: number;
  page_cap_respected: boolean;
  screenshots_match_pages: boolean;
  debug_artifacts_exist: boolean;
  source_level_captcha_or_block: boolean;
  source_level_degraded_page: boolean;
  direct_rows_proposed: number;
  row_hash_conflicts: number;
  duplicate_row_id_conflicts: number;
  append_allowed: boolean;
  failure_reasons: string[];
}

export function buildBookingSourceLevelCheck(rows: readonly BookingPreviewRow[], maxPages = MAX_BOOKING_PAGES): SourceLevelCheck {
  const screenshots = rows.filter((row) => row.screenshot_path !== "").length;
  const blocked = rows.some((row) => row.warning_flags.some((flag) => /captcha|security|login|blocked/iu.test(flag)));
  const degraded = rows.some((row) => row.availability_status === "degraded_empty");
  return sourceLevel({
    source: "booking",
    executed_pages: rows.length,
    source_cap: maxPages,
    screenshots_count: screenshots,
    debug_artifacts_exist: rows.every((row) => row.debug_path !== ""),
    source_level_captcha_or_block: blocked,
    source_level_degraded_page: degraded,
    direct_rows_proposed: 0
  });
}

export function buildJalanSourceLevelCheck(rows: readonly JalanImprovedPreviewRow[], maxPages = MAX_JALAN_PAGES): SourceLevelCheck {
  const screenshots = rows.filter((row) => row.screenshot_path !== "").length;
  const blocked = rows.some((row) => /captcha|block|security/iu.test(`${row.error_reason};${row.warning_flags}`));
  const degraded = rows.some((row) => row.availability_status === "failed" && /degraded|empty/iu.test(row.error_reason));
  return sourceLevel({
    source: "jalan",
    executed_pages: rows.length,
    source_cap: maxPages,
    screenshots_count: screenshots,
    debug_artifacts_exist: rows.every((row) => row.debug_artifact_path !== ""),
    source_level_captcha_or_block: blocked,
    source_level_degraded_page: degraded,
    direct_rows_proposed: rows.filter((row) => row.dp_usage === "direct").length
  });
}

function sourceLevel(input: Omit<SourceLevelCheck, "page_cap_respected" | "screenshots_match_pages" | "append_allowed" | "failure_reasons" | "row_hash_conflicts" | "duplicate_row_id_conflicts">): SourceLevelCheck {
  const failure_reasons: string[] = [];
  const page_cap_respected = input.executed_pages <= input.source_cap;
  const screenshots_match_pages = input.screenshots_count === input.executed_pages;
  if (!page_cap_respected) failure_reasons.push("page_cap_exceeded");
  if (!screenshots_match_pages) failure_reasons.push("screenshots_count_mismatch");
  if (!input.debug_artifacts_exist) failure_reasons.push("debug_artifact_missing");
  if (input.source_level_captcha_or_block) failure_reasons.push("captcha_or_block_detected");
  if (input.source_level_degraded_page) failure_reasons.push("source_degraded_page_detected");
  if (input.direct_rows_proposed > 0) failure_reasons.push("direct_rows_proposed");
  return {
    ...input,
    page_cap_respected,
    screenshots_match_pages,
    row_hash_conflicts: 0,
    duplicate_row_id_conflicts: 0,
    append_allowed: failure_reasons.length === 0,
    failure_reasons
  };
}

export interface ExistingHistoryKey {
  row_id: string;
  row_hash: string;
  shard_month: string;
  // Comparable fields for intraday/basis classification. `undefined` means the
  // existing value is unknown (e.g. a legacy key built without price columns),
  // which is treated as "cannot compare" and routed to hard_conflict.
  normalized_total_price?: number | null | undefined;
  availability_status?: string | undefined;
  basis_confidence?: string | undefined;
  dp_directional?: boolean | undefined;
  dp_excluded?: boolean | undefined;
}

// Classification of a same-row_id / different-row_hash collision.
export type RowConflictClass =
  | "intraday_price_change"
  | "metadata_only_diff"
  | "basis_or_classification_diff"
  | "hard_conflict";

export interface RowConflictDetail {
  base_row_id: string;
  source: "booking" | "jalan";
  classification: RowConflictClass;
  existing_price: number | null | "unknown";
  new_price: number | null;
  price_delta: number | null;
  price_delta_pct: number | null;
  existing_availability_status: string;
  new_availability_status: string;
  existing_basis_confidence: string;
  new_basis_confidence: string;
  existing_hash: string;
  new_hash: string;
  changed_fields: string[];
  intraday_row_id: string | null;
  recommended_action: string;
}

export interface AppendPlan {
  approved_rows: HistoryRow[];
  skipped_identical_rows: number;
  conflict_rows: { row_id: string; existing_hash: string; new_hash: string }[];
  rejected_rows: { source: string; identity: string; reason: string }[];
  touched_shards: string[];
  new_row_count: number;
  append_allowed: boolean;
  intraday_rows: RowConflictDetail[];
  metadata_only_diffs: RowConflictDetail[];
  basis_or_classification_diffs: RowConflictDetail[];
  hard_conflicts: RowConflictDetail[];
}

// Build a unique, traceable row_id for an intraday price-change observation.
// The base (existing) row_id is preserved unchanged in history; this derives a
// new id keyed by the collection time-of-day, with a numeric suffix fallback to
// guarantee uniqueness against ids already present.
export function buildIntradayRowId(
  baseRowId: string,
  collectedAtJst: string,
  takenIds: ReadonlySet<string>
): string {
  const hhmm = collectedAtJst.slice(11, 16).replace(":", "") || "0000";
  const base = `${baseRowId}::intraday::${hhmm}`;
  if (!takenIds.has(base)) return base;
  let n = 2;
  while (takenIds.has(`${base}::${n}`)) n += 1;
  return `${base}::${n}`;
}

// Classify a same-row_id / different-row_hash collision. Caller guarantees the
// candidate already passed source row policy (evidence present, not direct, no
// block/CAPTCHA), so this focuses on the price/basis comparison.
export function classifyRowConflict(existing: ExistingHistoryKey, candidate: HistoryRow): RowConflictClass {
  if (candidate.isPriceUsableForDpDirect) return "hard_conflict"; // direct never allowed
  const existingPrice = existing.normalized_total_price;
  const newPrice = candidate.normalizedTotalPrice;
  const bothNumeric =
    typeof existingPrice === "number" && Number.isFinite(existingPrice) &&
    typeof newPrice === "number" && Number.isFinite(newPrice);
  if (bothNumeric) {
    if (existingPrice !== newPrice) {
      // Real visible price movement for the same property/checkin/scope/source.
      return candidate.isPriceUsableForDpDirectional ? "intraday_price_change" : "basis_or_classification_diff";
    }
    // Same price but the hash differs => a hashed non-price field changed
    // (availability / sold-out / basis / classification / dp flags). Pure
    // metadata (paths, run_id, basis_note) is excluded from the hash, so it
    // cannot produce a collision; metadata_only_diff is therefore defensive.
    return conflictChangedFields(existing, candidate).length > 0 ? "basis_or_classification_diff" : "metadata_only_diff";
  }
  if (existingPrice === undefined) return "hard_conflict"; // cannot compare
  // One side has a price and the other does not (excluded <-> priced): a
  // material availability/classification change requiring manual review.
  return "basis_or_classification_diff";
}

function conflictChangedFields(existing: ExistingHistoryKey, candidate: HistoryRow): string[] {
  const changed: string[] = [];
  const existingPrice = existing.normalized_total_price;
  if (existingPrice !== undefined && existingPrice !== candidate.normalizedTotalPrice) changed.push("normalized_total_price");
  if (existing.availability_status !== undefined && existing.availability_status !== candidate.availabilityStatus) changed.push("availability_status");
  if (existing.basis_confidence !== undefined && existing.basis_confidence !== candidate.basisConfidence) changed.push("basis_confidence");
  if (existing.dp_directional !== undefined && existing.dp_directional !== candidate.isPriceUsableForDpDirectional) changed.push("dp_directional");
  if (existing.dp_excluded !== undefined && existing.dp_excluded !== candidate.isPriceExcludedFromDp) changed.push("dp_excluded");
  return changed;
}

function buildConflictDetail(input: {
  source: "booking" | "jalan";
  existing: ExistingHistoryKey;
  candidate: HistoryRow;
  classification: RowConflictClass;
  intradayRowId: string | null;
}): RowConflictDetail {
  const existingPrice = input.existing.normalized_total_price === undefined ? "unknown" : input.existing.normalized_total_price;
  const newPrice = input.candidate.normalizedTotalPrice;
  const numericExisting = typeof existingPrice === "number" ? existingPrice : null;
  const delta = numericExisting !== null && newPrice !== null ? newPrice - numericExisting : null;
  const pct = delta !== null && numericExisting !== null && numericExisting !== 0 ? Number(((delta / numericExisting) * 100).toFixed(2)) : null;
  const action: Record<RowConflictClass, string> = {
    intraday_price_change: "append as new intraday observation row",
    metadata_only_diff: "do not append; metadata-only difference",
    basis_or_classification_diff: "manual_review; do not append automatically",
    hard_conflict: "block this source append; do not overwrite"
  };
  return {
    base_row_id: input.candidate.rowId,
    source: input.source,
    classification: input.classification,
    existing_price: existingPrice,
    new_price: newPrice,
    price_delta: delta,
    price_delta_pct: pct,
    existing_availability_status: input.existing.availability_status ?? "unknown",
    new_availability_status: input.candidate.availabilityStatus,
    existing_basis_confidence: input.existing.basis_confidence ?? "unknown",
    new_basis_confidence: input.candidate.basisConfidence,
    existing_hash: input.existing.row_hash,
    new_hash: input.candidate.rowHash,
    changed_fields: conflictChangedFields(input.existing, input.candidate),
    intraday_row_id: input.intradayRowId,
    recommended_action: action[input.classification]
  };
}

export function buildAppendPlan(input: {
  bookingRows: readonly BookingPreviewRow[];
  jalanRows: readonly JalanImprovedPreviewRow[];
  existingKeys: readonly ExistingHistoryKey[];
  bookingSourceCheck: SourceLevelCheck;
  jalanSourceCheck: SourceLevelCheck;
  bookingReportPath: string;
  bookingCsvPath: string;
}): AppendPlan {
  const existing = new Map(input.existingKeys.map((key) => [`${key.shard_month}::${key.row_id}`, key]));
  const candidates: { source: "booking" | "jalan"; row: HistoryRow }[] = [];
  const rejected_rows: AppendPlan["rejected_rows"] = [];

  if (input.bookingSourceCheck.append_allowed) {
    for (const row of input.bookingRows) {
      const reason = bookingRowPolicyRejection(row);
      if (reason === "") candidates.push({ source: "booking", row: buildBookingHistoryRow({ row, sourceReportPath: input.bookingReportPath, sourceCsvPath: input.bookingCsvPath }) });
      else rejected_rows.push({ source: "booking", identity: `${row.property_slug}:${row.checkin}`, reason });
    }
  } else {
    for (const row of input.bookingRows) rejected_rows.push({ source: "booking", identity: `${row.property_slug}:${row.checkin}`, reason: input.bookingSourceCheck.failure_reasons.join(";") });
  }

  if (input.jalanSourceCheck.append_allowed) {
    for (const row of input.jalanRows) {
      const reason = jalanRowPolicyRejection(row);
      if (reason === "") candidates.push({ source: "jalan", row: jalanPreviewRowToHistoryRow(row) });
      else rejected_rows.push({ source: "jalan", identity: `${row.source_slug_or_code}:${row.checkin}`, reason });
    }
  } else {
    for (const row of input.jalanRows) rejected_rows.push({ source: "jalan", identity: `${row.source_slug_or_code}:${row.checkin}`, reason: input.jalanSourceCheck.failure_reasons.join(";") });
  }

  const candidateStatuses: {
    source: "booking" | "jalan";
    row: HistoryRow;
    status: "new" | "identical" | "intraday" | "metadata_only" | "manual_review" | "conflict";
  }[] = [];
  const conflict_rows: AppendPlan["conflict_rows"] = [];
  const intraday_rows: RowConflictDetail[] = [];
  const metadata_only_diffs: RowConflictDetail[] = [];
  const basis_or_classification_diffs: RowConflictDetail[] = [];
  const hard_conflicts: RowConflictDetail[] = [];
  const takenIds = new Set(input.existingKeys.map((key) => key.row_id)); // row_id space for intraday uniqueness
  let skipped_identical_rows = 0;

  for (const { source, row } of candidates) {
    const key = `${row.shardMonth}::${row.rowId}`;
    const existingKey = existing.get(key);
    if (existingKey === undefined) {
      candidateStatuses.push({ source, row, status: "new" });
      continue;
    }
    if (existingKey.row_hash === row.rowHash) {
      skipped_identical_rows += 1;
      candidateStatuses.push({ source, row, status: "identical" });
      continue;
    }
    const classification = classifyRowConflict(existingKey, row);
    if (classification === "intraday_price_change") {
      const intradayRowId = buildIntradayRowId(row.rowId, row.collectedAtJst, takenIds);
      takenIds.add(intradayRowId);
      const detail = buildConflictDetail({ source, existing: existingKey, candidate: row, classification, intradayRowId });
      const intradayRow: HistoryRow = {
        ...row,
        rowId: intradayRowId,
        basisNote: appendIntradayNote(row.basisNote, detail)
      };
      intraday_rows.push(detail);
      candidateStatuses.push({ source, row: intradayRow, status: "intraday" });
    } else if (classification === "metadata_only_diff") {
      metadata_only_diffs.push(buildConflictDetail({ source, existing: existingKey, candidate: row, classification, intradayRowId: null }));
      candidateStatuses.push({ source, row, status: "metadata_only" });
    } else if (classification === "basis_or_classification_diff") {
      basis_or_classification_diffs.push(buildConflictDetail({ source, existing: existingKey, candidate: row, classification, intradayRowId: null }));
      candidateStatuses.push({ source, row, status: "manual_review" });
    } else {
      const detail = buildConflictDetail({ source, existing: existingKey, candidate: row, classification, intradayRowId: null });
      hard_conflicts.push(detail);
      conflict_rows.push({ row_id: row.rowId, existing_hash: existingKey.row_hash, new_hash: row.rowHash });
      candidateStatuses.push({ source, row, status: "conflict" });
    }
  }

  // Only a HARD conflict blocks its source. Intraday/metadata/basis diffs never
  // block the source; intraday rows append, the others are reported.
  const hardConflictSources = new Set(candidateStatuses.filter((row) => row.status === "conflict").map((row) => row.source));
  const approved_rows = candidateStatuses
    .filter((item) => (item.status === "new" || item.status === "intraday") && !hardConflictSources.has(item.source))
    .map((item) => item.row);
  for (const item of candidateStatuses) {
    if ((item.status === "new" || item.status === "intraday") && hardConflictSources.has(item.source)) {
      rejected_rows.push({ source: item.source, identity: item.row.rowId, reason: "source_has_hard_conflict" });
    } else if (item.status === "metadata_only") {
      rejected_rows.push({ source: item.source, identity: item.row.rowId, reason: "metadata_only_diff_no_append" });
    } else if (item.status === "manual_review") {
      rejected_rows.push({ source: item.source, identity: item.row.rowId, reason: "basis_or_classification_diff_manual_review" });
    }
  }

  return {
    approved_rows,
    skipped_identical_rows,
    conflict_rows,
    rejected_rows,
    touched_shards: [...new Set(approved_rows.map((row) => row.shardMonth))].sort(),
    new_row_count: approved_rows.length,
    append_allowed: approved_rows.length > 0 || (conflict_rows.length === 0 && candidates.length === 0),
    intraday_rows,
    metadata_only_diffs,
    basis_or_classification_diffs,
    hard_conflicts
  };
}

function appendIntradayNote(existingNote: string, detail: RowConflictDetail): string {
  const note = `intraday_price_change base_row_id=${detail.base_row_id} existing_price=${detail.existing_price} new_price=${detail.new_price} price_delta=${detail.price_delta} price_delta_pct=${detail.price_delta_pct}`;
  return existingNote.trim() === "" ? note : `${existingNote} | ${note}`;
}

function bookingRowPolicyRejection(row: BookingPreviewRow): string {
  if (row.source !== "booking") return "source_not_booking";
  if (row.classification !== "directional" && row.classification !== "excluded") return "classification_not_allowed";
  if (row.classification === "directional") {
    if (row.primary_price_numeric === null) return "directional_missing_price";
    if (row.basis_confidence !== "directional_candidate_basis") return "directional_basis_not_acceptable";
    if (row.dp_usage !== "directional_only") return "directional_dp_usage_invalid";
  }
  if (row.screenshot_path === "") return "missing_screenshot";
  if (row.debug_path === "") return "missing_debug";
  if (row.warning_flags.some((flag) => /captcha|security|login|blocked/iu.test(flag))) return "blocked_or_login_warning";
  return "";
}

function jalanRowPolicyRejection(row: JalanImprovedPreviewRow): string {
  if (row.source !== "jalan") return "source_not_jalan";
  if (row.dp_usage === "direct") return "direct_rows_not_appendable";
  if (row.dp_usage !== "directional" && row.dp_usage !== "excluded") return "dp_usage_not_allowed";
  if (row.dp_usage === "directional") {
    if (row.normalized_total_price === null || row.source_primary_price === null) return "directional_missing_price";
    if (row.basis_confidence !== "A" && row.basis_confidence !== "B") return "directional_basis_not_acceptable";
  }
  if (row.dp_usage === "excluded" && row.is_price_usable_for_dp_directional) return "excluded_price_pressure_true";
  if (row.screenshot_path === "") return "missing_screenshot";
  if (row.debug_artifact_path === "") return "missing_debug";
  if (/captcha|block|security/iu.test(`${row.error_reason};${row.warning_flags}`)) return "blocked_or_captcha_warning";
  return "";
}

export function jalanPreviewRowToHistoryRow(row: JalanImprovedPreviewRow): HistoryRow {
  const direct = false;
  const directional = row.dp_usage === "directional";
  const excluded = row.dp_usage === "excluded";
  const sourceClassification = direct ? "jalan_direct_blocked_by_auto_runner10x" : row.source_classification;
  const rowId = buildRowId({
    collectedDateJst: row.collected_date_jst,
    source: "jalan",
    canonicalPropertyName: row.canonical_property_name,
    sourceSlugOrCode: row.source_slug_or_code,
    sourcePropertyId: row.source_property_id,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: row.stay_scope
  });
  const rowHash = buildRowHash({
    source: "jalan",
    sourcePhase: SOURCE_PHASE,
    collectorStage: "integrated_jalan_bounded_live",
    canonicalPropertyName: row.canonical_property_name,
    sourceSlugOrCode: row.source_slug_or_code,
    sourcePropertyId: row.source_property_id,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: row.stay_scope,
    collectedDateJst: row.collected_date_jst,
    availabilityStatus: row.availability_status,
    soldOutStatus: row.sold_out_status,
    normalizedTotalPrice: directional ? row.normalized_total_price : null,
    basisConfidence: directional ? row.basis_confidence : row.basis_confidence || "insufficient",
    sourceClassification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: directional,
    isPriceExcludedFromDp: excluded
  });
  return {
    rowId,
    rowHash,
    shardMonth: shardMonthFromCheckin(row.checkin),
    collectedDateJst: row.collected_date_jst,
    collectedAtJst: row.collected_at_jst,
    normalizedAtJst: row.normalized_at_jst,
    source: "jalan",
    sourcePhase: SOURCE_PHASE,
    collectorStage: "integrated_jalan_bounded_live",
    canonicalPropertyName: row.canonical_property_name,
    sourcePropertyName: row.source_property_name,
    propertyIdentityMatch: row.property_identity_match === "verified_target_url",
    sourcePropertyId: row.source_property_id,
    sourceSlugOrCode: row.source_slug_or_code,
    checkin: row.checkin,
    checkout: row.checkout,
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: row.stay_scope,
    availabilityStatus: row.availability_status,
    soldOutStatus: row.sold_out_status,
    normalizedTotalPrice: directional ? row.normalized_total_price : null,
    normalizedTotalPriceSource: directional ? row.normalized_total_price_source : null,
    normalizedTotalPriceBasis: directional ? row.normalized_total_price_basis : "missing_or_unclear",
    normalizedTotalPriceConfidence: row.normalized_total_price_confidence,
    basisConfidence: directional ? row.basis_confidence : row.basis_confidence || "insufficient",
    basisNote: row.basis_note,
    sourcePrimaryPrice: row.source_primary_price,
    sourceSecondaryPriceOrAdder: null,
    sourceComputedTotal: directional ? row.source_computed_total : null,
    sourceTaxOrFeeClassification: row.source_tax_or_fee_classification,
    sourceClassification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: directional,
    isPriceExcludedFromDp: excluded,
    dpExclusionReason: excluded ? row.dp_exclusion_reason || row.hard_exclusion_reason || "excluded_audit" : null,
    warningFlags: row.warning_flags,
    sourceReportPath: row.source_report_path,
    sourceCsvPath: row.source_csv_path,
    debugArtifactPath: row.debug_artifact_path,
    schemaVersion: HISTORY_SCHEMA_VERSION
  };
}

export interface HistoryAppendResult {
  rows_written: number;
  files_updated: number;
  backups_created: number;
  history_before: number;
  history_after: number;
  touched_shards: string[];
}

export function appendHistoryRowsAtomic(input: { rows: readonly HistoryRow[]; historyDir: string; backupDir: string; historyBefore: number }): HistoryAppendResult {
  mkdirSync(input.backupDir, { recursive: true });
  const byShard = new Map<string, HistoryRow[]>();
  for (const row of input.rows) {
    const list = byShard.get(row.shardMonth) ?? [];
    list.push(row);
    byShard.set(row.shardMonth, list);
  }
  let filesUpdated = 0;
  let backupsCreated = 0;
  for (const [shard, rows] of byShard) {
    const path = join(input.historyDir, `zao_signals_${shard}.csv`);
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    const backupPath = join(input.backupDir, `zao_signals_${shard}.csv.bak`);
    if (before !== "") {
      writeFileSync(backupPath, before, "utf8");
      backupsCreated += 1;
    }
    const rendered = renderHistoryCsv([...rows]);
    const body = rendered.split(/\r?\n/u).slice(1).filter((line) => line.length > 0).join("\n") + "\n";
    const next = before === "" ? rendered : `${before.endsWith("\n") ? before : `${before}\n`}${body}`;
    const tmp = `${path}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, path);
    filesUpdated += 1;
  }
  return {
    rows_written: input.rows.length,
    files_updated: filesUpdated,
    backups_created: backupsCreated,
    history_before: input.historyBefore,
    history_after: input.historyBefore + input.rows.length,
    touched_shards: [...byShard.keys()].sort()
  };
}

export interface SafetyConfirmation {
  live_booking_collection: boolean;
  live_jalan_collection: boolean;
  history_appended: boolean;
  db_synced: boolean;
  ai_context_refreshed: boolean;
  pricing_csv_generated: false;
  pms_output_generated: false;
  beds24_output_generated: false;
  airhost_output_generated: false;
  price_update: false;
  rakuten_collection: false;
  google_hotels_collection: false;
  paid_proxy: false;
  captcha_bypass: false;
  stealth: false;
  login_or_cookies: false;
  launchd_collector_install: false;
}

export function buildSafetyConfirmation(input: {
  liveBooking: boolean;
  liveJalan: boolean;
  historyAppended: boolean;
  dbSynced: boolean;
  aiContextRefreshed: boolean;
}): SafetyConfirmation {
  return {
    live_booking_collection: input.liveBooking,
    live_jalan_collection: input.liveJalan,
    history_appended: input.historyAppended,
    db_synced: input.dbSynced,
    ai_context_refreshed: input.aiContextRefreshed,
    pricing_csv_generated: false,
    pms_output_generated: false,
    beds24_output_generated: false,
    airhost_output_generated: false,
    price_update: false,
    rakuten_collection: false,
    google_hotels_collection: false,
    paid_proxy: false,
    captcha_bypass: false,
    stealth: false,
    login_or_cookies: false,
    launchd_collector_install: false
  };
}

export function decideMarketRefresh(input: {
  liveMode: boolean;
  preflightOk: boolean;
  appendConflict: boolean;
  appendAttempted: boolean;
  appendSucceeded: boolean;
  dbSyncSucceeded: boolean;
  contextSucceeded: boolean;
  postCountsAligned: boolean;
  sourceCaution: boolean;
}): AutoRunnerMarketRefreshDecision {
  if (!input.liveMode) return "auto_runner_market_refresh_ready_not_run";
  if (!input.preflightOk) return "auto_runner_market_refresh_not_ready";
  if (input.appendConflict) return "auto_runner_market_refresh_append_failed";
  if (input.appendAttempted && !input.appendSucceeded) return "auto_runner_market_refresh_append_failed";
  if (input.appendSucceeded && !input.dbSyncSucceeded) return "auto_runner_market_refresh_db_sync_failed";
  if (input.dbSyncSucceeded && !input.contextSucceeded) return "auto_runner_market_refresh_context_failed";
  if (input.postCountsAligned && input.sourceCaution) return "auto_runner_market_refresh_basis_caution";
  if (input.postCountsAligned) return "auto_runner_market_refresh_success";
  return "auto_runner_market_refresh_partial_success";
}

export function renderMarketRefreshCsv(rows: readonly HistoryRow[]): string {
  const header = ["row_id", "source", "canonical_property_name", "checkin", "dp_usage", "basis_confidence", "normalized_total_price"];
  const body = rows.map((row) =>
    [
      row.rowId,
      row.source,
      row.canonicalPropertyName,
      row.checkin,
      row.isPriceUsableForDpDirectional ? "directional" : row.isPriceExcludedFromDp ? "excluded" : "none",
      row.basisConfidence,
      row.normalizedTotalPrice === null ? "" : String(row.normalizedTotalPrice)
    ].map(csvCell).join(",")
  );
  return `${[header.join(","), ...body].join("\n")}\n`;
}

export function renderMarketRefreshReport(input: {
  runId: string;
  generatedAtJst: string;
  decision: AutoRunnerMarketRefreshDecision;
  preflight: MarketStateSummary;
  postState: MarketStateSummary;
  bookingSummary: Record<string, unknown>;
  jalanSummary: Record<string, unknown>;
  appendPlan: AppendPlan;
  appendResult: HistoryAppendResult | null;
  dbSyncResult: unknown;
  aiContextResult: unknown;
  safety: SafetyConfirmation;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
}): string {
  return [
    "# Auto Runner Market Refresh",
    "",
    `Generated at JST: ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Summary",
    `- decision=${input.decision}`,
    `- history_before=${input.preflight.history_rows}`,
    `- history_after=${input.postState.history_rows}`,
    `- db_after=${input.postState.db_rows}`,
    `- ai_context_after=${input.postState.ai_context_rows}`,
    "",
    "## 2. Booking",
    `- ${JSON.stringify(input.bookingSummary)}`,
    "",
    "## 3. Jalan",
    `- ${JSON.stringify(input.jalanSummary)}`,
    "",
    "## 4. Append",
    `- new_row_count=${input.appendPlan.new_row_count}`,
    `- skipped_identical_rows=${input.appendPlan.skipped_identical_rows}`,
    `- intraday_price_changes=${input.appendPlan.intraday_rows.length}`,
    `- metadata_only_diffs=${input.appendPlan.metadata_only_diffs.length}`,
    `- basis_or_classification_diffs=${input.appendPlan.basis_or_classification_diffs.length}`,
    `- hard_conflicts=${input.appendPlan.hard_conflicts.length}`,
    `- touched_shards=${JSON.stringify(input.appendPlan.touched_shards)}`,
    ...input.appendPlan.intraday_rows.map(
      (d) => `- intraday: ${d.base_row_id} ${d.existing_price}→${d.new_price} (Δ${d.price_delta}, ${d.price_delta_pct}%) → ${d.intraday_row_id}`
    ),
    "",
    "## 5. DB / AI Context",
    `- db_sync=${JSON.stringify(input.dbSyncResult)}`,
    `- ai_context=${JSON.stringify(input.aiContextResult)}`,
    "",
    "## 6. Safety",
    `${Object.entries(input.safety).map(([key, value]) => `- ${key}: ${value}`).join("\n")}`,
    "",
    "## 7. Output Paths",
    `- report_path=${input.reportPath}`,
    `- json_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugPath}`,
    ""
  ].join("\n");
}

function nextSaturdays(todayIso: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${todayIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  while (out.length < count) {
    if (d.getUTCDay() === 6) {
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function csvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/gu, "\"\"")}"` : value;
}
