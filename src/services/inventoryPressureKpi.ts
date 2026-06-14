// Phase ZMI Inventory KPI — inventory-first market KPI (pure).
//
// 喜らく / 三浦屋 run room-only (素泊まり), so the dominant market signal is
// competitor INVENTORY pressure, not price. This module aggregates canonical
// history rows into per-checkin availability, computes area inventory pressure
// and room-only-competitor inventory pressure (HAMMOND / ONSEN & STAY OAKHILL /
// 吉田屋), classifies a pressure level, and emits inventory-first recommended
// actions for 喜らく and 三浦屋. Pure: no I/O, no network.

export type AvailabilityBucket = "available" | "sold_out" | "not_found" | "excluded";

// Room-only key competitors. canonical_property_name must match history exactly.
export const ROOM_ONLY_COMPETITORS = ["HAMMOND", "ONSEN & STAY OAKHILL", "吉田屋"] as const;
export type RoomOnlyCompetitor = (typeof ROOM_ONLY_COMPETITORS)[number];

// Short labels for table headers.
export const COMPETITOR_LABELS: Record<RoomOnlyCompetitor, string> = {
  "HAMMOND": "HAMMOND",
  "ONSEN & STAY OAKHILL": "OAKHILL",
  "吉田屋": "吉田屋"
};

export type InventoryPressureLevel =
  | "strong_inventory_pressure"
  | "medium_inventory_pressure"
  | "weak_inventory_pressure";

// A competitor's collapsed status for one checkin across all its source rows.
export type CompetitorStatus = "available" | "sold_out" | "no_data";

export interface InventoryHistoryRow {
  source: string;
  canonical_property_name: string;
  checkin: string;
  availability_status: string;
  collected_at_jst: string;
  normalized_total_price: number | null;
  is_price_usable_for_dp_directional: boolean;
}

/** Map a raw availability_status to an inventory bucket. */
export function classifyAvailability(status: string): AvailabilityBucket {
  const s = status.trim().toLowerCase();
  if (s === "available" || s === "available_price_basis") return "available";
  if (s === "sold_out") return "sold_out";
  if (s === "not_found") return "not_found";
  // failed / unavailable_or_unknown / blank → excluded from the inventory denominator.
  return "excluded";
}

/**
 * Keep only the latest observation per (source, canonical_property_name, checkin)
 * so accumulated daily snapshots do not double-count. Latest = max collected_at_jst.
 */
export function latestObservations(rows: readonly InventoryHistoryRow[]): InventoryHistoryRow[] {
  const latest = new Map<string, InventoryHistoryRow>();
  for (const r of rows) {
    const key = `${r.source}|${r.canonical_property_name}|${r.checkin}`;
    const prev = latest.get(key);
    if (prev === undefined || r.collected_at_jst > prev.collected_at_jst) latest.set(key, r);
  }
  return [...latest.values()];
}

/** Collapse a competitor's per-checkin source rows: available wins, else sold_out, else no_data. */
export function competitorStatus(rows: readonly InventoryHistoryRow[]): CompetitorStatus {
  let sawSoldOut = false;
  for (const r of rows) {
    const b = classifyAvailability(r.availability_status);
    if (b === "available") return "available";
    if (b === "sold_out") sawSoldOut = true;
  }
  return sawSoldOut ? "sold_out" : "no_data";
}

export interface DateInventoryRow {
  checkin: string;
  area_available_count: number;
  area_sold_out_count: number;
  area_not_found_count: number;
  area_excluded_count: number;
  area_sold_out_rate: number; // sold_out / (available + sold_out); 0 when denominator 0
  room_only_comp_available_count: number;
  room_only_comp_sold_out_count: number;
  competitor_status: Record<RoomOnlyCompetitor, CompetitorStatus>;
  inventory_pressure_level: InventoryPressureLevel;
  recommended_action_for_kiraku: string;
  recommended_action_for_miuraya: string;
}

function rate(soldOut: number, available: number): number {
  const denom = soldOut + available;
  return denom === 0 ? 0 : Number((soldOut / denom).toFixed(4));
}

/**
 * Judgment (work-order thresholds):
 *  strong: area sold_out rate >= 0.40  OR  >= 2 of the 3 comps sold_out
 *  medium: area sold_out rate in [0.20, 0.40)  OR  exactly 1 comp sold_out
 *  weak:   area sold_out rate < 0.20  AND  all 3 comps available
 * A comp with no_data does not count as sold_out, but also breaks the
 * "all available" weak condition; with no comp sold_out and not-all-available
 * the level falls back to the area-rate band.
 */
export function judgeInventoryPressure(input: {
  areaSoldOutRate: number;
  competitorStatuses: readonly CompetitorStatus[];
}): InventoryPressureLevel {
  const soldOutComps = input.competitorStatuses.filter((s) => s === "sold_out").length;
  const allAvailable = input.competitorStatuses.length > 0 && input.competitorStatuses.every((s) => s === "available");

  if (input.areaSoldOutRate >= 0.4 || soldOutComps >= 2) return "strong_inventory_pressure";
  if ((input.areaSoldOutRate >= 0.2 && input.areaSoldOutRate < 0.4) || soldOutComps === 1) return "medium_inventory_pressure";
  if (input.areaSoldOutRate < 0.2 && allAvailable) return "weak_inventory_pressure";
  // area rate < 0.20 but comps not all available (no_data present) and none sold_out.
  return "weak_inventory_pressure";
}

const KIRAKU_ACTION: Record<InventoryPressureLevel, string> = {
  strong_inventory_pressure: "hold_or_raise: area inventory tight; room-only overflow demand — keep rate firm, raise on peak dates",
  medium_inventory_pressure: "hold: mixed sell-through; keep rate, watch comp inventory before moving",
  weak_inventory_pressure: "competitive_or_discount: soft area inventory; price competitively to win occupancy"
};

const MIURAYA_ACTION: Record<InventoryPressureLevel, string> = {
  strong_inventory_pressure: "raise_or_hold: capture spillover; lift the floor while area is sold-out heavy",
  medium_inventory_pressure: "hold: steady; no aggressive discount while demand is mixed",
  weak_inventory_pressure: "discount_to_fill: soft area; prioritize occupancy with a lower floor"
};

export function buildDateInventoryRow(checkin: string, rows: readonly InventoryHistoryRow[]): DateInventoryRow {
  let available = 0;
  let soldOut = 0;
  let notFound = 0;
  let excluded = 0;
  for (const r of rows) {
    const b = classifyAvailability(r.availability_status);
    if (b === "available") available += 1;
    else if (b === "sold_out") soldOut += 1;
    else if (b === "not_found") notFound += 1;
    else excluded += 1;
  }
  const competitor_status = {} as Record<RoomOnlyCompetitor, CompetitorStatus>;
  for (const comp of ROOM_ONLY_COMPETITORS) {
    competitor_status[comp] = competitorStatus(rows.filter((r) => r.canonical_property_name === comp));
  }
  const compStatuses = ROOM_ONLY_COMPETITORS.map((c) => competitor_status[c]);
  const compAvailable = compStatuses.filter((s) => s === "available").length;
  const compSoldOut = compStatuses.filter((s) => s === "sold_out").length;
  const areaSoldOutRate = rate(soldOut, available);
  const level = judgeInventoryPressure({ areaSoldOutRate, competitorStatuses: compStatuses });
  return {
    checkin,
    area_available_count: available,
    area_sold_out_count: soldOut,
    area_not_found_count: notFound,
    area_excluded_count: excluded,
    area_sold_out_rate: areaSoldOutRate,
    room_only_comp_available_count: compAvailable,
    room_only_comp_sold_out_count: compSoldOut,
    competitor_status,
    inventory_pressure_level: level,
    recommended_action_for_kiraku: KIRAKU_ACTION[level],
    recommended_action_for_miuraya: MIURAYA_ACTION[level]
  };
}

export interface InventoryKpiSummary {
  generated_at_jst: string;
  distinct_checkins: number;
  area_available_total: number;
  area_sold_out_total: number;
  area_sold_out_rate_overall: number;
  room_only_comp_observations: number;
  room_only_comp_sold_out_observations: number;
  room_only_comp_inventory_pressure: number; // sold_out / (available + sold_out) over comp observations
  level_counts: Record<InventoryPressureLevel, number>;
  overall_inventory_pressure_level: InventoryPressureLevel;
}

export interface InventoryKpiReport {
  summary: InventoryKpiSummary;
  rows: DateInventoryRow[];
}

export function buildInventoryKpiReport(input: {
  rows: readonly InventoryHistoryRow[];
  generatedAtJst: string;
}): InventoryKpiReport {
  const latest = latestObservations(input.rows);
  const byCheckin = new Map<string, InventoryHistoryRow[]>();
  for (const r of latest) {
    const list = byCheckin.get(r.checkin) ?? [];
    list.push(r);
    byCheckin.set(r.checkin, list);
  }
  const rows = [...byCheckin.keys()].sort().map((ck) => buildDateInventoryRow(ck, byCheckin.get(ck)!));

  let availTotal = 0;
  let soldTotal = 0;
  let compObs = 0;
  let compSold = 0;
  const levelCounts: Record<InventoryPressureLevel, number> = {
    strong_inventory_pressure: 0,
    medium_inventory_pressure: 0,
    weak_inventory_pressure: 0
  };
  for (const r of rows) {
    availTotal += r.area_available_count;
    soldTotal += r.area_sold_out_count;
    for (const comp of ROOM_ONLY_COMPETITORS) {
      const s = r.competitor_status[comp];
      if (s === "available") { compObs += 1; }
      else if (s === "sold_out") { compObs += 1; compSold += 1; }
    }
    levelCounts[r.inventory_pressure_level] += 1;
  }
  const areaRateOverall = rate(soldTotal, availTotal);
  const compPressure = compObs === 0 ? 0 : Number((compSold / compObs).toFixed(4));
  const overallLevel = judgeInventoryPressure({
    areaSoldOutRate: areaRateOverall,
    // overall comp judgment uses the count of comps that are sold-out on a
    // majority of observed dates is complex; for the headline we reuse the
    // area-rate band plus whether comp pressure is high (>=0.4 → treat as >=2).
    competitorStatuses: compPressure >= 0.4 ? ["sold_out", "sold_out"] : compPressure > 0 ? ["sold_out"] : []
  });

  return {
    summary: {
      generated_at_jst: input.generatedAtJst,
      distinct_checkins: rows.length,
      area_available_total: availTotal,
      area_sold_out_total: soldTotal,
      area_sold_out_rate_overall: areaRateOverall,
      room_only_comp_observations: compObs,
      room_only_comp_sold_out_observations: compSold,
      room_only_comp_inventory_pressure: compPressure,
      level_counts: levelCounts,
      overall_inventory_pressure_level: overallLevel
    },
    rows
  };
}

// ---------------------------------------------------------------------------
// Secondary price-pressure snapshot (inventory is primary; price is reported
// after it). Median directional price per checkin from usable directional rows.

export interface PricePressureRow {
  checkin: string;
  directional_sample_count: number;
  median_directional_price: number | null;
}

export function buildPricePressureRows(rows: readonly InventoryHistoryRow[]): PricePressureRow[] {
  const latest = latestObservations(rows);
  const byCheckin = new Map<string, number[]>();
  for (const r of latest) {
    if (!r.is_price_usable_for_dp_directional || r.normalized_total_price === null) continue;
    const list = byCheckin.get(r.checkin) ?? [];
    list.push(r.normalized_total_price);
    byCheckin.set(r.checkin, list);
  }
  return [...byCheckin.keys()].sort().map((ck) => {
    const prices = byCheckin.get(ck)!.slice().sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length === 0 ? null : prices.length % 2 === 1 ? prices[mid]! : Math.round((prices[mid - 1]! + prices[mid]!) / 2);
    return { checkin: ck, directional_sample_count: prices.length, median_directional_price: median };
  });
}

// ---------------------------------------------------------------------------
// Rendering. Report ORDER is fixed: inventory first, price after.

function compCell(s: CompetitorStatus): string {
  return s === "available" ? "available" : s === "sold_out" ? "SOLD_OUT" : "—";
}

export const INVENTORY_CSV_HEADERS = [
  "checkin",
  "area_available_count",
  "area_sold_out_count",
  "area_sold_out_rate",
  "room_only_comp_available_count",
  "room_only_comp_sold_out_count",
  "HAMMOND_status",
  "OAKHILL_status",
  "吉田屋_status",
  "inventory_pressure_level",
  "recommended_action_for_kiraku",
  "recommended_action_for_miuraya"
] as const;

function csvCell(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

export function renderInventoryCsv(report: InventoryKpiReport): string {
  const body = report.rows.map((r) =>
    [
      r.checkin,
      String(r.area_available_count),
      String(r.area_sold_out_count),
      r.area_sold_out_rate.toFixed(4),
      String(r.room_only_comp_available_count),
      String(r.room_only_comp_sold_out_count),
      r.competitor_status["HAMMOND"],
      r.competitor_status["ONSEN & STAY OAKHILL"],
      r.competitor_status["吉田屋"],
      r.inventory_pressure_level,
      r.recommended_action_for_kiraku,
      r.recommended_action_for_miuraya
    ].map(csvCell).join(",")
  );
  return [INVENTORY_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderInventoryReport(input: {
  report: InventoryKpiReport;
  pricePressure: readonly PricePressureRow[];
}): string {
  const { summary, rows } = input.report;
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const priceByCheckin = new Map(input.pricePressure.map((p) => [p.checkin, p]));

  const summaryBlock = [
    "# ZMI Market Report — Inventory-First KPI",
    "",
    `Generated at JST: ${summary.generated_at_jst}`,
    "",
    "## 1. Inventory KPI Summary",
    `- distinct_checkins: ${summary.distinct_checkins}`,
    `- area inventory pressure (overall sold_out rate): ${pct(summary.area_sold_out_rate_overall)} (${summary.area_sold_out_total} sold_out / ${summary.area_available_total + summary.area_sold_out_total} bookable)`,
    `- room_only_comp_inventory_pressure (HAMMOND/OAKHILL/吉田屋): ${pct(summary.room_only_comp_inventory_pressure)} (${summary.room_only_comp_sold_out_observations}/${summary.room_only_comp_observations} comp observations sold_out)`,
    `- overall_inventory_pressure_level: ${summary.overall_inventory_pressure_level}`,
    `- by level: strong=${summary.level_counts.strong_inventory_pressure} medium=${summary.level_counts.medium_inventory_pressure} weak=${summary.level_counts.weak_inventory_pressure}`
  ];

  const dateTable = [
    "",
    "## 2. Date-level Inventory Pressure Table",
    "",
    "| checkin | area_avail | area_sold | sold_rate | comp_avail | comp_sold | HAMMOND | OAKHILL | 吉田屋 | pressure | 喜らく action | 三浦屋 action |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${r.checkin} | ${r.area_available_count} | ${r.area_sold_out_count} | ${pct(r.area_sold_out_rate)} | ${r.room_only_comp_available_count} | ${r.room_only_comp_sold_out_count} | ${compCell(r.competitor_status["HAMMOND"])} | ${compCell(r.competitor_status["ONSEN & STAY OAKHILL"])} | ${compCell(r.competitor_status["吉田屋"])} | ${r.inventory_pressure_level.replace("_inventory_pressure", "")} | ${r.recommended_action_for_kiraku.split(":")[0]} | ${r.recommended_action_for_miuraya.split(":")[0]} |`
    )
  ];

  const compSection = [
    "",
    "## 3. Room-only Competitor Inventory (HAMMOND / OAKHILL / 吉田屋)",
    "",
    "| checkin | HAMMOND | OAKHILL | 吉田屋 | comp_sold_out_count |",
    "|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${r.checkin} | ${compCell(r.competitor_status["HAMMOND"])} | ${compCell(r.competitor_status["ONSEN & STAY OAKHILL"])} | ${compCell(r.competitor_status["吉田屋"])} | ${r.room_only_comp_sold_out_count} |`
    )
  ];

  const priceSection = [
    "",
    "## 4. Price Pressure (secondary)",
    "",
    "| checkin | directional_samples | median_directional_price |",
    "|---|---|---|",
    ...rows.map((r) => {
      const p = priceByCheckin.get(r.checkin);
      return `| ${r.checkin} | ${p?.directional_sample_count ?? 0} | ${p?.median_directional_price ?? "—"} |`;
    })
  ];

  const kirakuSection = [
    "",
    "## 5. 喜らく判断 (inventory KPI → price KPI)",
    `- overall inventory pressure: ${summary.overall_inventory_pressure_level}`,
    `- primary action: ${KIRAKU_ACTION[summary.overall_inventory_pressure_level]}`,
    "- decision order: read inventory pressure first; only then adjust within the price band. Room-only (素泊まり) demand tracks area availability, not nightly rate.",
    ...strongDates(rows).map((d) => `  - ${d.checkin}: ${d.inventory_pressure_level.replace("_inventory_pressure", "")} → ${d.recommended_action_for_kiraku.split(":")[0]}`)
  ];

  const miurayaSection = [
    "",
    "## 6. 三浦屋判断 (inventory KPI → price KPI)",
    `- overall inventory pressure: ${summary.overall_inventory_pressure_level}`,
    `- primary action: ${MIURAYA_ACTION[summary.overall_inventory_pressure_level]}`,
    "- decision order: inventory first. 三浦屋 is own-property self-monitor; fill when the area is soft, lift the floor when comps are sold out.",
    ...strongDates(rows).map((d) => `  - ${d.checkin}: ${d.inventory_pressure_level.replace("_inventory_pressure", "")} → ${d.recommended_action_for_miuraya.split(":")[0]}`)
  ];

  return [
    ...summaryBlock,
    ...dateTable,
    ...compSection,
    ...priceSection,
    ...kirakuSection,
    ...miurayaSection,
    "",
    "## Safety",
    "- read-only KPI report from canonical history; no collection, no append, no DB sync, no AI refresh, no pricing/PMS output.",
    ""
  ].join("\n");
}

/** Dates worth calling out: strong, then medium, capped for readability. */
function strongDates(rows: readonly DateInventoryRow[]): DateInventoryRow[] {
  const strong = rows.filter((r) => r.inventory_pressure_level === "strong_inventory_pressure");
  const medium = rows.filter((r) => r.inventory_pressure_level === "medium_inventory_pressure");
  return [...strong, ...medium].slice(0, 12);
}
