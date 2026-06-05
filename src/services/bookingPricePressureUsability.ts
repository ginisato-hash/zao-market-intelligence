// Phase BOOKING-B12X — Booking price-pressure usability verification (engine).
//
// READ-ONLY. Verifies that Booking rows in the DB mirror (market_signal_history)
// are usable as market PRICE-PRESSURE evidence for AI tasks, while NEVER being
// treated as direct automatic-pricing data. Booking rows are directional/B or
// excluded/C only; there must be zero direct Booking rows, and excluded rows must
// never enter the price-pressure sample.
//
// This module reads and classifies; it writes NO history, NO DB rows, runs NO
// live request / browser automation, emits NO property-management or
// channel-manager output, and performs NO price update.

// ---------------------------------------------------------------------------
// Decision labels
// ---------------------------------------------------------------------------

export type B12XDecision =
  | "booking_price_pressure_usability_ready"
  | "booking_price_pressure_usability_basis_caution"
  | "booking_price_pressure_usability_not_ready";

// price-pressure classification of a single Booking row.
export type PricePressureClass =
  | "price_pressure_usable" // directional + has a normalized total -> feeds price-pressure medians
  | "excluded_not_usable" // excluded, or directional with no usable total -> never feeds price pressure
  | "direct_disallowed"; // dp_usage=direct -> forbidden for Booking (must be 0)

// The subset of market_signal_history columns this verification needs.
export interface BookingSignalRow {
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

// Observation qualifier appended by the B11X identity policy (|obs:<16 hex>).
const OBS_QUALIFIER_RE = /\|obs:[0-9a-f]{16}$/u;

export function isObservationQualified(rowId: string): boolean {
  return OBS_QUALIFIER_RE.test(rowId);
}

// Market identity ignores the collected date and observation qualifier: a single
// (source, property, checkin, checkout, stay_scope) market cell can be observed
// many times.
export function deriveMarketIdentity(row: BookingSignalRow): string {
  return [row.source, row.sourcePropertyId, row.checkinDate, row.checkoutDate, row.stayScope].join("|");
}

export function classifyPricePressure(row: BookingSignalRow): PricePressureClass {
  if (row.dpUsage === "direct") return "direct_disallowed";
  if (row.dpUsage === "excluded") return "excluded_not_usable";
  if (row.dpUsage === "directional" && row.normalizedTotalJpy !== null) return "price_pressure_usable";
  return "excluded_not_usable";
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

export interface UsabilityInvariants {
  bookingDirectIsZero: boolean;
  excludedNotInPricePressure: boolean; // no excluded row carries a price
  directionalSurfacedInPricePressure: boolean; // directional priced rows exist
}

export interface UsabilitySummary {
  totalBookingRows: number;
  directionalCount: number;
  excludedCount: number;
  directCount: number;
  pricePressureUsableCount: number;
  excludedNotUsableCount: number;
  directDisallowedCount: number;
  excludedWithPriceCount: number;
  obsQualifiedRowCount: number;
  basisConfidenceCounts: Record<string, number>;
  repeatedMarketIdentityCount: number;
  repeatedObservations: RepeatedObservation[];
  priceMovementSamples: PriceMovementSample[];
  invariants: UsabilityInvariants;
  caveats: string[];
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function computeUsabilitySummary(rows: readonly BookingSignalRow[]): UsabilitySummary {
  let directionalCount = 0;
  let excludedCount = 0;
  let directCount = 0;
  let pricePressureUsableCount = 0;
  let excludedNotUsableCount = 0;
  let directDisallowedCount = 0;
  let excludedWithPriceCount = 0;
  let obsQualifiedRowCount = 0;
  const basisConfidenceCounts: Record<string, number> = {};

  const byIdentity = new Map<string, BookingSignalRow[]>();

  for (const row of rows) {
    if (row.dpUsage === "directional") directionalCount += 1;
    else if (row.dpUsage === "excluded") excludedCount += 1;
    else if (row.dpUsage === "direct") directCount += 1;

    const cls = classifyPricePressure(row);
    if (cls === "price_pressure_usable") pricePressureUsableCount += 1;
    else if (cls === "excluded_not_usable") excludedNotUsableCount += 1;
    else directDisallowedCount += 1;

    if (row.dpUsage === "excluded" && row.normalizedTotalJpy !== null) excludedWithPriceCount += 1;
    if (isObservationQualified(row.rowId)) obsQualifiedRowCount += 1;
    bump(basisConfidenceCounts, row.basisConfidence);

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
      a.collectedDateJst === b.collectedDateJst ? a.rowId.localeCompare(b.rowId) : a.collectedDateJst.localeCompare(b.collectedDateJst)
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

    // Build a price-movement sample from the first/last priced observations.
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

  repeatedObservations.sort((a, b) => b.observationCount - a.observationCount || a.marketIdentity.localeCompare(b.marketIdentity));
  priceMovementSamples.sort((a, b) => Math.abs(b.deltaJpy) - Math.abs(a.deltaJpy) || a.marketIdentity.localeCompare(b.marketIdentity));

  const invariants: UsabilityInvariants = {
    bookingDirectIsZero: directCount === 0 && directDisallowedCount === 0,
    excludedNotInPricePressure: excludedWithPriceCount === 0,
    directionalSurfacedInPricePressure: pricePressureUsableCount > 0
  };

  const caveats: string[] = [];
  const usableNonA = rows.some((r) => classifyPricePressure(r) === "price_pressure_usable" && r.basisConfidence !== "A");
  if (usableNonA) caveats.push("price_pressure_rows_are_directional_b_confidence_not_direct");
  if (excludedCount > 0) caveats.push("excluded_rows_present_audit_only_not_price_pressure");
  if (obsQualifiedRowCount > 0) caveats.push("repeated_observations_present_via_identity_qualified_row_ids");

  return {
    totalBookingRows: rows.length,
    directionalCount,
    excludedCount,
    directCount,
    pricePressureUsableCount,
    excludedNotUsableCount,
    directDisallowedCount,
    excludedWithPriceCount,
    obsQualifiedRowCount,
    basisConfidenceCounts,
    repeatedMarketIdentityCount: repeatedObservations.length,
    repeatedObservations,
    priceMovementSamples,
    invariants,
    caveats
  };
}

export function decideUsability(summary: UsabilitySummary): B12XDecision {
  const inv = summary.invariants;
  if (summary.totalBookingRows === 0) return "booking_price_pressure_usability_not_ready";
  if (!inv.bookingDirectIsZero) return "booking_price_pressure_usability_not_ready";
  if (!inv.excludedNotInPricePressure) return "booking_price_pressure_usability_not_ready";
  if (!inv.directionalSurfacedInPricePressure) return "booking_price_pressure_usability_not_ready";
  // Usable evidence exists and invariants hold. Booking evidence is directional /
  // B-confidence and carries repeated-observation + excluded-audit caveats, so the
  // verified-with-caveats state is basis_caution; a caveat-free sample is ready.
  if (summary.caveats.length > 0) return "booking_price_pressure_usability_basis_caution";
  return "booking_price_pressure_usability_ready";
}

// ---------------------------------------------------------------------------
// CSV rendering (one row per Booking signal, with its classification)
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
  "is_observation_qualified"
] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}

export function renderUsabilityCsv(rows: readonly BookingSignalRow[]): string {
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

export interface B12XReportInput {
  generatedAtJst: string;
  runId: string;
  decision: B12XDecision;
  dbHistoryRowCount: number;
  summary: UsabilitySummary;
  queryArtifacts: readonly QueryArtifactRef[];
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugRootPath: string;
}

export function renderB12XReport(input: B12XReportInput): string {
  const s = input.summary;
  return [
    "# Booking Price-Pressure Usability Verification (Phase BOOKING-B12X)",
    "",
    `Generated at (JST): ${input.generatedAtJst}`,
    `Run ID: ${input.runId}`,
    "",
    "## 1. Purpose & safety",
    "",
    "- READ-ONLY verification that Booking rows are usable as market price-pressure evidence, never as direct automatic-pricing data.",
    "- No history mutation, no DB mutation, no live request, no browser automation, no property-management or channel-manager output, no price update.",
    "",
    "## 2. Decision",
    "",
    `- decision=${input.decision}`,
    "",
    "## 3. DB mirror context",
    "",
    `- market_signal_history_row_count=${input.dbHistoryRowCount}`,
    `- total_booking_rows=${s.totalBookingRows}`,
    "",
    "## 4. Booking dp_usage split",
    "",
    `- directional=${s.directionalCount}`,
    `- excluded=${s.excludedCount}`,
    `- direct=${s.directCount}`,
    `- basis_confidence=${JSON.stringify(s.basisConfidenceCounts)}`,
    "",
    "## 5. Price-pressure classification",
    "",
    `- price_pressure_usable=${s.pricePressureUsableCount}`,
    `- excluded_not_usable=${s.excludedNotUsableCount}`,
    `- direct_disallowed=${s.directDisallowedCount}`,
    `- excluded_rows_with_a_price (must be 0)=${s.excludedWithPriceCount}`,
    "",
    "## 6. Invariants",
    "",
    `- booking_direct_rows_is_zero=${s.invariants.bookingDirectIsZero}`,
    `- excluded_rows_not_in_price_pressure=${s.invariants.excludedNotInPricePressure}`,
    `- directional_rows_surfaced_in_price_pressure=${s.invariants.directionalSurfacedInPricePressure}`,
    "",
    "## 7. Repeated observations (by market identity / obs row_id)",
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
    "## 8. Sample price-movement rows",
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
    "## 9. AI task query corroboration",
    "",
    "| task | decision | artifact |",
    "|---|---|---|",
    ...input.queryArtifacts.map((q) => `| ${q.task} | ${q.decision} | ${q.jsonPath} |`),
    "",
    "## 10. Caveats",
    "",
    ...(s.caveats.length > 0 ? s.caveats.map((c) => `- ${c}`) : ["- none"]),
    "",
    "## 11. Output paths",
    "",
    `- report_path=${input.reportPath}`,
    `- json_summary_path=${input.jsonPath}`,
    `- csv_path=${input.csvPath}`,
    `- debug_artifact_path=${input.debugRootPath}`,
    ""
  ].join("\n");
}
