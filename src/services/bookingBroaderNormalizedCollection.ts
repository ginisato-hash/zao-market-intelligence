// Phase BOOKING-B05X — Broader Booking.com normalized collection prototype.
//
// Broadens the small B04A/B04X Booking prototype into a BOUNDED set of Zao Onsen
// properties and dates, producing normalized market rows that are compatible with
// the local .data/history schema (zao_local_history_v1) and its DB mirror, WITHOUT
// appending history, writing the DB, or refreshing AI context.
//
// Price policy (inherited from Phase B04A, booking_official_visible_adder_v1):
//   computed_total_with_tax_fee = primary_price_numeric + official_tax_fee_adder_numeric
// NEVER primary_price_numeric × 1.1 + fee_adder. No synthetic tax multiplier, no
// inferred tax percentage, no estimated fees. When the official tax/fee adder is
// missing, the total stays null and the row is excluded from DP usage.

import {
  buildRowHash,
  buildRowId,
  HISTORY_SCHEMA_VERSION,
  shardMonthFromCheckin
} from "./localHistorySchemaDesign";
import { CANONICAL_NAME_BY_SLUG } from "./bookingMarketSignalNormalization";
import { BOOKING_PRICE_POLICY_VERSION, type B04ARow } from "./bookingOfficialTaxFeeTotalHardening";
import {
  buildBookingRenderedDomUrl,
  checkoutForOneNight,
  sanitizeBookingUrl,
  type BookingRenderedDomTarget
} from "./bookingRenderedDomProbe";

export const BOOKING_B05X_SOURCE_PHASE = "B05X";
export const BOOKING_B05X_COLLECTOR_STAGE = "prototype_read_only_b05x_broader_normalized";
export const BOOKING_B05X_STAY_SCOPE = "2_adults_1_room_1_night";

// Hard caps for the bounded broader collection (spec BOOKING-B05X).
export const B05X_MAX_PROPERTIES = 5;
export const B05X_MAX_DATES_PER_PROPERTY = 5;
export const B05X_MAX_PAGES = 25;
export const B05X_MAX_RUNTIME_MS = 600_000;

// Only Booking slugs that are independently verified are used. The property master
// (property_ota_links) currently has Booking entries with null URLs flagged
// "must be manually verified and not invented", so we DO NOT invent slugs.
export const B05X_VERIFIED_BOOKING_TARGETS: readonly BookingRenderedDomTarget[] = [
  { canonicalPropertyName: "蔵王国際ホテル", slug: "zao-kokusai" },
  { canonicalPropertyName: "蔵王四季のホテル", slug: "zao-shiki-no" },
  { canonicalPropertyName: "深山荘 高見屋", slug: "shinzanso-takamiya" }
] as const;

export const B05X_NEAR_TERM_DATES: readonly string[] = ["2026-06-14", "2026-06-21"];
export const B05X_PEAK_DATES: readonly string[] = ["2026-07-18", "2026-08-12", "2026-10-10"];
export const B05X_DEFAULT_DATES: readonly string[] = [...B05X_NEAR_TERM_DATES, ...B05X_PEAK_DATES];

// DB-mirror (market_signal_history) required columns the preview must cover. The
// preview is a prototype, so DB-assigned created_at/updated_at are intentionally
// omitted.
export const B05X_DB_MIRROR_REQUIRED_COLUMNS: readonly string[] = [
  "row_id",
  "row_hash",
  "shard_month",
  "collected_date_jst",
  "collected_at_jst",
  "normalized_at_jst",
  "source",
  "canonical_property_name",
  "source_property_id",
  "source_url",
  "checkin_date",
  "checkout_date",
  "stay_scope",
  "availability_status",
  "sold_out_flag",
  "normalized_total_jpy",
  "price_basis",
  "basis_confidence",
  "dp_usage",
  "classification",
  "exclusion_reason",
  "debug_artifact_path",
  "schema_version",
  "raw_json"
];

export type B05XDecision =
  | "booking_broader_normalized_collection_ready"
  | "booking_broader_normalized_collection_basis_caution"
  | "booking_broader_normalized_collection_not_ready";

export type B05XAvailabilityStatus =
  | "available"
  | "sold_out"
  | "not_listed"
  | "unavailable_or_unknown"
  | "blocked"
  | "navigation_failed";

export type B05XSoldOutStatus = "available" | "sold_out" | "not_listed" | "unknown";
export type B05XBasisConfidence = "A" | "B" | "C" | "none";
export type B05XDpUsage = "direct" | "directional" | "excluded";

export interface B05XTargetCell {
  canonicalPropertyName: string;
  slug: string;
  checkin: string;
  checkout: string;
  urlSanitized: string;
}

export interface B05XTargetMatrix {
  cells: B05XTargetCell[];
  propertyCount: number;
  datesPerProperty: number;
  pageCount: number;
  capsRespected: boolean;
  capNotes: string[];
}

// History-aligned normalized row preview. Column names mirror the DB target
// (market_signal_history) so the preview is directly DB-mirror compatible; row_id /
// row_hash / schema_version are produced with the canonical zao_local_history_v1
// helpers so it is also .data/history compatible.
export interface B05XNormalizedRowPreview {
  row_id: string;
  row_hash: string;
  shard_month: string;
  schema_version: string;
  collected_date_jst: string;
  collected_at_jst: string;
  normalized_at_jst: string;
  source: "booking";
  source_phase: string;
  collector_stage: string;
  price_policy_version: string;
  canonical_property_name: string;
  source_property_name: string;
  property_identity_match: boolean;
  source_property_id: string;
  source_slug_or_code: string;
  source_url: string;
  checkin_date: string;
  checkout_date: string;
  stay_scope: string;
  stay_nights: number;
  group_adults: number;
  no_rooms: number;
  group_children: number;
  currency: "JPY";
  language: "ja";
  availability_status: B05XAvailabilityStatus;
  sold_out_status: B05XSoldOutStatus;
  sold_out_flag: number | null;
  normalized_total_jpy: number | null;
  price_basis: string;
  basis_confidence: B05XBasisConfidence;
  source_primary_price: number | null;
  source_official_tax_fee_adder: number | null;
  source_computed_total_with_tax_fee: number | null;
  source_tax_basis_classification: string;
  classification: string;
  dp_usage: B05XDpUsage;
  exclusion_reason: string;
  basis_note: string;
  debug_artifact_path: string;
  raw_json: string;
}

export const B05X_CSV_HEADERS = [
  "row_id",
  "row_hash",
  "shard_month",
  "schema_version",
  "collected_date_jst",
  "collected_at_jst",
  "normalized_at_jst",
  "source",
  "source_phase",
  "collector_stage",
  "price_policy_version",
  "canonical_property_name",
  "source_property_name",
  "property_identity_match",
  "source_property_id",
  "source_slug_or_code",
  "source_url",
  "checkin_date",
  "checkout_date",
  "stay_scope",
  "stay_nights",
  "group_adults",
  "no_rooms",
  "group_children",
  "currency",
  "language",
  "availability_status",
  "sold_out_status",
  "sold_out_flag",
  "normalized_total_jpy",
  "price_basis",
  "basis_confidence",
  "source_primary_price",
  "source_official_tax_fee_adder",
  "source_computed_total_with_tax_fee",
  "source_tax_basis_classification",
  "classification",
  "dp_usage",
  "exclusion_reason",
  "basis_note",
  "debug_artifact_path",
  "raw_json"
] as const;

// ---------------------------------------------------------------------------
// Target matrix
// ---------------------------------------------------------------------------

export function buildB05XTargetMatrix(
  targets: readonly BookingRenderedDomTarget[],
  dates: readonly string[],
  caps: {
    maxProperties?: number;
    maxDatesPerProperty?: number;
    maxPages?: number;
  } = {}
): B05XTargetMatrix {
  const maxProperties = caps.maxProperties ?? B05X_MAX_PROPERTIES;
  const maxDatesPerProperty = caps.maxDatesPerProperty ?? B05X_MAX_DATES_PER_PROPERTY;
  const maxPages = caps.maxPages ?? B05X_MAX_PAGES;
  const capNotes: string[] = [];

  let boundedTargets = targets;
  if (targets.length > maxProperties) {
    boundedTargets = targets.slice(0, maxProperties);
    capNotes.push(`property_count_capped:${targets.length}->${maxProperties}`);
  }
  let boundedDates = dates;
  if (dates.length > maxDatesPerProperty) {
    boundedDates = dates.slice(0, maxDatesPerProperty);
    capNotes.push(`dates_per_property_capped:${dates.length}->${maxDatesPerProperty}`);
  }

  const cells: B05XTargetCell[] = [];
  for (const target of boundedTargets) {
    for (const checkin of boundedDates) {
      if (cells.length >= maxPages) {
        capNotes.push(`page_count_capped_at:${maxPages}`);
        break;
      }
      const checkout = checkoutForOneNight(checkin);
      const url = buildBookingRenderedDomUrl({ ...target, checkin });
      cells.push({
        canonicalPropertyName: target.canonicalPropertyName,
        slug: target.slug,
        checkin,
        checkout,
        urlSanitized: sanitizeBookingUrl(url)
      });
    }
    if (cells.length >= maxPages) break;
  }

  return {
    cells,
    propertyCount: boundedTargets.length,
    datesPerProperty: boundedDates.length,
    pageCount: cells.length,
    capsRespected: cells.length <= maxPages && boundedTargets.length <= maxProperties && boundedDates.length <= maxDatesPerProperty,
    capNotes
  };
}

// ---------------------------------------------------------------------------
// Normalization (B05X-specific: base + official adder, missing adder -> excluded)
// ---------------------------------------------------------------------------

interface AvailabilityMapping {
  availabilityStatus: B05XAvailabilityStatus;
  soldOutStatus: B05XSoldOutStatus;
  soldOutFlag: number | null;
}

function mapAvailability(row: B04ARow): AvailabilityMapping {
  switch (row.classification) {
    case "booking_b04a_navigation_failed":
      return { availabilityStatus: "navigation_failed", soldOutStatus: "unknown", soldOutFlag: null };
    case "booking_b04a_blocked":
      return { availabilityStatus: "blocked", soldOutStatus: "unknown", soldOutFlag: null };
    case "booking_b04a_property_mismatch":
      return { availabilityStatus: "unavailable_or_unknown", soldOutStatus: "unknown", soldOutFlag: null };
    case "booking_b04a_sold_out":
      return { availabilityStatus: "sold_out", soldOutStatus: "sold_out", soldOutFlag: 1 };
    default:
      if (row.primaryPriceNumeric !== null) {
        return { availabilityStatus: "available", soldOutStatus: "available", soldOutFlag: 0 };
      }
      return { availabilityStatus: "unavailable_or_unknown", soldOutStatus: "unknown", soldOutFlag: null };
  }
}

interface PriceGate {
  normalizedTotalJpy: number | null;
  priceBasis: string;
  basisConfidence: B05XBasisConfidence;
  dpUsage: B05XDpUsage;
  exclusionReason: string;
}

export function resolveB05XPriceGate(row: B04ARow, availabilityStatus: B05XAvailabilityStatus): PriceGate {
  const computed = row.computedTotalWithTaxFee;
  const primary = row.primaryPriceNumeric;
  const available = availabilityStatus === "available";
  const identity = row.propertyIdentityMatch;

  // Case 1: official total exists (numeric adder, or explicitly tax/fees included).
  if (computed !== null) {
    const confidence: B05XBasisConfidence = row.basisConfidence;
    const isAB = confidence === "A" || confidence === "B";
    let dpUsage: B05XDpUsage = "excluded";
    let exclusionReason = "";
    if (identity && available && confidence === "A") {
      dpUsage = "direct";
    } else if (identity && available && isAB) {
      dpUsage = "directional";
    } else {
      dpUsage = "excluded";
      if (!identity) exclusionReason = "property_identity_mismatch";
      else if (!available) exclusionReason = availabilityExclusionReason(availabilityStatus);
      else exclusionReason = "low_confidence_basis";
    }
    return {
      normalizedTotalJpy: computed,
      priceBasis: "room_total_official_base_plus_visible_tax_fee_2_adults_1_room_1_night",
      basisConfidence: confidence,
      dpUsage,
      exclusionReason
    };
  }

  // Case 2: a primary price is visible, but the official tax/fee adder is missing.
  // Spec rule: total stays null, confidence C, excluded, missing_official_tax_fee_adder.
  if (primary !== null) {
    return {
      normalizedTotalJpy: null,
      priceBasis: "booking_primary_price_available_but_official_tax_fee_adder_missing",
      basisConfidence: "C",
      dpUsage: "excluded",
      exclusionReason: "missing_official_tax_fee_adder"
    };
  }

  // Case 3: no usable price at all.
  return {
    normalizedTotalJpy: null,
    priceBasis: "no_usable_price",
    basisConfidence: "none",
    dpUsage: "excluded",
    exclusionReason: availabilityExclusionReason(availabilityStatus) || "no_usable_price"
  };
}

function availabilityExclusionReason(status: B05XAvailabilityStatus): string {
  switch (status) {
    case "blocked":
      return "blocked";
    case "navigation_failed":
      return "navigation_failed";
    case "sold_out":
      return "sold_out";
    case "unavailable_or_unknown":
      return "unavailable_or_unknown";
    default:
      return "";
  }
}

export function normalizeB05XRow(
  row: B04ARow,
  context: { collectedDateJst: string; collectedAtJst: string; normalizedAtJst: string }
): B05XNormalizedRowPreview {
  const canonicalPropertyName = CANONICAL_NAME_BY_SLUG[row.bookingSlug] ?? row.propertyNameExpected;
  const availability = mapAvailability(row);
  const gate = resolveB05XPriceGate(row, availability.availabilityStatus);

  const dpDirect = gate.dpUsage === "direct";
  const dpDirectional = gate.dpUsage === "direct" || gate.dpUsage === "directional";
  const dpExcluded = gate.dpUsage === "excluded";

  const rowId = buildRowId({
    collectedDateJst: context.collectedDateJst,
    source: "booking",
    canonicalPropertyName,
    sourceSlugOrCode: row.bookingSlug,
    sourcePropertyId: row.bookingSlug,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: BOOKING_B05X_STAY_SCOPE
  });

  const rowHash = buildRowHash({
    source: "booking",
    sourcePhase: BOOKING_B05X_SOURCE_PHASE,
    collectorStage: BOOKING_B05X_COLLECTOR_STAGE,
    canonicalPropertyName,
    sourceSlugOrCode: row.bookingSlug,
    sourcePropertyId: row.bookingSlug,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: BOOKING_B05X_STAY_SCOPE,
    collectedDateJst: context.collectedDateJst,
    availabilityStatus: availability.availabilityStatus,
    soldOutStatus: availability.soldOutStatus,
    normalizedTotalPrice: gate.normalizedTotalJpy,
    basisConfidence: gate.basisConfidence,
    sourceClassification: row.classification,
    isPriceUsableForDpDirect: dpDirect,
    isPriceUsableForDpDirectional: dpDirectional,
    isPriceExcludedFromDp: dpExcluded
  });

  const rawJson = JSON.stringify({
    slug: row.bookingSlug,
    checkin: row.checkin,
    primary_price_numeric: row.primaryPriceNumeric,
    official_tax_fee_adder_numeric: row.officialTaxFeeAdderNumeric,
    official_tax_fee_adder_extraction_status: row.officialTaxFeeAdderExtractionStatus,
    computed_total_with_tax_fee: row.computedTotalWithTaxFee,
    tax_basis_classification: row.taxBasisClassification,
    source_classification: row.classification,
    price_policy_version: row.pricePolicyVersion
  });

  return {
    row_id: rowId,
    row_hash: rowHash,
    shard_month: shardMonthFromCheckin(row.checkin),
    schema_version: HISTORY_SCHEMA_VERSION,
    collected_date_jst: context.collectedDateJst,
    collected_at_jst: context.collectedAtJst,
    normalized_at_jst: context.normalizedAtJst,
    source: "booking",
    source_phase: BOOKING_B05X_SOURCE_PHASE,
    collector_stage: BOOKING_B05X_COLLECTOR_STAGE,
    price_policy_version: BOOKING_PRICE_POLICY_VERSION,
    canonical_property_name: canonicalPropertyName,
    source_property_name: row.propertyNameDetected,
    property_identity_match: row.propertyIdentityMatch,
    source_property_id: row.bookingSlug,
    source_slug_or_code: row.bookingSlug,
    source_url: row.finalUrlSanitized || row.urlSanitized,
    checkin_date: row.checkin,
    checkout_date: row.checkout,
    stay_scope: BOOKING_B05X_STAY_SCOPE,
    stay_nights: 1,
    group_adults: 2,
    no_rooms: 1,
    group_children: 0,
    currency: "JPY",
    language: "ja",
    availability_status: availability.availabilityStatus,
    sold_out_status: availability.soldOutStatus,
    sold_out_flag: availability.soldOutFlag,
    normalized_total_jpy: gate.normalizedTotalJpy,
    price_basis: gate.priceBasis,
    basis_confidence: gate.basisConfidence,
    source_primary_price: row.primaryPriceNumeric,
    source_official_tax_fee_adder: row.officialTaxFeeAdderNumeric,
    source_computed_total_with_tax_fee: row.computedTotalWithTaxFee,
    source_tax_basis_classification: row.taxBasisClassification,
    classification: row.classification,
    dp_usage: gate.dpUsage,
    exclusion_reason: gate.exclusionReason,
    basis_note: row.basisNote,
    debug_artifact_path: row.debugArtifactPath ?? "",
    raw_json: rawJson
  };
}

export function normalizeB05XRows(
  rows: B04ARow[],
  context: { collectedDateJst: string; collectedAtJst: string; normalizedAtJst: string }
): B05XNormalizedRowPreview[] {
  return rows.map((row) => normalizeB05XRow(row, context));
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export interface B05XDpUsageSummary {
  direct: number;
  directional: number;
  excluded: number;
}

export function summarizeB05XDpUsage(rows: B05XNormalizedRowPreview[]): B05XDpUsageSummary {
  return {
    direct: rows.filter((r) => r.dp_usage === "direct").length,
    directional: rows.filter((r) => r.dp_usage === "direct" || r.dp_usage === "directional").length,
    excluded: rows.filter((r) => r.dp_usage === "excluded").length
  };
}

export interface B05XPriceBasisSummary {
  rows_total: number;
  normalized_total_present: number;
  normalized_total_missing: number;
  missing_official_tax_fee_adder: number;
  basis_confidence_counts: Record<string, number>;
  price_basis_counts: Record<string, number>;
  availability_counts: Record<string, number>;
}

export function summarizeB05XPriceBasis(rows: B05XNormalizedRowPreview[]): B05XPriceBasisSummary {
  return {
    rows_total: rows.length,
    normalized_total_present: rows.filter((r) => r.normalized_total_jpy !== null).length,
    normalized_total_missing: rows.filter((r) => r.normalized_total_jpy === null).length,
    missing_official_tax_fee_adder: rows.filter((r) => r.exclusion_reason === "missing_official_tax_fee_adder").length,
    basis_confidence_counts: countBy(rows.map((r) => r.basis_confidence)),
    price_basis_counts: countBy(rows.map((r) => r.price_basis)),
    availability_counts: countBy(rows.map((r) => r.availability_status))
  };
}

export interface B05XSchemaCompatibilitySummary {
  schema_version: string;
  db_mirror_required_columns: string[];
  covered_columns: string[];
  missing_columns: string[];
  compatible: boolean;
}

export function buildB05XSchemaCompatibilitySummary(): B05XSchemaCompatibilitySummary {
  const headerSet = new Set<string>(B05X_CSV_HEADERS);
  const missing = B05X_DB_MIRROR_REQUIRED_COLUMNS.filter((col) => !headerSet.has(col));
  const covered = B05X_DB_MIRROR_REQUIRED_COLUMNS.filter((col) => headerSet.has(col));
  return {
    schema_version: HISTORY_SCHEMA_VERSION,
    db_mirror_required_columns: [...B05X_DB_MIRROR_REQUIRED_COLUMNS],
    covered_columns: covered,
    missing_columns: missing,
    compatible: missing.length === 0
  };
}

// ---------------------------------------------------------------------------
// Sold-out semantics guard (mirrors the cross-source contract)
// ---------------------------------------------------------------------------

export interface B05XSoldOutSemanticsGuard {
  classification_for_single_full_context: string;
  property_level_sold_out: false;
  usable_for_property_sold_out_pressure: false;
  property_level_requirements: string[];
}

export function buildB05XSoldOutSemanticsGuard(): B05XSoldOutSemanticsGuard {
  return {
    classification_for_single_full_context: "booking_property_page_sold_out_for_search_condition",
    property_level_sold_out: false,
    usable_for_property_sold_out_pressure: false,
    property_level_requirements: [
      "the property page shows no available rooms for the search condition",
      "the no-availability state is confirmed across multiple dates, not a single date",
      "no usable price candidate is extractable for the searched condition",
      "an explicit no-vacancy indicator is visible, not merely an empty parse"
    ]
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideB05X(rows: B05XNormalizedRowPreview[]): B05XDecision {
  const usableDirectional = rows.filter(
    (r) => r.normalized_total_jpy !== null && (r.dp_usage === "direct" || r.dp_usage === "directional")
  ).length;
  if (usableDirectional >= 3) return "booking_broader_normalized_collection_ready";
  if (rows.some((r) => r.normalized_total_jpy !== null)) return "booking_broader_normalized_collection_basis_caution";
  return "booking_broader_normalized_collection_not_ready";
}

export function recommendedNextActionForB05X(decision: B05XDecision): string {
  if (decision === "booking_broader_normalized_collection_ready") {
    return "- Proceed to Phase BOOKING-B06X (Booking normalized history append proposal) as a dry-run only. Keep DB writes / history append / AI context refresh disabled until B06X is explicitly approved.";
  }
  if (decision === "booking_broader_normalized_collection_basis_caution") {
    return "- Some rows normalized but coverage is thin or official adders are mostly missing; inspect debug artifacts before any append proposal. Do not estimate tax, do not multiply by 1.1, do not append history.";
  }
  return "- Not ready: no usable normalized totals (likely blocking/consent/no-price). Do not broaden crawling, do not append history; document the blocking state and keep Booking experimental.";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderB05XCsv(rows: B05XNormalizedRowPreview[]): string {
  const body = rows.map((row) =>
    [
      row.row_id,
      row.row_hash,
      row.shard_month,
      row.schema_version,
      row.collected_date_jst,
      row.collected_at_jst,
      row.normalized_at_jst,
      row.source,
      row.source_phase,
      row.collector_stage,
      row.price_policy_version,
      row.canonical_property_name,
      row.source_property_name,
      bool(row.property_identity_match),
      row.source_property_id,
      row.source_slug_or_code,
      row.source_url,
      row.checkin_date,
      row.checkout_date,
      row.stay_scope,
      String(row.stay_nights),
      String(row.group_adults),
      String(row.no_rooms),
      String(row.group_children),
      row.currency,
      row.language,
      row.availability_status,
      row.sold_out_status,
      row.sold_out_flag === null ? "" : String(row.sold_out_flag),
      row.normalized_total_jpy === null ? "" : String(row.normalized_total_jpy),
      row.price_basis,
      row.basis_confidence,
      row.source_primary_price === null ? "" : String(row.source_primary_price),
      row.source_official_tax_fee_adder === null ? "" : String(row.source_official_tax_fee_adder),
      row.source_computed_total_with_tax_fee === null ? "" : String(row.source_computed_total_with_tax_fee),
      row.source_tax_basis_classification,
      row.classification,
      row.dp_usage,
      row.exclusion_reason,
      row.basis_note,
      row.debug_artifact_path,
      row.raw_json
    ]
      .map(csvEscape)
      .join(",")
  );
  return [B05X_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderB05XReport(input: {
  generatedAt: string;
  rows: B05XNormalizedRowPreview[];
  matrix: B05XTargetMatrix;
  decision: B05XDecision;
  dpUsage: B05XDpUsageSummary;
  priceBasis: B05XPriceBasisSummary;
  schemaCompatibility: B05XSchemaCompatibilitySummary;
  soldOutGuard: B05XSoldOutSemanticsGuard;
  pageLoadCount: number;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}): string {
  return [
    "# Booking.com Broader Normalized Collection Prototype (Phase BOOKING-B05X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Summary",
    "",
    `- decision=${input.decision}`,
    `- rows=${input.rows.length}`,
    `- page_load_count=${input.pageLoadCount}`,
    `- normalized_total_present=${input.priceBasis.normalized_total_present}`,
    `- normalized_total_missing=${input.priceBasis.normalized_total_missing}`,
    "",
    "## 2. Price policy",
    "",
    `- price_policy_version=${BOOKING_PRICE_POLICY_VERSION}`,
    "- computed_total_with_tax_fee = primary_price_numeric + official_tax_fee_adder_numeric.",
    "- NEVER primary_price_numeric × 1.1 + fee_adder. No synthetic tax multiplier, no inferred tax, no estimated fees.",
    "- Missing official tax/fee adder ⇒ total null, basis_confidence=C, dp_usage=excluded, exclusion_reason=missing_official_tax_fee_adder.",
    "",
    "## 3. Bounded target matrix",
    "",
    `- property_count=${input.matrix.propertyCount} (cap=${B05X_MAX_PROPERTIES})`,
    `- dates_per_property=${input.matrix.datesPerProperty} (cap=${B05X_MAX_DATES_PER_PROPERTY})`,
    `- page_count=${input.matrix.pageCount} (cap=${B05X_MAX_PAGES})`,
    `- caps_respected=${bool(input.matrix.capsRespected)}`,
    `- cap_notes=${input.matrix.capNotes.length > 0 ? input.matrix.capNotes.join("; ") : "(none)"}`,
    "",
    "## 4. Matrix cells",
    "",
    ...input.matrix.cells.map((c) => `- ${c.canonicalPropertyName} (${c.slug}) ${c.checkin}→${c.checkout}: ${c.urlSanitized}`),
    "",
    "## 5. Verified-slug scope note",
    "",
    "- Only independently verified Booking slugs are used.",
    "- The property master (property_ota_links) Booking entries currently have null URLs flagged 'must be manually verified and not invented'; no slugs were invented.",
    "",
    "## 6. Normalized rows",
    "",
    ...input.rows.map(
      (r) =>
        `- ${r.canonical_property_name} ${r.checkin_date}: total=${r.normalized_total_jpy ?? "null"}, base=${r.source_primary_price ?? "n/a"}, adder=${r.source_official_tax_fee_adder ?? "n/a"}, conf=${r.basis_confidence}, avail=${r.availability_status}, dp=${r.dp_usage}${r.exclusion_reason ? ` (${r.exclusion_reason})` : ""}`
    ),
    "",
    "## 7. DP usage gate",
    "",
    `- direct=${input.dpUsage.direct}`,
    `- directional=${input.dpUsage.directional}`,
    `- excluded=${input.dpUsage.excluded}`,
    "",
    "## 8. Price basis summary",
    "",
    `- basis_confidence_counts=${JSON.stringify(input.priceBasis.basis_confidence_counts)}`,
    `- price_basis_counts=${JSON.stringify(input.priceBasis.price_basis_counts)}`,
    `- availability_counts=${JSON.stringify(input.priceBasis.availability_counts)}`,
    `- missing_official_tax_fee_adder=${input.priceBasis.missing_official_tax_fee_adder}`,
    "",
    "## 9. Excluded rows",
    "",
    ...excludedLines(input.rows),
    "",
    "## 10. Canonical property mapping",
    "",
    ...uniqueMappingLines(input.rows),
    "",
    "## 11. Schema compatibility (.data/history / DB mirror)",
    "",
    `- schema_version=${input.schemaCompatibility.schema_version}`,
    `- compatible=${bool(input.schemaCompatibility.compatible)}`,
    `- covered_columns=${input.schemaCompatibility.covered_columns.length}/${input.schemaCompatibility.db_mirror_required_columns.length}`,
    `- missing_columns=${input.schemaCompatibility.missing_columns.length > 0 ? input.schemaCompatibility.missing_columns.join(", ") : "(none)"}`,
    "",
    "## 12. Row identity & hash",
    "",
    "- row_id / row_hash produced with the canonical zao_local_history_v1 helpers (buildRowId / buildRowHash).",
    "- This is a PREVIEW only: rows are NOT appended to .data/history and are NOT written to the DB.",
    "",
    "## 13. Sold-out semantics guard",
    "",
    `- classification_for_single_full_context=${input.soldOutGuard.classification_for_single_full_context}`,
    `- property_level_sold_out=${bool(input.soldOutGuard.property_level_sold_out)}`,
    `- usable_for_property_sold_out_pressure=${bool(input.soldOutGuard.usable_for_property_sold_out_pressure)}`,
    ...input.soldOutGuard.property_level_requirements.map((req) => `- property_level_requirement: ${req}`),
    "",
    "## 14. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 15. Strategic note",
    "",
    "- Booking.com remains the stronger near-term source for inbound/directional pricing signals.",
    "- Jalan remains the strongest domestic/direct-capable source; Rakuten stays frozen (NO_GO_FREEZE_RAKUTEN).",
    "- This prototype only proves bounded normalized collection feasibility; it does not promote Booking to a DB collector.",
    "",
    "## 16. Safety confirmation",
    "",
    "- Read-only rendered DOM over a bounded set of fixed Booking.com property-page URLs (no search results, no pagination, no broad crawl).",
    "- No history append, no DB writes, no AI context refresh, no GitHub Actions/cron.",
    "- No login, no cookie injection, no stealth, no CAPTCHA bypass, no paid proxy/API.",
    "- No Beds24/AirHost/PMS/OTA upload output. No base × 1.1; totals are official base + visible adder only.",
    "",
    "## 17. Decision basis",
    "",
    `- decision=${input.decision}`,
    "- ready requires ≥3 normalized rows usable for DP (direct/directional); basis_caution if any usable total exists; otherwise not_ready.",
    "",
    "## 18. Recommended next action",
    "",
    recommendedNextActionForB05X(input.decision),
    ""
  ].join("\n");
}

function excludedLines(rows: B05XNormalizedRowPreview[]): string[] {
  const excluded = rows.filter((r) => r.dp_usage === "excluded");
  if (excluded.length === 0) return ["- (none)"];
  return excluded.map((r) => `- ${r.canonical_property_name} ${r.checkin_date}: ${r.exclusion_reason || "unspecified"}`);
}

function uniqueMappingLines(rows: B05XNormalizedRowPreview[]): string[] {
  const seen = new Map<string, B05XNormalizedRowPreview>();
  for (const r of rows) if (!seen.has(r.source_slug_or_code)) seen.set(r.source_slug_or_code, r);
  if (seen.size === 0) return ["- (none)"];
  return [...seen.values()].map(
    (r) => `- ${r.source_slug_or_code} → ${r.canonical_property_name} (identity_match=${bool(r.property_identity_match)})`
  );
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
