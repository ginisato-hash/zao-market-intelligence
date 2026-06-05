// Phase AUTO05X — AI Context Pack Generator from the DB mirror.
//
// Pure, read-only transformation layer. Given rows already read from the DB
// mirror (market_signal_history) plus a sync-run count, it derives compact,
// AI-facing JSON context packs. This module MUTATES NOTHING: no DB access, no
// DB writes, no collector run, no external fetch, no .data/history or property
// master modification, no PMS/Beds24/AirHost output, no price update, and no
// Booking base × 1.1 logic. The context packs are DERIVED summaries, never the
// source of truth (which remains the .data/history monthly shards).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AiContextPacksDecision =
  | "ai_context_packs_ready"
  | "ai_context_packs_basis_caution"
  | "ai_context_packs_not_ready";

export type DemandSignalLevel = "strong" | "directional" | "weak" | "insufficient";
export type ConfidenceLevel = "high" | "medium" | "low" | "insufficient";

// Subset of market_signal_history columns consumed here.
export interface MirrorRow {
  row_id: string;
  source: string;
  canonical_property_name: string;
  source_property_id: string;
  source_url: string;
  checkin_date: string;
  checkout_date: string;
  stay_scope: string;
  availability_status: string;
  sold_out_flag: number; // 0 | 1
  normalized_total_jpy: number | null;
  price_basis: string;
  basis_confidence: string; // A | B | C | insufficient
  dp_usage: string; // direct | directional | excluded
  classification: string;
  exclusion_reason: string;
  collected_at_jst: string;
}

export interface SnapshotContext {
  generatedAtJst: string;
  syncRunCount: number;
}

// ---------------------------------------------------------------------------
// Small aggregation helpers
// ---------------------------------------------------------------------------

export function median(values: number[]): number | null {
  const nums = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? Math.round((nums[mid - 1]! + nums[mid]!) / 2) : nums[mid]!;
}

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function distinct<T>(items: T[], key: (item: T) => string): number {
  return new Set(items.map(key)).size;
}

// Rows usable for a price median: direct/directional dp_usage with a price.
function priceableRows(rows: MirrorRow[]): MirrorRow[] {
  return rows.filter(
    (r) => (r.dp_usage === "direct" || r.dp_usage === "directional") && r.normalized_total_jpy !== null
  );
}

function priceMedian(rows: MirrorRow[]): number | null {
  return median(priceableRows(rows).map((r) => r.normalized_total_jpy as number));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// 7.1 latest_market_snapshot.json
// ---------------------------------------------------------------------------

export interface DatePressure {
  checkin_date: string;
  sold_out_ratio: number;
  sold_out_count: number;
  row_count: number;
}

export interface DatePrice {
  checkin_date: string;
  median_total_jpy: number;
  price_row_count: number;
}

export interface MarketSnapshot {
  generated_at_jst: string;
  source: "db_mirror";
  market_signal_history_row_count: number;
  sync_run_count: number;
  date_range: { min: string | null; max: string | null };
  source_counts: Record<string, number>;
  dp_usage_counts: Record<string, number>;
  basis_confidence_counts: Record<string, number>;
  availability_counts: Record<string, number>;
  property_count: number;
  direct_row_count: number;
  directional_row_count: number;
  excluded_row_count: number;
  sold_out_row_count: number;
  available_row_count: number;
  top_sold_out_pressure_dates: DatePressure[];
  top_price_pressure_dates: DatePrice[];
  data_quality_summary: string;
  recommended_use: string[];
  do_not_use_for: string[];
}

function groupByCheckin(rows: MirrorRow[]): Map<string, MirrorRow[]> {
  const map = new Map<string, MirrorRow[]>();
  for (const r of rows) {
    const list = map.get(r.checkin_date) ?? [];
    list.push(r);
    map.set(r.checkin_date, list);
  }
  return map;
}

export function buildMarketSnapshot(rows: MirrorRow[], ctx: SnapshotContext): MarketSnapshot {
  const dates = rows.map((r) => r.checkin_date).filter((d) => d !== "").sort();
  const byDate = groupByCheckin(rows);

  const pressures: DatePressure[] = [];
  const prices: DatePrice[] = [];
  for (const [checkin, group] of byDate) {
    if (checkin === "") continue;
    const soldOut = group.filter((r) => r.sold_out_flag === 1).length;
    const available = group.filter((r) => r.availability_status === "available").length;
    const denom = soldOut + available;
    pressures.push({
      checkin_date: checkin,
      sold_out_ratio: denom > 0 ? round2(soldOut / denom) : 0,
      sold_out_count: soldOut,
      row_count: group.length
    });
    const m = priceMedian(group);
    if (m !== null) prices.push({ checkin_date: checkin, median_total_jpy: m, price_row_count: priceableRows(group).length });
  }
  pressures.sort((a, b) => b.sold_out_ratio - a.sold_out_ratio || b.sold_out_count - a.sold_out_count);
  prices.sort((a, b) => b.median_total_jpy - a.median_total_jpy);

  const directional = rows.filter((r) => r.dp_usage === "directional").length;
  const direct = rows.filter((r) => r.dp_usage === "direct").length;
  const bConf = rows.filter((r) => r.basis_confidence === "B").length;

  return {
    generated_at_jst: ctx.generatedAtJst,
    source: "db_mirror",
    market_signal_history_row_count: rows.length,
    sync_run_count: ctx.syncRunCount,
    date_range: { min: dates[0] ?? null, max: dates[dates.length - 1] ?? null },
    source_counts: countBy(rows, (r) => r.source),
    dp_usage_counts: countBy(rows, (r) => r.dp_usage),
    basis_confidence_counts: countBy(rows, (r) => r.basis_confidence),
    availability_counts: countBy(rows, (r) => r.availability_status),
    property_count: distinct(rows, (r) => r.canonical_property_name),
    direct_row_count: direct,
    directional_row_count: directional,
    excluded_row_count: rows.filter((r) => r.dp_usage === "excluded").length,
    sold_out_row_count: rows.filter((r) => r.sold_out_flag === 1).length,
    available_row_count: rows.filter((r) => r.availability_status === "available").length,
    top_sold_out_pressure_dates: pressures.slice(0, 5),
    top_price_pressure_dates: prices.slice(0, 5),
    data_quality_summary:
      `Thin DB mirror: ${rows.length} rows across ${distinct(rows, (r) => r.checkin_date)} check-in dates. ` +
      `Coverage is dominated by directional B-confidence rows (directional=${directional}, direct=${direct}, B=${bConf}). ` +
      `Treat as directional market intelligence, not automated-pricing-grade truth.`,
    recommended_use: [
      "Understand directional market demand and sold-out pressure tendencies.",
      "Brief a human before pricing decisions.",
      "Pair with latest_caveats_and_guardrails.json before acting."
    ],
    do_not_use_for: [
      "Automated price updates without human approval.",
      "Treating OTA sold-out as guaranteed occupancy.",
      "Booking synthetic base × 1.1 pricing."
    ]
  };
}

// ---------------------------------------------------------------------------
// 7.2 latest_demand_context.json
// ---------------------------------------------------------------------------

export interface DemandContextRow {
  checkin_date: string;
  stay_scope: string;
  source_count: number;
  property_count: number;
  available_count: number;
  sold_out_count: number;
  sold_out_ratio: number;
  direct_price_row_count: number;
  directional_price_row_count: number;
  median_total_jpy: number | null;
  basis_confidence_summary: Record<string, number>;
  dp_usage_summary: Record<string, number>;
  demand_signal_level: DemandSignalLevel;
  confidence_level: ConfidenceLevel;
  human_readable_note: string;
}

export function demandSignalLevel(input: {
  usableRowCount: number;
  excludedRowCount: number;
  soldOutRatio: number;
  sourceCount: number;
  propertyCount: number;
  directRowCount: number;
}): DemandSignalLevel {
  if (input.usableRowCount === 0) return "insufficient";
  const coverage = input.sourceCount >= 2 || input.propertyCount >= 3;
  const strongPressure = input.soldOutRatio >= 0.6;
  // Conservative: only call it strong with both real pressure AND breadth.
  if (strongPressure && coverage && (input.directRowCount > 0 || input.usableRowCount >= 3)) return "strong";
  if (input.usableRowCount < 2 || input.excludedRowCount >= input.usableRowCount) return "weak";
  // Default conservative read for B-confidence-dominated coverage.
  return "directional";
}

export function confidenceLevelFor(input: {
  usableRowCount: number;
  directRowCount: number;
  sourceCount: number;
}): ConfidenceLevel {
  if (input.usableRowCount === 0) return "insufficient";
  if (input.directRowCount > 0 && input.sourceCount >= 2) return "high";
  if (input.directRowCount > 0 || (input.usableRowCount >= 3 && input.sourceCount >= 2)) return "medium";
  return "low";
}

export function buildDemandContext(rows: MirrorRow[]): DemandContextRow[] {
  const byDate = groupByCheckin(rows);
  const out: DemandContextRow[] = [];
  for (const [checkin, group] of byDate) {
    if (checkin === "") continue;
    const soldOut = group.filter((r) => r.sold_out_flag === 1).length;
    const available = group.filter((r) => r.availability_status === "available").length;
    const denom = soldOut + available;
    const soldOutRatio = denom > 0 ? round2(soldOut / denom) : 0;
    const directPriced = priceableRows(group).filter((r) => r.dp_usage === "direct").length;
    const directionalPriced = priceableRows(group).filter((r) => r.dp_usage === "directional").length;
    const usable = directPriced + directionalPriced;
    const excluded = group.filter((r) => r.dp_usage === "excluded").length;
    const sourceCount = distinct(group, (r) => r.source);
    const propertyCount = distinct(group, (r) => r.canonical_property_name);
    const directRows = group.filter((r) => r.dp_usage === "direct").length;
    const signal = demandSignalLevel({
      usableRowCount: usable,
      excludedRowCount: excluded,
      soldOutRatio,
      sourceCount,
      propertyCount,
      directRowCount: directRows
    });
    const confidence = confidenceLevelFor({ usableRowCount: usable, directRowCount: directRows, sourceCount });
    const median_total_jpy = priceMedian(group);
    out.push({
      checkin_date: checkin,
      stay_scope: group[0]!.stay_scope,
      source_count: sourceCount,
      property_count: propertyCount,
      available_count: available,
      sold_out_count: soldOut,
      sold_out_ratio: soldOutRatio,
      direct_price_row_count: directPriced,
      directional_price_row_count: directionalPriced,
      median_total_jpy,
      basis_confidence_summary: countBy(group, (r) => r.basis_confidence),
      dp_usage_summary: countBy(group, (r) => r.dp_usage),
      demand_signal_level: signal,
      confidence_level: confidence,
      human_readable_note: demandNote({ checkin, signal, confidence, soldOut, available, propertyCount, sourceCount, usable, median_total_jpy })
    });
  }
  out.sort((a, b) => a.checkin_date.localeCompare(b.checkin_date));
  return out;
}

function demandNote(input: {
  checkin: string;
  signal: DemandSignalLevel;
  confidence: ConfidenceLevel;
  soldOut: number;
  available: number;
  propertyCount: number;
  sourceCount: number;
  usable: number;
  median_total_jpy: number | null;
}): string {
  if (input.signal === "insufficient") {
    return `${input.checkin}: insufficient usable price/demand signal; do not infer demand.`;
  }
  const base =
    `${input.checkin}: ${input.signal} demand signal (confidence ${input.confidence}); ` +
    `sold_out=${input.soldOut}, available=${input.available}, properties=${input.propertyCount}, sources=${input.sourceCount}.`;
  const caution =
    input.confidence === "low" || input.confidence === "insufficient"
      ? " Directional only (mostly B-confidence); not automated-pricing safe."
      : "";
  const thinCaution =
    input.soldOut > input.available && input.propertyCount < 3
      ? " High sold-out share but thin property coverage — interpret with caution."
      : "";
  return base + caution + thinCaution;
}

// ---------------------------------------------------------------------------
// 7.3 latest_property_signal_context.json
// ---------------------------------------------------------------------------

export interface PropertySignalRow {
  canonical_property_name: string;
  source: string;
  source_property_id: string;
  latest_collected_at_jst: string;
  date_count: number;
  available_count: number;
  sold_out_count: number;
  price_row_count: number;
  median_total_jpy: number | null;
  basis_confidence_summary: Record<string, number>;
  dp_usage_summary: Record<string, number>;
  recommended_ai_use: string;
  caution: string;
}

export function buildPropertySignalContext(rows: MirrorRow[]): PropertySignalRow[] {
  const groups = new Map<string, MirrorRow[]>();
  for (const r of rows) {
    const key = `${r.canonical_property_name} ${r.source}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: PropertySignalRow[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const priced = priceableRows(group);
    const directRows = group.filter((r) => r.dp_usage === "direct").length;
    const latest = group.map((r) => r.collected_at_jst).filter((v) => v !== "").sort().pop() ?? "";
    const idCounts = countBy(group.filter((r) => r.source_property_id !== ""), (r) => r.source_property_id);
    const sourcePropertyId = Object.entries(idCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    out.push({
      canonical_property_name: first.canonical_property_name,
      source: first.source,
      source_property_id: sourcePropertyId,
      latest_collected_at_jst: latest,
      date_count: distinct(group, (r) => r.checkin_date),
      available_count: group.filter((r) => r.availability_status === "available").length,
      sold_out_count: group.filter((r) => r.sold_out_flag === 1).length,
      price_row_count: priced.length,
      median_total_jpy: priceMedian(group),
      basis_confidence_summary: countBy(group, (r) => r.basis_confidence),
      dp_usage_summary: countBy(group, (r) => r.dp_usage),
      recommended_ai_use:
        directRows > 0
          ? "Direct-capable signal present (A-confidence); usable as a stronger directional reference."
          : "Directional reference only; brief a human before pricing.",
      caution:
        first.source === "rakuten"
          ? "Rakuten totals are computed from per-person CHARGE_PER_HUMAN; not raw room totals."
          : first.source === "booking"
            ? "Booking uses official visible base + visible tax/fee adder; never synthetic base × 1.1."
            : "Jalan is strongest/direct-capable only when basis_confidence is A."
    });
  }
  out.sort(
    (a, b) =>
      a.canonical_property_name.localeCompare(b.canonical_property_name) || a.source.localeCompare(b.source)
  );
  return out;
}

// ---------------------------------------------------------------------------
// 7.4 latest_caveats_and_guardrails.json
// ---------------------------------------------------------------------------

export interface CaveatsPack {
  generated_at_jst: string;
  purpose: string;
  caveats: string[];
  guardrails: string[];
}

export function buildCaveats(generatedAtJst: string): CaveatsPack {
  return {
    generated_at_jst: generatedAtJst,
    purpose: "Prevent AI misuse of the derived market-intelligence context packs.",
    caveats: [
      "B-confidence rows are directional only and are NOT automated-pricing safe.",
      "C-confidence and insufficient-confidence rows are excluded or weak; do not use them for price medians.",
      "OTA stock/availability is not actual occupancy.",
      "Sold-out pressure is a market signal, not guaranteed demand.",
      "Booking.com uses the official visible base price plus the visible tax/fee adder; do not use a synthetic base × 1.1.",
      "Rakuten CHARGE_PER_HUMAN raw price is per-person; the 2-adult total is computed, not raw.",
      "Jalan is the strongest/direct-capable source when basis_confidence is A."
    ],
    guardrails: [
      "Do not update PMS/OTA/Beds24/AirHost without explicit approval.",
      "Do not modify the property master, .data/history, or workflows without explicit approval.",
      "DP03X and R01X are paused unless the user explicitly asks."
    ]
  };
}

// ---------------------------------------------------------------------------
// 7.5 latest_ai_task_entrypoint.json
// ---------------------------------------------------------------------------

export interface AiTaskEntrypoint {
  generated_at_jst: string;
  read_order: string[];
  task_routes: Record<string, string[]>;
  safe_commands: string[];
  forbidden_without_approval: string[];
  recommended_next_phases: string[];
}

export const CONTEXT_PACK_FILES = {
  marketSnapshot: ".data/ai-context/latest_market_snapshot.json",
  demandContext: ".data/ai-context/latest_demand_context.json",
  propertySignalContext: ".data/ai-context/latest_property_signal_context.json",
  caveats: ".data/ai-context/latest_caveats_and_guardrails.json",
  aiTaskEntrypoint: ".data/ai-context/latest_ai_task_entrypoint.json"
} as const;

const MANIFEST_PATH = ".data/reports/market-update/ai_readable_market_manifest_latest.json";
const DICTIONARY_PATH = ".data/reports/market-update/market_data_dictionary_latest.json";

export function buildAiTaskEntrypoint(generatedAtJst: string): AiTaskEntrypoint {
  return {
    generated_at_jst: generatedAtJst,
    read_order: [
      CONTEXT_PACK_FILES.aiTaskEntrypoint,
      CONTEXT_PACK_FILES.caveats,
      CONTEXT_PACK_FILES.marketSnapshot,
      CONTEXT_PACK_FILES.demandContext,
      CONTEXT_PACK_FILES.propertySignalContext,
      MANIFEST_PATH,
      DICTIONARY_PATH
    ],
    task_routes: {
      market_report: [CONTEXT_PACK_FILES.marketSnapshot, CONTEXT_PACK_FILES.demandContext],
      pricing_support: [CONTEXT_PACK_FILES.marketSnapshot, CONTEXT_PACK_FILES.demandContext, CONTEXT_PACK_FILES.caveats],
      property_data_quality: [CONTEXT_PACK_FILES.propertySignalContext, MANIFEST_PATH, DICTIONARY_PATH],
      bootstrap: [MANIFEST_PATH, DICTIONARY_PATH, CONTEXT_PACK_FILES.caveats]
    },
    safe_commands: [
      "npm run db:verify",
      "npm run check:no-paid-sources",
      "npm run build:ai-context-packs"
    ],
    forbidden_without_approval: [
      "DB writes",
      "live collector runs / external fetch",
      "property master / .data/history modification",
      "PMS/OTA/Beds24/AirHost output",
      "GitHub Actions / GitOps / cron activation",
      "git commit / git push",
      "paid sources (SerpAPI/DataForSEO/Apify/Bright Data/Oxylabs/paid proxy)",
      "Booking base × 1.1 pricing",
      "starting DP03X or R01X"
    ],
    recommended_next_phases: ["AUTO06X — Task-specific AI query recipes / CLI"]
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideAiContextPacks(input: {
  historyRowCount: number;
  syncRunCount: number;
  directRowCount: number;
  directionalRowCount: number;
  excludedRowCount: number;
  bConfidenceCount: number;
  distinctSourceCount: number;
  propertyCount: number;
}): AiContextPacksDecision {
  if (input.historyRowCount === 0 || input.syncRunCount === 0) return "ai_context_packs_not_ready";
  const directionalHeavy = input.directionalRowCount > input.directRowCount * 3;
  const bHeavy = input.bConfidenceCount > input.historyRowCount / 2;
  const thinCoverage = input.distinctSourceCount < 3 || input.propertyCount < 3;
  if (directionalHeavy || bHeavy || thinCoverage) return "ai_context_packs_basis_caution";
  return "ai_context_packs_ready";
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export interface ContextPackReport {
  run_id: string;
  generated_at_jst: string;
  decision: AiContextPacksDecision;
  db_mirror_summary: {
    market_signal_history_row_count: number;
    market_signal_sync_runs_count: number;
    source_counts: Record<string, number>;
    dp_usage_counts: Record<string, number>;
    basis_confidence_counts: Record<string, number>;
  };
  context_pack_paths: string[];
  market_snapshot_summary: MarketSnapshot;
  demand_context_summary: { row_count: number; signal_level_counts: Record<string, number> };
  property_signal_context_summary: { row_count: number };
  caveats_summary: { caveat_count: number; guardrail_count: number };
  ai_task_entrypoint_summary: { task_route_count: number };
  safety_confirmation: Record<string, boolean>;
  report_path: string;
  json_path: string;
  csv_path: string;
  debug_artifact_path: string;
  next_phase: string;
}

export function renderDemandContextCsv(rows: DemandContextRow[]): string {
  const headers = [
    "checkin_date",
    "stay_scope",
    "source_count",
    "property_count",
    "available_count",
    "sold_out_count",
    "sold_out_ratio",
    "direct_price_row_count",
    "directional_price_row_count",
    "median_total_jpy",
    "demand_signal_level",
    "confidence_level"
  ];
  const body = rows.map((r) =>
    [
      r.checkin_date,
      r.stay_scope,
      String(r.source_count),
      String(r.property_count),
      String(r.available_count),
      String(r.sold_out_count),
      String(r.sold_out_ratio),
      String(r.direct_price_row_count),
      String(r.directional_price_row_count),
      r.median_total_jpy === null ? "" : String(r.median_total_jpy),
      r.demand_signal_level,
      r.confidence_level
    ]
      .map(csvEscape)
      .join(",")
  );
  return `${headers.join(",")}\n${body.join("\n")}\n`;
}

export function renderContextPackReport(report: ContextPackReport, caveats: CaveatsPack, entrypoint: AiTaskEntrypoint): string {
  const snap = report.market_snapshot_summary;
  return [
    "# AI Context Packs from DB Mirror",
    "",
    `Generated at: ${report.generated_at_jst}`,
    `Decision: ${report.decision}`,
    "",
    "## 1. Executive Summary",
    "",
    `- decision=${report.decision}`,
    `- market_signal_history_row_count=${report.db_mirror_summary.market_signal_history_row_count}`,
    `- market_signal_sync_runs_count=${report.db_mirror_summary.market_signal_sync_runs_count}`,
    "- Derived AI context packs were generated from the DB mirror (read-only). Packs are summaries, not the source of truth.",
    "",
    "## 2. DB Mirror Source",
    "",
    `- source_counts=${JSON.stringify(report.db_mirror_summary.source_counts)}`,
    `- dp_usage_counts=${JSON.stringify(report.db_mirror_summary.dp_usage_counts)}`,
    `- basis_confidence_counts=${JSON.stringify(report.db_mirror_summary.basis_confidence_counts)}`,
    "",
    "## 3. Generated Context Packs",
    "",
    ...report.context_pack_paths.map((p) => `- ${p}`),
    "",
    "## 4. Market Snapshot Summary",
    "",
    `- date_range=${snap.date_range.min} → ${snap.date_range.max}`,
    `- property_count=${snap.property_count}`,
    `- direct/directional/excluded=${snap.direct_row_count}/${snap.directional_row_count}/${snap.excluded_row_count}`,
    `- sold_out/available rows=${snap.sold_out_row_count}/${snap.available_row_count}`,
    `- data_quality_summary=${snap.data_quality_summary}`,
    "",
    "## 5. Demand Context Summary",
    "",
    `- demand_context_row_count=${report.demand_context_summary.row_count}`,
    `- signal_level_counts=${JSON.stringify(report.demand_context_summary.signal_level_counts)}`,
    "",
    "## 6. Property Signal Context Summary",
    "",
    `- property_signal_row_count=${report.property_signal_context_summary.row_count}`,
    "",
    "## 7. Caveats and Guardrails",
    "",
    ...caveats.caveats.map((c) => `- ${c}`),
    ...caveats.guardrails.map((g) => `- ${g}`),
    "",
    "## 8. AI Task Entrypoint",
    "",
    `- read_order=${JSON.stringify(entrypoint.read_order)}`,
    `- task_routes=${Object.keys(entrypoint.task_routes).join(", ")}`,
    "",
    "## 9. Safety Validation",
    "",
    ...Object.entries(report.safety_confirmation).map(([k, v]) => `- ${k}=${v}`),
    "",
    "## 10. Next Phase",
    "",
    `- ${report.next_phase}`,
    ""
  ].join("\n");
}

export function signalLevelCounts(rows: DemandContextRow[]): Record<string, number> {
  return countBy(rows, (r) => r.demand_signal_level);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/gu, "\"\"")}"`;
  return value;
}
