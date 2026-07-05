// Phase ZMI PRICING-CRITICAL02 — per-source, tiered-SLA coverage report for
// priority competitors and own properties (pure, read-only derivation).
//
// Two upgrades over the PRICING-CRITICAL01 version:
//  1. Coverage is reported PER SOURCE (booking/jalan/rakuten) plus an
//     all_source aggregate — a source ZMI does not live-collect yet is never
//     silently counted as "successful" (its own coverage stays visible at
//     whatever the history happens to contain, but drives a WARNING, not a
//     coverage-based pass).
//  2. Staleness is TIER-AWARE: the near-term (D+1..D+30) latest observation
//     must be <48h old or it's critical; mid-term (D+31..D+60) tolerates up to
//     3 days; far-term (D+61..D+90) up to 7 days — matching the refresh SLA in
//     priorityRefreshTiers.ts.

import type { PriceHistoryInputRow } from "./priceHistorySignals";
import { tierForCheckin } from "./priorityRefreshTiers";

export type CoverageStatus = "ok" | "warning" | "critical";
export const KNOWN_SOURCES = ["booking", "jalan", "rakuten"] as const;
export type KnownSource = (typeof KNOWN_SOURCES)[number];

export interface TieredThresholds {
  critical_30d_below: number;
  critical_45d_below: number;
  near_term_stale_hours: number;
  mid_term_stale_days: number;
  far_term_stale_days: number;
  warning_90d_below: number | null;
  require_presence: boolean; // own properties: must have >=1 available+priced row
}

// §7.1 — competitors.
export const PRIORITY_COMPETITOR_THRESHOLDS: TieredThresholds = {
  critical_30d_below: 0.90,
  critical_45d_below: 0.80,
  near_term_stale_hours: 48,
  mid_term_stale_days: 3,
  far_term_stale_days: 7,
  warning_90d_below: null,
  require_presence: false
};

// §7.2 — own properties: stricter, plus a hard presence requirement.
export const OWN_PROPERTY_THRESHOLDS: TieredThresholds = {
  critical_30d_below: 0.95,
  critical_45d_below: 0.90,
  near_term_stale_hours: 48,
  mid_term_stale_days: 3,
  far_term_stale_days: 7,
  warning_90d_below: 0.80,
  require_presence: true
};

export interface SourceCoverage {
  coverage_30d: number;
  coverage_45d: number;
  coverage_90d: number;
  latest_collected_at_jst: string | null;
  live_supported: boolean;
}

export interface PropertyCoverageInput {
  canonical_property_key: string;
  display_name: string;
  canonical_property_name: string;
  /** Sources this property actually has a verified OTA target for (booking/jalan/...). */
  verified_sources?: readonly string[];
}

export interface PropertyCoverageResult {
  property: string;
  display_name: string;
  coverage: Record<string, SourceCoverage>; // keyed by "booking" | "jalan" | "rakuten" | "all_source"
  coverage_30d: number; // all_source convenience mirror
  coverage_45d: number;
  coverage_90d: number;
  missing_dates_30d: string[]; // all_source, within D+1..D+30
  latest_collected_at_jst: string | null; // all_source
  status: CoverageStatus;
  reasons: string[];
  warnings: string[];
}

function coverageOverWindow(observedDates: ReadonlySet<string>, window: readonly string[]): number {
  if (window.length === 0) return 1;
  return Number((window.filter((d) => observedDates.has(d)).length / window.length).toFixed(4));
}

function daysSince(iso: string | null, nowMs: number): number | null {
  if (iso === null || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (nowMs - t) / (24 * 60 * 60 * 1000) : null;
}

function latestObservedAt(rows: readonly PriceHistoryInputRow[]): string | null {
  return rows.reduce<string | null>((acc, r) => (acc === null || r.observed_at > acc ? r.observed_at : acc), null);
}

function computeSourceCoverage(rows: readonly PriceHistoryInputRow[], dateRange90d: readonly string[], liveSupported: boolean): SourceCoverage {
  const observed = new Set(rows.map((r) => r.checkin_date));
  return {
    coverage_30d: coverageOverWindow(observed, dateRange90d.slice(0, 30)),
    coverage_45d: coverageOverWindow(observed, dateRange90d.slice(0, 45)),
    coverage_90d: coverageOverWindow(observed, dateRange90d),
    latest_collected_at_jst: latestObservedAt(rows),
    live_supported: liveSupported
  };
}

export function computePropertyCoverage(input: {
  rows: readonly PriceHistoryInputRow[];
  property: PropertyCoverageInput;
  dateRange90d: readonly string[]; // exactly the D+1..D+90 window
  thresholds: TieredThresholds;
  liveCollectSources: ReadonlySet<string>; // sources actually live-collected today (e.g. {"booking"})
  nowMs?: number;
  todayIso: string;
}): PropertyCoverageResult {
  const { rows, property, dateRange90d, thresholds, liveCollectSources, todayIso } = input;
  const nowMs = input.nowMs ?? Date.now();
  const propRows = rows.filter((r) => r.property_name === property.canonical_property_name);
  const verifiedSources = new Set(property.verified_sources ?? KNOWN_SOURCES);

  const coverage: Record<string, SourceCoverage> = {};
  for (const source of KNOWN_SOURCES) {
    coverage[source] = computeSourceCoverage(propRows.filter((r) => r.source === source), dateRange90d, liveCollectSources.has(source));
  }
  coverage["all_source"] = computeSourceCoverage(propRows, dateRange90d, true);
  const allSource = coverage["all_source"]!;

  const window30 = dateRange90d.slice(0, 30);
  const observedAll = new Set(propRows.map((r) => r.checkin_date));
  const missing30 = window30.filter((d) => !observedAll.has(d));

  // Tier-aware staleness: latest observation WITHIN each tier's own window.
  const nearRows = propRows.filter((r) => tierForCheckin(r.checkin_date, todayIso) === "near_term");
  const midRows = propRows.filter((r) => tierForCheckin(r.checkin_date, todayIso) === "mid_term");
  const farRows = propRows.filter((r) => tierForCheckin(r.checkin_date, todayIso) === "far_term");
  const nearLatest = latestObservedAt(nearRows);
  const midLatest = latestObservedAt(midRows);
  const farLatest = latestObservedAt(farRows);
  const nearAgeH = daysSince(nearLatest, nowMs) === null ? null : daysSince(nearLatest, nowMs)! * 24;
  const midAgeD = daysSince(midLatest, nowMs);
  const farAgeD = daysSince(farLatest, nowMs);
  const nearTermStale = nearAgeH === null || nearAgeH > thresholds.near_term_stale_hours;
  const midTermStale = midRows.length === 0 || (midAgeD !== null && midAgeD > thresholds.mid_term_stale_days);
  const farTermStale = farRows.length === 0 || (farAgeD !== null && farAgeD > thresholds.far_term_stale_days);
  const nearTermMissing = missing30.length > 0;

  const reasons: string[] = [];
  const warnings: string[] = [];
  let status: CoverageStatus = "ok";

  if (allSource.coverage_30d < thresholds.critical_30d_below) { reasons.push(`coverage_30d_below_${thresholds.critical_30d_below}`); status = "critical"; }
  if (allSource.coverage_45d < thresholds.critical_45d_below) { reasons.push(`coverage_45d_below_${thresholds.critical_45d_below}`); status = "critical"; }
  if (nearTermMissing) { reasons.push("near_term_missing_dates"); status = "critical"; }
  if (nearTermStale) { reasons.push(`near_term_stale_over_${thresholds.near_term_stale_hours}h`); status = "critical"; }
  if (thresholds.require_presence) {
    const hasPricedAvailable = propRows.some((r) => r.availability_status_raw.toLowerCase().includes("available") && r.normalized_total_price !== null);
    if (!hasPricedAvailable) { reasons.push("not_present_in_own_property_prices"); status = "critical"; }
  }

  if (midTermStale) warnings.push(`mid_term_stale_over_${thresholds.mid_term_stale_days}d`);
  if (farTermStale) warnings.push(`far_term_stale_over_${thresholds.far_term_stale_days}d`);
  for (const source of verifiedSources) {
    if (!liveCollectSources.has(source)) warnings.push(`${source}_live_collection_not_connected`);
  }
  if (thresholds.warning_90d_below !== null && allSource.coverage_90d < thresholds.warning_90d_below) warnings.push(`coverage_90d_below_${thresholds.warning_90d_below}`);

  if (status !== "critical" && warnings.length > 0) status = "warning";

  return {
    property: property.canonical_property_key,
    display_name: property.display_name,
    coverage,
    coverage_30d: allSource.coverage_30d,
    coverage_45d: allSource.coverage_45d,
    coverage_90d: allSource.coverage_90d,
    missing_dates_30d: missing30,
    latest_collected_at_jst: allSource.latest_collected_at_jst,
    status,
    reasons,
    warnings
  };
}

export function computeCoverageForProperties(input: {
  rows: readonly PriceHistoryInputRow[];
  properties: readonly PropertyCoverageInput[];
  dateRange90d: readonly string[];
  thresholds: TieredThresholds;
  liveCollectSources: ReadonlySet<string>;
  todayIso: string;
  nowMs?: number;
}): PropertyCoverageResult[] {
  const nowMs = input.nowMs ?? Date.now();
  return input.properties.map((property) =>
    computePropertyCoverage({ rows: input.rows, property, dateRange90d: input.dateRange90d, thresholds: input.thresholds, liveCollectSources: input.liveCollectSources, nowMs, todayIso: input.todayIso })
  );
}
