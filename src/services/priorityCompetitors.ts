// Phase ZMI PRICING-CRITICAL01 — priority (direct) competitor registry (pure).
//
// HAMMOND / ONSEN & STAY OAKHILL / 吉田屋 are the direct competitors whose price
// moves matter most for 三浦屋・喜らく pricing decisions (they already back the
// existing ROOM_ONLY_COMPS / is_room_only_comp BI flag in biWebDataExport.ts).
// This module gives them an explicit alias-matching registry so a 90-day recrawl
// horizon can be generated regardless of what BI already has on file — the prior
// gap-driven targeting only recrawls dates that ALREADY have a low-confidence
// row, so a date with ZERO rows (e.g. early August for OAKHILL) never surfaces.
// No I/O, no network. Never used to exclude a property from anything — this is
// an INCLUSION list for forced recrawl coverage.

export type PriorityLevel = "critical" | "high";

export interface PriorityCompetitor {
  canonical_property_key: string;
  display_name: string;
  // Canonical BI name as produced by biWebDataExport.canonicalizeName — the
  // join key against history/BI rows for coverage + price-change detection.
  canonical_property_name: string;
  aliases: string[];
  priority_level: PriorityLevel;
}

export const PRIORITY_COMPETITORS: readonly PriorityCompetitor[] = [
  {
    canonical_property_key: "hammond",
    display_name: "HAMMOND / ハモンド",
    canonical_property_name: "HAMMOND",
    aliases: [
      "HAMMOND", "Hammond", "hammond", "ハモンド",
      "ペンションハモンド", "Pension Hammond", "Pension HAMMOND", "hammond-takamiya"
    ],
    priority_level: "critical"
  },
  {
    canonical_property_key: "oakhill",
    display_name: "OAKHILL / オークヒル",
    canonical_property_name: "ONSEN & STAY OAKHILL",
    aliases: [
      "OAKHILL", "Oakhill", "oakhill", "オークヒル",
      "ONSEN & STAY OAKHILL", "onsen & stay oakhill", "蔵王温泉 オークヒル",
      "onsen-amp-stay-oakhill"
    ],
    priority_level: "critical"
  },
  {
    canonical_property_key: "yoshidaya",
    display_name: "吉田屋 / 吉田や",
    canonical_property_name: "吉田屋",
    aliases: [
      "吉田屋", "吉田や", "よしだや", "Yoshidaya", "Yoshida-ya", "Yoshida Ya", "yoshidaya",
      "ji-tian-wu-shan-xing-shi"
    ],
    priority_level: "critical"
  }
] as const;

function normKey(name: string): string {
  return (name ?? "").trim().normalize("NFKC").toLowerCase().replace(/[\s　・･-]+/gu, "");
}

const ALIAS_INDEX: ReadonlyMap<string, string> = new Map(
  PRIORITY_COMPETITORS.flatMap((c) => [
    [normKey(c.canonical_property_key), c.canonical_property_key],
    [normKey(c.canonical_property_name), c.canonical_property_key],
    [normKey(c.display_name), c.canonical_property_key],
    ...c.aliases.map((a): [string, string] => [normKey(a), c.canonical_property_key])
  ])
);

export function getPriorityCompetitorKey(name: string): string | null {
  return ALIAS_INDEX.get(normKey(name)) ?? null;
}

export function isPriorityCompetitorName(name: string): boolean {
  return getPriorityCompetitorKey(name) !== null;
}

export function normalizePriorityCompetitorName(name: string): string | null {
  const key = getPriorityCompetitorKey(name);
  if (key === null) return null;
  return PRIORITY_COMPETITORS.find((c) => c.canonical_property_key === key)?.canonical_property_name ?? null;
}

export function getPriorityCompetitor(key: string): PriorityCompetitor | null {
  return PRIORITY_COMPETITORS.find((c) => c.canonical_property_key === key) ?? null;
}
