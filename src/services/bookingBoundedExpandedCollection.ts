// Phase BOOKING-B09X — bounded expanded Booking.com normalized collection.
//
// Executes only the B08X-approved fixed Booking.com property/date matrix and
// produces PREVIEW rows compatible with .data/history / DB mirror schema. It does
// not append history, write DB rows, refresh AI context, or emit PMS/OTA output.
// Booking.com totals use the official visible base + official visible adder
// policy only; the synthetic base-times-1.1 rule is rejected.

import { BOOKING_PRICE_POLICY_VERSION, type B04ARow } from "./bookingOfficialTaxFeeTotalHardening";
import { buildBookingRenderedDomUrl, checkoutForOneNight, sanitizeBookingUrl } from "./bookingRenderedDomProbe";
import { buildRowHash, buildRowId, HISTORY_SCHEMA_VERSION, shardMonthFromCheckin } from "./localHistorySchemaDesign";

export const BOOKING_B09X_SOURCE_PHASE = "B09X";
export const BOOKING_B09X_COLLECTOR_STAGE = "bounded_expanded_normalized_collection";
export const BOOKING_B09X_STAY_SCOPE = "2_adults_1_room_1_night";
export const B09X_MAX_PROPERTIES = 3;
export const B09X_MAX_DATES_PER_PROPERTY = 10;
export const B09X_MAX_PAGES = 30;

export type BookingB09XDecision =
  | "booking_bounded_expanded_collection_ready"
  | "booking_bounded_expanded_collection_basis_caution"
  | "booking_bounded_expanded_collection_not_ready";

export type BookingB09XDpUsage = "directional" | "excluded";
export type BookingB09XBasisConfidence = "B" | "C";
export type BookingB09XAvailabilityStatus = "available" | "sold_out" | "not_listed" | "unavailable_or_unknown" | "blocked" | "navigation_failed";
export type BookingB09XSoldOutStatus = "available" | "sold_out" | "not_listed" | "unknown";

export const B09X_VERIFIED_SLUGS = new Map<string, string>([
  ["蔵王国際ホテル", "zao-kokusai"],
  ["蔵王四季のホテル", "zao-shiki-no"],
  ["深山荘 高見屋", "shinzanso-takamiya"]
]);

export interface B08XTargetCell {
  canonical_property_name: string;
  booking_slug: string;
  checkin: string;
  checkout: string;
  url: string;
  query_scope: string;
  slug_status: string;
  risk_level: string;
}

export interface B08XProposalLike {
  decision: string;
  proposed_b09x_target_matrix: B08XTargetCell[];
  page_cap_plan?: {
    max_properties: number;
    max_dates_per_property: number;
    max_pages: number;
    proposed_pages: number;
    caps_respected: boolean;
  };
}

export interface TargetMatrixValidation {
  target_count: number;
  property_count: number;
  dates_per_property_max: number;
  max_pages: number;
  fixed_slug_urls_only: boolean;
  search_pages_used: boolean;
  unverified_slug_count: number;
  invalid_checkout_count: number;
  cap_exceeded: boolean;
  valid: boolean;
  reasons: string[];
}

export interface B09XNormalizedPreviewRow {
  row_id: string;
  row_hash: string;
  shard_month: string;
  collected_date_jst: string;
  collected_at_jst: string;
  normalized_at_jst: string;
  source: "booking";
  source_phase: "B09X";
  collector_stage: "bounded_expanded_normalized_collection";
  canonical_property_name: string;
  source_property_name: string;
  property_identity_match: boolean;
  source_property_id: string;
  source_slug_or_code: string;
  source_url: string;
  checkin: string;
  checkout: string;
  checkin_date: string;
  checkout_date: string;
  stay_nights: number;
  group_adults: number;
  no_rooms: number;
  group_children: number;
  currency: "JPY";
  language: "ja";
  stay_scope: "2_adults_1_room_1_night";
  availability_status: BookingB09XAvailabilityStatus;
  sold_out_status: BookingB09XSoldOutStatus;
  sold_out_flag: number | null;
  normalized_total_price: number | null;
  normalized_total_jpy: number | null;
  normalized_total_price_source: string | null;
  normalized_total_price_basis: string;
  normalized_total_price_confidence: BookingB09XBasisConfidence;
  basis_confidence: BookingB09XBasisConfidence;
  basis_note: string;
  source_primary_price: number | null;
  source_secondary_price_or_adder: number | null;
  source_computed_total: number | null;
  source_tax_or_fee_classification: string;
  source_classification: string;
  classification: string;
  is_price_usable_for_dp_direct: false;
  is_price_usable_for_dp_directional: boolean;
  is_price_excluded_from_dp: boolean;
  price_pressure_usable: boolean;
  dp_usable: false;
  dp_usage: BookingB09XDpUsage;
  dp_exclusion_reason: string | null;
  exclusion_reason: string;
  warning_flags: string;
  source_report_path: string;
  source_csv_path: string;
  debug_artifact_path: string;
  schema_version: string;
}

export const B09X_CSV_HEADERS = [
  "row_id",
  "row_hash",
  "shard_month",
  "collected_date_jst",
  "collected_at_jst",
  "normalized_at_jst",
  "source",
  "source_phase",
  "collector_stage",
  "canonical_property_name",
  "source_property_name",
  "property_identity_match",
  "source_property_id",
  "source_slug_or_code",
  "source_url",
  "checkin",
  "checkout",
  "stay_nights",
  "group_adults",
  "no_rooms",
  "group_children",
  "currency",
  "language",
  "stay_scope",
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
  "source_report_path",
  "source_csv_path",
  "debug_artifact_path",
  "schema_version"
] as const;

export function validateB09XTargetMatrix(cells: readonly B08XTargetCell[]): TargetMatrixValidation {
  const reasons: string[] = [];
  const byProperty = new Map<string, number>();
  let fixedSlugUrlsOnly = true;
  let searchPagesUsed = false;
  let unverifiedSlugCount = 0;
  let invalidCheckoutCount = 0;

  for (const cell of cells) {
    byProperty.set(cell.canonical_property_name, (byProperty.get(cell.canonical_property_name) ?? 0) + 1);
    const verified = B09X_VERIFIED_SLUGS.get(cell.canonical_property_name);
    if (verified !== cell.booking_slug) unverifiedSlugCount += 1;
    if (!isFixedBookingPropertyUrl(cell.url, cell.booking_slug)) fixedSlugUrlsOnly = false;
    if (isBookingSearchUrl(cell.url)) searchPagesUsed = true;
    if (cell.checkout !== checkoutForOneNight(cell.checkin)) invalidCheckoutCount += 1;
  }

  const propertyCount = byProperty.size;
  const datesPerPropertyMax = Math.max(0, ...byProperty.values());
  const capExceeded =
    cells.length > B09X_MAX_PAGES || propertyCount > B09X_MAX_PROPERTIES || datesPerPropertyMax > B09X_MAX_DATES_PER_PROPERTY;

  if (capExceeded) reasons.push("target_matrix_exceeds_cap");
  if (!fixedSlugUrlsOnly) reasons.push("non_fixed_property_url_detected");
  if (searchPagesUsed) reasons.push("booking_search_page_detected");
  if (unverifiedSlugCount > 0) reasons.push("unverified_slug_detected");
  if (invalidCheckoutCount > 0) reasons.push("invalid_checkout_detected");

  return {
    target_count: cells.length,
    property_count: propertyCount,
    dates_per_property_max: datesPerPropertyMax,
    max_pages: B09X_MAX_PAGES,
    fixed_slug_urls_only: fixedSlugUrlsOnly,
    search_pages_used: searchPagesUsed,
    unverified_slug_count: unverifiedSlugCount,
    invalid_checkout_count: invalidCheckoutCount,
    cap_exceeded: capExceeded,
    valid: reasons.length === 0,
    reasons
  };
}

export function buildB09XUrl(cell: Pick<B08XTargetCell, "canonical_property_name" | "booking_slug" | "checkin">): string {
  const verified = B09X_VERIFIED_SLUGS.get(cell.canonical_property_name);
  if (verified !== cell.booking_slug) throw new Error(`unverified Booking slug: ${cell.canonical_property_name}/${cell.booking_slug}`);
  return buildBookingRenderedDomUrl({
    canonicalPropertyName: cell.canonical_property_name,
    slug: cell.booking_slug,
    checkin: cell.checkin
  });
}

export function normalizeB09XRow(
  row: B04ARow,
  context: {
    collectedDateJst: string;
    collectedAtJst: string;
    normalizedAtJst: string;
    sourceReportPath: string;
    sourceCsvPath: string;
  }
): B09XNormalizedPreviewRow {
  const availability = mapB09XAvailability(row);
  const gate = resolveB09XPriceGate(row, availability.availability_status);
  const canonicalPropertyName = canonicalNameForSlug(row.bookingSlug) ?? row.propertyNameExpected;
  const sourceUrl = sanitizeBookingUrl(row.finalUrlSanitized || row.urlSanitized);
  const warningFlags = buildWarningFlags(row, gate.exclusionReason);

  const rowId = buildRowId({
    collectedDateJst: context.collectedDateJst,
    source: "booking",
    canonicalPropertyName,
    sourceSlugOrCode: row.bookingSlug,
    sourcePropertyId: row.bookingSlug,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: BOOKING_B09X_STAY_SCOPE
  });
  const rowHash = buildRowHash({
    source: "booking",
    sourcePhase: BOOKING_B09X_SOURCE_PHASE,
    collectorStage: BOOKING_B09X_COLLECTOR_STAGE,
    canonicalPropertyName,
    sourceSlugOrCode: row.bookingSlug,
    sourcePropertyId: row.bookingSlug,
    checkin: row.checkin,
    checkout: row.checkout,
    stayScope: BOOKING_B09X_STAY_SCOPE,
    collectedDateJst: context.collectedDateJst,
    availabilityStatus: availability.availability_status,
    soldOutStatus: availability.sold_out_status,
    normalizedTotalPrice: gate.normalizedTotalPrice,
    basisConfidence: gate.basisConfidence,
    sourceClassification: gate.classification,
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: gate.dpUsage === "directional",
    isPriceExcludedFromDp: gate.dpUsage === "excluded"
  });

  return {
    row_id: rowId,
    row_hash: rowHash,
    shard_month: shardMonthFromCheckin(row.checkin),
    collected_date_jst: context.collectedDateJst,
    collected_at_jst: context.collectedAtJst,
    normalized_at_jst: context.normalizedAtJst,
    source: "booking",
    source_phase: BOOKING_B09X_SOURCE_PHASE,
    collector_stage: BOOKING_B09X_COLLECTOR_STAGE,
    canonical_property_name: canonicalPropertyName,
    source_property_name: row.propertyNameDetected,
    property_identity_match: row.propertyIdentityMatch,
    source_property_id: row.bookingSlug,
    source_slug_or_code: row.bookingSlug,
    source_url: sourceUrl,
    checkin: row.checkin,
    checkout: row.checkout,
    checkin_date: row.checkin,
    checkout_date: row.checkout,
    stay_nights: 1,
    group_adults: 2,
    no_rooms: 1,
    group_children: 0,
    currency: "JPY",
    language: "ja",
    stay_scope: BOOKING_B09X_STAY_SCOPE,
    availability_status: availability.availability_status,
    sold_out_status: availability.sold_out_status,
    sold_out_flag: availability.sold_out_flag,
    normalized_total_price: gate.normalizedTotalPrice,
    normalized_total_jpy: gate.normalizedTotalPrice,
    normalized_total_price_source: gate.normalizedTotalPrice === null ? null : "booking_official_visible_total",
    normalized_total_price_basis: gate.priceBasis,
    normalized_total_price_confidence: gate.basisConfidence,
    basis_confidence: gate.basisConfidence,
    basis_note: gate.basisNote,
    source_primary_price: row.primaryPriceNumeric,
    source_secondary_price_or_adder: row.officialTaxFeeAdderNumeric,
    source_computed_total: row.computedTotalWithTaxFee,
    source_tax_or_fee_classification: row.taxBasisClassification,
    source_classification: row.classification,
    classification: gate.classification,
    is_price_usable_for_dp_direct: false,
    is_price_usable_for_dp_directional: gate.dpUsage === "directional",
    is_price_excluded_from_dp: gate.dpUsage === "excluded",
    price_pressure_usable: gate.dpUsage === "directional",
    dp_usable: false,
    dp_usage: gate.dpUsage,
    dp_exclusion_reason: gate.exclusionReason || null,
    exclusion_reason: gate.exclusionReason,
    warning_flags: warningFlags,
    source_report_path: context.sourceReportPath,
    source_csv_path: context.sourceCsvPath,
    debug_artifact_path: row.debugArtifactPath,
    schema_version: HISTORY_SCHEMA_VERSION
  };
}

export function normalizeB09XRows(
  rows: readonly B04ARow[],
  context: Parameters<typeof normalizeB09XRow>[1]
): B09XNormalizedPreviewRow[] {
  return rows.map((row) => normalizeB09XRow(row, context));
}

interface B09XAvailability {
  availability_status: BookingB09XAvailabilityStatus;
  sold_out_status: BookingB09XSoldOutStatus;
  sold_out_flag: number | null;
}

function mapB09XAvailability(row: B04ARow): B09XAvailability {
  if (row.classification === "booking_b04a_navigation_failed") {
    return { availability_status: "navigation_failed", sold_out_status: "unknown", sold_out_flag: null };
  }
  if (row.classification === "booking_b04a_blocked") {
    return { availability_status: "blocked", sold_out_status: "unknown", sold_out_flag: null };
  }
  if (row.classification === "booking_b04a_sold_out") {
    return { availability_status: "sold_out", sold_out_status: "sold_out", sold_out_flag: 1 };
  }
  if (row.primaryPriceNumeric !== null) {
    return { availability_status: "available", sold_out_status: "available", sold_out_flag: 0 };
  }
  return { availability_status: "unavailable_or_unknown", sold_out_status: "unknown", sold_out_flag: null };
}

function resolveB09XPriceGate(
  row: B04ARow,
  availabilityStatus: BookingB09XAvailabilityStatus
): {
  normalizedTotalPrice: number | null;
  priceBasis: string;
  basisConfidence: BookingB09XBasisConfidence;
  basisNote: string;
  dpUsage: BookingB09XDpUsage;
  exclusionReason: string;
  classification: string;
} {
  const officialTotalVisible = row.computedTotalWithTaxFee !== null && row.propertyIdentityMatch && availabilityStatus === "available";
  if (officialTotalVisible) {
    return {
      normalizedTotalPrice: row.computedTotalWithTaxFee,
      priceBasis: "booking_official_visible_base_plus_tax_fee_adder_2_adults_1_room_1_night",
      basisConfidence: "B",
      basisNote:
        "Booking.com directional total = official visible base price + official visible tax/fee adder; no synthetic tax multiplier applied. Booking rows remain directional, not direct.",
      dpUsage: "directional",
      exclusionReason: "",
      classification: "booking_official_total_directional"
    };
  }
  if (row.primaryPriceNumeric !== null) {
    return {
      normalizedTotalPrice: null,
      priceBasis: "booking_primary_price_available_but_official_tax_fee_adder_missing",
      basisConfidence: "C",
      basisNote:
        "Primary Booking.com price was visible, but the official tax/fee adder was missing or basis was incomplete; total was not estimated.",
      dpUsage: "excluded",
      exclusionReason: "missing_official_tax_fee_adder",
      classification: "booking_missing_official_tax_fee_adder"
    };
  }
  return {
    normalizedTotalPrice: null,
    priceBasis: "booking_page_blocked_or_unavailable",
    basisConfidence: "C",
    basisNote: "Booking.com page was blocked, unavailable, sold out, mismatched, or did not expose a usable official total.",
    dpUsage: "excluded",
    exclusionReason: "booking_page_blocked_or_unavailable",
    classification: "booking_page_unavailable"
  };
}

function buildWarningFlags(row: B04ARow, exclusionReason: string): string {
  const flags: string[] = [];
  if (!row.propertyIdentityMatch) flags.push("property_identity_mismatch");
  if (row.blockingOrModalState && row.blockingOrModalState !== "none") flags.push(row.blockingOrModalState);
  if (row.classification === "booking_b04a_blocked") flags.push("blocked_or_security");
  if (row.classification === "booking_b04a_navigation_failed") flags.push("navigation_failed");
  if (exclusionReason) flags.push(exclusionReason);
  return [...new Set(flags)].join(";");
}

function canonicalNameForSlug(slug: string): string | null {
  for (const [name, verifiedSlug] of B09X_VERIFIED_SLUGS.entries()) {
    if (verifiedSlug === slug) return name;
  }
  return null;
}

export function summarizeB09XRows(rows: readonly B09XNormalizedPreviewRow[]): {
  total_rows: number;
  directional_rows: number;
  excluded_rows: number;
  direct_rows: 0;
  normalized_total_present: number;
  normalized_total_missing: number;
  booking_direct_rows: 0;
} {
  return {
    total_rows: rows.length,
    directional_rows: rows.filter((r) => r.dp_usage === "directional").length,
    excluded_rows: rows.filter((r) => r.dp_usage === "excluded").length,
    direct_rows: 0,
    normalized_total_present: rows.filter((r) => r.normalized_total_price !== null).length,
    normalized_total_missing: rows.filter((r) => r.normalized_total_price === null).length,
    booking_direct_rows: 0
  };
}

export function summarizeB09XPriceBasis(rows: readonly B09XNormalizedPreviewRow[]): {
  policy_version: string;
  computed_total_rule: "primary_price_numeric + official_tax_fee_adder_numeric";
  forbidden_rule_rejected: "primary_price_numeric * 1.1";
  basis_confidence_counts: Record<string, number>;
  classification_counts: Record<string, number>;
  missing_official_tax_fee_adder: number;
  official_total_directional: number;
} {
  return {
    policy_version: BOOKING_PRICE_POLICY_VERSION,
    computed_total_rule: "primary_price_numeric + official_tax_fee_adder_numeric",
    forbidden_rule_rejected: "primary_price_numeric * 1.1",
    basis_confidence_counts: countBy(rows.map((r) => r.basis_confidence)),
    classification_counts: countBy(rows.map((r) => r.classification)),
    missing_official_tax_fee_adder: rows.filter((r) => r.exclusion_reason === "missing_official_tax_fee_adder").length,
    official_total_directional: rows.filter((r) => r.classification === "booking_official_total_directional").length
  };
}

export function summarizeB09XBlockDetection(rows: readonly B09XNormalizedPreviewRow[]): {
  blocked_or_unavailable_rows: number;
  blocked_or_unavailable_ratio: number;
  more_than_30_percent_blocked: boolean;
  more_than_60_percent_blocked: boolean;
} {
  const blocked = rows.filter((r) => r.exclusion_reason === "booking_page_blocked_or_unavailable").length;
  const ratio = rows.length === 0 ? 0 : blocked / rows.length;
  return {
    blocked_or_unavailable_rows: blocked,
    blocked_or_unavailable_ratio: ratio,
    more_than_30_percent_blocked: ratio > 0.3,
    more_than_60_percent_blocked: ratio > 0.6
  };
}

export function buildB09XSchemaCompatibilitySummary(rows: readonly B09XNormalizedPreviewRow[]): {
  schema_version: string;
  required_columns: string[];
  missing_columns_by_row: number;
  compatible: boolean;
  preview_only: true;
} {
  const missingRows = rows.filter((row) => B09X_CSV_HEADERS.some((key) => row[key] === undefined)).length;
  return {
    schema_version: HISTORY_SCHEMA_VERSION,
    required_columns: [...B09X_CSV_HEADERS],
    missing_columns_by_row: missingRows,
    compatible: missingRows === 0 && rows.every((row) => row.schema_version === HISTORY_SCHEMA_VERSION),
    preview_only: true
  };
}

export function decideB09X(input: {
  matrixValidation: TargetMatrixValidation;
  rows: readonly B09XNormalizedPreviewRow[];
  blockSummary: ReturnType<typeof summarizeB09XBlockDetection>;
  schemaCompatibility: ReturnType<typeof buildB09XSchemaCompatibilitySummary>;
}): BookingB09XDecision {
  if (!input.matrixValidation.valid || !input.schemaCompatibility.compatible || input.blockSummary.more_than_60_percent_blocked) {
    return "booking_bounded_expanded_collection_not_ready";
  }
  const usable = input.rows.filter((row) => row.dp_usage === "directional").length;
  if (input.blockSummary.more_than_30_percent_blocked || usable === 0 || input.rows.some((row) => row.dp_usage === "excluded")) {
    return "booking_bounded_expanded_collection_basis_caution";
  }
  return "booking_bounded_expanded_collection_ready";
}

export function buildB09XFutureB10XPlan() {
  return {
    phase: "BOOKING-B10X — Booking bounded expanded history append proposal",
    execute_now: false,
    steps: [
      "Read B09X normalized preview rows.",
      "Compare row_id / row_hash against current .data/history.",
      "Propose append_directional rows for B-confidence official-total rows.",
      "Propose append_excluded_audit rows for C-confidence rows.",
      "Detect conflicts and produce proposal only."
    ]
  };
}

export function buildB09XSafetyConfirmation() {
  return {
    history_append: false,
    db_writes: false,
    db_sync: false,
    ai_context_refresh: false,
    pms_beds24_airhost_ota_output: false,
    price_update: false,
    booking_search_scraping: false,
    slug_discovery_live: false,
    unverified_booking_slugs: false,
    paid_source_tooling: false,
    captcha_bypass: false,
    stealth_plugin: false,
    login: false,
    cookie_injection: false,
    booking_base_times_1_1: false,
    fixed_slug_pages_only: true,
    preview_rows_only: true
  };
}

export function renderB09XCsv(rows: readonly B09XNormalizedPreviewRow[]): string {
  const body = rows.map((row) => B09X_CSV_HEADERS.map((key) => csvEscape(String(row[key] ?? ""))).join(","));
  return [B09X_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderB09XReport(input: {
  generatedAtJst: string;
  decision: BookingB09XDecision;
  sourceB08xArtifactPath: string;
  targetMatrixSummary: TargetMatrixValidation;
  pageResultsSummary: Record<string, unknown>;
  normalizedRowsSummary: ReturnType<typeof summarizeB09XRows>;
  priceBasisSummary: ReturnType<typeof summarizeB09XPriceBasis>;
  dpUsageSummary: Record<string, number>;
  blockDetectionSummary: ReturnType<typeof summarizeB09XBlockDetection>;
  schemaCompatibilitySummary: ReturnType<typeof buildB09XSchemaCompatibilitySummary>;
  futureB10xPlan: ReturnType<typeof buildB09XFutureB10XPlan>;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
}): string {
  return [
    "# Booking.com Bounded Expanded Collection (Phase BOOKING-B09X)",
    "",
    `Generated at JST: ${input.generatedAtJst}`,
    `Decision: ${input.decision}`,
    "",
    "## 1. Summary",
    "",
    `- Source B08X proposal: ${input.sourceB08xArtifactPath}`,
    `- Target pages: ${input.targetMatrixSummary.target_count}`,
    `- Normalized preview rows: ${input.normalizedRowsSummary.total_rows}`,
    `- Directional rows: ${input.normalizedRowsSummary.directional_rows}`,
    `- Excluded rows: ${input.normalizedRowsSummary.excluded_rows}`,
    `- Direct rows: ${input.normalizedRowsSummary.direct_rows}`,
    "",
    "## 2. Target Matrix Summary",
    "",
    `- property_count=${input.targetMatrixSummary.property_count}`,
    `- dates_per_property_max=${input.targetMatrixSummary.dates_per_property_max}`,
    `- max_pages=${input.targetMatrixSummary.max_pages}`,
    `- fixed_slug_urls_only=${input.targetMatrixSummary.fixed_slug_urls_only}`,
    `- search_pages_used=${input.targetMatrixSummary.search_pages_used}`,
    `- unverified_slug_count=${input.targetMatrixSummary.unverified_slug_count}`,
    "",
    "## 3. Page Results Summary",
    "",
    ...Object.entries(input.pageResultsSummary).map(([key, value]) => `- ${key}=${JSON.stringify(value)}`),
    "",
    "## 4. Price Basis Summary",
    "",
    `- policy_version=${input.priceBasisSummary.policy_version}`,
    `- computed_total_rule=${input.priceBasisSummary.computed_total_rule}`,
    `- forbidden_rule_rejected=${input.priceBasisSummary.forbidden_rule_rejected}`,
    `- basis_confidence_counts=${JSON.stringify(input.priceBasisSummary.basis_confidence_counts)}`,
    `- classification_counts=${JSON.stringify(input.priceBasisSummary.classification_counts)}`,
    "",
    "## 5. DP Usage Summary",
    "",
    ...Object.entries(input.dpUsageSummary).map(([key, value]) => `- ${key}=${value}`),
    "",
    "## 6. Block / WAF Detection Summary",
    "",
    `- blocked_or_unavailable_rows=${input.blockDetectionSummary.blocked_or_unavailable_rows}`,
    `- blocked_or_unavailable_ratio=${input.blockDetectionSummary.blocked_or_unavailable_ratio}`,
    "",
    "## 7. Schema Compatibility Summary",
    "",
    `- schema_version=${input.schemaCompatibilitySummary.schema_version}`,
    `- compatible=${input.schemaCompatibilitySummary.compatible}`,
    `- preview_only=${input.schemaCompatibilitySummary.preview_only}`,
    "",
    "## 8. Future B10X Plan",
    "",
    `- phase=${input.futureB10xPlan.phase}`,
    `- execute_now=${input.futureB10xPlan.execute_now}`,
    ...input.futureB10xPlan.steps.map((step) => `- ${step}`),
    "",
    "## 9. Safety Confirmation",
    "",
    "- B09X appends no history, writes no DB rows, refreshes no AI context, and emits no PMS/Beds24/AirHost/OTA output.",
    "- Collection is bounded to fixed verified Booking.com property slug pages only; no search pages, pagination, login, cookies, stealth, proxy, or CAPTCHA bypass.",
    "- Booking rows remain B-confidence directional or C-confidence excluded. Direct Booking rows remain zero.",
    "",
    "## 10. Output Paths",
    "",
    `- report_path=${input.reportPath}`,
    `- json_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugPath}`,
    "",
    "## 11. Decision",
    "",
    `- ${input.decision}`,
    "",
    "## 12. Next Step",
    "",
    "- BOOKING-B10X — Booking bounded expanded history append proposal. Do not start without explicit instruction.",
    ""
  ].join("\n");
}

function isFixedBookingPropertyUrl(url: string, slug: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.booking.com" && parsed.pathname === `/hotel/jp/${slug}.ja.html`;
  } catch {
    return false;
  }
}

function isBookingSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\/searchresults\./u.test(parsed.pathname) || parsed.searchParams.has("ss");
  } catch {
    return true;
  }
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
