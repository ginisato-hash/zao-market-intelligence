// Phase ZMI BI Web — unified-source BI dataset builder (pure).
//
// Collapses ZMI canonical history into ONE unified market view per
// (canonical_property_name, checkin): all sources (Booking/Jalan/Rakuten/…) are
// merged, never selectable. Availability is unified ("bookable anywhere =
// available"); directional prices are aggregated (median/avg); source coverage
// drives price/inventory confidence. Output feeds a static BI page. Pure: no
// I/O, no network. Only ZMI-history-derived values — no external/invented data.

export type UnifiedAvailability = "available" | "sold_out" | "not_found" | "excluded";
export type Confidence = "high" | "medium" | "low";

export const ROOM_ONLY_COMPS = ["HAMMOND", "ONSEN & STAY OAKHILL", "吉田屋"] as const;
export const OWN_PROPERTIES = ["三浦屋", "ホテル喜らく", "喜らく"] as const;

// Canonical alias folding (BI/aggregation ONLY — never mutates raw history).
// Different OTAs label the same property differently; fold every known alias to
// the single existing canonical so BI shows ONE facility, not split rows.
// e.g. jalan "喜らく" and Booking "ZAO SPA HOTEL Kiraku" → "ホテル喜らく".
export const CANONICAL_ALIASES: Readonly<Record<string, string>> = {
  "喜らく": "ホテル喜らく",
  "ホテル喜らく": "ホテル喜らく",
  "旅館きらく": "ホテル喜らく",
  "kiraku": "ホテル喜らく",
  "hotelkiraku": "ホテル喜らく",
  "zaospahotelkiraku": "ホテル喜らく"
};

/** Fold a raw canonical_property_name to the unified canonical (alias-aware). */
export function canonicalizeName(name: string): string {
  const raw = (name ?? "").trim();
  if (CANONICAL_ALIASES[raw]) return CANONICAL_ALIASES[raw];
  const key = raw.normalize("NFKC").toLowerCase().replace(/[\s　・･]+/gu, "");
  return CANONICAL_ALIASES[key] ?? raw;
}

export interface BiHistoryRow {
  source: string;
  canonical_property_name: string;
  source_slug_or_code: string;
  checkin: string;
  checkout: string;
  availability_status: string;
  normalized_total_price: number | null;
  is_price_usable_for_dp_directional: boolean;
  collected_at_jst: string;
  tier: string;
  // Existing v1 columns used to DERIVE meal/room basis at export time (history
  // schema is NOT widened). Optional so older callers/tests still construct rows.
  source_classification?: string;
  warning_flags?: string;
  basis_confidence?: string;
  is_price_excluded_from_dp?: boolean;
  dp_exclusion_reason?: string;
  basis_note?: string;
}

export type MealBasisBi = "assumed_room_only" | "confirmed_room_only" | "meal_included" | "unknown_meal_basis";

// Derive meal basis for a BI row from existing v1 columns (§5.3/§5.4):
//  - Booking → assumed_room_only by policy.
//  - Jalan → confirmed_room_only ONLY if the new meal gate marked it
//    (warning_flags / source_classification); meal-included if so classified;
//    otherwise unknown (this is how LEGACY pre-gate Jalan rows are kept OUT of
//    room-only DP pricing — they lack the confirmed marker).
//  - Rakuten/other → unknown.
export function deriveBiMealBasis(row: BiHistoryRow): MealBasisBi {
  if (row.source === "booking") return "assumed_room_only";
  if (row.source === "jalan") {
    const wf = row.warning_flags ?? "";
    const sc = row.source_classification ?? "";
    if (wf.includes("meal_basis=confirmed_room_only") || wf.includes("meal_basis_confirmed_room_only") || sc === "jalan_confirmed_room_only_total_tax_included") {
      return "confirmed_room_only";
    }
    if (sc === "jalan_meal_included_excluded" || wf.includes("meal_included_plan_excluded")) return "meal_included";
    return "unknown_meal_basis";
  }
  return "unknown_meal_basis";
}

// A row contributes a room-only price sample only when it is room-only eligible
// (Booking assumed_room_only or Jalan confirmed_room_only), DP-directional usable,
// not excluded, and carries a price.
export function isRoomOnlyPriceSample(row: BiHistoryRow): boolean {
  const meal = deriveBiMealBasis(row);
  const eligible = meal === "assumed_room_only" || meal === "confirmed_room_only";
  return eligible && row.is_price_usable_for_dp_directional && row.is_price_excluded_from_dp !== true && row.normalized_total_price !== null;
}

export type RoomBasisBi =
  | "confirmed_two_person_standard_room"
  | "excluded_single_room"
  | "excluded_semi_double_room"
  | "excluded_large_room"
  | "excluded_family_or_suite_room"
  | "unknown_room_basis";

// Derive room basis for a BI row from existing v1 columns (§5.3-style):
//  - dp_exclusion_reason carries the room-type exclusion when a collector gated
//    the row (excluded_room_type_* / unknown_room_basis_excluded /
//    no_confirmed_two_person_room_only_safe_plan_candidates).
//  - a positive confirmation marker lives in warning_flags (Jalan) or basis_note
//    (Booking): "room_basis=confirmed_two_person_standard_room".
//  - everything else (incl. LEGACY rows written before this gate) is unknown —
//    this keeps legacy rows OUT of two-person-standard DP pricing.
export function deriveBiRoomBasis(row: BiHistoryRow): RoomBasisBi {
  const reason = row.dp_exclusion_reason ?? "";
  if (reason === "excluded_room_type_single") return "excluded_single_room";
  if (reason === "excluded_room_type_semi_double") return "excluded_semi_double_room";
  if (reason === "excluded_room_type_large") return "excluded_large_room";
  if (reason === "excluded_room_type_family_or_suite") return "excluded_family_or_suite_room";
  if (reason === "unknown_room_basis_excluded" || reason === "no_confirmed_two_person_room_only_safe_plan_candidates") {
    return "unknown_room_basis";
  }
  const wf = row.warning_flags ?? "";
  const bn = row.basis_note ?? "";
  const sc = row.source_classification ?? "";
  if (
    wf.includes("room_basis=confirmed_two_person_standard_room") ||
    wf.includes("room_basis_confirmed_two_person_standard") ||
    bn.includes("room_basis=confirmed_two_person_standard_room") ||
    sc.includes("two_person_standard")
  ) {
    return "confirmed_two_person_standard_room";
  }
  return "unknown_room_basis";
}

// A row is a DP price sample under the room-basis-hardened policy only when it is
// a room-only eligible price sample AND a confirmed two-person standard room.
export function isTwoPersonStandardRoomPriceSample(row: BiHistoryRow): boolean {
  return isRoomOnlyPriceSample(row) && deriveBiRoomBasis(row) === "confirmed_two_person_standard_room";
}

// A priced row excluded specifically for room type (or unknown room basis).
export function isExcludedRoomTypePriceSample(row: BiHistoryRow): boolean {
  const reason = row.dp_exclusion_reason ?? "";
  return (
    reason.startsWith("excluded_room_type_") ||
    reason === "unknown_room_basis_excluded" ||
    reason === "no_confirmed_two_person_room_only_safe_plan_candidates"
  );
}

export interface UnifiedRow {
  period_key: string;
  period_label: string;
  checkin: string;
  canonical_property_name: string;
  unified_availability_status: UnifiedAvailability;
  source_count: number;
  available_source_count: number;
  sold_out_source_count: number;
  no_data_source_count: number;
  median_directional_price: number | null;
  avg_directional_price: number | null;
  price_sample_count: number; // room-only usable price samples (redesigned meaning)
  price_confidence: Confidence; // overall, meal-basis aware (no longer just sampleCount)
  price_basis_confidence: Confidence; // quality of the price reading itself
  price_coverage_confidence: Confidence; // multi-source corroboration of room-only price
  meal_basis_summary: string; // e.g. "assumed_room_only:1,confirmed_room_only:1,unknown:0"
  room_only_price_sample_count: number;
  excluded_meal_price_sample_count: number;
  unknown_meal_basis_count: number;
  room_basis_summary: string; // e.g. "confirmed_two_person_standard_room:1,excluded_single_room:0,...,unknown:2"
  two_person_room_price_sample_count: number;
  excluded_room_type_price_sample_count: number;
  unknown_room_basis_count: number;
  inventory_confidence: Confidence;
  latest_collected_at_jst: string;
  is_room_only_comp: boolean;
  is_own_property: boolean;
  tier: string;
}

// §7.2 price reading quality.
export function priceBasisConfidence(input: { roomOnlySampleCount: number; strongBookingRoomOnly: boolean }): Confidence {
  if (input.roomOnlySampleCount >= 2 || input.strongBookingRoomOnly) return "high";
  if (input.roomOnlySampleCount === 1) return "medium";
  return "low";
}

// §7.3 multi-source corroboration.
export function priceCoverageConfidence(roomOnlySourceCount: number): Confidence {
  if (roomOnlySourceCount >= 2) return "high";
  if (roomOnlySourceCount === 1) return "medium";
  return "low";
}

// §7.4 overall — Booking single strong room-only price can be high.
export function overallPriceConfidence(input: { basis: Confidence; coverage: Confidence; strongBookingRoomOnly: boolean; roomOnlySampleCount: number }): Confidence {
  if ((input.basis === "high" && input.coverage === "high") || input.strongBookingRoomOnly) return "high";
  if (input.roomOnlySampleCount >= 1) return "medium";
  return "low";
}

export function normalizeAvailability(status: string): UnifiedAvailability {
  const s = status.trim().toLowerCase();
  if (s === "available" || s === "available_price_basis") return "available";
  if (s === "sold_out") return "sold_out";
  if (s === "not_found") return "not_found";
  return "excluded";
}

/** 上旬 (1–15) / 下旬 (16–end). */
export function halfOf(checkin: string): "early" | "late" {
  const day = Number(checkin.slice(8, 10));
  return day <= 15 ? "early" : "late";
}
export function periodKey(checkin: string): string {
  return `${checkin.slice(0, 7)}_${halfOf(checkin)}`;
}
export function periodLabel(key: string): string {
  const [ym, half] = key.split("_");
  const [y, m] = (ym ?? "").split("-");
  const label = half === "early" ? "上旬（1〜15日）" : "下旬（16〜末日）";
  return `${y}年${Number(m)}月 ${label}`;
}

/**
 * Latest observation per (source, canonical_property_name, checkin) by
 * collected_at_jst. canonical_property_name is alias-folded first so OTA naming
 * variants (e.g. jalan 喜らく / booking ZAO SPA HOTEL Kiraku) collapse to one
 * property — BI/aggregation only; raw history rows are not modified on disk.
 */
export function latestObservations(rows: readonly BiHistoryRow[]): BiHistoryRow[] {
  const latest = new Map<string, BiHistoryRow>();
  for (const raw of rows) {
    const r = { ...raw, canonical_property_name: canonicalizeName(raw.canonical_property_name) };
    const key = `${r.source}|${r.canonical_property_name}|${r.checkin}`;
    const prev = latest.get(key);
    if (prev === undefined || r.collected_at_jst > prev.collected_at_jst) latest.set(key, r);
  }
  return [...latest.values()];
}

function inventoryConfidence(sourceCount: number): Confidence {
  if (sourceCount >= 2) return "high";
  if (sourceCount === 1) return "medium";
  return "low";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Unify latest observations into one row per (property, checkin) across all sources. */
export function unifyByPropertyCheckin(latest: readonly BiHistoryRow[]): UnifiedRow[] {
  const groups = new Map<string, BiHistoryRow[]>();
  for (const r of latest) {
    const key = `${r.canonical_property_name}|${r.checkin}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: UnifiedRow[] = [];
  for (const [, rows] of groups) {
    const first = rows[0]!;
    let available = 0;
    let soldOut = 0;
    let noData = 0;
    for (const r of rows) {
      const b = normalizeAvailability(r.availability_status);
      if (b === "available") available += 1;
      else if (b === "sold_out") soldOut += 1;
      else noData += 1; // not_found + excluded both count as no inventory signal from that source
    }
    const unified: UnifiedAvailability =
      available > 0 ? "available" : soldOut > 0 ? "sold_out" : rows.some((r) => normalizeAvailability(r.availability_status) === "not_found") ? "not_found" : "excluded";

    // BI display price stays room-only / meal-basis-hardened so legacy rows
    // (which lack room-basis hints and derive as unknown_room_basis) still show
    // a price. Room-basis is reported separately and used only to CAP confidence
    // — it must not blank the display price. two_person is the confirmed subset.
    const roomOnlyRows = unified === "available" ? rows.filter((r) => isRoomOnlyPriceSample(r)) : [];
    const twoPersonRows = unified === "available" ? rows.filter((r) => isTwoPersonStandardRoomPriceSample(r)) : [];
    const displayPriceRows = roomOnlyRows;
    const prices = displayPriceRows.map((r) => r.normalized_total_price!);
    const med = median(prices);
    const avg = prices.length === 0 ? null : Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

    // Meal-basis + room-basis summaries across all sources for this property/checkin.
    const mealCounts = { assumed_room_only: 0, confirmed_room_only: 0, meal_included: 0, unknown_meal_basis: 0 };
    const roomCounts = {
      confirmed_two_person_standard_room: 0,
      excluded_single_room: 0,
      excluded_semi_double_room: 0,
      excluded_large_room: 0,
      excluded_family_or_suite_room: 0,
      unknown_room_basis: 0
    };
    let excludedMealPriced = 0;
    let excludedRoomTypePriced = 0;
    for (const r of rows) {
      const mb = deriveBiMealBasis(r);
      mealCounts[mb] += 1;
      if (mb === "meal_included" && r.normalized_total_price !== null) excludedMealPriced += 1;
      const rb = deriveBiRoomBasis(r);
      roomCounts[rb] += 1;
      if (isExcludedRoomTypePriceSample(r) && r.normalized_total_price !== null) excludedRoomTypePriced += 1;
    }
    // Basis/coverage reflect the reading quality + source coverage of the
    // (room-only) display prices. Overall confidence is then CAPPED to low while
    // no confirmed two-person standard room sample exists — display prices are
    // shown but flagged as not-yet-room-confirmed.
    const roomOnlySourceCount = new Set(roomOnlyRows.map((r) => r.source)).size;
    const strongBookingRoomOnly = roomOnlyRows.some(
      (r) => r.source === "booking" && (r.basis_confidence === "A" || r.basis_confidence === "B" || r.basis_confidence === "directional_candidate_basis")
    );
    const basisConf = priceBasisConfidence({ roomOnlySampleCount: prices.length, strongBookingRoomOnly });
    const coverageConf = priceCoverageConfidence(roomOnlySourceCount);
    const baseOverallConf = overallPriceConfidence({ basis: basisConf, coverage: coverageConf, strongBookingRoomOnly, roomOnlySampleCount: prices.length });
    const overallConf: Confidence = prices.length === 0 ? "low" : twoPersonRows.length === 0 ? "low" : baseOverallConf;
    const mealSummary = `assumed_room_only:${mealCounts.assumed_room_only},confirmed_room_only:${mealCounts.confirmed_room_only},meal_included:${mealCounts.meal_included},unknown:${mealCounts.unknown_meal_basis}`;
    const roomSummary = `confirmed_two_person_standard_room:${roomCounts.confirmed_two_person_standard_room},excluded_single_room:${roomCounts.excluded_single_room},excluded_semi_double_room:${roomCounts.excluded_semi_double_room},excluded_large_room:${roomCounts.excluded_large_room},excluded_family_or_suite_room:${roomCounts.excluded_family_or_suite_room},unknown:${roomCounts.unknown_room_basis}`;

    const latestCollected = rows.reduce((acc, r) => (r.collected_at_jst > acc ? r.collected_at_jst : acc), "");
    const sourceCount = new Set(rows.map((r) => r.source)).size;
    const tier = rows.find((r) => r.tier)?.tier ?? "unknown";

    out.push({
      period_key: periodKey(first.checkin),
      period_label: periodLabel(periodKey(first.checkin)),
      checkin: first.checkin,
      canonical_property_name: first.canonical_property_name,
      unified_availability_status: unified,
      source_count: sourceCount,
      available_source_count: available,
      sold_out_source_count: soldOut,
      no_data_source_count: noData,
      median_directional_price: med,
      avg_directional_price: avg,
      price_sample_count: prices.length,
      price_confidence: overallConf,
      price_basis_confidence: basisConf,
      price_coverage_confidence: coverageConf,
      meal_basis_summary: mealSummary,
      room_only_price_sample_count: roomOnlyRows.length,
      excluded_meal_price_sample_count: excludedMealPriced,
      unknown_meal_basis_count: mealCounts.unknown_meal_basis,
      room_basis_summary: roomSummary,
      two_person_room_price_sample_count: twoPersonRows.length,
      excluded_room_type_price_sample_count: excludedRoomTypePriced,
      unknown_room_basis_count: roomCounts.unknown_room_basis,
      inventory_confidence: inventoryConfidence(sourceCount),
      latest_collected_at_jst: latestCollected,
      is_room_only_comp: (ROOM_ONLY_COMPS as readonly string[]).includes(first.canonical_property_name),
      is_own_property: (OWN_PROPERTIES as readonly string[]).includes(first.canonical_property_name),
      tier
    });
  }
  return out.sort((a, b) => (a.checkin === b.checkin ? a.canonical_property_name.localeCompare(b.canonical_property_name) : a.checkin.localeCompare(b.checkin)));
}

// ---------------------------------------------------------------------------
// Phase AUTO-RUNNER17X — availability separation for honest "unavailable" rates.
//
// not_found / failed / excluded mean "no inventory signal" (failed normalizes to
// excluded), NOT "OTA sold out". They must never inflate the OTA-unavailable
// rate. Rates are computed over unified (property, checkin) rows.

export interface AvailabilityBreakdown {
  total: number;
  available: number;
  sold_out: number;
  not_found: number;
  excluded: number;
  // OTA販売不可日率 — only over rows with a real availability signal.
  ota_unavailable_rate: number; // sold_out / (available + sold_out)
  // データ未取得率 — not_found + excluded(+failed) share of all rows.
  data_missing_rate: number; // (not_found + excluded) / total
  // 取得信頼度 — share of rows with a usable available/sold_out signal.
  data_reliability_rate: number; // (available + sold_out) / total
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

export function availabilityBreakdown(rows: readonly UnifiedRow[]): AvailabilityBreakdown {
  let available = 0;
  let soldOut = 0;
  let notFound = 0;
  let excluded = 0;
  for (const r of rows) {
    if (r.unified_availability_status === "available") available += 1;
    else if (r.unified_availability_status === "sold_out") soldOut += 1;
    else if (r.unified_availability_status === "not_found") notFound += 1;
    else excluded += 1;
  }
  const total = rows.length;
  return {
    total,
    available,
    sold_out: soldOut,
    not_found: notFound,
    excluded,
    ota_unavailable_rate: ratio(soldOut, available + soldOut),
    data_missing_rate: ratio(notFound + excluded, total),
    data_reliability_rate: ratio(available + soldOut, total)
  };
}

export const BI_CSV_HEADERS = [
  "period_key",
  "period_label",
  "checkin",
  "canonical_property_name",
  "unified_availability_status",
  "source_count",
  "available_source_count",
  "sold_out_source_count",
  "no_data_source_count",
  "median_directional_price",
  "avg_directional_price",
  "price_sample_count",
  "price_confidence",
  "price_basis_confidence",
  "price_coverage_confidence",
  "meal_basis_summary",
  "room_only_price_sample_count",
  "excluded_meal_price_sample_count",
  "unknown_meal_basis_count",
  "room_basis_summary",
  "two_person_room_price_sample_count",
  "excluded_room_type_price_sample_count",
  "unknown_room_basis_count",
  "inventory_confidence",
  "latest_collected_at_jst",
  "is_room_only_comp",
  "is_own_property",
  "tier"
] as const;

function csvCell(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

export function renderUnifiedCsv(rows: readonly UnifiedRow[]): string {
  const body = rows.map((r) =>
    [
      r.period_key,
      r.period_label,
      r.checkin,
      r.canonical_property_name,
      r.unified_availability_status,
      String(r.source_count),
      String(r.available_source_count),
      String(r.sold_out_source_count),
      String(r.no_data_source_count),
      r.median_directional_price === null ? "" : String(r.median_directional_price),
      r.avg_directional_price === null ? "" : String(r.avg_directional_price),
      String(r.price_sample_count),
      r.price_confidence,
      r.price_basis_confidence,
      r.price_coverage_confidence,
      r.meal_basis_summary,
      String(r.room_only_price_sample_count),
      String(r.excluded_meal_price_sample_count),
      String(r.unknown_meal_basis_count),
      r.room_basis_summary,
      String(r.two_person_room_price_sample_count),
      String(r.excluded_room_type_price_sample_count),
      String(r.unknown_room_basis_count),
      r.inventory_confidence,
      r.latest_collected_at_jst,
      String(r.is_room_only_comp),
      String(r.is_own_property),
      r.tier
    ].map(csvCell).join(",")
  );
  return [BI_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Period retention (BI publish scope only — NEVER touches raw history).
// Keep: default period + previous 3 periods + all future periods.

export const RETENTION_PREVIOUS_PERIODS = 3;

/** Period key (YYYY-MM_early|late) containing a given checkin date. */
export function getCurrentPeriodKeyJst(date: Date): string {
  const jst = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return periodKey(jst);
}

/** Chronological sort of period keys (string sort works: YYYY-MM_early < _late). */
export function sortPeriodKeys(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort((a, b) => {
    const ra = a.slice(0, 7) + (a.endsWith("_early") ? "0" : "1");
    const rb = b.slice(0, 7) + (b.endsWith("_early") ? "0" : "1");
    return ra.localeCompare(rb);
  });
}

/**
 * Default period: the current period if present, else the first future period,
 * else the latest available period.
 */
export function pickDefaultPeriodKey(sortedKeys: readonly string[], currentPeriodKey: string): string {
  if (sortedKeys.length === 0) return "";
  if (sortedKeys.includes(currentPeriodKey)) return currentPeriodKey;
  const future = sortedKeys.find((k) => comparePeriodKeys(k, currentPeriodKey) > 0);
  return future ?? sortedKeys[sortedKeys.length - 1]!;
}

function comparePeriodKeys(a: string, b: string): number {
  const ra = a.slice(0, 7) + (a.endsWith("_early") ? "0" : "1");
  const rb = b.slice(0, 7) + (b.endsWith("_early") ? "0" : "1");
  return ra < rb ? -1 : ra > rb ? 1 : 0;
}

export interface PeriodRetentionResult {
  retainedRows: UnifiedRow[];
  current_period_key_jst: string;
  default_period_key: string;
  retained_period_keys: string[];
  dropped_past_period_keys: string[];
  dropped_past_rows_count: number;
}

export function applyPeriodRetention(rows: readonly UnifiedRow[], now: Date): PeriodRetentionResult {
  const allKeys = sortPeriodKeys(rows.map((r) => r.period_key));
  const currentKey = getCurrentPeriodKeyJst(now);
  const defaultKey = pickDefaultPeriodKey(allKeys, currentKey);
  const defaultIndex = allKeys.indexOf(defaultKey);
  const startIndex = defaultIndex < 0 ? 0 : Math.max(0, defaultIndex - RETENTION_PREVIOUS_PERIODS);
  const retained = new Set(defaultIndex < 0 ? allKeys : allKeys.slice(startIndex));
  const dropped = allKeys.filter((k) => !retained.has(k));
  const retainedRows = rows.filter((r) => retained.has(r.period_key));
  return {
    retainedRows,
    current_period_key_jst: currentKey,
    default_period_key: defaultKey,
    retained_period_keys: [...retained],
    dropped_past_period_keys: dropped,
    dropped_past_rows_count: rows.length - retainedRows.length
  };
}

export interface BiMetadata {
  generated_at_jst: string;
  latest_collected_at_jst: string;
  history_rows_total: number;
  latest_observation_rows: number;
  unified_rows: number;
  unified_rows_before_retention: number;
  distinct_properties: number;
  distinct_checkins: number;
  sources_included: string[];
  data_policy: string;
  period_retention_policy: string;
  current_period_key_jst: string;
  default_period_key: string;
  retention_previous_periods: number;
  retained_period_keys: string[];
  dropped_past_period_keys_count: number;
  dropped_past_rows_count: number;
  availability_breakdown: AvailabilityBreakdown;
  availability_rate_policy: string;
}

export function buildBiMetadata(input: {
  generatedAtJst: string;
  historyRowsTotal: number;
  latest: readonly BiHistoryRow[];
  unifiedBeforeRetention: readonly UnifiedRow[];
  retention: PeriodRetentionResult;
}): BiMetadata {
  const latestCollected = input.latest.reduce((acc, r) => (r.collected_at_jst > acc ? r.collected_at_jst : acc), "");
  const retained = input.retention.retainedRows;
  return {
    generated_at_jst: input.generatedAtJst,
    latest_collected_at_jst: latestCollected,
    history_rows_total: input.historyRowsTotal,
    latest_observation_rows: input.latest.length,
    unified_rows: retained.length,
    unified_rows_before_retention: input.unifiedBeforeRetention.length,
    distinct_properties: new Set(retained.map((r) => r.canonical_property_name)).size,
    distinct_checkins: new Set(retained.map((r) => r.checkin)).size,
    sources_included: [...new Set(input.latest.map((r) => r.source))].sort(),
    data_policy: "ZMI history only. All sources unified. No external data.",
    period_retention_policy: "current_or_next_period_plus_3_previous_periods_and_all_future_periods",
    current_period_key_jst: input.retention.current_period_key_jst,
    default_period_key: input.retention.default_period_key,
    retention_previous_periods: RETENTION_PREVIOUS_PERIODS,
    retained_period_keys: sortPeriodKeys(input.retention.retained_period_keys),
    dropped_past_period_keys_count: input.retention.dropped_past_period_keys.length,
    dropped_past_rows_count: input.retention.dropped_past_rows_count,
    availability_breakdown: availabilityBreakdown(retained),
    availability_rate_policy:
      "ota_unavailable_rate=sold_out/(available+sold_out); data_missing_rate=(not_found+failed+excluded)/total; not_found/failed/excluded never counted as sold_out"
  };
}
