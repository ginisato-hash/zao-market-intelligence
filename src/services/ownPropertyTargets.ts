// Phase ZMI PRICING-CRITICAL01 — own-property target registry (pure).
//
// 三浦屋 (Miuraya) and 喜らく (ZAO SPA HOTEL Kiraku) are self-operated. They are
// ALREADY correctly flagged is_own_property=true throughout biWebDataExport.ts
// (isOwnProperty / OWN_PROPERTIES) and are already visible in the BI unified CSV
// — that pipeline is NOT broken. What is missing is a forced 90-day recrawl
// horizon: own-property targeting today only follows whatever the rotating
// collector already picked up, so near-term coverage decays whenever the
// rotating planner's attention drifts elsewhere.
//
// This module is a THIN, alias-rich wrapper with an explicit canonical_property_key
// surface (miuraya / kiraku) for target generation and coverage reporting. It
// delegates canonical-name matching to the existing biWebDataExport helpers so
// there is exactly one source of truth for "is this an own property" — this file
// never redefines that boundary, only adds a key/alias layer on top of it.
//
// Responsibility split (must not blur):
//   competitor market aggregation -> excludeOwnPropertiesFromCompetitorMarket()
//   own price tracking (this file) -> includeOwnPropertiesForOwnPriceTracking()

import { canonicalizeName, isOwnProperty } from "./biWebDataExport";

export type OwnPropertyGroup = "miuraya" | "kiraku";

export interface OwnPropertyTarget {
  canonical_property_key: string;
  display_name: string;
  canonical_property_name: string;
  aliases: string[];
  property_group: OwnPropertyGroup;
  priority_level: "critical";
}

export const OWN_PROPERTY_TARGETS: readonly OwnPropertyTarget[] = [
  {
    canonical_property_key: "miuraya",
    display_name: "三浦屋 / Miuraya",
    canonical_property_name: "三浦屋",
    aliases: [
      "三浦屋", "Miuraya", "MIURAYA", "miuraya",
      "Guesthouse Miuraya", "ゲストハウス三浦屋", "japanese-hostel-miuraya"
    ],
    property_group: "miuraya",
    priority_level: "critical"
  },
  {
    canonical_property_key: "kiraku",
    display_name: "喜らく / ZAO SPA HOTEL Kiraku",
    canonical_property_name: "ホテル喜らく",
    aliases: [
      "喜らく", "きらく", "旅館きらく", "ホテル喜らく",
      "ZAO SPA HOTEL Kiraku", "Zao Spa Hotel Kiraku", "ZAO SPA HOTEL KIRAKU",
      "Kiraku", "KIRAKU", "Zao Spa Hotel", "xi-raku"
    ],
    property_group: "kiraku",
    priority_level: "critical"
  }
] as const;

function normKey(name: string): string {
  return (name ?? "").trim().normalize("NFKC").toLowerCase().replace(/[\s　・･-]+/gu, "");
}

const ALIAS_INDEX: ReadonlyMap<string, string> = new Map(
  OWN_PROPERTY_TARGETS.flatMap((p) => [
    [normKey(p.canonical_property_key), p.canonical_property_key],
    [normKey(p.canonical_property_name), p.canonical_property_key],
    [normKey(p.display_name), p.canonical_property_key],
    ...p.aliases.map((a): [string, string] => [normKey(a), p.canonical_property_key])
  ])
);

export function getOwnPropertyKey(name: string): string | null {
  const direct = ALIAS_INDEX.get(normKey(name));
  if (direct !== undefined) return direct;
  // Fall back to the canonical BI alias fold (biWebDataExport.canonicalizeName)
  // so any OTA-label variant not explicitly listed here still resolves, as long
  // as it folds to a name isOwnProperty() already recognizes.
  const folded = canonicalizeName(name);
  return ALIAS_INDEX.get(normKey(folded)) ?? null;
}

export function isOwnPropertyName(name: string): boolean {
  return getOwnPropertyKey(name) !== null || isOwnProperty(name);
}

export function normalizeOwnPropertyName(name: string): string | null {
  const key = getOwnPropertyKey(name);
  if (key === null) return null;
  return OWN_PROPERTY_TARGETS.find((p) => p.canonical_property_key === key)?.canonical_property_name ?? null;
}

export function getOwnPropertyTarget(key: string): OwnPropertyTarget | null {
  return OWN_PROPERTY_TARGETS.find((p) => p.canonical_property_key === key) ?? null;
}

// Responsibility-split markers (§6.2). These are intentionally trivial — the
// separation is enforced by WHICH function callers use, not by extra logic:
//   competitor aggregation code must call excludeOwnPropertiesFromCompetitorMarket
//   own price tracking code must call includeOwnPropertiesForOwnPriceTracking
export function excludeOwnPropertiesFromCompetitorMarket<T extends { canonical_property_name: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => !isOwnPropertyName(r.canonical_property_name));
}

export function includeOwnPropertiesForOwnPriceTracking<T extends { canonical_property_name: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => isOwnPropertyName(r.canonical_property_name));
}
