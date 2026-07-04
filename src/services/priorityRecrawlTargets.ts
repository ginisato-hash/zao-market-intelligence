// Phase ZMI PRICING-CRITICAL01 — 90-day guaranteed recrawl target generator (pure).
//
// The existing Booking recrawl targeting (runBookingLowConfidenceTargeting.ts /
// runBookingVerifiedTargetGapReview.ts) is REACTIVE: it only surfaces a date once
// BI already has a low-confidence row for it. A date with ZERO rows never
// appears, which is exactly why priority competitors like OAKHILL had no August
// coverage at all. This module is PROACTIVE: for a fixed property list, it
// unconditionally generates every (property, source, checkin) cell for the next
// N days, using the REAL verified source list from marketRefreshTargetUniverse
// (never invents a slug/source). No I/O, no network, no history read.

import { liveTargets, type MarketRefreshPropertyTarget } from "./marketRefreshTargetUniverse";
import { PRIORITY_COMPETITORS, getPriorityCompetitor, type PriorityCompetitor } from "./priorityCompetitors";
import { OWN_PROPERTY_TARGETS, getOwnPropertyTarget, type OwnPropertyTarget } from "./ownPropertyTargets";

export const DEFAULT_HORIZON_DAYS = 90;
export const DEFAULT_START_OFFSET_DAYS = 1;

export interface RecrawlTarget {
  priority: "critical" | "high";
  reason: "priority_competitor_90d_horizon" | "own_property_90d_price_tracking";
  target_type: "competitor" | "own_property";
  canonical_property_key: string;
  canonical_property_name: string;
  property_aliases: readonly string[];
  display_name: string;
  property_group?: string;
  source: MarketRefreshPropertyTarget["source"];
  property_slug: string;
  checkin: string;
}

function parseYmd(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}
function toYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function addDays(iso: string, n: number): string {
  const d = parseYmd(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toYmd(d);
}

/** Today in Asia/Tokyo as YYYY-MM-DD. Injectable for tests via todayJstIso. */
export function todayJstIso(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/**
 * D+startOffsetDays .. D+startOffsetDays+horizonDays-1, inclusive, as YYYY-MM-DD.
 * Default: D+1 .. D+90 (does not include D+0 "today"; does not include D+91).
 */
export function buildJstDateRange(horizonDays = DEFAULT_HORIZON_DAYS, startOffsetDays = DEFAULT_START_OFFSET_DAYS, todayIso: string = todayJstIso()): string[] {
  const out: string[] = [];
  for (let i = 0; i < horizonDays; i += 1) {
    out.push(addDays(todayIso, startOffsetDays + i));
  }
  return out;
}

function verifiedSourcesFor(canonicalPropertyName: string): MarketRefreshPropertyTarget[] {
  return liveTargets().filter((t) => t.canonical_property_name === canonicalPropertyName && (t.source === "booking" || t.source === "jalan"));
}

export interface BuildTargetsOptions {
  startOffsetDays?: number;
  horizonDays?: number;
  todayIso?: string;
  /** Restrict to these keys (competitor keys for priority, property keys for own). Default: all. */
  keys?: readonly string[];
}

export interface TargetGenerationResult {
  targets: RecrawlTarget[];
  skipped_no_verified_source: string[]; // canonical_property_key values with zero verified sources
}

export function buildPriorityCompetitorTargets(options: BuildTargetsOptions = {}): TargetGenerationResult {
  const dates = buildJstDateRange(options.horizonDays, options.startOffsetDays, options.todayIso);
  const competitors: readonly PriorityCompetitor[] = options.keys
    ? options.keys.map((k) => getPriorityCompetitor(k)).filter((c): c is PriorityCompetitor => c !== null)
    : PRIORITY_COMPETITORS;

  const targets: RecrawlTarget[] = [];
  const skipped: string[] = [];
  for (const competitor of competitors) {
    const sources = verifiedSourcesFor(competitor.canonical_property_name);
    if (sources.length === 0) { skipped.push(competitor.canonical_property_key); continue; }
    for (const checkin of dates) {
      for (const src of sources) {
        targets.push({
          priority: competitor.priority_level,
          reason: "priority_competitor_90d_horizon",
          target_type: "competitor",
          canonical_property_key: competitor.canonical_property_key,
          canonical_property_name: competitor.canonical_property_name,
          property_aliases: competitor.aliases,
          display_name: competitor.display_name,
          source: src.source,
          property_slug: src.property_slug,
          checkin
        });
      }
    }
  }
  return { targets, skipped_no_verified_source: skipped };
}

export function buildOwnPropertyTargets(options: BuildTargetsOptions = {}): TargetGenerationResult {
  const dates = buildJstDateRange(options.horizonDays, options.startOffsetDays, options.todayIso);
  const properties: readonly OwnPropertyTarget[] = options.keys
    ? options.keys.map((k) => getOwnPropertyTarget(k)).filter((p): p is OwnPropertyTarget => p !== null)
    : OWN_PROPERTY_TARGETS;

  const targets: RecrawlTarget[] = [];
  const skipped: string[] = [];
  for (const property of properties) {
    const sources = verifiedSourcesFor(property.canonical_property_name);
    if (sources.length === 0) { skipped.push(property.canonical_property_key); continue; }
    for (const checkin of dates) {
      for (const src of sources) {
        targets.push({
          priority: property.priority_level,
          reason: "own_property_90d_price_tracking",
          target_type: "own_property",
          canonical_property_key: property.canonical_property_key,
          canonical_property_name: property.canonical_property_name,
          property_aliases: property.aliases,
          display_name: property.display_name,
          property_group: property.property_group,
          source: src.source,
          property_slug: src.property_slug,
          checkin
        });
      }
    }
  }
  return { targets, skipped_no_verified_source: skipped };
}
