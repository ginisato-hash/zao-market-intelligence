// Phase ZMI PRICING-CRITICAL01 — price-change detection for priority competitors
// and own properties (pure, read-only derivation over existing canonical history).
//
// Compares the latest TWO priced observations for the same (target_type, source,
// canonical_property_key, checkin) and reports direction (up/down/unchanged).
// Unlike marketPriceMovementSignals.ts (which deliberately EXCLUDES own
// properties and gates on room/meal-basis confidence for DP-pressure evidence
// quality), this is a simpler raw price-change signal used for both competitor
// AND self price monitoring — own properties are explicitly INCLUDED here.

import type { PriceHistoryInputRow } from "./priceHistorySignals";

export type PriceChangeDirection = "up" | "down" | "unchanged";
export type PriceChangeTargetType = "competitor" | "own_property";

export interface TrackedPropertyRef {
  canonical_property_key: string;
  display_name: string;
  canonical_property_name: string;
}

export interface PriceChangeRecord {
  target_type: PriceChangeTargetType;
  property: string;
  display_name: string;
  source: string;
  checkin: string;
  previous_price: number;
  latest_price: number;
  delta_amount: number;
  delta_rate: number;
  direction: PriceChangeDirection;
  previous_collected_at_jst: string;
  latest_collected_at_jst: string;
}

function priceOf(row: PriceHistoryInputRow): number | null {
  return Number.isFinite(row.normalized_total_price as number) ? row.normalized_total_price : null;
}

export function detectPriceChanges(input: {
  rows: readonly PriceHistoryInputRow[];
  properties: readonly TrackedPropertyRef[];
  targetType: PriceChangeTargetType;
}): PriceChangeRecord[] {
  const byKey = new Map<string, { ref: TrackedPropertyRef; rows: PriceHistoryInputRow[] }>();
  const propByName = new Map(input.properties.map((p) => [p.canonical_property_name, p]));
  for (const r of input.rows) {
    const ref = propByName.get(r.property_name);
    if (ref === undefined) continue;
    const key = `${r.source}|${ref.canonical_property_key}|${r.checkin_date}`;
    const entry = byKey.get(key) ?? { ref, rows: [] };
    entry.rows.push(r);
    byKey.set(key, entry);
  }

  const out: PriceChangeRecord[] = [];
  for (const { ref, rows } of byKey.values()) {
    const priced = rows.filter((r) => priceOf(r) !== null).sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    if (priced.length < 2) continue;
    const previous = priced[priced.length - 2]!;
    const latest = priced[priced.length - 1]!;
    const previousPrice = priceOf(previous)!;
    const latestPrice = priceOf(latest)!;
    const delta = latestPrice - previousPrice;
    const direction: PriceChangeDirection = delta > 0 ? "up" : delta < 0 ? "down" : "unchanged";
    if (direction === "unchanged") continue; // skip_identical (§7)
    out.push({
      target_type: input.targetType,
      property: ref.canonical_property_key,
      display_name: ref.display_name,
      source: latest.source,
      checkin: latest.checkin_date,
      previous_price: previousPrice,
      latest_price: latestPrice,
      delta_amount: delta,
      delta_rate: previousPrice === 0 ? 0 : Number((delta / previousPrice).toFixed(4)),
      direction,
      previous_collected_at_jst: previous.observed_at,
      latest_collected_at_jst: latest.observed_at
    });
  }
  return out.sort((a, b) => (a.checkin === b.checkin ? a.property.localeCompare(b.property) : a.checkin.localeCompare(b.checkin)));
}
