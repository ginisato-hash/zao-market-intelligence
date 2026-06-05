// Phase DP01X — Zao Demand Index / DP Matrix Design (prototype, read-only).
//
// Pure scoring/design helpers that convert existing cross-source market-signal
// history (.data/history/zao_signals_*.csv) into decision-support outputs:
// daily demand strength, sold-out pressure, price pressure, confidence-weighted
// signal, recommended pricing posture, and a restaurant-facing congestion
// forecast rank.
//
// THIS MODULE MUTATES NOTHING and PRICES NOTHING. No DB writes. No PMS / Beds24
// / AirHost / OTA output. No price update. No GitHub Actions / GitOps / cron.
// No commits/pushes. No live external fetch. No collector re-run. No paid
// sources. No `.data/history` modification. No Booking base × 1.1 logic. This
// is a design/prototype layer only.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Subset of the zao_local_history_v1 row schema that DP01X consumes (read-only).
export interface HistoryRow {
  source: string;
  canonicalPropertyName: string;
  checkin: string;
  checkout: string;
  stayScope: string;
  availabilityStatus: string;
  soldOutStatus: string;
  normalizedTotalPrice: string;
  basisConfidence: string;
  isPriceUsableForDpDirect: string;
  isPriceUsableForDpDirectional: string;
  isPriceExcludedFromDp: string;
  dpExclusionReason: string;
  warningFlags: string;
}

export type DpUsage = "direct" | "directional" | "excluded" | "unusable";

export type DemandBand = "S_extreme" | "A_strong" | "B_moderate_high" | "C_normal" | "D_weak" | "E_very_weak";

export type CongestionRank = "S" | "A" | "B" | "C" | "D" | "E";

export type PricingPosture =
  | "raise_now"
  | "hold_strong"
  | "hold"
  | "sell_through"
  | "discount_candidate"
  | "insufficient_data";

export type ConfidenceLevel = "high" | "medium" | "low" | "insufficient";

export type DP01XDecision =
  | "zao_demand_index_design_ready"
  | "zao_demand_index_design_basis_caution"
  | "zao_demand_index_design_not_ready";

export interface DemandIndexRow {
  runId: string;
  generatedAtJst: string;
  checkinDate: string;
  checkoutDate: string;
  stayScope: string;
  rowCount: number;
  sourceCount: number;
  propertyCount: number;
  directPriceRowCount: number;
  directionalPriceRowCount: number;
  excludedRowCount: number;
  soldOutCount: number;
  availableCount: number;
  notListedCount: number;
  crossSourceMedianJpy: number | null;
  directOnlyMedianJpy: number | null;
  directionalMedianJpy: number | null;
  soldOutPressureScore: number;
  pricePressureScore: number;
  confidenceScore: number;
  calendarScore: number;
  bookingWindowScore: number;
  demandIndex: number;
  demandBand: DemandBand;
  pricingPosture: PricingPosture;
  congestionForecastRank: CongestionRank;
  confidenceLevel: ConfidenceLevel;
  basisNote: string;
  recommendedHumanAction: string;
  debugArtifactPath: string;
}

export const DEMAND_INDEX_CSV_HEADERS = [
  "run_id",
  "generated_at_jst",
  "checkin_date",
  "checkout_date",
  "stay_scope",
  "row_count",
  "source_count",
  "property_count",
  "direct_price_row_count",
  "directional_price_row_count",
  "excluded_row_count",
  "sold_out_count",
  "available_count",
  "not_listed_count",
  "cross_source_median_jpy",
  "direct_only_median_jpy",
  "directional_median_jpy",
  "sold_out_pressure_score",
  "price_pressure_score",
  "confidence_score",
  "calendar_score",
  "booking_window_score",
  "demand_index",
  "demand_band",
  "pricing_posture",
  "congestion_forecast_rank",
  "confidence_level",
  "basis_note",
  "recommended_human_action",
  "debug_artifact_path"
] as const;

// Output must never carry PMS / channel-manager / per-room columns.
export const FORBIDDEN_OUTPUT_COLUMN_TOKENS = [
  "roomid",
  "inventory",
  "minstay",
  "maxstay",
  "multiplier",
  "price1",
  "price2",
  "price3",
  "price4",
  "price5",
  "beds24",
  "airhost",
  "pms"
] as const;

// Static Japanese public-holiday set (2026) — avoids any external holiday API.
export const JP_HOLIDAYS_2026 = new Set<string>([
  "2026-01-01", // New Year's Day
  "2026-01-12", // Coming of Age Day
  "2026-02-11", // National Foundation Day
  "2026-02-23", // Emperor's Birthday
  "2026-03-20", // Vernal Equinox Day
  "2026-04-29", // Showa Day
  "2026-05-03", // Constitution Memorial Day
  "2026-05-04", // Greenery Day
  "2026-05-05", // Children's Day
  "2026-05-06", // substitute holiday
  "2026-07-20", // Marine Day
  "2026-08-11", // Mountain Day
  "2026-09-21", // Respect for the Aged Day
  "2026-09-22", // National holiday (between)
  "2026-09-23", // Autumnal Equinox Day
  "2026-10-12", // Sports Day
  "2026-11-03", // Culture Day
  "2026-11-23" // Labor Thanksgiving Day
]);

// Component score caps (sum = 100).
export const SCORE_CAPS = {
  soldOutPressure: 35,
  pricePressure: 25,
  confidence: 15,
  calendar: 15,
  bookingWindow: 10
} as const;

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

export function deriveDpUsage(row: HistoryRow): DpUsage {
  if (row.isPriceExcludedFromDp === "true") return "excluded";
  if (row.isPriceUsableForDpDirect === "true") return "direct";
  if (row.isPriceUsableForDpDirectional === "true") return "directional";
  return "unusable";
}

function isSoldOut(row: HistoryRow): boolean {
  return row.availabilityStatus === "sold_out" || row.soldOutStatus === "sold_out";
}

function isAvailable(row: HistoryRow): boolean {
  return row.availabilityStatus === "available";
}

function isNotListed(row: HistoryRow): boolean {
  return !isSoldOut(row) && !isAvailable(row);
}

function priceOf(row: HistoryRow): number | null {
  const n = Number(row.normalizedTotalPrice);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface DateGroup {
  checkinDate: string;
  checkoutDate: string;
  stayScope: string;
  rows: HistoryRow[];
}

export function groupKey(row: HistoryRow): string {
  return `${row.checkin}|${row.checkout}|${row.stayScope}`;
}

export function aggregateByDate(rows: HistoryRow[]): DateGroup[] {
  const map = new Map<string, DateGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    let group = map.get(key);
    if (!group) {
      group = { checkinDate: row.checkin, checkoutDate: row.checkout, stayScope: row.stayScope, rows: [] };
      map.set(key, group);
    }
    group.rows.push(row);
  }
  return [...map.values()].sort((a, b) => a.checkinDate.localeCompare(b.checkinDate) || a.checkoutDate.localeCompare(b.checkoutDate));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
  return s[idx]!;
}

// Aggregate counts/medians for one date group (excludes `excluded` rows from medians).
export interface GroupMetrics {
  rowCount: number;
  sourceCount: number;
  propertyCount: number;
  directPriceRowCount: number;
  directionalPriceRowCount: number;
  excludedRowCount: number;
  soldOutCount: number;
  availableCount: number;
  notListedCount: number;
  crossSourceMedianJpy: number | null;
  directOnlyMedianJpy: number | null;
  directionalMedianJpy: number | null;
  usablePriceRowCount: number;
}

export function computeGroupMetrics(group: DateGroup): GroupMetrics {
  const directPrices: number[] = [];
  const directionalPrices: number[] = [];
  const sources = new Set<string>();
  const properties = new Set<string>();
  let excludedRowCount = 0;
  let soldOutCount = 0;
  let availableCount = 0;
  let notListedCount = 0;

  for (const row of group.rows) {
    sources.add(row.source);
    if (row.canonicalPropertyName) properties.add(row.canonicalPropertyName);
    if (isSoldOut(row)) soldOutCount += 1;
    else if (isAvailable(row)) availableCount += 1;
    else notListedCount += 1;

    const usage = deriveDpUsage(row);
    if (usage === "excluded") {
      excludedRowCount += 1;
      continue; // excluded rows never contribute to price medians
    }
    const price = priceOf(row);
    if (price === null) continue;
    if (usage === "direct") directPrices.push(price);
    else if (usage === "directional") directionalPrices.push(price);
  }

  const crossSource = [...directPrices, ...directionalPrices];
  return {
    rowCount: group.rows.length,
    sourceCount: sources.size,
    propertyCount: properties.size,
    directPriceRowCount: directPrices.length,
    directionalPriceRowCount: directionalPrices.length,
    excludedRowCount,
    soldOutCount,
    availableCount,
    notListedCount,
    crossSourceMedianJpy: median(crossSource),
    directOnlyMedianJpy: median(directPrices),
    directionalMedianJpy: median(directionalPrices),
    usablePriceRowCount: crossSource.length
  };
}

// ---------------------------------------------------------------------------
// Scoring components
// ---------------------------------------------------------------------------

function clampRound(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

// 8.1 Sold-out pressure (0–35). Ratio of sold-out vs (sold-out + available),
// plus a multi-source confirmation bonus. Small stock counts are NOT used.
export function soldOutPressureScore(input: { soldOutCount: number; availableCount: number; sourceCount: number }): number {
  const denom = input.soldOutCount + input.availableCount;
  const ratio = denom > 0 ? input.soldOutCount / denom : 0;
  let score = ratio * 28;
  if (input.soldOutCount >= 1 && input.sourceCount >= 2) {
    score += Math.min(7, (input.sourceCount - 1) * 3.5);
  }
  return clampRound(score, SCORE_CAPS.soldOutPressure);
}

// 8.2 Price pressure (0–25). Uses usable (direct/directional) medians vs a
// dataset reference. Excluded rows are not used. No Booking base × 1.1.
export function pricePressureScore(input: {
  usablePriceRowCount: number;
  sourceCountWithPrice: number;
  groupMedianJpy: number | null;
  refP66: number;
  refP90: number;
}): { score: number; highPriceFlag: boolean; premiumCeilingFlag: boolean } {
  if (input.usablePriceRowCount === 0 || input.groupMedianJpy === null) {
    return { score: 0, highPriceFlag: false, premiumCeilingFlag: false };
  }
  const highPriceFlag = input.groupMedianJpy >= input.refP66;
  const premiumCeilingFlag = input.groupMedianJpy >= input.refP90;
  let score = 8; // prices observed at all = baseline pressure signal
  if (highPriceFlag) score += 9;
  if (premiumCeilingFlag) score += 5;
  if (input.sourceCountWithPrice >= 2) score += 3;
  return { score: clampRound(score, SCORE_CAPS.pricePressure), highPriceFlag, premiumCeilingFlag };
}

// 8.3 Confidence (0–15). Direct (A) rows strongest; directional adds a little;
// source diversity adds a little.
export function confidenceScore(input: { directRowCount: number; directionalRowCount: number; sourceCount: number }): number {
  let score = 0;
  score += Math.min(8, input.directRowCount * 4);
  score += Math.min(4, input.directionalRowCount * 1);
  score += Math.min(3, Math.max(0, input.sourceCount - 1) * 1.5);
  return clampRound(score, SCORE_CAPS.confidence);
}

export type Season =
  | "winter_ski"
  | "autumn_foliage"
  | "summer_vacation"
  | "obon"
  | "golden_week"
  | "new_year"
  | "none";

export function seasonFor(checkinDate: string): Season {
  const [, mm, dd] = checkinDate.split("-").map((x) => Number(x));
  const m = mm ?? 0;
  const d = dd ?? 0;
  const md = m * 100 + d;
  if ((m === 12 && d >= 30) || (m === 1 && d <= 3)) return "new_year";
  if (m === 12 || m === 1 || m === 2) return "winter_ski";
  if (md >= 811 && md <= 816) return "obon";
  if (md >= 1010 && md <= 1110) return "autumn_foliage";
  if (md >= 720 && md <= 831) return "summer_vacation";
  if (md >= 429 && md <= 506) return "golden_week";
  return "none";
}

function seasonBonus(season: Season): number {
  switch (season) {
    case "new_year":
    case "winter_ski":
    case "obon":
    case "golden_week":
      return 5;
    case "autumn_foliage":
    case "summer_vacation":
      return 4;
    default:
      return 0;
  }
}

// 8.4 Calendar / seasonality (0–15). Date features only; local static holiday set.
export function calendarScore(input: { checkinDate: string; holidays?: Set<string> }): number {
  const holidays = input.holidays ?? JP_HOLIDAYS_2026;
  const dow = dayOfWeek(input.checkinDate); // 0=Sun..6=Sat
  let score = 0;
  if (dow === 6) score += 7; // Saturday
  else if (dow === 5) score += 4; // Friday
  else if (dow === 0) score += 2; // Sunday
  if (holidays.has(input.checkinDate)) score += 6;
  // Sunday before a Monday holiday (long-weekend Sunday).
  if (dow === 0 && holidays.has(addDays(input.checkinDate, 1))) score += 2;
  score += seasonBonus(seasonFor(input.checkinDate));
  return clampRound(score, SCORE_CAPS.calendar);
}

// 8.5 Booking window / proximity (0–10). Uses days-until-checkin and sold-out pressure.
export function bookingWindowScore(input: { daysUntilCheckin: number; soldOutPressureScore: number }): number {
  const d = input.daysUntilCheckin;
  if (d < 0) return 1; // past date — minimal residual signal
  if (d <= 7) return input.soldOutPressureScore >= 20 ? 10 : 5;
  if (d <= 21) return 7;
  if (d <= 60) return 5;
  return 3;
}

// ---------------------------------------------------------------------------
// Demand index assembly + classification
// ---------------------------------------------------------------------------

export function demandIndexFrom(components: {
  soldOutPressureScore: number;
  pricePressureScore: number;
  confidenceScore: number;
  calendarScore: number;
  bookingWindowScore: number;
}): number {
  const sum =
    components.soldOutPressureScore +
    components.pricePressureScore +
    components.confidenceScore +
    components.calendarScore +
    components.bookingWindowScore;
  return Math.max(0, Math.min(100, Math.round(sum)));
}

export function demandBandFor(index: number): DemandBand {
  if (index >= 90) return "S_extreme";
  if (index >= 75) return "A_strong";
  if (index >= 60) return "B_moderate_high";
  if (index >= 45) return "C_normal";
  if (index >= 30) return "D_weak";
  return "E_very_weak";
}

export function congestionRankFor(index: number): CongestionRank {
  const band = demandBandFor(index);
  switch (band) {
    case "S_extreme":
      return "S";
    case "A_strong":
      return "A";
    case "B_moderate_high":
      return "B";
    case "C_normal":
      return "C";
    case "D_weak":
      return "D";
    case "E_very_weak":
      return "E";
  }
}

const MIN_USABLE_SIGNAL = 1;

export function decidePricingPosture(input: {
  demandIndex: number;
  soldOutPressureScore: number;
  confidenceScore: number;
  daysUntilCheckin: number;
  availableCount: number;
  usableSignalCount: number;
  minUsable?: number;
}): PricingPosture {
  const minUsable = input.minUsable ?? MIN_USABLE_SIGNAL;
  if (input.usableSignalCount < minUsable) return "insufficient_data";
  if (input.demandIndex >= 75 && input.soldOutPressureScore >= 24 && input.confidenceScore >= 8) return "raise_now";
  if (input.demandIndex >= 75) return "hold_strong";
  if (input.demandIndex < 45 && input.soldOutPressureScore < 10 && input.daysUntilCheckin >= 0 && input.daysUntilCheckin <= 14) {
    return "discount_candidate";
  }
  if (input.demandIndex < 60 && input.soldOutPressureScore < 12 && input.availableCount >= 1) return "sell_through";
  return "hold";
}

export function confidenceLevelFor(input: {
  usableSignalCount: number;
  directRowCount: number;
  sourceCount: number;
  confidenceScore: number;
  minUsable?: number;
}): ConfidenceLevel {
  const minUsable = input.minUsable ?? MIN_USABLE_SIGNAL;
  if (input.usableSignalCount < minUsable) return "insufficient";
  if (input.directRowCount >= 1 && input.sourceCount >= 2 && input.confidenceScore >= 10) return "high";
  if (input.confidenceScore >= 6) return "medium";
  return "low";
}

export function recommendedHumanActionFor(posture: PricingPosture): string {
  switch (posture) {
    case "raise_now":
      return "Review for an immediate rate increase (strong demand + sold-out pressure).";
    case "hold_strong":
      return "Hold rate firm; gather one more confirming signal before raising.";
    case "hold":
      return "Maintain current posture; monitor.";
    case "sell_through":
      return "Consider sell-through tactics; ample remaining supply proxy.";
    case "discount_candidate":
      return "Review for a close-in discount; weak demand and low sold-out pressure.";
    case "insufficient_data":
      return "Collect more signal before any pricing decision.";
  }
}

// ---------------------------------------------------------------------------
// Build demand-index rows
// ---------------------------------------------------------------------------

export interface BuildContext {
  runId: string;
  generatedAtJst: string;
  todayJst: string; // YYYY-MM-DD (JST) for booking-window math
  refP66: number;
  refP90: number;
  holidays?: Set<string>;
  debugArtifactPath: string;
}

export function buildDemandIndexRow(group: DateGroup, ctx: BuildContext): DemandIndexRow {
  const m = computeGroupMetrics(group);

  const soldOut = soldOutPressureScore({ soldOutCount: m.soldOutCount, availableCount: m.availableCount, sourceCount: m.sourceCount });
  const price = pricePressureScore({
    usablePriceRowCount: m.usablePriceRowCount,
    sourceCountWithPrice: m.sourceCount,
    groupMedianJpy: m.crossSourceMedianJpy,
    refP66: ctx.refP66,
    refP90: ctx.refP90
  });
  const confidence = confidenceScore({
    directRowCount: m.directPriceRowCount,
    directionalRowCount: m.directionalPriceRowCount,
    sourceCount: m.sourceCount
  });
  const calendar = calendarScore({ checkinDate: group.checkinDate, ...(ctx.holidays ? { holidays: ctx.holidays } : {}) });
  const daysUntilCheckin = daysBetween(ctx.todayJst, group.checkinDate);
  const bookingWindow = bookingWindowScore({ daysUntilCheckin, soldOutPressureScore: soldOut });

  const demandIndex = demandIndexFrom({
    soldOutPressureScore: soldOut,
    pricePressureScore: price.score,
    confidenceScore: confidence,
    calendarScore: calendar,
    bookingWindowScore: bookingWindow
  });
  const demandBand = demandBandFor(demandIndex);
  const usableSignalCount = m.soldOutCount + m.usablePriceRowCount;
  const pricingPosture = decidePricingPosture({
    demandIndex,
    soldOutPressureScore: soldOut,
    confidenceScore: confidence,
    daysUntilCheckin,
    availableCount: m.availableCount,
    usableSignalCount
  });
  const confidenceLevel = confidenceLevelFor({
    usableSignalCount,
    directRowCount: m.directPriceRowCount,
    sourceCount: m.sourceCount,
    confidenceScore: confidence
  });

  const basisNote =
    `season=${seasonFor(group.checkinDate)}; days_until=${daysUntilCheckin}; ` +
    `usable_price_rows=${m.usablePriceRowCount} (direct=${m.directPriceRowCount}, directional=${m.directionalPriceRowCount}); ` +
    `sold_out=${m.soldOutCount}/${m.soldOutCount + m.availableCount}; ` +
    `high_price=${price.highPriceFlag}; premium_ceiling=${price.premiumCeilingFlag}`;

  return {
    runId: ctx.runId,
    generatedAtJst: ctx.generatedAtJst,
    checkinDate: group.checkinDate,
    checkoutDate: group.checkoutDate,
    stayScope: group.stayScope,
    rowCount: m.rowCount,
    sourceCount: m.sourceCount,
    propertyCount: m.propertyCount,
    directPriceRowCount: m.directPriceRowCount,
    directionalPriceRowCount: m.directionalPriceRowCount,
    excludedRowCount: m.excludedRowCount,
    soldOutCount: m.soldOutCount,
    availableCount: m.availableCount,
    notListedCount: m.notListedCount,
    crossSourceMedianJpy: m.crossSourceMedianJpy,
    directOnlyMedianJpy: m.directOnlyMedianJpy,
    directionalMedianJpy: m.directionalMedianJpy,
    soldOutPressureScore: soldOut,
    pricePressureScore: price.score,
    confidenceScore: confidence,
    calendarScore: calendar,
    bookingWindowScore: bookingWindow,
    demandIndex,
    demandBand,
    pricingPosture,
    congestionForecastRank: congestionRankFor(demandIndex),
    confidenceLevel,
    basisNote,
    recommendedHumanAction: recommendedHumanActionFor(pricingPosture),
    debugArtifactPath: ctx.debugArtifactPath
  };
}

export function buildDemandIndexRows(rows: HistoryRow[], ctx: BuildContext): DemandIndexRow[] {
  return aggregateByDate(rows).map((group) => buildDemandIndexRow(group, ctx));
}

// Reference price thresholds from all usable (direct/directional) prices in the dataset.
export function computePriceReference(rows: HistoryRow[]): { refP66: number; refP90: number; usablePriceValueCount: number } {
  const prices: number[] = [];
  for (const row of rows) {
    const usage = deriveDpUsage(row);
    if (usage === "direct" || usage === "directional") {
      const p = priceOf(row);
      if (p !== null) prices.push(p);
    }
  }
  return { refP66: percentile(prices, 0.66), refP90: percentile(prices, 0.9), usablePriceValueCount: prices.length };
}

// ---------------------------------------------------------------------------
// Decision + summary
// ---------------------------------------------------------------------------

export interface DesignCounts {
  historyFileCount: number;
  historyRowCount: number;
  demandRowCount: number;
  directPriceRowCount: number;
  directionalPriceRowCount: number;
  avgSourceCount: number;
}

export function decideDP01X(counts: DesignCounts): DP01XDecision {
  if (counts.historyFileCount === 0 || counts.historyRowCount === 0 || counts.demandRowCount === 0) {
    return "zao_demand_index_design_not_ready";
  }
  const directionalHeavy = counts.directionalPriceRowCount > counts.directPriceRowCount * 3;
  const thinCoverage = counts.avgSourceCount < 2;
  if (directionalHeavy || thinCoverage) return "zao_demand_index_design_basis_caution";
  return "zao_demand_index_design_ready";
}

export function countBy<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export interface DesignSummary {
  runId: string;
  generatedAt: string;
  sourceHistoryFiles: string[];
  historyRowCount: number;
  demandRowCount: number;
  refP66: number;
  refP90: number;
  decision: DP01XDecision;
  demandBandCounts: Record<string, number>;
  pricingPostureCounts: Record<string, number>;
  congestionRankCounts: Record<string, number>;
  confidenceLevelCounts: Record<string, number>;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderDemandIndexCsv(rows: DemandIndexRow[]): string {
  const body = rows.map((r) =>
    [
      r.runId,
      r.generatedAtJst,
      r.checkinDate,
      r.checkoutDate,
      r.stayScope,
      String(r.rowCount),
      String(r.sourceCount),
      String(r.propertyCount),
      String(r.directPriceRowCount),
      String(r.directionalPriceRowCount),
      String(r.excludedRowCount),
      String(r.soldOutCount),
      String(r.availableCount),
      String(r.notListedCount),
      r.crossSourceMedianJpy === null ? "" : String(r.crossSourceMedianJpy),
      r.directOnlyMedianJpy === null ? "" : String(r.directOnlyMedianJpy),
      r.directionalMedianJpy === null ? "" : String(r.directionalMedianJpy),
      String(r.soldOutPressureScore),
      String(r.pricePressureScore),
      String(r.confidenceScore),
      String(r.calendarScore),
      String(r.bookingWindowScore),
      String(r.demandIndex),
      r.demandBand,
      r.pricingPosture,
      r.congestionForecastRank,
      r.confidenceLevel,
      r.basisNote,
      r.recommendedHumanAction,
      r.debugArtifactPath
    ]
      .map(csvEscape)
      .join(",")
  );
  return [DEMAND_INDEX_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderDesignReport(input: { summary: DesignSummary; rows: DemandIndexRow[] }): string {
  const { summary, rows } = input;
  const byIndexDesc = [...rows].sort((a, b) => b.demandIndex - a.demandIndex);
  const topStrong = byIndexDesc.slice(0, 8);
  const topWeak = [...rows].sort((a, b) => a.demandIndex - b.demandIndex).slice(0, 8);
  const line = (r: DemandIndexRow): string =>
    `- ${r.checkinDate} | index=${r.demandIndex} (${r.demandBand}) | posture=${r.pricingPosture} | ` +
    `congestion=${r.congestionForecastRank} | conf=${r.confidenceLevel} | sold_out=${r.soldOutCount}/${r.soldOutCount + r.availableCount}`;

  return [
    "# Zao Demand Index / DP Matrix Design (Phase DP01X)",
    "",
    `Generated at: ${summary.generatedAt}`,
    "",
    "## 1. Executive Summary",
    "",
    `- decision=${summary.decision}`,
    `- history_row_count=${summary.historyRowCount}`,
    `- demand_index_row_count=${summary.demandRowCount}`,
    `- demand_band_counts=${JSON.stringify(summary.demandBandCounts)}`,
    `- pricing_posture_counts=${JSON.stringify(summary.pricingPostureCounts)}`,
    "- DP01X is a design/prototype layer. It computes decision-support signals only; it does NOT set or export prices.",
    "",
    "## 2. Source History Input",
    "",
    ...summary.sourceHistoryFiles.map((f) => `- ${f}`),
    `- usable price reference: p66=${summary.refP66} JPY, p90=${summary.refP90} JPY`,
    "",
    "## 3. Scoring Model",
    "",
    "- Zao Demand Index = 0–100, summed from five capped components:",
    `  - sold_out_pressure_score (0–${SCORE_CAPS.soldOutPressure})`,
    `  - price_pressure_score (0–${SCORE_CAPS.pricePressure})`,
    `  - confidence_score (0–${SCORE_CAPS.confidence})`,
    `  - calendar_score (0–${SCORE_CAPS.calendar})`,
    `  - booking_window_score (0–${SCORE_CAPS.bookingWindow})`,
    "",
    "## 4. Weighting Rationale",
    "",
    "- Sold-out pressure carries the most weight: a confirmed sold-out/unavailable state is a stronger demand signal than small OTA stock-count changes.",
    "- Price pressure is secondary and only uses direct/directional rows vs a dataset reference; excluded rows and Booking base × 1.1 are never used.",
    "- Confidence rewards A-direct rows and source diversity; most current rows are B-directional, so confidence is intentionally modest.",
    "- Calendar and booking-window are bounded contextual modifiers, not primary drivers.",
    "",
    "## 5. Output Bands",
    "",
    "- 90–100 S_extreme; 75–89 A_strong; 60–74 B_moderate_high; 45–59 C_normal; 30–44 D_weak; 0–29 E_very_weak.",
    `- observed: ${JSON.stringify(summary.demandBandCounts)}`,
    "",
    "## 6. Pricing Posture Rules",
    "",
    "- raise_now: index≥75 AND sold-out pressure high AND adequate confidence.",
    "- hold_strong: index≥75 but evidence insufficient for an immediate raise.",
    "- hold: normal signal.",
    "- sell_through: weak/normal demand with high remaining-supply proxy.",
    "- discount_candidate: weak demand + low sold-out pressure + close-in date.",
    "- insufficient_data: too few usable rows.",
    `- observed: ${JSON.stringify(summary.pricingPostureCounts)}`,
    "",
    "## 7. Restaurant Congestion Forecast Use",
    "",
    "- congestion_forecast_rank S–E is derived from the demand band as a Zao Onsen congestion tendency / lodging/OTA-derived demand signal.",
    "- This is a demand-signal product, NOT an exact restaurant footfall or visitor-count prediction.",
    `- observed: ${JSON.stringify(summary.congestionRankCounts)}`,
    "",
    "## 8. Sample Date Results",
    "",
    "### High-demand sample",
    ...(topStrong.length === 0 ? ["- none"] : topStrong.map(line)),
    "",
    "### Weak-demand sample",
    ...(topWeak.length === 0 ? ["- none"] : topWeak.map(line)),
    "",
    "## 9. Cautions / Limitations",
    "",
    "- OTA signals are not actual occupancy.",
    "- Stock counts may be capped or blocked by OTA display logic.",
    "- Sold-out pressure is more reliable than small stock changes.",
    "- Booking/Rakuten B-confidence rows are directional unless later confirmed.",
    "- Restaurant congestion forecast is a tendency/rank, not an exact visitor count.",
    "- No automatic price update happens in DP01X.",
    "",
    "## 10. Not Yet Implemented",
    "",
    "- Production weight calibration (DP02X).",
    "- Property-specific DP matrices for 三浦屋 / 喜らく / ナリサワ / 一棟貸し (DP03X).",
    "- Restaurant-facing congestion report product (R01X).",
    "- Any PMS / Beds24 / AirHost export or price write.",
    "",
    "## 11. Safety Confirmation",
    "",
    "- DP01X read .data/history only and did not modify it.",
    "- DP01X did not write the DB.",
    "- DP01X did not update prices.",
    "- DP01X produced no PMS / Beds24 / AirHost / OTA output.",
    "- DP01X used no Booking base × 1.1 logic.",
    "- No GitHub Actions/GitOps activation, no commits/pushes, no live external fetch, no collector re-run, no paid sources.",
    "",
    "## 12. Next Steps",
    "",
    "- Human review of the band/posture distribution; calibrate weights in a later DP02X.",
    `- report_path=${summary.reportPath}`,
    `- csv_path=${summary.csvPath}`,
    `- json_summary_path=${summary.jsonPath}`,
    `- debug_artifact_path=${summary.debugRootPath}`,
    ""
  ].join("\n");
}

export function assertNoForbiddenColumns(headerLine: string): void {
  const lower = headerLine.toLowerCase();
  for (const token of FORBIDDEN_OUTPUT_COLUMN_TOKENS) {
    if (lower.includes(token)) {
      throw new Error(`DP01X output must not include forbidden column token: ${token}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Date helpers (UTC-based; inputs are JST calendar dates as YYYY-MM-DD)
// ---------------------------------------------------------------------------

function toUtcDays(date: string): number {
  const [y, m, d] = date.split("-").map((x) => Number(x));
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

export function daysBetween(from: string, to: string): number {
  return toUtcDays(to) - toUtcDays(from);
}

export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map((x) => Number(x));
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

function addDays(date: string, n: number): string {
  const base = toUtcDays(date) + n;
  const dt = new Date(base * 86_400_000);
  const p = (x: number): string => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
