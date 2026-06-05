// Phase M01X — Cross-source local market-signal schema.
//
// Normalizes Booking.com B04X rows, Rakuten Phase 66X day rows, and Jalan
// DP-safe (date-level aggregate) signals into ONE unified local schema so the
// three sources can be compared on a common basis.
//
// Local-design / prototype only. NO DB writes, NO collector promotion.
// No base × 1.1. No estimation. Missing/unsafe basis stays null and excluded.

import { type NormalizedMarketSignalRow as BookingB04XRow } from "./bookingMarketSignalNormalization";

export const UNIFIED_STAY_SCOPE = "2_adults_1_room_1_night";

export type UnifiedSource = "booking" | "rakuten" | "jalan";

export type AvailabilityStatus =
  | "available"
  | "sold_out"
  | "not_listed"
  | "unavailable_or_unknown"
  | "blocked"
  | "navigation_failed";

export type SoldOutStatus = "available" | "sold_out" | "not_listed" | "unknown";

export type BasisConfidence = "A" | "B" | "C" | "none" | "insufficient";

export type M01XDecision =
  | "cross_source_market_signal_schema_ready"
  | "cross_source_market_signal_schema_basis_caution"
  | "cross_source_market_signal_schema_not_ready";

export interface UnifiedMarketSignalRow {
  runId: string;
  normalizedAtJst: string;
  source: UnifiedSource;
  sourcePhase: string;
  collectorStage: string;
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
  currency: string;
  language: string;
  stayScope: string;
  availabilityStatus: AvailabilityStatus;
  soldOutStatus: SoldOutStatus;
  normalizedTotalPrice: number | null;
  normalizedTotalPriceSource: string | null;
  normalizedTotalPriceBasis: string;
  normalizedTotalPriceConfidence: BasisConfidence;
  basisConfidence: BasisConfidence;
  basisNote: string;
  sourcePrimaryPrice: number | null;
  sourceSecondaryPriceOrAdder: number | null;
  sourceComputedTotal: number | null;
  sourceTaxOrFeeClassification: string;
  sourceClassification: string;
  isPriceUsableForDpDirect: boolean;
  isPriceUsableForDpDirectional: boolean;
  isPriceExcludedFromDp: boolean;
  dpExclusionReason: string | null;
  warningFlags: string;
  sourceReportPath: string;
  sourceCsvPath: string;
  debugArtifactPath: string;
}

export const UNIFIED_CSV_HEADERS = [
  "run_id",
  "normalized_at_jst",
  "source",
  "source_phase",
  "collector_stage",
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
  "debug_artifact_path"
] as const;

export interface SourceArtifactPaths {
  reportPath: string;
  csvPath: string;
}

// ---------------------------------------------------------------------------
// Common DP gate invariants
// ---------------------------------------------------------------------------

export interface DpFlags {
  isPriceUsableForDpDirect: boolean;
  isPriceUsableForDpDirectional: boolean;
  isPriceExcludedFromDp: boolean;
  dpExclusionReason: string | null;
}

// Enforce: never direct && excluded; direct implies directional; excluded clears usability.
export function reconcileDpFlags(input: {
  direct: boolean;
  directional: boolean;
  excluded: boolean;
  reason: string | null;
}): DpFlags {
  if (input.excluded) {
    return {
      isPriceUsableForDpDirect: false,
      isPriceUsableForDpDirectional: false,
      isPriceExcludedFromDp: true,
      dpExclusionReason: input.reason
    };
  }
  return {
    isPriceUsableForDpDirect: input.direct,
    isPriceUsableForDpDirectional: input.directional || input.direct,
    isPriceExcludedFromDp: false,
    dpExclusionReason: null
  };
}

// ---------------------------------------------------------------------------
// Booking.com B04X → unified
// ---------------------------------------------------------------------------

export function normalizeBookingToUnified(row: BookingB04XRow, paths: SourceArtifactPaths): UnifiedMarketSignalRow {
  const flags = reconcileDpFlags({
    direct: row.isPriceUsableForDpDirect,
    directional: row.isPriceUsableForDpDirectional,
    excluded: row.isPriceExcludedFromDp,
    reason: row.dpExclusionReason
  });
  return {
    runId: row.runId,
    normalizedAtJst: row.normalizedAtJst,
    source: "booking",
    sourcePhase: "B04X",
    collectorStage: "local_normalization_only",
    canonicalPropertyName: row.canonicalPropertyName,
    sourcePropertyName: row.sourcePropertyName,
    propertyIdentityMatch: row.propertyIdentityMatch,
    sourcePropertyId: row.sourcePropertyId,
    sourceSlugOrCode: row.sourceSlugOrCode,
    checkin: row.checkin,
    checkout: row.checkout,
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: UNIFIED_STAY_SCOPE,
    availabilityStatus: row.availabilityStatus,
    soldOutStatus: row.soldOutStatus,
    normalizedTotalPrice: row.normalizedTotalPrice,
    normalizedTotalPriceSource: row.normalizedTotalPriceSource,
    normalizedTotalPriceBasis: row.normalizedTotalPriceBasis,
    normalizedTotalPriceConfidence: row.normalizedTotalPriceConfidence,
    basisConfidence: row.basisConfidence,
    basisNote: row.basisNote,
    sourcePrimaryPrice: row.sourcePrimaryPrice,
    sourceSecondaryPriceOrAdder: row.sourceOfficialTaxFeeAdder,
    sourceComputedTotal: row.sourceComputedTotalWithTaxFee,
    sourceTaxOrFeeClassification: row.sourceTaxBasisClassification,
    sourceClassification: row.sourceClassification,
    ...flags,
    warningFlags: "",
    sourceReportPath: paths.reportPath,
    sourceCsvPath: paths.csvPath,
    debugArtifactPath: row.debugArtifactPath
  };
}

// ---------------------------------------------------------------------------
// Rakuten Phase 66X day row → unified
// ---------------------------------------------------------------------------

export interface RakutenDayInput {
  runId: string;
  collectedAtJst: string;
  propertyName: string;
  hotelNo: string;
  dateIso: string;
  isPast: boolean;
  isFull: boolean;
  isVacant: boolean;
  rawPrice: number;
  computed2AdultTotal: number | null;
  chargeType: string;
  sourcePriceBasis: string;
  basisConfidence: string;
  basisNote: string;
  linkPresent: boolean;
  classification: string;
  debugArtifactPath: string;
}

export function normalizeRakutenToUnified(input: RakutenDayInput, paths: SourceArtifactPaths): UnifiedMarketSignalRow {
  let availabilityStatus: AvailabilityStatus = "unavailable_or_unknown";
  let soldOutStatus: SoldOutStatus = "unknown";
  let normalizedTotalPrice: number | null = null;
  let normalizedTotalPriceSource: string | null = null;
  let normalizedTotalPriceBasis = "rakuten_basis_unusable";
  let warningFlags = "";
  let rawFlags = { direct: false, directional: false, excluded: true, reason: "rakuten_basis_unusable" as string | null };

  if (input.classification === "rakuten_day_available_price_link" && input.computed2AdultTotal !== null) {
    availabilityStatus = "available";
    soldOutStatus = "available";
    normalizedTotalPrice = input.computed2AdultTotal;
    normalizedTotalPriceSource = "rakuten_dayList_price_times_2";
    normalizedTotalPriceBasis = "per_person_tax_included_unconfirmed_total_times_2";
    rawFlags = { direct: false, directional: true, excluded: false, reason: null };
  } else if (input.classification === "rakuten_day_full" || input.isFull) {
    availabilityStatus = "sold_out";
    soldOutStatus = "sold_out";
    normalizedTotalPriceBasis = "no_price_sold_out";
    warningFlags = "sold_out_pressure_signal";
    rawFlags = { direct: false, directional: true, excluded: false, reason: null };
  } else if (input.classification === "rakuten_day_past" || input.isPast) {
    availabilityStatus = "unavailable_or_unknown";
    soldOutStatus = "unknown";
    normalizedTotalPriceBasis = "no_usable_price";
    rawFlags = { direct: false, directional: false, excluded: true, reason: "past_row" };
  } else {
    availabilityStatus = "unavailable_or_unknown";
    soldOutStatus = "unknown";
    rawFlags = { direct: false, directional: false, excluded: true, reason: "rakuten_basis_unusable" };
  }

  const flags = reconcileDpFlags(rawFlags);
  const confidence: BasisConfidence = normalizedTotalPrice !== null ? "B" : "none";

  return {
    runId: input.runId,
    normalizedAtJst: input.collectedAtJst,
    source: "rakuten",
    sourcePhase: "Phase66X",
    collectorStage: "prototype_read_only",
    canonicalPropertyName: input.propertyName,
    sourcePropertyName: input.propertyName,
    propertyIdentityMatch: true,
    sourcePropertyId: input.hotelNo,
    sourceSlugOrCode: input.hotelNo,
    checkin: input.dateIso,
    checkout: addOneDay(input.dateIso),
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: UNIFIED_STAY_SCOPE,
    availabilityStatus,
    soldOutStatus,
    normalizedTotalPrice,
    normalizedTotalPriceSource,
    normalizedTotalPriceBasis,
    normalizedTotalPriceConfidence: confidence,
    basisConfidence: input.basisConfidence === "B" ? "B" : confidence,
    basisNote: input.basisNote,
    sourcePrimaryPrice: input.rawPrice > 0 ? input.rawPrice : null,
    sourceSecondaryPriceOrAdder: null,
    sourceComputedTotal: input.computed2AdultTotal,
    sourceTaxOrFeeClassification: input.sourcePriceBasis,
    sourceClassification: input.classification,
    ...flags,
    warningFlags,
    sourceReportPath: paths.reportPath,
    sourceCsvPath: paths.csvPath,
    debugArtifactPath: input.debugArtifactPath
  };
}

// ---------------------------------------------------------------------------
// Jalan DP-safe (date-level aggregate) → unified
// ---------------------------------------------------------------------------

export interface JalanDpSafeInput {
  runId: string;
  normalizedAtJst: string;
  stayDate: string;
  confidence: string;
  rawMedianJpy: number | null;
  qualityAdjustedMedianJpy: number | null;
  dpSafeMedianJpy: number | null;
  useClass: string;
  availableCount: number;
  failedCount: number;
  excludedQualityRowsCount: number;
  reason: string;
  warningFlags: string;
}

const JALAN_HARD_EXCLUDE_FLAG = /coupon|price_basis_suspicious|per_person_or_basis_mismatch/u;

export function normalizeJalanToUnified(input: JalanDpSafeInput, paths: SourceArtifactPaths): UnifiedMarketSignalRow {
  const confidence = mapBasisConfidence(input.confidence);
  const hasMedian = input.dpSafeMedianJpy !== null;
  const couponOrSuspicious = JALAN_HARD_EXCLUDE_FLAG.test(input.warningFlags);

  let rawFlags: { direct: boolean; directional: boolean; excluded: boolean; reason: string | null };
  if (input.useClass === "exclude" || couponOrSuspicious || !hasMedian) {
    const reason = couponOrSuspicious
      ? "coupon_or_price_basis_suspicious"
      : input.reason || "excluded_not_dp_safe";
    rawFlags = { direct: false, directional: false, excluded: true, reason };
  } else if (input.useClass === "use_directly") {
    rawFlags = { direct: true, directional: true, excluded: false, reason: null };
  } else {
    // use_directionally (and any other non-excluded class)
    rawFlags = { direct: false, directional: true, excluded: false, reason: null };
  }
  const flags = reconcileDpFlags(rawFlags);

  return {
    runId: input.runId,
    normalizedAtJst: input.normalizedAtJst,
    source: "jalan",
    sourcePhase: "DP_SAFE",
    collectorStage: "dp_safe_local_signal",
    canonicalPropertyName: "market_aggregate",
    sourcePropertyName: "market_aggregate",
    propertyIdentityMatch: true,
    sourcePropertyId: "",
    sourceSlugOrCode: "",
    checkin: input.stayDate,
    checkout: addOneDay(input.stayDate),
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: UNIFIED_STAY_SCOPE,
    availabilityStatus: hasMedian ? "available" : "unavailable_or_unknown",
    soldOutStatus: "unknown",
    normalizedTotalPrice: hasMedian ? input.dpSafeMedianJpy : null,
    normalizedTotalPriceSource: hasMedian ? "jalan_dp_safe_median" : null,
    normalizedTotalPriceBasis: "dp_safe_median_quality_adjusted_market_aggregate",
    normalizedTotalPriceConfidence: confidence,
    basisConfidence: confidence,
    basisNote: input.reason,
    sourcePrimaryPrice: input.rawMedianJpy,
    sourceSecondaryPriceOrAdder: input.qualityAdjustedMedianJpy,
    sourceComputedTotal: input.dpSafeMedianJpy,
    sourceTaxOrFeeClassification: "",
    sourceClassification: input.useClass,
    ...flags,
    warningFlags: input.warningFlags,
    sourceReportPath: paths.reportPath,
    sourceCsvPath: paths.csvPath,
    debugArtifactPath: ""
  };
}

function mapBasisConfidence(value: string): BasisConfidence {
  if (value === "A") return "A";
  if (value === "B") return "B";
  if (value === "C") return "C";
  if (value === "insufficient") return "insufficient";
  return "none";
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export interface SourceDateSummaryRow {
  checkin: string;
  source: UnifiedSource;
  rowCount: number;
  availableCount: number;
  soldOutCount: number;
  numericPriceCount: number;
  directCount: number;
  directionalCount: number;
  excludedCount: number;
  medianNormalizedTotalPrice: number | null;
  minNormalizedTotalPrice: number | null;
  maxNormalizedTotalPrice: number | null;
  basisConfidenceCounts: Record<string, number>;
  warningFlagsSummary: Record<string, number>;
}

export function buildSourceDateSummary(rows: UnifiedMarketSignalRow[]): SourceDateSummaryRow[] {
  const groups = new Map<string, UnifiedMarketSignalRow[]>();
  for (const row of rows) {
    const key = `${row.checkin}__${row.source}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const out: SourceDateSummaryRow[] = [];
  for (const [key, bucket] of groups) {
    const [checkin, source] = key.split("__") as [string, UnifiedSource];
    const prices = bucket.map((r) => r.normalizedTotalPrice).filter((p): p is number => p !== null);
    out.push({
      checkin,
      source,
      rowCount: bucket.length,
      availableCount: bucket.filter((r) => r.availabilityStatus === "available").length,
      soldOutCount: bucket.filter((r) => r.soldOutStatus === "sold_out").length,
      numericPriceCount: prices.length,
      directCount: bucket.filter((r) => r.isPriceUsableForDpDirect).length,
      directionalCount: bucket.filter((r) => r.isPriceUsableForDpDirectional).length,
      excludedCount: bucket.filter((r) => r.isPriceExcludedFromDp).length,
      medianNormalizedTotalPrice: median(prices),
      minNormalizedTotalPrice: prices.length ? Math.min(...prices) : null,
      maxNormalizedTotalPrice: prices.length ? Math.max(...prices) : null,
      basisConfidenceCounts: countBy(bucket.map((r) => r.basisConfidence)),
      warningFlagsSummary: countBy(bucket.flatMap((r) => splitFlags(r.warningFlags)))
    });
  }
  return out.sort((a, b) => (a.checkin === b.checkin ? a.source.localeCompare(b.source) : a.checkin.localeCompare(b.checkin)));
}

export interface CrossSourceDateSummaryRow {
  checkin: string;
  sourcesPresent: UnifiedSource[];
  totalRows: number;
  numericPriceRows: number;
  soldOutRows: number;
  directRows: number;
  directionalRows: number;
  excludedRows: number;
  medianPriceAllDirectional: number | null;
  medianPriceDirectOnly: number | null;
  bookingDirectionalCount: number;
  rakutenDirectionalCount: number;
  jalanDirectCount: number;
  jalanDirectionalCount: number;
  notes: string;
}

export function buildCrossSourceDateSummary(rows: UnifiedMarketSignalRow[]): CrossSourceDateSummaryRow[] {
  const groups = new Map<string, UnifiedMarketSignalRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.checkin) ?? [];
    bucket.push(row);
    groups.set(row.checkin, bucket);
  }
  const out: CrossSourceDateSummaryRow[] = [];
  for (const [checkin, bucket] of groups) {
    const sourcesPresent = [...new Set(bucket.map((r) => r.source))].sort() as UnifiedSource[];
    const directionalPrices = bucket
      .filter((r) => r.isPriceUsableForDpDirectional && r.normalizedTotalPrice !== null)
      .map((r) => r.normalizedTotalPrice as number);
    const directPrices = bucket
      .filter((r) => r.isPriceUsableForDpDirect && r.normalizedTotalPrice !== null)
      .map((r) => r.normalizedTotalPrice as number);
    out.push({
      checkin,
      sourcesPresent,
      totalRows: bucket.length,
      numericPriceRows: bucket.filter((r) => r.normalizedTotalPrice !== null).length,
      soldOutRows: bucket.filter((r) => r.soldOutStatus === "sold_out").length,
      directRows: bucket.filter((r) => r.isPriceUsableForDpDirect).length,
      directionalRows: bucket.filter((r) => r.isPriceUsableForDpDirectional).length,
      excludedRows: bucket.filter((r) => r.isPriceExcludedFromDp).length,
      medianPriceAllDirectional: median(directionalPrices),
      medianPriceDirectOnly: median(directPrices),
      bookingDirectionalCount: bucket.filter((r) => r.source === "booking" && r.isPriceUsableForDpDirectional).length,
      rakutenDirectionalCount: bucket.filter((r) => r.source === "rakuten" && r.isPriceUsableForDpDirectional).length,
      jalanDirectCount: bucket.filter((r) => r.source === "jalan" && r.isPriceUsableForDpDirect).length,
      jalanDirectionalCount: bucket.filter((r) => r.source === "jalan" && r.isPriceUsableForDpDirectional).length,
      notes: sourcesPresent.length >= 2 ? "multi_source" : "single_source"
    });
  }
  return out.sort((a, b) => a.checkin.localeCompare(b.checkin));
}

export interface DpGateBySource {
  booking: { direct: number; directional: number; excluded: number };
  rakuten: { direct: number; directional: number; excluded: number };
  jalan: { direct: number; directional: number; excluded: number };
}

export function summarizeDpGateBySource(rows: UnifiedMarketSignalRow[]): DpGateBySource {
  const make = (source: UnifiedSource) => {
    const sub = rows.filter((r) => r.source === source);
    return {
      direct: sub.filter((r) => r.isPriceUsableForDpDirect).length,
      directional: sub.filter((r) => r.isPriceUsableForDpDirectional).length,
      excluded: sub.filter((r) => r.isPriceExcludedFromDp).length
    };
  };
  return { booking: make("booking"), rakuten: make("rakuten"), jalan: make("jalan") };
}

export function decideM01X(rows: UnifiedMarketSignalRow[]): M01XDecision {
  const sourcesWithRows = (["booking", "rakuten", "jalan"] as UnifiedSource[]).filter((s) =>
    rows.some((r) => r.source === s)
  );
  if (sourcesWithRows.length >= 3) return "cross_source_market_signal_schema_ready";
  if (sourcesWithRows.length === 2) return "cross_source_market_signal_schema_basis_caution";
  return "cross_source_market_signal_schema_not_ready";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderUnifiedCsv(rows: UnifiedMarketSignalRow[]): string {
  const body = rows.map((row) =>
    [
      row.runId,
      row.normalizedAtJst,
      row.source,
      row.sourcePhase,
      row.collectorStage,
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
      numOrEmpty(row.normalizedTotalPrice),
      row.normalizedTotalPriceSource ?? "",
      row.normalizedTotalPriceBasis,
      row.normalizedTotalPriceConfidence,
      row.basisConfidence,
      row.basisNote,
      numOrEmpty(row.sourcePrimaryPrice),
      numOrEmpty(row.sourceSecondaryPriceOrAdder),
      numOrEmpty(row.sourceComputedTotal),
      row.sourceTaxOrFeeClassification,
      row.sourceClassification,
      bool(row.isPriceUsableForDpDirect),
      bool(row.isPriceUsableForDpDirectional),
      bool(row.isPriceExcludedFromDp),
      row.dpExclusionReason ?? "",
      row.warningFlags,
      row.sourceReportPath,
      row.sourceCsvPath,
      row.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [UNIFIED_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderCrossSourceReport(input: {
  generatedAt: string;
  rows: UnifiedMarketSignalRow[];
  decision: M01XDecision;
  dpGate: DpGateBySource;
  sourceDateSummary: SourceDateSummaryRow[];
  crossSourceDateSummary: CrossSourceDateSummaryRow[];
  artifacts: {
    booking: SourceArtifactPaths & { jsonPath: string };
    rakuten: SourceArtifactPaths & { jsonPath: string };
    jalan: SourceArtifactPaths;
  };
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}): string {
  const countSource = (s: UnifiedSource): number => input.rows.filter((r) => r.source === s).length;
  return [
    "# Cross-Source Local Market-Signal Schema (Phase M01X)",
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## 1. Policy & safety",
    "",
    "- Local schema design only: NO DB writes, no collector_runs, no rate_snapshots, no inventory_snapshots.",
    "- No production cron, no GitHub Actions, no GitOps, no daily history append, no Beds24/AirHost/PMS/OTA output.",
    "- Booking uses official visible total (base + official tax/fee adder); no synthetic base × 1.1.",
    "- Rakuten stays directional-only (basis_confidence B); never upgraded to direct/A.",
    "- Jalan DP-safe rows are date-level market aggregates; no property-level rows are invented.",
    "",
    "## 2. Summary",
    "",
    `- decision=${input.decision}`,
    `- unified_rows=${input.rows.length}`,
    `- booking_rows=${countSource("booking")}`,
    `- rakuten_rows=${countSource("rakuten")}`,
    `- jalan_rows=${countSource("jalan")}`,
    "",
    "## 3. DP gate summary by source",
    "",
    `- booking: ${JSON.stringify(input.dpGate.booking)}`,
    `- rakuten: ${JSON.stringify(input.dpGate.rakuten)}`,
    `- jalan: ${JSON.stringify(input.dpGate.jalan)}`,
    "",
    "## 4. Source artifacts used",
    "",
    `- booking_report=${input.artifacts.booking.reportPath}`,
    `- booking_csv=${input.artifacts.booking.csvPath}`,
    `- booking_json=${input.artifacts.booking.jsonPath}`,
    `- rakuten_report=${input.artifacts.rakuten.reportPath}`,
    `- rakuten_csv=${input.artifacts.rakuten.csvPath}`,
    `- rakuten_json=${input.artifacts.rakuten.jsonPath}`,
    `- jalan_report=${input.artifacts.jalan.reportPath}`,
    `- jalan_csv=${input.artifacts.jalan.csvPath}`,
    "",
    "## 5. Cross-source date summary",
    "",
    "| checkin | sources | rows | numeric | sold_out | direct | directional | excluded | median_directional | median_direct |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...input.crossSourceDateSummary.map(
      (r) =>
        `| ${r.checkin} | ${r.sourcesPresent.join("+")} | ${r.totalRows} | ${r.numericPriceRows} | ${r.soldOutRows} | ${r.directRows} | ${r.directionalRows} | ${r.excludedRows} | ${r.medianPriceAllDirectional ?? "n/a"} | ${r.medianPriceDirectOnly ?? "n/a"} |`
    ),
    "",
    "## 6. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- csv_path=${input.csvPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    "",
    "## 7. Recommended next action",
    "",
    recommendedNextAction(input.decision),
    ""
  ].join("\n");
}

function recommendedNextAction(decision: M01XDecision): string {
  if (decision === "cross_source_market_signal_schema_ready") {
    return "- Proceed to Phase M02X local history schema design with monthly shard plan. Keep DB writes / GitHub Actions / auto-commit disabled.";
  }
  if (decision === "cross_source_market_signal_schema_basis_caution") {
    return "- Two sources normalized but one is missing/weak; inspect the missing source before history schema design. Do not re-run collectors automatically.";
  }
  return "- Not ready (fewer than two sources normalized). Fix source-specific normalization locally before history schema design.";
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return null;
  return Math.round((lo + hi) / 2);
}

function addOneDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (!match) return iso;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function splitFlags(value: string): string[] {
  return value
    .split(/[;,]/u)
    .map((flag) => flag.trim())
    .filter(Boolean);
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function numOrEmpty(value: number | null): string {
  return value === null ? "" : String(value);
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
