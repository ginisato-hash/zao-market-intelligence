// Phase JALAN-AUTO06X — Jalan price-pressure usability verification (engine).
//
// READ-ONLY. Verifies that Jalan rows in the DB mirror (market_signal_history)
// are usable as a SUPPLEMENTARY domestic-OTA / same-property price-pressure
// signal for AI tasks, while Booking.com remains the PRIMARY directional
// market price-pressure backbone. Jalan directional+priced rows feed
// supplementary price-pressure; excluded rows are audit-only and must never
// enter the price-pressure sample; the JALAN-AUTO05X append must have added
// zero direct rows (pre-existing legacy direct rows are allowed).
//
// This module reads and classifies; it writes NO history, NO DB rows, runs NO
// live request / browser automation, emits NO property-management or
// channel-manager output, and performs NO price update.

// ---------------------------------------------------------------------------
// Decision labels
// ---------------------------------------------------------------------------

export type AUTO06XDecision =
  | "jalan_price_pressure_usability_ready"
  | "jalan_price_pressure_usability_basis_caution"
  | "jalan_price_pressure_usability_not_ready";

// price-pressure classification of a single Jalan row.
export type PricePressureClass =
  | "price_pressure_usable" // directional + has a normalized total -> feeds supplementary price-pressure
  | "directional_no_price" // directional but no usable total -> not usable
  | "excluded_audit_only" // excluded -> audit only, never feeds price pressure (even if priced)
  | "direct_legacy"; // dp_usage=direct -> pre-existing legacy A-confidence rows (not AUTO05X)

// The subset of market_signal_history columns this verification needs.
export interface JalanSignalRow {
  rowId: string;
  source: string;
  canonicalPropertyName: string;
  sourcePropertyId: string;
  checkinDate: string;
  checkoutDate: string;
  stayScope: string;
  collectedDateJst: string;
  availabilityStatus: string;
  normalizedTotalJpy: number | null;
  basisConfidence: string;
  dpUsage: string;
  exclusionReason: string;
}

// Observation qualifier appended by the identity policy (|obs:<16 hex>).
const OBS_QUALIFIER_RE = /\|obs:[0-9a-f]{16}$/u;

export function isObservationQualified(rowId: string): boolean {
  return OBS_QUALIFIER_RE.test(rowId);
}

// Market identity ignores the collected date and observation qualifier: a single
// (source, property, checkin, checkout, stay_scope) market cell can be observed
// many times.
export function deriveMarketIdentity(row: JalanSignalRow): string {
  return [row.source, row.sourcePropertyId, row.checkinDate, row.checkoutDate, row.stayScope].join("|");
}

export function classifyPricePressure(row: JalanSignalRow): PricePressureClass {
  if (row.dpUsage === "direct") return "direct_legacy";
  if (row.dpUsage === "excluded") return "excluded_audit_only";
  if (row.dpUsage === "directional" && row.normalizedTotalJpy !== null) return "price_pressure_usable";
  return "directional_no_price";
}

// ---------------------------------------------------------------------------
// Repeated observations + price movement
// ---------------------------------------------------------------------------

export interface ObservationPoint {
  rowId: string;
  collectedDateJst: string;
  normalizedTotalJpy: number | null;
  dpUsage: string;
  isObservationQualified: boolean;
}

export interface RepeatedObservation {
  marketIdentity: string;
  canonicalPropertyName: string;
  observationCount: number;
  obsQualifiedCount: number;
  priceMinJpy: number | null;
  priceMaxJpy: number | null;
  priceSpreadJpy: number | null;
  observations: ObservationPoint[];
}

export interface PriceMovementSample {
  marketIdentity: string;
  canonicalPropertyName: string;
  fromCollectedDateJst: string;
  fromPriceJpy: number;
  fromRowId: string;
  toCollectedDateJst: string;
  toPriceJpy: number;
  toRowId: string;
  deltaJpy: number;
  toIsObservationQualified: boolean;
}

// AUTO05X-subset metrics: the 25 rows appended in Phase JALAN-AUTO05X.
export interface Auto05xSubsetSummary {
  rowsCount: number;
  directionalCount: number;
  excludedCount: number;
  directCount: number;
  pricePressureUsableCount: number;
}

export interface UsabilityInvariants {
  jalanDirectionalSurfacedInPricePressure: boolean; // directional priced rows exist
  excludedNotPricePressureUsable: boolean; // no excluded row classified usable
  auto05xAddedDirectIsZero: boolean; // AUTO05X added zero direct rows
}

export interface JalanUsabilitySummary {
  totalJalanRows: number;
  directionalCount: number;
  excludedCount: number;
  directCount: number;
  pricePressureUsableCount: number;
  directionalNoPriceCount: number;
  excludedAuditOnlyCount: number;
  directLegacyCount: number;
  excludedWithPriceCount: number; // informational: Jalan excluded rows may carry a price
  excludedClassifiedUsableCount: number; // leakage check (must be 0)
  obsQualifiedRowCount: number;
  basisConfidenceCounts: Record<string, number>;
  repeatedMarketIdentityCount: number;
  repeatedObservations: RepeatedObservation[];
  priceMovementSamples: PriceMovementSample[];
  auto05x: Auto05xSubsetSummary;
  invariants: UsabilityInvariants;
  caveats: string[];
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function computeUsabilitySummary(
  rows: readonly JalanSignalRow[],
  auto05xRowIds: ReadonlySet<string>
): JalanUsabilitySummary {
  let directionalCount = 0;
  let excludedCount = 0;
  let directCount = 0;
  let pricePressureUsableCount = 0;
  let directionalNoPriceCount = 0;
  let excludedAuditOnlyCount = 0;
  let directLegacyCount = 0;
  let excludedWithPriceCount = 0;
  let excludedClassifiedUsableCount = 0;
  let obsQualifiedRowCount = 0;
  const basisConfidenceCounts: Record<string, number> = {};

  let auto05xRowsCount = 0;
  let auto05xDirectionalCount = 0;
  let auto05xExcludedCount = 0;
  let auto05xDirectCount = 0;
  let auto05xUsableCount = 0;

  const byIdentity = new Map<string, JalanSignalRow[]>();

  for (const row of rows) {
    if (row.dpUsage === "directional") directionalCount += 1;
    else if (row.dpUsage === "excluded") excludedCount += 1;
    else if (row.dpUsage === "direct") directCount += 1;

    const cls = classifyPricePressure(row);
    if (cls === "price_pressure_usable") pricePressureUsableCount += 1;
    else if (cls === "directional_no_price") directionalNoPriceCount += 1;
    else if (cls === "excluded_audit_only") excludedAuditOnlyCount += 1;
    else directLegacyCount += 1;

    if (row.dpUsage === "excluded" && row.normalizedTotalJpy !== null) excludedWithPriceCount += 1;
    if (row.dpUsage === "excluded" && cls === "price_pressure_usable") excludedClassifiedUsableCount += 1;
    if (isObservationQualified(row.rowId)) obsQualifiedRowCount += 1;
    bump(basisConfidenceCounts, row.basisConfidence);

    if (auto05xRowIds.has(row.rowId)) {
      auto05xRowsCount += 1;
      if (row.dpUsage === "directional") auto05xDirectionalCount += 1;
      else if (row.dpUsage === "excluded") auto05xExcludedCount += 1;
      else if (row.dpUsage === "direct") auto05xDirectCount += 1;
      if (cls === "price_pressure_usable") auto05xUsableCount += 1;
    }

    const id = deriveMarketIdentity(row);
    const bucket = byIdentity.get(id) ?? [];
    bucket.push(row);
    byIdentity.set(id, bucket);
  }

  const repeatedObservations: RepeatedObservation[] = [];
  const priceMovementSamples: PriceMovementSample[] = [];

  for (const [marketIdentity, bucket] of byIdentity) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) =>
      a.collectedDateJst === b.collectedDateJst
        ? a.rowId.localeCompare(b.rowId)
        : a.collectedDateJst.localeCompare(b.collectedDateJst)
    );
    const prices = sorted.map((r) => r.normalizedTotalJpy).filter((p): p is number => p !== null);
    const priceMin = prices.length > 0 ? Math.min(...prices) : null;
    const priceMax = prices.length > 0 ? Math.max(...prices) : null;
    repeatedObservations.push({
      marketIdentity,
      canonicalPropertyName: sorted[0]!.canonicalPropertyName,
      observationCount: sorted.length,
      obsQualifiedCount: sorted.filter((r) => isObservationQualified(r.rowId)).length,
      priceMinJpy: priceMin,
      priceMaxJpy: priceMax,
      priceSpreadJpy: priceMin !== null && priceMax !== null ? priceMax - priceMin : null,
      observations: sorted.map((r) => ({
        rowId: r.rowId,
        collectedDateJst: r.collectedDateJst,
        normalizedTotalJpy: r.normalizedTotalJpy,
        dpUsage: r.dpUsage,
        isObservationQualified: isObservationQualified(r.rowId)
      }))
    });

    const priced = sorted.filter((r) => r.normalizedTotalJpy !== null);
    if (priced.length >= 2) {
      const from = priced[0]!;
      const to = priced[priced.length - 1]!;
      if (from.normalizedTotalJpy !== to.normalizedTotalJpy || from.rowId !== to.rowId) {
        priceMovementSamples.push({
          marketIdentity,
          canonicalPropertyName: from.canonicalPropertyName,
          fromCollectedDateJst: from.collectedDateJst,
          fromPriceJpy: from.normalizedTotalJpy!,
          fromRowId: from.rowId,
          toCollectedDateJst: to.collectedDateJst,
          toPriceJpy: to.normalizedTotalJpy!,
          toRowId: to.rowId,
          deltaJpy: to.normalizedTotalJpy! - from.normalizedTotalJpy!,
          toIsObservationQualified: isObservationQualified(to.rowId)
        });
      }
    }
  }

  repeatedObservations.sort(
    (a, b) => b.observationCount - a.observationCount || a.marketIdentity.localeCompare(b.marketIdentity)
  );
  priceMovementSamples.sort(
    (a, b) => Math.abs(b.deltaJpy) - Math.abs(a.deltaJpy) || a.marketIdentity.localeCompare(b.marketIdentity)
  );

  const invariants: UsabilityInvariants = {
    jalanDirectionalSurfacedInPricePressure: pricePressureUsableCount > 0,
    excludedNotPricePressureUsable: excludedClassifiedUsableCount === 0,
    auto05xAddedDirectIsZero: auto05xDirectCount === 0
  };

  // Jalan is supplementary by design; that framing lives in the price-pressure
  // policy / report rather than as a forced caveat, so a hypothetical clean
  // A-confidence directional-only sample can still reach the ready state.
  const caveats: string[] = [];
  const usableNonA = rows.some(
    (r) => classifyPricePressure(r) === "price_pressure_usable" && r.basisConfidence !== "A"
  );
  if (usableNonA) caveats.push("price_pressure_rows_are_directional_b_confidence_not_direct");
  if (excludedCount > 0) caveats.push("excluded_rows_present_audit_only_not_price_pressure");
  if (directCount > 0) caveats.push("legacy_direct_rows_present_not_added_by_auto05x");
  if (obsQualifiedRowCount > 0) caveats.push("repeated_observations_present_via_identity_qualified_row_ids");

  return {
    totalJalanRows: rows.length,
    directionalCount,
    excludedCount,
    directCount,
    pricePressureUsableCount,
    directionalNoPriceCount,
    excludedAuditOnlyCount,
    directLegacyCount,
    excludedWithPriceCount,
    excludedClassifiedUsableCount,
    obsQualifiedRowCount,
    basisConfidenceCounts,
    repeatedMarketIdentityCount: repeatedObservations.length,
    repeatedObservations,
    priceMovementSamples,
    auto05x: {
      rowsCount: auto05xRowsCount,
      directionalCount: auto05xDirectionalCount,
      excludedCount: auto05xExcludedCount,
      directCount: auto05xDirectCount,
      pricePressureUsableCount: auto05xUsableCount
    },
    invariants,
    caveats
  };
}

// ---------------------------------------------------------------------------
// Environmental / DB invariants
// ---------------------------------------------------------------------------

export interface InvariantEnvInput {
  dbTotalRows: number;
  dbJalanRows: number;
  dbBookingRows: number;
  bookingDirectionalCount: number;
  jalanDirectionalCount: number;
  querySmokeOk: boolean;
  historyNotModified: boolean;
  dbNotWritten: boolean;
  contextNotRefreshed: boolean;
}

export interface InvariantChecks {
  db_total_rows_is_210: boolean;
  db_jalan_rows_is_38: boolean;
  db_booking_rows_is_46: boolean;
  jalan_directional_rows_gt_0: boolean;
  jalan_excluded_rows_not_price_pressure_usable: boolean;
  auto05x_added_direct_rows_is_0: boolean;
  booking_remains_primary_directional_source: boolean;
  query_smoke_passed_or_basis_caution: boolean;
  history_not_modified: boolean;
  db_not_written_by_this_phase: boolean;
  context_not_refreshed_by_this_phase: boolean;
}

export const EXPECTED_DB_TOTAL_ROWS = 210;
export const EXPECTED_DB_JALAN_ROWS = 38;
export const EXPECTED_DB_BOOKING_ROWS = 46;

export function evaluateInvariants(summary: JalanUsabilitySummary, env: InvariantEnvInput): InvariantChecks {
  return {
    db_total_rows_is_210: env.dbTotalRows === EXPECTED_DB_TOTAL_ROWS,
    db_jalan_rows_is_38: env.dbJalanRows === EXPECTED_DB_JALAN_ROWS,
    db_booking_rows_is_46: env.dbBookingRows === EXPECTED_DB_BOOKING_ROWS,
    jalan_directional_rows_gt_0: summary.directionalCount > 0,
    jalan_excluded_rows_not_price_pressure_usable: summary.invariants.excludedNotPricePressureUsable,
    auto05x_added_direct_rows_is_0: summary.invariants.auto05xAddedDirectIsZero,
    // Booking remains the primary directional backbone: it must carry strictly
    // more directional rows than Jalan, the supplementary source.
    booking_remains_primary_directional_source: env.bookingDirectionalCount > env.jalanDirectionalCount,
    query_smoke_passed_or_basis_caution: env.querySmokeOk,
    history_not_modified: env.historyNotModified,
    db_not_written_by_this_phase: env.dbNotWritten,
    context_not_refreshed_by_this_phase: env.contextNotRefreshed
  };
}

export function allInvariantsHold(checks: InvariantChecks): boolean {
  return Object.values(checks).every((v) => v === true);
}

export function decideUsability(summary: JalanUsabilitySummary, checks: InvariantChecks): AUTO06XDecision {
  if (summary.totalJalanRows === 0) return "jalan_price_pressure_usability_not_ready";
  if (!allInvariantsHold(checks)) return "jalan_price_pressure_usability_not_ready";
  // Usable supplementary evidence exists and all invariants hold. Jalan evidence
  // is supplementary directional / B-confidence and carries excluded-audit +
  // legacy-direct + repeated-observation caveats, so the verified-with-caveats
  // state is basis_caution; a caveat-free sample would be ready.
  if (summary.caveats.length > 0) return "jalan_price_pressure_usability_basis_caution";
  return "jalan_price_pressure_usability_ready";
}

// ---------------------------------------------------------------------------
// CSV rendering (one row per Jalan signal, with its classification)
// ---------------------------------------------------------------------------

export const USABILITY_CSV_HEADERS = [
  "row_id",
  "market_identity",
  "canonical_property_name",
  "collected_date_jst",
  "checkin_date",
  "stay_scope",
  "normalized_total_jpy",
  "basis_confidence",
  "dp_usage",
  "price_pressure_class",
  "is_auto05x_row",
  "is_observation_qualified"
] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

export function renderUsabilityCsv(rows: readonly JalanSignalRow[], auto05xRowIds: ReadonlySet<string>): string {
  const body = rows.map((r) =>
    [
      r.rowId,
      deriveMarketIdentity(r),
      r.canonicalPropertyName,
      r.collectedDateJst,
      r.checkinDate,
      r.stayScope,
      r.normalizedTotalJpy === null ? "" : String(r.normalizedTotalJpy),
      r.basisConfidence,
      r.dpUsage,
      classifyPricePressure(r),
      String(auto05xRowIds.has(r.rowId)),
      String(isObservationQualified(r.rowId))
    ]
      .map(csvEscape)
      .join(",")
  );
  return [USABILITY_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export interface QueryArtifactRef {
  task: string;
  decision: string;
  jsonPath: string;
}

export interface BookingComparisonSummary {
  totalBookingRows: number;
  bookingDirectionalCount: number;
  bookingDirectCount: number;
  jalanDirectionalCount: number;
  bookingRemainsPrimary: boolean;
}

export interface AUTO06XReportInput {
  generatedAtJst: string;
  runId: string;
  decision: AUTO06XDecision;
  dbHistoryRowCount: number;
  summary: JalanUsabilitySummary;
  bookingComparison: BookingComparisonSummary;
  invariantChecks: InvariantChecks;
  queryArtifacts: readonly QueryArtifactRef[];
  sourceAuto05bArtifactPath: string;
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugRootPath: string;
}

export function renderAUTO06XReport(input: AUTO06XReportInput): string {
  const s = input.summary;
  const bc = input.bookingComparison;
  const inv = input.invariantChecks;
  return [
    "# Jalan Price-Pressure Usability Verification (Phase JALAN-AUTO06X)",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Purpose & safety",
    "",
    "- READ-ONLY verification that Jalan rows are usable as a SUPPLEMENTARY domestic-OTA price-pressure signal, never as direct automatic-pricing data, with Booking.com remaining the PRIMARY directional backbone.",
    "- No history mutation, no DB mutation, no live request, no browser automation, no property-management or channel-manager output, no price update.",
    "",
    "## 2. Decision",
    "",
    `- decision=${input.decision}`,
    "",
    "## 3. DB mirror context",
    "",
    `- market_signal_history_row_count=${input.dbHistoryRowCount}`,
    `- total_jalan_rows=${s.totalJalanRows}`,
    `- source_auto05b_artifact=${input.sourceAuto05bArtifactPath}`,
    "",
    "## 4. Jalan dp_usage split",
    "",
    `- directional=${s.directionalCount}`,
    `- excluded=${s.excludedCount}`,
    `- direct=${s.directCount}`,
    `- basis_confidence=${JSON.stringify(s.basisConfidenceCounts)}`,
    "",
    "## 5. Price-pressure classification (Jalan supplementary)",
    "",
    `- jalan_price_pressure_usable_count=${s.pricePressureUsableCount}`,
    `- jalan_directional_with_price_count=${s.pricePressureUsableCount}`,
    `- jalan_directional_missing_price_count=${s.directionalNoPriceCount}`,
    `- excluded_audit_only=${s.excludedAuditOnlyCount}`,
    `- direct_legacy=${s.directLegacyCount}`,
    `- excluded_rows_with_a_price (informational)=${s.excludedWithPriceCount}`,
    `- jalan_excluded_with_price_pressure_usable_count (must be 0)=${s.excludedClassifiedUsableCount}`,
    "",
    "## 6. JALAN-AUTO05X appended-subset metrics",
    "",
    `- jalan_auto05x_rows_count=${s.auto05x.rowsCount}`,
    `- jalan_auto05x_directional_count=${s.auto05x.directionalCount}`,
    `- jalan_auto05x_excluded_count=${s.auto05x.excludedCount}`,
    `- jalan_auto05x_direct_count=${s.auto05x.directCount}`,
    `- jalan_direct_from_auto05x_count=${s.auto05x.directCount}`,
    `- jalan_auto05x_price_pressure_usable_count=${s.auto05x.pricePressureUsableCount}`,
    "",
    "## 7. Booking comparison (Booking remains primary)",
    "",
    `- total_booking_rows=${bc.totalBookingRows}`,
    `- booking_directional_count=${bc.bookingDirectionalCount}`,
    `- booking_direct_count=${bc.bookingDirectCount}`,
    `- jalan_directional_count=${bc.jalanDirectionalCount}`,
    `- booking_remains_primary_directional_source=${bc.bookingRemainsPrimary}`,
    "",
    "## 8. Invariants",
    "",
    `- db_total_rows_is_210=${inv.db_total_rows_is_210}`,
    `- db_jalan_rows_is_38=${inv.db_jalan_rows_is_38}`,
    `- db_booking_rows_is_46=${inv.db_booking_rows_is_46}`,
    `- jalan_directional_rows_gt_0=${inv.jalan_directional_rows_gt_0}`,
    `- jalan_excluded_rows_not_price_pressure_usable=${inv.jalan_excluded_rows_not_price_pressure_usable}`,
    `- auto05x_added_direct_rows_is_0=${inv.auto05x_added_direct_rows_is_0}`,
    `- booking_remains_primary_directional_source=${inv.booking_remains_primary_directional_source}`,
    `- query_smoke_passed_or_basis_caution=${inv.query_smoke_passed_or_basis_caution}`,
    `- history_not_modified=${inv.history_not_modified}`,
    `- db_not_written_by_this_phase=${inv.db_not_written_by_this_phase}`,
    `- context_not_refreshed_by_this_phase=${inv.context_not_refreshed_by_this_phase}`,
    "",
    "## 9. Repeated observations (by market identity / obs row_id)",
    "",
    `- observation_qualified_rows=${s.obsQualifiedRowCount}`,
    `- repeated_market_identities=${s.repeatedMarketIdentityCount}`,
    "",
    "| market_identity | property | observations | obs_qualified | price_min | price_max | spread |",
    "|---|---|---|---|---|---|---|",
    ...s.repeatedObservations
      .slice(0, 20)
      .map(
        (r) =>
          `| ${r.marketIdentity} | ${r.canonicalPropertyName} | ${r.observationCount} | ${r.obsQualifiedCount} | ${r.priceMinJpy ?? ""} | ${r.priceMaxJpy ?? ""} | ${r.priceSpreadJpy ?? ""} |`
      ),
    "",
    "## 10. Sample price-movement rows",
    "",
    "| property | from_date | from_jpy | to_date | to_jpy | delta_jpy | to_obs_qualified |",
    "|---|---|---|---|---|---|---|",
    ...s.priceMovementSamples
      .slice(0, 20)
      .map(
        (m) =>
          `| ${m.canonicalPropertyName} | ${m.fromCollectedDateJst} | ${m.fromPriceJpy} | ${m.toCollectedDateJst} | ${m.toPriceJpy} | ${m.deltaJpy} | ${m.toIsObservationQualified} |`
      ),
    "",
    "## 11. AI task query corroboration",
    "",
    "| task | decision | artifact |",
    "|---|---|---|",
    ...input.queryArtifacts.map((q) => `| ${q.task} | ${q.decision} | ${q.jsonPath} |`),
    "",
    "## 12. Caveats",
    "",
    ...(s.caveats.length > 0 ? s.caveats.map((c) => `- ${c}`) : ["- none"]),
    "",
    "## 13. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    ""
  ].join("\n");
}
