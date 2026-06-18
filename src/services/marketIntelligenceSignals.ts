// Phase ZMI MARKET-CURVE / CRAWL-PRIORITY01 — market booking curve + adaptive
// fetch prioritization (pure, read-only derivation).
//
// Built from the EXISTING canonical history plus PRICE-HISTORY01 change events.
// 1) Market booking curve: per (checkin_date, observation day) how the market's
//    availability / sold-out / price level moves as the stay approaches.
// 2) Crawl priority: a rule-based per-checkin-date score for which stay dates the
//    next crawl should refresh first.
// No new crawler, no DB writes, no schema widening, no price decisions. Low-
// confidence data is never promoted to high confidence.

import {
  normalizeStatus,
  type CompetitorPriceChange,
  type NormalizedStatus,
  type PriceHistoryInputRow
} from "./priceHistorySignals";

function observedDay(observedAt: string): string {
  return (observedAt ?? "").slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = (fromIso ?? "").slice(0, 10);
  const b = (toIso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(a) || !/^\d{4}-\d{2}-\d{2}$/u.test(b)) return null;
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / (24 * 60 * 60 * 1000));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

// ---------------------------------------------------------------------------
// 1. Market booking curve.

export type MarketMovementLevel = "high" | "medium" | "softening" | "low" | "insufficient_data";
export type DataQuality = "high" | "medium" | "low" | "insufficient";

export interface MarketCurveRow {
  checkin_date: string;
  observed_at: string; // observation day (collected_at_jst date)
  lead_time_days: number | null;
  raw_observation_count: number;
  property_count: number;
  available_count: number;
  sold_out_count: number;
  not_listed_count: number;
  unknown_count: number;
  available_ratio: number;
  sold_out_ratio: number;
  not_listed_ratio: number;
  price_observation_count: number;
  median_available_price: number | null;
  min_available_price: number | null;
  max_available_price: number | null;
  price_up_count_since_previous_observation: number;
  price_down_count_since_previous_observation: number;
  available_to_sold_out_count_since_previous_observation: number;
  sold_out_to_available_count_since_previous_observation: number;
  market_movement_level: MarketMovementLevel;
  data_quality: DataQuality;
  notes: string;
}

function ratio(n: number, d: number): number {
  return d === 0 ? 0 : Number((n / d).toFixed(4));
}

function movementLevel(raw: number, deltas: { up: number; down: number; a2s: number }): MarketMovementLevel {
  if (raw < 3) return "insufficient_data";
  if (deltas.a2s >= 3) return "high";
  if (deltas.up >= 5) return "high";
  if (deltas.up >= 2) return "medium";
  if (deltas.down >= 3) return "softening";
  return "low";
}

function dataQuality(raw: number): DataQuality {
  if (raw >= 10) return "high";
  if (raw >= 5) return "medium";
  if (raw >= 3) return "low";
  return "insufficient";
}

// Changes detected AT a given observation day for a checkin (current side maps
// to the later snapshot), counted by type — the "since previous observation".
function changeDeltaIndex(changes: readonly CompetitorPriceChange[]): Map<string, { up: number; down: number; a2s: number; s2a: number }> {
  const idx = new Map<string, { up: number; down: number; a2s: number; s2a: number }>();
  for (const c of changes) {
    const key = `${c.checkin_date}::${observedDay(c.current_observed_at)}`;
    const e = idx.get(key) ?? { up: 0, down: 0, a2s: 0, s2a: 0 };
    if (c.change_type === "price_up") e.up += 1;
    else if (c.change_type === "price_down") e.down += 1;
    else if (c.change_type === "available_to_sold_out") e.a2s += 1;
    else if (c.change_type === "sold_out_to_available") e.s2a += 1;
    idx.set(key, e);
  }
  return idx;
}

export function buildMarketBookingCurve(rows: readonly PriceHistoryInputRow[], changes: readonly CompetitorPriceChange[]): MarketCurveRow[] {
  const deltaIdx = changeDeltaIndex(changes);
  const groups = new Map<string, PriceHistoryInputRow[]>();
  for (const r of rows) {
    const day = observedDay(r.observed_at);
    if (r.checkin_date === "" || day === "") continue;
    const key = `${r.checkin_date}::${day}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: MarketCurveRow[] = [];
  for (const [key, group] of groups) {
    const [checkinDate, day] = key.split("::") as [string, string];
    let available = 0, soldOut = 0, notListed = 0, unknown = 0;
    const prices: number[] = [];
    for (const r of group) {
      const status: NormalizedStatus = normalizeStatus(r.availability_status_raw);
      if (status === "available") available += 1;
      else if (status === "sold_out") soldOut += 1;
      else if (status === "not_listed") notListed += 1;
      else unknown += 1;
      if (status === "available" && r.is_price_usable_for_dp_directional && r.normalized_total_price !== null) {
        prices.push(r.normalized_total_price);
      }
    }
    const raw = group.length;
    const delta = deltaIdx.get(key) ?? { up: 0, down: 0, a2s: 0, s2a: 0 };
    out.push({
      checkin_date: checkinDate,
      observed_at: day,
      lead_time_days: daysBetween(day, checkinDate),
      raw_observation_count: raw,
      property_count: new Set(group.map((r) => r.property_id)).size,
      available_count: available,
      sold_out_count: soldOut,
      not_listed_count: notListed,
      unknown_count: unknown,
      available_ratio: ratio(available, raw),
      sold_out_ratio: ratio(soldOut, raw),
      not_listed_ratio: ratio(notListed, raw),
      price_observation_count: prices.length,
      median_available_price: median(prices),
      min_available_price: prices.length === 0 ? null : Math.min(...prices),
      max_available_price: prices.length === 0 ? null : Math.max(...prices),
      price_up_count_since_previous_observation: delta.up,
      price_down_count_since_previous_observation: delta.down,
      available_to_sold_out_count_since_previous_observation: delta.a2s,
      sold_out_to_available_count_since_previous_observation: delta.s2a,
      market_movement_level: movementLevel(raw, delta),
      data_quality: dataQuality(raw),
      notes: ""
    });
  }
  return out.sort((a, b) => (a.checkin_date === b.checkin_date ? a.observed_at.localeCompare(b.observed_at) : a.checkin_date.localeCompare(b.checkin_date)));
}

export type MarketCurveDecision =
  | "market_booking_curve_ready"
  | "market_booking_curve_ready_with_warnings"
  | "market_booking_curve_insufficient_data"
  | "market_booking_curve_failed";

export interface MarketCurveValidation {
  run_at: string;
  input_history_rows: number;
  booking_curve_rows: number;
  min_checkin_date: string | null;
  max_checkin_date: string | null;
  min_observed_at: string | null;
  max_observed_at: string | null;
  unique_checkin_dates: number;
  unique_observed_ats: number;
  decision: MarketCurveDecision;
  warnings: string[];
}

export function buildMarketCurveValidation(input: { runAt: string; inputHistoryRows: number; curve: readonly MarketCurveRow[] }): MarketCurveValidation {
  const { curve } = input;
  const checkins = [...new Set(curve.map((r) => r.checkin_date))].sort();
  const observedAts = [...new Set(curve.map((r) => r.observed_at))].sort();
  const warnings: string[] = [];
  const insufficient = curve.filter((r) => r.market_movement_level === "insufficient_data").length;
  if (curve.length > 0 && insufficient === curve.length) warnings.push("all_curve_rows_insufficient_data");
  if (observedAts.length < 2) warnings.push("single_observation_day_only_curve_is_flat");

  let decision: MarketCurveDecision;
  if (input.inputHistoryRows === 0) decision = "market_booking_curve_insufficient_data";
  else if (curve.length === 0) decision = "market_booking_curve_insufficient_data";
  else if (warnings.length > 0) decision = "market_booking_curve_ready_with_warnings";
  else decision = "market_booking_curve_ready";

  return {
    run_at: input.runAt,
    input_history_rows: input.inputHistoryRows,
    booking_curve_rows: curve.length,
    min_checkin_date: checkins[0] ?? null,
    max_checkin_date: checkins[checkins.length - 1] ?? null,
    min_observed_at: observedAts[0] ?? null,
    max_observed_at: observedAts[observedAts.length - 1] ?? null,
    unique_checkin_dates: checkins.length,
    unique_observed_ats: observedAts.length,
    decision,
    warnings
  };
}

// ---------------------------------------------------------------------------
// 2. Adaptive crawl priority.

export type PriorityLevel = "high" | "medium" | "low";

export interface CrawlPriorityRow {
  target_checkin_date: string;
  priority_score: number;
  priority_level: PriorityLevel;
  lead_time_days: number | null;
  raw_observation_count: number;
  available_count: number;
  sold_out_count: number;
  sold_out_ratio: number;
  price_up_count: number;
  price_down_count: number;
  available_to_sold_out_count: number;
  sold_out_to_available_count: number;
  reason_codes: string;
  recommended_sources: string;
  recommended_properties: string;
  notes: string;
}

const SOURCE_DISPLAY: Record<string, string> = { booking: "Booking", jalan: "Jalan", rakuten: "Rakuten" };

// Order the three canonical sources with the LEAST-observed (for this checkin)
// first, so the next crawl fills coverage gaps.
function recommendedSources(rows: readonly PriceHistoryInputRow[]): string {
  const counts: Record<string, number> = { booking: 0, jalan: 0, rakuten: 0 };
  for (const r of rows) {
    const s = r.source.toLowerCase();
    if (s in counts) counts[s] = (counts[s] ?? 0) + 1;
  }
  return (["booking", "jalan", "rakuten"] as const)
    .slice()
    .sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0))
    .map((s) => SOURCE_DISPLAY[s])
    .join(",");
}

function recommendedProperties(changes: readonly CompetitorPriceChange[]): string {
  const freq = new Map<string, number>();
  for (const c of changes) {
    if (c.change_type === "same_price" || c.change_type === "unknown") continue;
    if (c.property_name === "") continue;
    freq.set(c.property_name, (freq.get(c.property_name) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n).join(",");
}

export function buildCrawlPriority(input: {
  rows: readonly PriceHistoryInputRow[];
  curve: readonly MarketCurveRow[];
  changes: readonly CompetitorPriceChange[];
  runDateIso: string;
}): CrawlPriorityRow[] {
  const { rows, curve, changes, runDateIso } = input;
  const checkinDates = [...new Set(rows.map((r) => r.checkin_date).filter((d) => /^\d{4}-\d{2}-\d{2}$/u.test(d)))];
  const out: CrawlPriorityRow[] = [];

  for (const checkin of checkinDates) {
    const lead = daysBetween(runDateIso, checkin);
    if (lead === null || lead < 0) continue; // only future stays are crawl targets

    // Latest observation-day snapshot for this checkin = current market state.
    const snapshots = curve.filter((c) => c.checkin_date === checkin).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    const latest = snapshots[snapshots.length - 1];
    const rawObs = latest?.raw_observation_count ?? 0;
    const available = latest?.available_count ?? 0;
    const soldOut = latest?.sold_out_count ?? 0;
    const soldOutRatio = latest?.sold_out_ratio ?? 0;

    // Cumulative change signal for this checkin.
    const checkinChanges = changes.filter((c) => c.checkin_date === checkin);
    const count = (t: CompetitorPriceChange["change_type"]): number => checkinChanges.filter((c) => c.change_type === t).length;
    const priceUp = count("price_up");
    const priceDown = count("price_down");
    const a2s = count("available_to_sold_out");
    const s2a = count("sold_out_to_available");

    let score = 0;
    const reasons: string[] = [];
    if (lead <= 3) score += 3;
    if (lead <= 14) score += 2;
    if (lead <= 30) score += 1;
    if (lead <= 14) reasons.push("NEAR_STAY_DATE");
    if (soldOutRatio >= 0.5) { score += 3; reasons.push("HIGH_SOLD_OUT_RATIO"); }
    else if (soldOutRatio >= 0.3) { score += 2; reasons.push("HIGH_SOLD_OUT_RATIO"); }
    if (a2s >= 2) { score += 3; reasons.push("SOLD_OUT_TRANSITION"); }
    if (priceUp > priceDown) { score += 2; reasons.push("PRICE_UP_DOMINANT"); }
    else if (priceDown > priceUp) { score += 1; reasons.push("PRICE_DOWN_DOMINANT"); }
    if (rawObs < 5) { score += 1; reasons.push("LOW_OBSERVATION_COUNT"); }

    const level: PriorityLevel = score >= 8 ? "high" : score >= 4 ? "medium" : "low";

    out.push({
      target_checkin_date: checkin,
      priority_score: score,
      priority_level: level,
      lead_time_days: lead,
      raw_observation_count: rawObs,
      available_count: available,
      sold_out_count: soldOut,
      sold_out_ratio: soldOutRatio,
      price_up_count: priceUp,
      price_down_count: priceDown,
      available_to_sold_out_count: a2s,
      sold_out_to_available_count: s2a,
      reason_codes: reasons.join(","),
      recommended_sources: recommendedSources(rows.filter((r) => r.checkin_date === checkin)),
      recommended_properties: recommendedProperties(checkinChanges),
      notes: ""
    });
  }
  return out.sort((a, b) => (b.priority_score - a.priority_score) || a.target_checkin_date.localeCompare(b.target_checkin_date));
}

export type CrawlPriorityDecision =
  | "crawl_priority_ready"
  | "crawl_priority_ready_with_warnings"
  | "crawl_priority_insufficient_data"
  | "crawl_priority_failed";

export interface CrawlPriorityValidation {
  run_at: string;
  crawl_priority_rows: number;
  high_priority_count: number;
  medium_priority_count: number;
  low_priority_count: number;
  max_priority_score: number;
  min_priority_score: number;
  decision: CrawlPriorityDecision;
  warnings: string[];
}

export function buildCrawlPriorityValidation(input: { runAt: string; rows: readonly CrawlPriorityRow[]; inputHistoryRows: number }): CrawlPriorityValidation {
  const { rows } = input;
  const scores = rows.map((r) => r.priority_score);
  const warnings: string[] = [];
  if (input.inputHistoryRows > 0 && rows.length === 0) warnings.push("no_future_checkin_targets");
  const high = rows.filter((r) => r.priority_level === "high").length;
  const medium = rows.filter((r) => r.priority_level === "medium").length;
  const low = rows.filter((r) => r.priority_level === "low").length;

  let decision: CrawlPriorityDecision;
  if (input.inputHistoryRows === 0) decision = "crawl_priority_insufficient_data";
  else if (rows.length === 0) decision = "crawl_priority_ready_with_warnings";
  else if (warnings.length > 0) decision = "crawl_priority_ready_with_warnings";
  else decision = "crawl_priority_ready";

  return {
    run_at: input.runAt,
    crawl_priority_rows: rows.length,
    high_priority_count: high,
    medium_priority_count: medium,
    low_priority_count: low,
    max_priority_score: scores.length === 0 ? 0 : Math.max(...scores),
    min_priority_score: scores.length === 0 ? 0 : Math.min(...scores),
    decision,
    warnings
  };
}

// ---------------------------------------------------------------------------
// CSV rendering.

export const MARKET_CURVE_HEADERS = [
  "checkin_date", "observed_at", "lead_time_days",
  "raw_observation_count", "property_count", "available_count", "sold_out_count", "not_listed_count", "unknown_count",
  "available_ratio", "sold_out_ratio", "not_listed_ratio",
  "price_observation_count", "median_available_price", "min_available_price", "max_available_price",
  "price_up_count_since_previous_observation", "price_down_count_since_previous_observation",
  "available_to_sold_out_count_since_previous_observation", "sold_out_to_available_count_since_previous_observation",
  "market_movement_level", "data_quality", "notes"
] as const;

export const CRAWL_PRIORITY_HEADERS = [
  "target_checkin_date", "priority_score", "priority_level",
  "lead_time_days", "raw_observation_count", "available_count", "sold_out_count", "sold_out_ratio",
  "price_up_count", "price_down_count", "available_to_sold_out_count", "sold_out_to_available_count",
  "reason_codes", "recommended_sources", "recommended_properties", "notes"
] as const;

function num(v: number | null): string {
  return v === null ? "" : String(v);
}
function csvCell(v: string): string {
  return /[",\n\r]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v;
}

export function renderMarketCurveCsv(rows: readonly MarketCurveRow[]): string {
  const body = rows.map((r) => [
    r.checkin_date, r.observed_at, num(r.lead_time_days),
    String(r.raw_observation_count), String(r.property_count), String(r.available_count), String(r.sold_out_count), String(r.not_listed_count), String(r.unknown_count),
    String(r.available_ratio), String(r.sold_out_ratio), String(r.not_listed_ratio),
    String(r.price_observation_count), num(r.median_available_price), num(r.min_available_price), num(r.max_available_price),
    String(r.price_up_count_since_previous_observation), String(r.price_down_count_since_previous_observation),
    String(r.available_to_sold_out_count_since_previous_observation), String(r.sold_out_to_available_count_since_previous_observation),
    r.market_movement_level, r.data_quality, r.notes
  ].map(csvCell).join(","));
  return [MARKET_CURVE_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderCrawlPriorityCsv(rows: readonly CrawlPriorityRow[]): string {
  const body = rows.map((r) => [
    r.target_checkin_date, String(r.priority_score), r.priority_level,
    num(r.lead_time_days), String(r.raw_observation_count), String(r.available_count), String(r.sold_out_count), String(r.sold_out_ratio),
    String(r.price_up_count), String(r.price_down_count), String(r.available_to_sold_out_count), String(r.sold_out_to_available_count),
    r.reason_codes, r.recommended_sources, r.recommended_properties, r.notes
  ].map(csvCell).join(","));
  return [CRAWL_PRIORITY_HEADERS.join(","), ...body].join("\n") + "\n";
}
