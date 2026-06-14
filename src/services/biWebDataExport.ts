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
  price_sample_count: number;
  price_confidence: Confidence;
  inventory_confidence: Confidence;
  latest_collected_at_jst: string;
  is_room_only_comp: boolean;
  is_own_property: boolean;
  tier: string;
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

/** Latest observation per (source, canonical_property_name, checkin) by collected_at_jst. */
export function latestObservations(rows: readonly BiHistoryRow[]): BiHistoryRow[] {
  const latest = new Map<string, BiHistoryRow>();
  for (const r of rows) {
    const key = `${r.source}|${r.canonical_property_name}|${r.checkin}`;
    const prev = latest.get(key);
    if (prev === undefined || r.collected_at_jst > prev.collected_at_jst) latest.set(key, r);
  }
  return [...latest.values()];
}

function priceConfidence(sampleCount: number): Confidence {
  if (sampleCount >= 2) return "high";
  if (sampleCount === 1) return "medium";
  return "low";
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

    // Directional prices only from usable rows; price only meaningful when bookable.
    const prices = unified === "available"
      ? rows.filter((r) => r.is_price_usable_for_dp_directional && r.normalized_total_price !== null).map((r) => r.normalized_total_price!)
      : [];
    const med = median(prices);
    const avg = prices.length === 0 ? null : Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

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
      price_confidence: priceConfidence(prices.length),
      inventory_confidence: inventoryConfidence(sourceCount),
      latest_collected_at_jst: latestCollected,
      is_room_only_comp: (ROOM_ONLY_COMPS as readonly string[]).includes(first.canonical_property_name),
      is_own_property: (OWN_PROPERTIES as readonly string[]).includes(first.canonical_property_name),
      tier
    });
  }
  return out.sort((a, b) => (a.checkin === b.checkin ? a.canonical_property_name.localeCompare(b.canonical_property_name) : a.checkin.localeCompare(b.checkin)));
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
    dropped_past_rows_count: input.retention.dropped_past_rows_count
  };
}
