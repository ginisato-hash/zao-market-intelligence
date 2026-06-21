// Phase ZMI MARKET-PRICE-MOVEMENT01 — competitor price movement + DP pressure
// proxy (pure, read-only derivation).
//
// IMPORTANT: this is an INVENTORY / DP-PRESSURE PROXY, not a measurement of real
// inventory. "sold_out" is an OTA listing state, not a guaranteed empty hotel.
// Derived only from existing canonical history. Own properties (三浦屋 / 喜らく /
// Kiraku / Miuraya) are NEVER included as market evidence. Comparisons are made
// only WITHIN a single source for the same property + checkin, and only between
// room-only, two-person standard (confirmed/probable) high/medium-confidence
// observations. No scraping, no live collection, no history write.

import {
  deriveMealBasis,
  deriveRoomBasis,
  normalizeStatus,
  parseHistoryForPriceHistory,
  type NormalizedStatus,
  type PriceHistoryInputRow
} from "./priceHistorySignals";
import { isOwnProperty } from "./biWebDataExport";

export type MovementType =
  | "price_up_available"
  | "price_down_available"
  | "same_price_available"
  | "sold_out_after_price_up"
  | "sold_out_after_price_down"
  | "sold_out_after_same_price"
  | "newly_sold_out"
  | "newly_available"
  | "noise"
  | "unknown"
  | "not_comparable";

export type DpPressureLevel =
  | "high_upward_pressure"
  | "moderate_upward_pressure"
  | "neutral"
  | "downward_pressure"
  | "strong_downward_pressure";

export interface MarketPriceMovementRow {
  source: string;
  canonical_property_name: string;
  checkin: string;
  previous_observed_at: string;
  latest_observed_at: string;
  observation_interval_hours: number | null;
  previous_availability_status: NormalizedStatus;
  latest_availability_status: NormalizedStatus;
  previous_price: number | null;
  latest_price: number | null;
  price_delta_abs: number | null;
  price_delta_pct: number | null;
  movement_type: MovementType;
  movement_magnitude: "strong" | "meaningful" | "noise" | "none";
  meal_basis: string;
  room_basis: string;
  price_confidence: "high" | "medium" | "low";
  room_basis_confidence: "high" | "medium" | "low";
  row_weight: number;
  movement_score: number;
  last_available_price: number | null;
  is_own_property: boolean;
  notes: string;
}

export interface MarketDpPressureRow {
  checkin: string;
  movement_sample_count: number;
  weighted_sample_count: number;
  price_up_count: number;
  price_down_count: number;
  sold_out_transition_count: number;
  newly_available_count: number;
  noise_count: number;
  dp_pressure_score_raw: number;
  dp_pressure_score_normalized: number;
  dp_pressure_level: DpPressureLevel;
  dp_pressure_reason: string;
  latest_collected_at_jst: string;
}

const MARKET_SOURCES = new Set(["booking", "jalan", "rakuten"]);
const OWN_NAME_RE = /三浦屋|miuraya|喜らく|kiraku/iu; // belt-and-suspenders over isOwnProperty

function isMarketRow(row: PriceHistoryInputRow): boolean {
  if (!MARKET_SOURCES.has(row.source)) return false;
  if (isOwnProperty(row.property_name) || OWN_NAME_RE.test(row.property_name)) return false;
  return true;
}

function mealOk(meal: string): boolean {
  return meal === "assumed_room_only" || meal === "confirmed_room_only";
}
function roomWeight(room: string): number {
  if (room === "confirmed_two_person_standard_room") return 1.0;
  if (room === "probable_two_person_standard_room") return 0.6;
  return 0;
}
function confLabel(room: string): "high" | "medium" | "low" {
  if (room === "confirmed_two_person_standard_room") return "high";
  if (room === "probable_two_person_standard_room") return "medium";
  return "low";
}

interface Anchor {
  row: PriceHistoryInputRow;
  status: NormalizedStatus;
  price: number | null;
  meal: string;
  room: string;
  eligiblePriced: boolean; // available, room-only, conf/probable, priced, usable, not excluded
}

function toAnchor(row: PriceHistoryInputRow): Anchor {
  const status = normalizeStatus(row.availability_status_raw);
  const meal = deriveMealBasis(row);
  const room = deriveRoomBasis(row);
  const price = Number.isFinite(row.normalized_total_price as number) ? row.normalized_total_price : null;
  const eligiblePriced =
    status === "available" &&
    mealOk(meal) &&
    roomWeight(room) > 0 &&
    price !== null &&
    row.is_price_usable_for_dp_directional &&
    row.is_price_excluded_from_dp !== true;
  return { row, status, price, meal, room, eligiblePriced };
}

function hoursBetween(aIso: string, bIso: string): number | null {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Number(((b - a) / (60 * 60 * 1000)).toFixed(2));
}

function magnitude(absDelta: number, pct: number): "strong" | "meaningful" | "noise" {
  const a = Math.abs(absDelta);
  const p = Math.abs(pct);
  if (p >= 0.05 || a >= 2000) return "strong";
  if (p >= 0.03 || a >= 1000) return "meaningful";
  return "noise";
}

const MOVEMENT_SCORE: Record<MovementType, number> = {
  price_up_available: 1.0,
  sold_out_after_price_up: 1.5,
  sold_out_after_same_price: 1.0,
  newly_sold_out: 0.8,
  sold_out_after_price_down: 0.5,
  price_down_available: -1.0,
  newly_available: -0.5,
  same_price_available: 0,
  noise: 0,
  unknown: 0,
  not_comparable: 0
};

function buildMovementForGroup(rows: PriceHistoryInputRow[]): MarketPriceMovementRow | null {
  const sorted = [...rows].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const anchors = sorted.map(toAnchor);
  const latest = anchors[anchors.length - 1]!;
  const prevObs = anchors.length >= 2 ? anchors[anchors.length - 2]! : null;
  const priced = anchors.filter((a) => a.eligiblePriced);
  const lastPriced = priced[priced.length - 1] ?? null;
  const priorPriced = priced[priced.length - 2] ?? null;
  const base = sorted[0]!;

  // Weighting comes from the last available room-only anchor (the price we trust).
  const weightRow = lastPriced ?? null;
  const room = weightRow?.room ?? latest.room;
  const meal = weightRow?.meal ?? latest.meal;
  const rWeight = weightRow ? roomWeight(weightRow.room) : 0;
  const priceConf = confLabel(weightRow?.room ?? "unknown_room_basis");
  const roomConf = confLabel(weightRow?.room ?? "unknown_room_basis");
  const rowWeight = Number((rWeight * rWeight).toFixed(4)); // price_conf_weight * room_basis_weight (both from room basis)

  let movement: MovementType = "not_comparable";
  let prevAnchor: Anchor | null = null;
  let curAnchor: Anchor = latest;
  let deltaAbs: number | null = null;
  let deltaPct: number | null = null;
  let mag: "strong" | "meaningful" | "noise" | "none" = "none";

  const trend = (a: Anchor, b: Anchor): { abs: number; pct: number; m: "strong" | "meaningful" | "noise" } => {
    const abs = (b.price as number) - (a.price as number);
    const pct = a.price ? abs / (a.price as number) : 0;
    return { abs, pct, m: magnitude(abs, pct) };
  };

  if (priced.length === 0) {
    movement = "not_comparable";
  } else if (latest.status === "available") {
    if (prevObs && (prevObs.status === "sold_out" || prevObs.status === "not_listed")) {
      movement = "newly_available";
      prevAnchor = prevObs;
      curAnchor = latest;
    } else if (priorPriced && lastPriced) {
      const t = trend(priorPriced, lastPriced);
      deltaAbs = t.abs; deltaPct = Number(t.pct.toFixed(4)); mag = t.m;
      prevAnchor = priorPriced; curAnchor = lastPriced;
      if (t.abs === 0) movement = "same_price_available";
      else if (t.m === "noise") movement = "noise";
      else movement = t.abs > 0 ? "price_up_available" : "price_down_available";
    } else {
      movement = "unknown"; // single observation, no prior to compare
    }
  } else if (latest.status === "sold_out") {
    if (priorPriced && lastPriced) {
      const t = trend(priorPriced, lastPriced);
      deltaAbs = t.abs; deltaPct = Number(t.pct.toFixed(4)); mag = t.m;
      prevAnchor = lastPriced; curAnchor = latest;
      if (t.m !== "noise" && t.abs > 0) movement = "sold_out_after_price_up";
      else if (t.m !== "noise" && t.abs < 0) movement = "sold_out_after_price_down";
      else movement = "sold_out_after_same_price";
    } else if (lastPriced) {
      movement = "newly_sold_out";
      prevAnchor = lastPriced; curAnchor = latest;
    } else {
      movement = "not_comparable";
    }
  } else {
    movement = "unknown";
  }

  const prevForOut = prevAnchor ?? prevObs ?? null;
  const score = Number((MOVEMENT_SCORE[movement] * rowWeight).toFixed(4));

  return {
    source: base.source,
    canonical_property_name: base.property_name,
    checkin: base.checkin_date,
    previous_observed_at: prevForOut?.row.observed_at ?? "",
    latest_observed_at: curAnchor.row.observed_at,
    observation_interval_hours: prevForOut ? hoursBetween(prevForOut.row.observed_at, curAnchor.row.observed_at) : null,
    previous_availability_status: prevForOut?.status ?? "unknown",
    latest_availability_status: latest.status,
    previous_price: prevForOut?.eligiblePriced ? prevForOut.price : (prevAnchor?.price ?? null),
    latest_price: latest.eligiblePriced ? latest.price : null,
    price_delta_abs: deltaAbs,
    price_delta_pct: deltaPct,
    movement_type: movement,
    movement_magnitude: mag,
    meal_basis: meal,
    room_basis: room,
    price_confidence: priceConf,
    room_basis_confidence: roomConf,
    row_weight: rowWeight,
    movement_score: score,
    last_available_price: lastPriced?.price ?? null,
    is_own_property: false,
    notes: "inventory_dp_pressure_proxy"
  };
}

export interface BuildMovementResult {
  movements: MarketPriceMovementRow[];
  ownPropertyRows: number;
  notComparableRows: number;
}

// Build one movement row per (source, canonical_property_name, checkin) group,
// over MARKET (non-own) rows only.
export function buildMarketPriceMovements(rows: readonly PriceHistoryInputRow[]): BuildMovementResult {
  let ownPropertyRows = 0;
  const groups = new Map<string, PriceHistoryInputRow[]>();
  for (const r of rows) {
    if (!MARKET_SOURCES.has(r.source)) continue;
    if (isOwnProperty(r.property_name) || OWN_NAME_RE.test(r.property_name)) { ownPropertyRows += 1; continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(r.checkin_date)) continue;
    const key = `${r.source}|${r.property_name}|${r.checkin_date}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const movements: MarketPriceMovementRow[] = [];
  for (const list of groups.values()) {
    const m = buildMovementForGroup(list);
    if (m) movements.push(m);
  }
  movements.sort((a, b) => (a.checkin === b.checkin ? `${a.source}|${a.canonical_property_name}`.localeCompare(`${b.source}|${b.canonical_property_name}`) : a.checkin.localeCompare(b.checkin)));
  const notComparableRows = movements.filter((m) => m.movement_type === "not_comparable").length;
  return { movements, ownPropertyRows, notComparableRows };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function pressureLevel(normalized: number): DpPressureLevel {
  if (normalized >= 0.6) return "high_upward_pressure";
  if (normalized >= 0.25) return "moderate_upward_pressure";
  if (normalized <= -0.6) return "strong_downward_pressure";
  if (normalized <= -0.25) return "downward_pressure";
  return "neutral";
}

const SOLD_OUT_TRANSITIONS = new Set<MovementType>([
  "sold_out_after_price_up",
  "sold_out_after_price_down",
  "sold_out_after_same_price",
  "newly_sold_out"
]);

export function buildDpPressureByCheckin(movements: readonly MarketPriceMovementRow[]): MarketDpPressureRow[] {
  const byCheckin = new Map<string, MarketPriceMovementRow[]>();
  for (const m of movements) {
    if (m.movement_type === "not_comparable" || m.movement_type === "unknown") continue;
    const list = byCheckin.get(m.checkin) ?? [];
    list.push(m);
    byCheckin.set(m.checkin, list);
  }
  const out: MarketDpPressureRow[] = [];
  for (const [checkin, list] of byCheckin) {
    const weighted = list.reduce((s, m) => s + m.row_weight, 0);
    const scoreRaw = list.reduce((s, m) => s + m.movement_score, 0);
    const normalized = Number(clamp(scoreRaw / Math.max(weighted, 1), -1, 1).toFixed(4));
    const priceUp = list.filter((m) => m.movement_type === "price_up_available").length;
    const priceDown = list.filter((m) => m.movement_type === "price_down_available").length;
    const soldOut = list.filter((m) => SOLD_OUT_TRANSITIONS.has(m.movement_type)).length;
    const newlyAvail = list.filter((m) => m.movement_type === "newly_available").length;
    const noise = list.filter((m) => m.movement_type === "noise" || m.movement_type === "same_price_available").length;
    const level = pressureLevel(normalized);
    const latestCollected = list.reduce((acc, m) => (m.latest_observed_at > acc ? m.latest_observed_at : acc), "");
    out.push({
      checkin,
      movement_sample_count: list.length,
      weighted_sample_count: Number(weighted.toFixed(4)),
      price_up_count: priceUp,
      price_down_count: priceDown,
      sold_out_transition_count: soldOut,
      newly_available_count: newlyAvail,
      noise_count: noise,
      dp_pressure_score_raw: Number(scoreRaw.toFixed(4)),
      dp_pressure_score_normalized: normalized,
      dp_pressure_level: level,
      dp_pressure_reason: `up=${priceUp},down=${priceDown},sold_out=${soldOut},newly_available=${newlyAvail},weighted=${weighted.toFixed(2)} (inventory/DP pressure proxy)`,
      latest_collected_at_jst: latestCollected
    });
  }
  return out.sort((a, b) => a.checkin.localeCompare(b.checkin));
}

// ---------------------------------------------------------------------------
// CSV rendering.

export const MOVEMENT_CSV_HEADERS = [
  "source", "canonical_property_name", "checkin",
  "previous_observed_at", "latest_observed_at", "observation_interval_hours",
  "previous_availability_status", "latest_availability_status",
  "previous_price", "latest_price", "price_delta_abs", "price_delta_pct",
  "movement_type", "movement_magnitude", "meal_basis", "room_basis",
  "price_confidence", "room_basis_confidence", "row_weight", "movement_score",
  "last_available_price", "is_own_property", "notes"
] as const;

export const DP_PRESSURE_CSV_HEADERS = [
  "checkin", "movement_sample_count", "weighted_sample_count",
  "price_up_count", "price_down_count", "sold_out_transition_count", "newly_available_count", "noise_count",
  "dp_pressure_score_raw", "dp_pressure_score_normalized", "dp_pressure_level", "dp_pressure_reason",
  "latest_collected_at_jst"
] as const;

function num(v: number | null): string {
  return v === null ? "" : String(v);
}
function csvCell(v: string): string {
  return /[",\n\r]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v;
}

export function renderMovementCsv(rows: readonly MarketPriceMovementRow[]): string {
  const body = rows.map((r) => [
    r.source, r.canonical_property_name, r.checkin,
    r.previous_observed_at, r.latest_observed_at, num(r.observation_interval_hours),
    r.previous_availability_status, r.latest_availability_status,
    num(r.previous_price), num(r.latest_price), num(r.price_delta_abs), num(r.price_delta_pct),
    r.movement_type, r.movement_magnitude, r.meal_basis, r.room_basis,
    r.price_confidence, r.room_basis_confidence, String(r.row_weight), String(r.movement_score),
    num(r.last_available_price), String(r.is_own_property), r.notes
  ].map(csvCell).join(","));
  return [MOVEMENT_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderDpPressureCsv(rows: readonly MarketDpPressureRow[]): string {
  const body = rows.map((r) => [
    r.checkin, String(r.movement_sample_count), String(r.weighted_sample_count),
    String(r.price_up_count), String(r.price_down_count), String(r.sold_out_transition_count), String(r.newly_available_count), String(r.noise_count),
    String(r.dp_pressure_score_raw), String(r.dp_pressure_score_normalized), r.dp_pressure_level, r.dp_pressure_reason,
    r.latest_collected_at_jst
  ].map(csvCell).join(","));
  return [DP_PRESSURE_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

// Pure assembly from raw history CSV files (parse -> movements -> DP pressure).
// Scripts do the file I/O and pass the contents here.
export function assembleMovementArtifacts(historyFiles: readonly { filename: string; content: string }[]): {
  movements: MarketPriceMovementRow[];
  dpPressure: MarketDpPressureRow[];
  ownPropertyRows: number;
  notComparableRows: number;
} {
  const parsed = parseHistoryForPriceHistory(historyFiles);
  const { movements, ownPropertyRows, notComparableRows } = buildMarketPriceMovements(parsed.rows);
  const dpPressure = buildDpPressureByCheckin(movements);
  return { movements, dpPressure, ownPropertyRows, notComparableRows };
}

export function latestCollectedAt(rows: readonly { latest_observed_at?: string; latest_collected_at_jst?: string }[]): string {
  return rows.reduce((acc, r) => {
    const v = r.latest_observed_at ?? r.latest_collected_at_jst ?? "";
    return v > acc ? v : acc;
  }, "");
}
