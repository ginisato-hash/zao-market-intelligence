// Phase B04X — Booking.com limited market-signal normalization.
//
// Converts Phase B04A rows (booking_official_visible_adder_v1) into a local
// unified market-signal schema compatible with future Jalan/Rakuten rows.
//
// Read-only / local-output only. NO DB writes, NO collector promotion.
//
// Price policy is inherited from B04A unchanged:
//   normalized_total_price = source computed_total_with_tax_fee
//                          = primary_price_numeric + official_tax_fee_adder_numeric
// No synthetic 1.1 multiplier. No estimation of missing official adders.

import { BOOKING_PRICE_POLICY_VERSION, type B04ARow } from "./bookingOfficialTaxFeeTotalHardening";

export const BOOKING_SOURCE_PHASE = "B04A";
export const BOOKING_COLLECTOR_STAGE = "local_normalization_only";
export const BOOKING_STAY_SCOPE = "2_adults_1_room_1_night";

export const CANONICAL_NAME_BY_SLUG: Record<string, string> = {
  "zao-kokusai": "蔵王国際ホテル",
  "zao-shiki-no": "蔵王四季のホテル",
  "shinzanso-takamiya": "深山荘 高見屋"
};

export type AvailabilityStatus =
  | "available"
  | "sold_out"
  | "not_listed"
  | "unavailable_or_unknown"
  | "blocked"
  | "navigation_failed";

export type SoldOutStatus = "available" | "sold_out" | "not_listed" | "unknown";

export type NormalizedTotalPriceConfidence = "A" | "B" | "C" | "none";

export type B04XDecision =
  | "booking_market_signal_normalization_ready"
  | "booking_market_signal_normalization_basis_caution"
  | "booking_market_signal_normalization_not_ready";

export interface NormalizedMarketSignalRow {
  runId: string;
  normalizedAtJst: string;
  source: "booking";
  sourcePhase: string;
  collectorStage: string;
  pricePolicyVersion: string;
  canonicalPropertyName: string;
  sourcePropertyName: string;
  propertyIdentityMatch: boolean;
  sourcePropertyId: string;
  sourceSlugOrCode: string;
  checkin: string;
  checkout: string;
  stayNights: number;
  groupAdults: number;
  noRooms: number;
  groupChildren: number;
  currency: "JPY";
  language: "ja";
  stayScope: string;
  availabilityStatus: AvailabilityStatus;
  soldOutStatus: SoldOutStatus;
  normalizedTotalPrice: number | null;
  normalizedTotalPriceSource: string | null;
  normalizedTotalPriceConfidence: NormalizedTotalPriceConfidence;
  normalizedTotalPriceBasis: string;
  basisConfidence: NormalizedTotalPriceConfidence;
  basisNote: string;
  sourcePrimaryPrice: number | null;
  sourceOfficialTaxFeeAdder: number | null;
  sourceComputedTotalWithTaxFee: number | null;
  sourceTaxBasisClassification: string;
  sourceClassification: string;
  isPriceUsableForDpDirect: boolean;
  isPriceUsableForDpDirectional: boolean;
  isPriceExcludedFromDp: boolean;
  dpExclusionReason: string | null;
  debugArtifactPath: string;
  sourceReportPath: string;
  sourceCsvPath: string;
}

export const BOOKING_MARKET_SIGNAL_CSV_HEADERS = [
  "run_id",
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
  "normalized_total_price_confidence",
  "normalized_total_price_basis",
  "basis_confidence",
  "basis_note",
  "source_primary_price",
  "source_official_tax_fee_adder",
  "source_computed_total_with_tax_fee",
  "source_tax_basis_classification",
  "source_classification",
  "is_price_usable_for_dp_direct",
  "is_price_usable_for_dp_directional",
  "is_price_excluded_from_dp",
  "dp_exclusion_reason",
  "debug_artifact_path",
  "source_report_path",
  "source_csv_path"
] as const;

interface PriceNormalization {
  normalizedTotalPrice: number | null;
  normalizedTotalPriceSource: string | null;
  normalizedTotalPriceConfidence: NormalizedTotalPriceConfidence;
  normalizedTotalPriceBasis: string;
  basisConfidence: NormalizedTotalPriceConfidence;
}

function normalizePrice(row: B04ARow): PriceNormalization {
  const computed = row.computedTotalWithTaxFee;
  const primary = row.primaryPriceNumeric;

  if (computed !== null) {
    const confidence: NormalizedTotalPriceConfidence = row.basisConfidence === "A" ? "A" : "B";
    return {
      normalizedTotalPrice: computed,
      normalizedTotalPriceSource: "booking_official_base_plus_visible_tax_fee_adder",
      normalizedTotalPriceConfidence: confidence,
      normalizedTotalPriceBasis: "room_total_official_visible_tax_fee_2_adults_1_room_1_night",
      basisConfidence: confidence
    };
  }

  if (primary !== null) {
    return {
      normalizedTotalPrice: null,
      normalizedTotalPriceSource: null,
      normalizedTotalPriceConfidence: "C",
      normalizedTotalPriceBasis: "booking_primary_price_available_but_official_total_missing",
      basisConfidence: "C"
    };
  }

  return {
    normalizedTotalPrice: null,
    normalizedTotalPriceSource: null,
    normalizedTotalPriceConfidence: "none",
    normalizedTotalPriceBasis: "no_usable_price",
    basisConfidence: "none"
  };
}

function mapAvailability(row: B04ARow): { availabilityStatus: AvailabilityStatus; soldOutStatus: SoldOutStatus } {
  switch (row.classification) {
    case "booking_b04a_navigation_failed":
      return { availabilityStatus: "navigation_failed", soldOutStatus: "unknown" };
    case "booking_b04a_blocked":
      return { availabilityStatus: "blocked", soldOutStatus: "unknown" };
    case "booking_b04a_property_mismatch":
      return { availabilityStatus: "unavailable_or_unknown", soldOutStatus: "unknown" };
    case "booking_b04a_sold_out":
      return { availabilityStatus: "sold_out", soldOutStatus: "sold_out" };
    default:
      if (row.primaryPriceNumeric !== null) {
        return { availabilityStatus: "available", soldOutStatus: "available" };
      }
      return { availabilityStatus: "unavailable_or_unknown", soldOutStatus: "unknown" };
  }
}

interface DpGate {
  isPriceUsableForDpDirect: boolean;
  isPriceUsableForDpDirectional: boolean;
  isPriceExcludedFromDp: boolean;
  dpExclusionReason: string | null;
}

function computeDpGate(input: {
  normalizedTotalPrice: number | null;
  primaryPriceNumeric: number | null;
  basisConfidence: NormalizedTotalPriceConfidence;
  propertyIdentityMatch: boolean;
  availabilityStatus: AvailabilityStatus;
}): DpGate {
  const numeric = input.normalizedTotalPrice !== null;
  const confidenceAB = input.basisConfidence === "A" || input.basisConfidence === "B";
  const available = input.availabilityStatus === "available";

  const direct = numeric && input.basisConfidence === "A" && input.propertyIdentityMatch && available;
  const directional = numeric && confidenceAB && input.propertyIdentityMatch && available;

  const excludingAvailability =
    input.availabilityStatus === "blocked" ||
    input.availabilityStatus === "navigation_failed" ||
    input.availabilityStatus === "unavailable_or_unknown";
  const excluded =
    !numeric ||
    !input.propertyIdentityMatch ||
    excludingAvailability ||
    input.basisConfidence === "C" ||
    input.basisConfidence === "none";

  let reason: string | null = null;
  if (excluded) {
    if (!input.propertyIdentityMatch) reason = "property_identity_mismatch";
    else if (input.availabilityStatus === "blocked") reason = "blocked";
    else if (input.availabilityStatus === "navigation_failed") reason = "navigation_failed";
    else if (input.availabilityStatus === "unavailable_or_unknown") reason = "unavailable_or_unknown";
    else if (!numeric && input.primaryPriceNumeric === null) reason = "no_usable_price";
    else if (!numeric) reason = "official_tax_fee_adder_missing";
    else reason = "low_confidence_basis";
  }

  return {
    isPriceUsableForDpDirect: direct,
    isPriceUsableForDpDirectional: directional,
    isPriceExcludedFromDp: excluded,
    dpExclusionReason: reason
  };
}

export function normalizeBookingMarketSignalRow(
  row: B04ARow,
  context: { normalizedAtJst: string; sourceReportPath: string; sourceCsvPath: string }
): NormalizedMarketSignalRow {
  const canonicalPropertyName = CANONICAL_NAME_BY_SLUG[row.bookingSlug] ?? row.propertyNameExpected;
  const price = normalizePrice(row);
  const availability = mapAvailability(row);
  const gate = computeDpGate({
    normalizedTotalPrice: price.normalizedTotalPrice,
    primaryPriceNumeric: row.primaryPriceNumeric,
    basisConfidence: price.basisConfidence,
    propertyIdentityMatch: row.propertyIdentityMatch,
    availabilityStatus: availability.availabilityStatus
  });

  return {
    runId: row.runId,
    normalizedAtJst: context.normalizedAtJst,
    source: "booking",
    sourcePhase: BOOKING_SOURCE_PHASE,
    collectorStage: BOOKING_COLLECTOR_STAGE,
    pricePolicyVersion: BOOKING_PRICE_POLICY_VERSION,
    canonicalPropertyName,
    sourcePropertyName: row.propertyNameDetected,
    propertyIdentityMatch: row.propertyIdentityMatch,
    sourcePropertyId: row.bookingSlug,
    sourceSlugOrCode: row.bookingSlug,
    checkin: row.checkin,
    checkout: row.checkout,
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: BOOKING_STAY_SCOPE,
    availabilityStatus: availability.availabilityStatus,
    soldOutStatus: availability.soldOutStatus,
    normalizedTotalPrice: price.normalizedTotalPrice,
    normalizedTotalPriceSource: price.normalizedTotalPriceSource,
    normalizedTotalPriceConfidence: price.normalizedTotalPriceConfidence,
    normalizedTotalPriceBasis: price.normalizedTotalPriceBasis,
    basisConfidence: price.basisConfidence,
    basisNote: row.basisNote,
    sourcePrimaryPrice: row.primaryPriceNumeric,
    sourceOfficialTaxFeeAdder: row.officialTaxFeeAdderNumeric,
    sourceComputedTotalWithTaxFee: row.computedTotalWithTaxFee,
    sourceTaxBasisClassification: row.taxBasisClassification,
    sourceClassification: row.classification,
    isPriceUsableForDpDirect: gate.isPriceUsableForDpDirect,
    isPriceUsableForDpDirectional: gate.isPriceUsableForDpDirectional,
    isPriceExcludedFromDp: gate.isPriceExcludedFromDp,
    dpExclusionReason: gate.dpExclusionReason,
    debugArtifactPath: row.debugArtifactPath ?? "",
    sourceReportPath: context.sourceReportPath,
    sourceCsvPath: context.sourceCsvPath
  };
}

export function normalizeBookingMarketSignalRows(
  rows: B04ARow[],
  context: { normalizedAtJst: string; sourceReportPath: string; sourceCsvPath: string }
): NormalizedMarketSignalRow[] {
  return rows.map((row) => normalizeBookingMarketSignalRow(row, context));
}

export interface DpGateSummary {
  direct: number;
  directional: number;
  excluded: number;
}

export function summarizeDpGate(rows: NormalizedMarketSignalRow[]): DpGateSummary {
  return {
    direct: rows.filter((row) => row.isPriceUsableForDpDirect).length,
    directional: rows.filter((row) => row.isPriceUsableForDpDirectional).length,
    excluded: rows.filter((row) => row.isPriceExcludedFromDp).length
  };
}

export function decideB04X(rows: NormalizedMarketSignalRow[]): B04XDecision {
  const directionalNumeric = rows.filter(
    (row) => row.normalizedTotalPrice !== null && row.isPriceUsableForDpDirectional
  ).length;
  if (directionalNumeric >= 3) return "booking_market_signal_normalization_ready";
  if (rows.some((row) => row.normalizedTotalPrice !== null)) return "booking_market_signal_normalization_basis_caution";
  return "booking_market_signal_normalization_not_ready";
}

export function renderBookingMarketSignalCsv(rows: NormalizedMarketSignalRow[]): string {
  const body = rows.map((row) =>
    [
      row.runId,
      row.normalizedAtJst,
      row.source,
      row.sourcePhase,
      row.collectorStage,
      row.pricePolicyVersion,
      row.canonicalPropertyName,
      row.sourcePropertyName,
      bool(row.propertyIdentityMatch),
      row.sourcePropertyId,
      row.sourceSlugOrCode,
      row.checkin,
      row.checkout,
      String(row.stayNights),
      String(row.groupAdults),
      String(row.noRooms),
      String(row.groupChildren),
      row.currency,
      row.language,
      row.stayScope,
      row.availabilityStatus,
      row.soldOutStatus,
      row.normalizedTotalPrice === null ? "" : String(row.normalizedTotalPrice),
      row.normalizedTotalPriceSource ?? "",
      row.normalizedTotalPriceConfidence,
      row.normalizedTotalPriceBasis,
      row.basisConfidence,
      row.basisNote,
      row.sourcePrimaryPrice === null ? "" : String(row.sourcePrimaryPrice),
      row.sourceOfficialTaxFeeAdder === null ? "" : String(row.sourceOfficialTaxFeeAdder),
      row.sourceComputedTotalWithTaxFee === null ? "" : String(row.sourceComputedTotalWithTaxFee),
      row.sourceTaxBasisClassification,
      row.sourceClassification,
      bool(row.isPriceUsableForDpDirect),
      bool(row.isPriceUsableForDpDirectional),
      bool(row.isPriceExcludedFromDp),
      row.dpExclusionReason ?? "",
      row.debugArtifactPath,
      row.sourceReportPath,
      row.sourceCsvPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [BOOKING_MARKET_SIGNAL_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderBookingMarketSignalReport(input: {
  generatedAt: string;
  rows: NormalizedMarketSignalRow[];
  decision: B04XDecision;
  dpGate: DpGateSummary;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
  sourceReportPath: string;
  sourceCsvPath: string;
  sourceJsonPath: string;
}): string {
  return [
    "# Booking.com Limited Market-Signal Normalization (Phase B04X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Policy",
    "",
    `- price_policy_version=${BOOKING_PRICE_POLICY_VERSION}`,
    "- Inherits the Phase B04A official rule: normalized_total_price = primary_price_numeric + official_tax_fee_adder_numeric.",
    "- No synthetic 1.1 multiplier, no inferred tax, no estimated fees; missing official totals stay null and are excluded from DP.",
    "- Local normalization only: no DB writes, no collector promotion.",
    "",
    "## 2. Summary",
    "",
    `- decision=${input.decision}`,
    `- rows=${input.rows.length}`,
    `- normalized_total_price_count=${input.rows.filter((r) => r.normalizedTotalPrice !== null).length}`,
    `- availability_counts=${JSON.stringify(countBy(input.rows.map((r) => r.availabilityStatus)))}`,
    `- basis_confidence_counts=${JSON.stringify(countBy(input.rows.map((r) => r.basisConfidence)))}`,
    "",
    "## 3. DP usage gate",
    "",
    `- direct_usable=${input.dpGate.direct}`,
    `- directional_usable=${input.dpGate.directional}`,
    `- excluded=${input.dpGate.excluded}`,
    "",
    "## 4. Normalized rows",
    "",
    ...input.rows.map(
      (row) =>
        `- ${row.canonicalPropertyName} ${row.checkin}: total=${row.normalizedTotalPrice ?? "null"} (${row.normalizedTotalPriceSource ?? "none"}), conf=${row.basisConfidence}, avail=${row.availabilityStatus}, direct=${bool(row.isPriceUsableForDpDirect)}, directional=${bool(row.isPriceUsableForDpDirectional)}, excluded=${bool(row.isPriceExcludedFromDp)}${row.dpExclusionReason ? ` (${row.dpExclusionReason})` : ""}`
    ),
    "",
    "## 5. Excluded rows",
    "",
    ...excludedLines(input.rows),
    "",
    "## 6. Canonical property mapping",
    "",
    ...input.rows.map((row) => `- ${row.sourceSlugOrCode} → ${row.canonicalPropertyName} (identity_match=${bool(row.propertyIdentityMatch)})`),
    "",
    "## 7. Source B04A artifacts",
    "",
    `- source_report_path=${input.sourceReportPath}`,
    `- source_csv_path=${input.sourceCsvPath}`,
    `- source_json_path=${input.sourceJsonPath}`,
    "",
    "## 8. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 9. Safety confirmation",
    "",
    "- Local normalization over B04A artifacts only; no Booking.com page re-opened.",
    "- No DB writes, no collector_runs, no rate_snapshots, no inventory_snapshots.",
    "- No login, no private data, no cookie injection, no stealth, no CAPTCHA bypass, no paid proxy/API.",
    "- No Beds24/AirHost/PMS/OTA upload output. No synthetic base×1.1 calculation.",
    "",
    "## 10. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function excludedLines(rows: NormalizedMarketSignalRow[]): string[] {
  const excluded = rows.filter((row) => row.isPriceExcludedFromDp);
  if (excluded.length === 0) return ["- (none)"];
  return excluded.map((row) => `- ${row.canonicalPropertyName} ${row.checkin}: ${row.dpExclusionReason ?? "unspecified"}`);
}

function recommendedNextAction(decision: B04XDecision): string {
  if (decision === "booking_market_signal_normalization_ready") {
    return "- Proceed to Phase M01X cross-source local market-signal schema design (unify Booking B04X, Rakuten 66X, Jalan DP-safe). Keep DB writes disabled.";
  }
  if (decision === "booking_market_signal_normalization_basis_caution") {
    return "- Some rows normalized but most are excluded/low-confidence; inspect source artifacts before unifying schemas. Do not estimate missing totals.";
  }
  return "- Not ready. Do not proceed to GitHub Actions or DB writes; fix schema normalization locally first.";
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
