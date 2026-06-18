// Phase ZMI PRICE-HISTORY01 — competitor price-change history + daily market
// pressure signals (pure, read-only derivation).
//
// Derives, from the EXISTING canonical history, how each competitor's price /
// availability changed between consecutive observations of the SAME stay
// (property + source + checkin + meal_basis + room_basis + occupancy), and rolls
// those changes up into a per-checkin-date market-pressure score. No new crawler,
// no DB writes, no schema widening. Meal/room basis reuse the BI derivations so
// this stays consistent with the room-only / two-person-standard gates.

import { deriveBiMealBasis, deriveBiRoomBasis, canonicalizeName, type BiHistoryRow } from "./biWebDataExport";

export type NormalizedStatus = "available" | "sold_out" | "not_listed" | "unavailable" | "unknown";

export type ChangeType =
  | "price_up"
  | "price_down"
  | "same_price"
  | "available_to_sold_out"
  | "sold_out_to_available"
  | "available_to_not_listed"
  | "not_listed_to_available"
  | "sold_out_to_not_listed"
  | "not_listed_to_sold_out"
  | "unknown";

export type SignalDirection = "positive_demand" | "negative_demand" | "neutral" | "unknown";
export type SignalStrength = "high" | "medium" | "low" | "unknown";
export type MarketPressureLevel = "very_high" | "high" | "medium" | "low" | "insufficient_data";
export type PricingPosture = "raise_or_hold_strong" | "hold" | "sell_through" | "discount_watch" | "insufficient_data";

// One observation pulled from history, with the fields needed for comparison.
export interface PriceHistoryInputRow {
  property_id: string;
  property_name: string;
  source: string;
  checkin_date: string;
  observed_at: string;
  occupancy_basis: string;
  availability_status_raw: string;
  normalized_total_price: number | null;
  basis_confidence: string;
  warning_flags: string;
  source_classification: string;
  dp_exclusion_reason: string;
  is_price_excluded_from_dp: boolean;
  is_price_usable_for_dp_directional: boolean;
  basis_note: string;
  room_type_key: string;
}

export interface CompetitorPriceChange {
  property_id: string;
  property_name: string;
  source: string;
  checkin_date: string;
  previous_observed_at: string;
  current_observed_at: string;
  lead_time_days_previous: number | null;
  lead_time_days_current: number | null;
  comparison_key: string;
  comparison_key_level: "level_1" | "level_2";
  meal_basis: string;
  room_basis: string;
  occupancy_basis: string;
  room_type_key: string;
  basis_confidence: string;
  previous_status: NormalizedStatus;
  current_status: NormalizedStatus;
  previous_price: number | null;
  current_price: number | null;
  price_delta: number | null;
  price_delta_pct: number | null;
  change_type: ChangeType;
  signal_direction: SignalDirection;
  signal_strength: SignalStrength;
  is_comparable: boolean;
  non_comparable_reason: string;
  last_available_price_before_sold_out: number | null;
  notes: string;
}

export interface MarketDailySignal {
  checkin_date: string;
  sample_count: number;
  comparable_pair_count: number;
  price_up_count: number;
  price_down_count: number;
  same_price_count: number;
  available_to_sold_out_count: number;
  sold_out_to_available_count: number;
  not_listed_to_available_count: number;
  available_to_not_listed_count: number;
  positive_demand_signal_count: number;
  negative_demand_signal_count: number;
  median_price_delta_pct: number | null;
  avg_price_delta_pct: number | null;
  max_price_delta_pct: number | null;
  min_price_delta_pct: number | null;
  sold_out_pressure_score: number;
  price_up_pressure_score: number;
  market_pressure_score: number;
  market_pressure_level: MarketPressureLevel;
  recommended_pricing_posture: PricingPosture;
  data_quality: string;
  notes: string;
}

// ---------------------------------------------------------------------------
// Normalization.

export function normalizeStatus(raw: string): NormalizedStatus {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "") return "unknown";
  if (/(^available$|available_price_basis|販売中|空室あり|空室有)/u.test(s)) return "available";
  if (/(sold_?out|soldout|closed|満室|売り切れ|空室なし)/u.test(s)) return "sold_out";
  if (/(not_?found|not_?listed|missing|未掲載)/u.test(s)) return "not_listed";
  if (/(failed|unavailable|navigation_failed|degraded|blocked|captcha|login|error)/u.test(s)) return "unavailable";
  return "unknown";
}

function toBiRow(row: PriceHistoryInputRow): BiHistoryRow {
  return {
    source: row.source,
    canonical_property_name: row.property_name,
    source_slug_or_code: row.property_id,
    checkin: row.checkin_date,
    checkout: "",
    availability_status: row.availability_status_raw,
    normalized_total_price: row.normalized_total_price,
    is_price_usable_for_dp_directional: row.is_price_usable_for_dp_directional,
    collected_at_jst: row.observed_at,
    tier: "",
    source_classification: row.source_classification,
    warning_flags: row.warning_flags,
    basis_confidence: row.basis_confidence,
    is_price_excluded_from_dp: row.is_price_excluded_from_dp,
    dp_exclusion_reason: row.dp_exclusion_reason,
    basis_note: row.basis_note
  };
}

export function deriveMealBasis(row: PriceHistoryInputRow): string {
  return deriveBiMealBasis(toBiRow(row));
}
export function deriveRoomBasis(row: PriceHistoryInputRow): string {
  return deriveBiRoomBasis(toBiRow(row));
}

// A stay is comparable for PRICE only when meal basis is room-only-eligible AND
// room basis is the confirmed two-person standard room. Single/family/suite/
// unknown rooms are KEPT (availability still visible) but flagged non-comparable.
export function comparability(mealBasis: string, roomBasis: string): { isComparable: boolean; reason: string } {
  const mealOk = mealBasis === "assumed_room_only" || mealBasis === "confirmed_room_only";
  const roomOk = roomBasis === "confirmed_two_person_standard_room";
  if (!mealOk) return { isComparable: false, reason: `meal_basis_excluded:${mealBasis}` };
  if (!roomOk) return { isComparable: false, reason: `room_basis_mismatch:${roomBasis}` };
  return { isComparable: true, reason: "" };
}

export function comparisonKey(row: PriceHistoryInputRow, mealBasis: string, roomBasis: string): { key: string; level: "level_1" | "level_2" } {
  const level1 = [row.property_id, row.source, row.checkin_date, mealBasis, roomBasis, row.occupancy_basis].join("|");
  if (row.room_type_key !== "") return { key: `${level1}|${row.room_type_key}`, level: "level_2" };
  return { key: level1, level: "level_1" };
}

function priceOf(row: PriceHistoryInputRow): number | null {
  return Number.isFinite(row.normalized_total_price as number) ? row.normalized_total_price : null;
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = fromIso.slice(0, 10);
  const b = toIso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(a) || !/^\d{4}-\d{2}-\d{2}$/u.test(b)) return null;
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ms = Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!);
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Dedupe: one representative per (comparison_key, observed_at).

export interface DedupeResult {
  rows: Array<{ key: string; level: "level_1" | "level_2"; mealBasis: string; roomBasis: string; isComparable: boolean; reason: string; row: PriceHistoryInputRow }>;
  duplicateGroupCount: number;
  duplicateRowsRemoved: number;
}

function confidenceRank(c: string): number {
  const v = (c ?? "").toLowerCase();
  if (v === "a" || v === "high") return 3;
  if (v === "b" || v === "medium" || v === "directional_candidate_basis") return 2;
  if (v === "c" || v === "low") return 1;
  return 0;
}

// Representative priority: comparable > higher basis confidence > available >
// has price > lowest available price.
function preferred(a: { isComparable: boolean; row: PriceHistoryInputRow }, b: { isComparable: boolean; row: PriceHistoryInputRow }): number {
  if (a.isComparable !== b.isComparable) return a.isComparable ? -1 : 1;
  const cr = confidenceRank(b.row.basis_confidence) - confidenceRank(a.row.basis_confidence);
  if (cr !== 0) return cr;
  const aAvail = normalizeStatus(a.row.availability_status_raw) === "available" ? 0 : 1;
  const bAvail = normalizeStatus(b.row.availability_status_raw) === "available" ? 0 : 1;
  if (aAvail !== bAvail) return aAvail - bAvail;
  const aHasPrice = priceOf(a.row) !== null ? 0 : 1;
  const bHasPrice = priceOf(b.row) !== null ? 0 : 1;
  if (aHasPrice !== bHasPrice) return aHasPrice - bHasPrice;
  return (priceOf(a.row) ?? Infinity) - (priceOf(b.row) ?? Infinity);
}

export function dedupeObservations(rows: readonly PriceHistoryInputRow[]): DedupeResult {
  const annotated = rows.map((row) => {
    const mealBasis = deriveMealBasis(row);
    const roomBasis = deriveRoomBasis(row);
    const { key, level } = comparisonKey(row, mealBasis, roomBasis);
    const { isComparable, reason } = comparability(mealBasis, roomBasis);
    return { key, level, mealBasis, roomBasis, isComparable, reason, row };
  });
  const groups = new Map<string, typeof annotated>();
  for (const a of annotated) {
    const gk = `${a.key}::${a.row.observed_at}`;
    const list = groups.get(gk) ?? [];
    list.push(a);
    groups.set(gk, list);
  }
  let duplicateGroupCount = 0;
  let duplicateRowsRemoved = 0;
  const out: DedupeResult["rows"] = [];
  for (const list of groups.values()) {
    if (list.length > 1) {
      duplicateGroupCount += 1;
      duplicateRowsRemoved += list.length - 1;
    }
    out.push([...list].sort(preferred)[0]!);
  }
  return { rows: out, duplicateGroupCount, duplicateRowsRemoved };
}

// ---------------------------------------------------------------------------
// Change detection.

function classifyChange(prev: NormalizedStatus, curr: NormalizedStatus, prevPrice: number | null, currPrice: number | null): ChangeType {
  if (prev === "available" && curr === "available" && prevPrice !== null && currPrice !== null) {
    if (currPrice > prevPrice) return "price_up";
    if (currPrice < prevPrice) return "price_down";
    return "same_price";
  }
  if (prev === "available" && curr === "sold_out") return "available_to_sold_out";
  if (prev === "sold_out" && curr === "available") return "sold_out_to_available";
  if (prev === "available" && curr === "not_listed") return "available_to_not_listed";
  if (prev === "not_listed" && curr === "available") return "not_listed_to_available";
  if (prev === "sold_out" && curr === "not_listed") return "sold_out_to_not_listed";
  if (prev === "not_listed" && curr === "sold_out") return "not_listed_to_sold_out";
  return "unknown";
}

function signalDirectionFor(change: ChangeType): SignalDirection {
  if (change === "price_up" || change === "available_to_sold_out") return "positive_demand";
  if (change === "price_down" || change === "sold_out_to_available") return "negative_demand";
  if (change === "same_price") return "neutral";
  return "unknown";
}

function signalStrengthFor(change: ChangeType, pct: number | null): SignalStrength {
  if (change === "available_to_sold_out") return "high";
  if (change === "price_up") {
    if (pct !== null && pct >= 10) return "high";
    if (pct !== null && pct >= 3) return "medium";
    return "low";
  }
  if (change === "price_down") {
    if (pct !== null && pct <= -10) return "high";
    if (pct !== null && pct <= -3) return "medium";
    return "low";
  }
  if (change === "same_price") return "low";
  if (change === "sold_out_to_available") return "medium";
  return "unknown";
}

export function buildPriceChanges(deduped: DedupeResult["rows"]): CompetitorPriceChange[] {
  const byKey = new Map<string, DedupeResult["rows"]>();
  for (const r of deduped) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  const changes: CompetitorPriceChange[] = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => a.row.observed_at.localeCompare(b.row.observed_at));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      const prevStatus = normalizeStatus(prev.row.availability_status_raw);
      const currStatus = normalizeStatus(curr.row.availability_status_raw);
      const prevPrice = priceOf(prev.row);
      const currPrice = priceOf(curr.row);
      const changeType = classifyChange(prevStatus, currStatus, prevPrice, currPrice);
      const priceDelta = prevPrice !== null && currPrice !== null ? currPrice - prevPrice : null;
      const priceDeltaPct = priceDelta !== null && prevPrice !== null && prevPrice !== 0 ? Number(((priceDelta / prevPrice) * 100).toFixed(2)) : null;
      changes.push({
        property_id: curr.row.property_id,
        property_name: curr.row.property_name,
        source: curr.row.source,
        checkin_date: curr.row.checkin_date,
        previous_observed_at: prev.row.observed_at,
        current_observed_at: curr.row.observed_at,
        lead_time_days_previous: daysBetween(prev.row.observed_at, curr.row.checkin_date),
        lead_time_days_current: daysBetween(curr.row.observed_at, curr.row.checkin_date),
        comparison_key: curr.key,
        comparison_key_level: curr.level,
        meal_basis: curr.mealBasis,
        room_basis: curr.roomBasis,
        occupancy_basis: curr.row.occupancy_basis,
        room_type_key: curr.row.room_type_key,
        basis_confidence: curr.row.basis_confidence,
        previous_status: prevStatus,
        current_status: currStatus,
        previous_price: prevPrice,
        current_price: currPrice,
        price_delta: priceDelta,
        price_delta_pct: priceDeltaPct,
        change_type: changeType,
        signal_direction: signalDirectionFor(changeType),
        signal_strength: signalStrengthFor(changeType, priceDeltaPct),
        is_comparable: curr.isComparable,
        non_comparable_reason: curr.reason,
        last_available_price_before_sold_out: changeType === "available_to_sold_out" ? prevPrice : null,
        notes: ""
      });
    }
  }
  return changes.sort((a, b) => (a.checkin_date === b.checkin_date ? a.comparison_key.localeCompare(b.comparison_key) : a.checkin_date.localeCompare(b.checkin_date)));
}

// ---------------------------------------------------------------------------
// Daily aggregation (over COMPARABLE changes only — never mix room/meal bases).

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Number(((s[mid - 1]! + s[mid]!) / 2).toFixed(2));
}

export function buildDailySignals(changes: readonly CompetitorPriceChange[]): MarketDailySignal[] {
  const byDate = new Map<string, CompetitorPriceChange[]>();
  for (const c of changes) {
    const list = byDate.get(c.checkin_date) ?? [];
    list.push(c);
    byDate.set(c.checkin_date, list);
  }
  const out: MarketDailySignal[] = [];
  for (const [checkinDate, all] of byDate) {
    const comp = all.filter((c) => c.is_comparable);
    const count = (t: ChangeType): number => comp.filter((c) => c.change_type === t).length;
    const priceUp = count("price_up");
    const priceDown = count("price_down");
    const samePrice = count("same_price");
    const a2s = count("available_to_sold_out");
    const s2a = count("sold_out_to_available");
    const nl2a = count("not_listed_to_available");
    const a2nl = count("available_to_not_listed");
    const positive = comp.filter((c) => c.signal_direction === "positive_demand").length;
    const negative = comp.filter((c) => c.signal_direction === "negative_demand").length;
    const pcts = comp.map((c) => c.price_delta_pct).filter((v): v is number => v !== null);

    const priceUpPressure = priceUp - priceDown;
    const soldOutPressure = a2s - s2a;
    const marketPressure = priceUpPressure + soldOutPressure * 2 + positive - negative;

    let level: MarketPressureLevel;
    let posture: PricingPosture;
    if (comp.length < 3) {
      level = "insufficient_data";
      posture = "insufficient_data";
    } else if (marketPressure >= 8) {
      level = "very_high";
      posture = "raise_or_hold_strong";
    } else if (marketPressure >= 4) {
      level = "high";
      posture = "raise_or_hold_strong";
    } else if (marketPressure >= 1) {
      level = "medium";
      posture = "hold";
    } else if (marketPressure <= -3) {
      level = "low";
      posture = "discount_watch";
    } else {
      level = "low";
      posture = "sell_through";
    }

    out.push({
      checkin_date: checkinDate,
      sample_count: all.length,
      comparable_pair_count: comp.length,
      price_up_count: priceUp,
      price_down_count: priceDown,
      same_price_count: samePrice,
      available_to_sold_out_count: a2s,
      sold_out_to_available_count: s2a,
      not_listed_to_available_count: nl2a,
      available_to_not_listed_count: a2nl,
      positive_demand_signal_count: positive,
      negative_demand_signal_count: negative,
      median_price_delta_pct: median(pcts),
      avg_price_delta_pct: pcts.length === 0 ? null : Number((pcts.reduce((s, v) => s + v, 0) / pcts.length).toFixed(2)),
      max_price_delta_pct: pcts.length === 0 ? null : Math.max(...pcts),
      min_price_delta_pct: pcts.length === 0 ? null : Math.min(...pcts),
      sold_out_pressure_score: soldOutPressure,
      price_up_pressure_score: priceUpPressure,
      market_pressure_score: marketPressure,
      market_pressure_level: level,
      recommended_pricing_posture: posture,
      data_quality: comp.length >= 3 ? "ok" : "insufficient",
      notes: ""
    });
  }
  return out.sort((a, b) => a.checkin_date.localeCompare(b.checkin_date));
}

// ---------------------------------------------------------------------------
// Validation summary.

export type PriceHistoryDecision =
  | "price_history_ready"
  | "price_history_ready_with_warnings"
  | "price_history_insufficient_data"
  | "price_history_failed";

export interface PriceHistoryValidation {
  run_at: string;
  input_sources: string[];
  total_raw_rows: number;
  normalized_rows: number;
  comparable_rows: number;
  non_comparable_rows: number;
  comparison_pair_count: number;
  change_type_counts: Record<string, number>;
  signal_direction_counts: Record<string, number>;
  excluded_meal_basis_count: number;
  excluded_room_basis_count: number;
  duplicate_group_count: number;
  duplicate_rows_removed_count: number;
  observed_at_column_used: string;
  observed_at_confidence: string;
  min_checkin_date: string | null;
  max_checkin_date: string | null;
  min_observed_at: string | null;
  max_observed_at: string | null;
  daily_signal_rows: number;
  insufficient_data_days: number;
  decision: PriceHistoryDecision;
  warnings: string[];
}

export function buildValidation(input: {
  runAt: string;
  inputSources: string[];
  totalRawRows: number;
  deduped: DedupeResult;
  changes: readonly CompetitorPriceChange[];
  dailySignals: readonly MarketDailySignal[];
  observedAtColumnUsed: string;
  observedAtConfidence: string;
  extraWarnings?: readonly string[];
}): PriceHistoryValidation {
  const { deduped, changes, dailySignals } = input;
  const normalizedRows = deduped.rows.length;
  const comparableRows = deduped.rows.filter((r) => r.isComparable).length;
  const excludedMeal = deduped.rows.filter((r) => r.reason.startsWith("meal_basis_excluded")).length;
  const excludedRoom = deduped.rows.filter((r) => r.reason.startsWith("room_basis_mismatch")).length;
  const changeTypeCounts: Record<string, number> = {};
  const signalDirCounts: Record<string, number> = {};
  for (const c of changes) {
    changeTypeCounts[c.change_type] = (changeTypeCounts[c.change_type] ?? 0) + 1;
    signalDirCounts[c.signal_direction] = (signalDirCounts[c.signal_direction] ?? 0) + 1;
  }
  const checkins = deduped.rows.map((r) => r.row.checkin_date).filter((d) => /^\d{4}-\d{2}-\d{2}$/u.test(d)).sort();
  const observedAts = deduped.rows.map((r) => r.row.observed_at).filter((d) => d.length > 0).sort();
  const insufficientDays = dailySignals.filter((d) => d.market_pressure_level === "insufficient_data").length;

  const warnings: string[] = [...(input.extraWarnings ?? [])];
  if (input.observedAtConfidence !== "high") warnings.push(`observed_at_confidence_${input.observedAtConfidence}`);
  if (excludedMeal > 0) warnings.push(`excluded_meal_basis_rows:${excludedMeal}`);
  if (excludedRoom > 0) warnings.push(`excluded_room_basis_rows:${excludedRoom}`);
  if (deduped.duplicateRowsRemoved > 0) warnings.push(`duplicate_rows_removed:${deduped.duplicateRowsRemoved}`);
  if (changes.length === 0) warnings.push("no_comparison_pairs_yet");
  if (dailySignals.length > 0 && insufficientDays === dailySignals.length) warnings.push("all_days_insufficient_data");

  let decision: PriceHistoryDecision;
  if (input.totalRawRows === 0 || normalizedRows === 0) decision = "price_history_insufficient_data";
  else if (warnings.length > 0) decision = "price_history_ready_with_warnings";
  else decision = "price_history_ready";

  return {
    run_at: input.runAt,
    input_sources: input.inputSources,
    total_raw_rows: input.totalRawRows,
    normalized_rows: normalizedRows,
    comparable_rows: comparableRows,
    non_comparable_rows: normalizedRows - comparableRows,
    comparison_pair_count: changes.length,
    change_type_counts: changeTypeCounts,
    signal_direction_counts: signalDirCounts,
    excluded_meal_basis_count: excludedMeal,
    excluded_room_basis_count: excludedRoom,
    duplicate_group_count: deduped.duplicateGroupCount,
    duplicate_rows_removed_count: deduped.duplicateRowsRemoved,
    observed_at_column_used: input.observedAtColumnUsed,
    observed_at_confidence: input.observedAtConfidence,
    min_checkin_date: checkins[0] ?? null,
    max_checkin_date: checkins[checkins.length - 1] ?? null,
    min_observed_at: observedAts[0] ?? null,
    max_observed_at: observedAts[observedAts.length - 1] ?? null,
    daily_signal_rows: dailySignals.length,
    insufficient_data_days: insufficientDays,
    decision,
    warnings
  };
}

// High-level: input rows -> all artifacts.
export function buildPriceHistorySignals(rows: readonly PriceHistoryInputRow[], input: {
  runAt: string;
  inputSources: string[];
  totalRawRows: number;
  observedAtColumnUsed: string;
  observedAtConfidence: string;
  extraWarnings?: readonly string[];
}): { changes: CompetitorPriceChange[]; dailySignals: MarketDailySignal[]; validation: PriceHistoryValidation } {
  const deduped = dedupeObservations(rows);
  const changes = buildPriceChanges(deduped.rows);
  const dailySignals = buildDailySignals(changes);
  const validation = buildValidation({ ...input, deduped, changes, dailySignals });
  return { changes, dailySignals, validation };
}

// ---------------------------------------------------------------------------
// CSV rendering.

export const COMPETITOR_PRICE_CHANGES_HEADERS = [
  "property_id", "property_name", "source", "checkin_date",
  "previous_observed_at", "current_observed_at", "lead_time_days_previous", "lead_time_days_current",
  "comparison_key", "comparison_key_level", "meal_basis", "room_basis", "occupancy_basis", "room_type_key", "basis_confidence",
  "previous_status", "current_status", "previous_price", "current_price", "price_delta", "price_delta_pct",
  "change_type", "signal_direction", "signal_strength", "is_comparable", "non_comparable_reason",
  "last_available_price_before_sold_out", "notes"
] as const;

export const MARKET_DAILY_SIGNALS_HEADERS = [
  "checkin_date", "sample_count", "comparable_pair_count",
  "price_up_count", "price_down_count", "same_price_count",
  "available_to_sold_out_count", "sold_out_to_available_count", "not_listed_to_available_count", "available_to_not_listed_count",
  "positive_demand_signal_count", "negative_demand_signal_count",
  "median_price_delta_pct", "avg_price_delta_pct", "max_price_delta_pct", "min_price_delta_pct",
  "sold_out_pressure_score", "price_up_pressure_score", "market_pressure_score",
  "market_pressure_level", "recommended_pricing_posture", "data_quality", "notes"
] as const;

function num(v: number | null): string {
  return v === null ? "" : String(v);
}
function csvCell(v: string): string {
  return /[",\n\r]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v;
}

export function renderCompetitorPriceChangesCsv(rows: readonly CompetitorPriceChange[]): string {
  const body = rows.map((r) => [
    r.property_id, r.property_name, r.source, r.checkin_date,
    r.previous_observed_at, r.current_observed_at, num(r.lead_time_days_previous), num(r.lead_time_days_current),
    r.comparison_key, r.comparison_key_level, r.meal_basis, r.room_basis, r.occupancy_basis, r.room_type_key, r.basis_confidence,
    r.previous_status, r.current_status, num(r.previous_price), num(r.current_price), num(r.price_delta), num(r.price_delta_pct),
    r.change_type, r.signal_direction, r.signal_strength, String(r.is_comparable), r.non_comparable_reason,
    num(r.last_available_price_before_sold_out), r.notes
  ].map(csvCell).join(","));
  return [COMPETITOR_PRICE_CHANGES_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderMarketDailySignalsCsv(rows: readonly MarketDailySignal[]): string {
  const body = rows.map((r) => [
    r.checkin_date, String(r.sample_count), String(r.comparable_pair_count),
    String(r.price_up_count), String(r.price_down_count), String(r.same_price_count),
    String(r.available_to_sold_out_count), String(r.sold_out_to_available_count), String(r.not_listed_to_available_count), String(r.available_to_not_listed_count),
    String(r.positive_demand_signal_count), String(r.negative_demand_signal_count),
    num(r.median_price_delta_pct), num(r.avg_price_delta_pct), num(r.max_price_delta_pct), num(r.min_price_delta_pct),
    String(r.sold_out_pressure_score), String(r.price_up_pressure_score), String(r.market_pressure_score),
    r.market_pressure_level, r.recommended_pricing_posture, r.data_quality, r.notes
  ].map(csvCell).join(","));
  return [MARKET_DAILY_SIGNALS_HEADERS.join(","), ...body].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Parse canonical history CSVs into PriceHistoryInputRow[] (observed_at column
// chosen by priority; canonical_property_name folded to the BI canonical).

const OBSERVED_AT_PRIORITY = ["observed_at", "collected_at", "snapshot_at", "run_at", "collected_at_jst", "created_at"] as const;

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && q && line[i + 1] === '"') { cur += '"'; i += 1; }
    else if (ch === '"') q = !q;
    else if (ch === "," && !q) { cells.push(cur); cur = ""; }
    else cur += (ch ?? "");
  }
  cells.push(cur);
  return cells;
}

export function chooseObservedAtColumn(headers: readonly string[]): string | null {
  for (const c of OBSERVED_AT_PRIORITY) if (headers.includes(c)) return c;
  return null;
}

export function parseHistoryForPriceHistory(files: readonly { filename: string; content: string }[]): {
  rows: PriceHistoryInputRow[];
  totalRawRows: number;
  observedAtColumnUsed: string;
  observedAtConfidence: string;
} {
  const rows: PriceHistoryInputRow[] = [];
  let totalRawRows = 0;
  let observedAtColumnUsed = "collected_at_jst";
  let observedAtConfidence = "high";
  for (const { content } of files) {
    const lines = content.split(/\r?\n/u).filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const h = parseCsvLine(lines[0]!);
    const idx = (name: string): number => h.indexOf(name);
    const observedCol = chooseObservedAtColumn(h) ?? "collected_at_jst";
    observedAtColumnUsed = observedCol;
    if (observedCol !== "observed_at" && observedCol !== "collected_at" && observedCol !== "snapshot_at") {
      observedAtConfidence = observedCol === "collected_at_jst" ? "high" : "low";
    }
    const oi = idx(observedCol);
    const si = idx("source");
    const ni = idx("canonical_property_name");
    const pidi = idx("source_property_id");
    const sci = idx("source_slug_or_code");
    const ci = idx("checkin");
    const ai = idx("availability_status");
    const pi = idx("normalized_total_price");
    const bci = idx("basis_confidence");
    const wfi = idx("warning_flags");
    const scli = idx("source_classification");
    const deri = idx("dp_exclusion_reason");
    const exi = idx("is_price_excluded_from_dp");
    const ddi = idx("is_price_usable_for_dp_directional");
    const bni = idx("basis_note");
    const gai = idx("group_adults");
    const nri = idx("no_rooms");
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      totalRawRows += 1;
      const rawPrice = pi >= 0 ? (c[pi] ?? "").trim() : "";
      const price = rawPrice === "" || /^(null|n\/a|-)$/iu.test(rawPrice) ? null : Number(rawPrice);
      const adults = gai >= 0 ? (c[gai] ?? "") : "";
      const rooms = nri >= 0 ? (c[nri] ?? "") : "";
      rows.push({
        property_id: (pidi >= 0 ? c[pidi] : "") || (sci >= 0 ? c[sci] : "") || "",
        property_name: canonicalizeName(ni >= 0 ? (c[ni] ?? "") : ""),
        source: si >= 0 ? (c[si] ?? "") : "",
        checkin_date: ci >= 0 ? (c[ci] ?? "") : "",
        observed_at: oi >= 0 ? (c[oi] ?? "") : "",
        occupancy_basis: `${adults || "?"}_adults_${rooms || "?"}_rooms`,
        availability_status_raw: ai >= 0 ? (c[ai] ?? "") : "",
        normalized_total_price: price !== null && Number.isFinite(price) ? price : null,
        basis_confidence: bci >= 0 ? (c[bci] ?? "") : "",
        warning_flags: wfi >= 0 ? (c[wfi] ?? "") : "",
        source_classification: scli >= 0 ? (c[scli] ?? "") : "",
        dp_exclusion_reason: deri >= 0 ? (c[deri] ?? "") : "",
        is_price_excluded_from_dp: exi >= 0 ? (c[exi] ?? "").toLowerCase() === "true" : false,
        is_price_usable_for_dp_directional: ddi >= 0 ? (c[ddi] ?? "").toLowerCase() === "true" : false,
        basis_note: bni >= 0 ? (c[bni] ?? "") : "",
        room_type_key: ""
      });
    }
  }
  return { rows, totalRawRows, observedAtColumnUsed, observedAtConfidence };
}
