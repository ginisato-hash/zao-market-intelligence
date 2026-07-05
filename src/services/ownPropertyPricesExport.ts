// Phase ZMI PRICING-CRITICAL01 — own-property price export (pure, additive).
//
// A dedicated own-property price view, separate from the competitor-facing
// zmi_market_unified.csv (which this module NEVER touches or widens). Own
// properties are explicitly INCLUDED here (§6.6) — this is the "own price"
// axis pricing_recommendation needs alongside the competitor market axis.

import { deriveMealBasis, deriveRoomBasis, normalizeStatus, type PriceHistoryInputRow } from "./priceHistorySignals";
import type { PropertyCoverageResult } from "./priorityCoverageReport";

export interface OwnPropertyPriceRow {
  date: string; // observation date (latest_collected_at_jst date part) for this group
  checkin: string;
  property_key: string;
  property_name: string;
  source: string;
  own_price_min: number | null;
  own_price_median: number | null;
  own_price_max: number | null;
  room_basis: string;
  meal_basis: string;
  price_confidence: "high" | "medium" | "low";
  coverage_status: string;
  latest_collected_at_jst: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function priceConfidenceFor(roomBasis: string, sampleCount: number): "high" | "medium" | "low" {
  if (roomBasis === "confirmed_two_person_standard_room" && sampleCount >= 1) return "high";
  if (roomBasis === "probable_two_person_standard_room" && sampleCount >= 1) return "medium";
  return "low";
}

export function buildOwnPropertyPriceRows(input: {
  rows: readonly PriceHistoryInputRow[];
  properties: readonly { canonical_property_key: string; canonical_property_name: string }[];
  coverageByPropertyKey: ReadonlyMap<string, PropertyCoverageResult>;
}): OwnPropertyPriceRow[] {
  const byKeyByProp = new Map(input.properties.map((p) => [p.canonical_property_name, p.canonical_property_key]));
  const groups = new Map<string, PriceHistoryInputRow[]>();
  for (const r of input.rows) {
    const key = byKeyByProp.get(r.property_name);
    if (key === undefined) continue;
    if (normalizeStatus(r.availability_status_raw) !== "available" || r.normalized_total_price === null) continue;
    const gk = `${key}|${r.source}|${r.checkin_date}`;
    const list = groups.get(gk) ?? [];
    list.push(r);
    groups.set(gk, list);
  }

  const out: OwnPropertyPriceRow[] = [];
  for (const [gk, rows] of groups) {
    const [propertyKey, source, checkin] = gk.split("|") as [string, string, string];
    const propertyName = rows[0]!.property_name;
    const prices = rows.map((r) => r.normalized_total_price!);
    const latest = rows.reduce((acc, r) => (r.observed_at > acc.observed_at ? r : acc));
    const roomBasis = deriveRoomBasis(latest);
    const mealBasis = deriveMealBasis(latest);
    const coverage = input.coverageByPropertyKey.get(propertyKey);
    out.push({
      date: latest.observed_at.slice(0, 10),
      checkin,
      property_key: propertyKey,
      property_name: propertyName,
      source,
      own_price_min: Math.min(...prices),
      own_price_median: median(prices),
      own_price_max: Math.max(...prices),
      room_basis: roomBasis,
      meal_basis: mealBasis,
      price_confidence: priceConfidenceFor(roomBasis, prices.length),
      coverage_status: coverage?.status ?? "unknown",
      latest_collected_at_jst: latest.observed_at
    });
  }
  return out.sort((a, b) => (a.checkin === b.checkin ? a.property_key.localeCompare(b.property_key) : a.checkin.localeCompare(b.checkin)));
}

export const OWN_PROPERTY_PRICE_CSV_HEADERS = [
  "date", "checkin", "property_key", "property_name", "source",
  "own_price_min", "own_price_median", "own_price_max",
  "room_basis", "meal_basis", "price_confidence", "coverage_status", "latest_collected_at_jst"
] as const;

function num(v: number | null): string { return v === null ? "" : String(v); }
function csvCell(v: string): string { return /[",\n\r]/u.test(v) ? `"${v.replace(/"/gu, '""')}"` : v; }

export function renderOwnPropertyPriceCsv(rows: readonly OwnPropertyPriceRow[]): string {
  const body = rows.map((r) => [
    r.date, r.checkin, r.property_key, r.property_name, r.source,
    num(r.own_price_min), num(r.own_price_median), num(r.own_price_max),
    r.room_basis, r.meal_basis, r.price_confidence, r.coverage_status, r.latest_collected_at_jst
  ].map(csvCell).join(","));
  return [OWN_PROPERTY_PRICE_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}
