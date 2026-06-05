// Phase AUTO06X — task-specific AI query recipes (pure, read-only).
//
// Given context already loaded from the read-only context packs and DB mirror,
// these recipes answer: "for this user task type, which data should AI read, how
// should it be filtered, and what output structure should it produce?". This
// module MUTATES NOTHING: no DB access, no fs writes, no live fetch, no PMS/OTA
// output, no price update, no Booking base × 1.1. Every recipe is a read-only
// projection of already-loaded data, and every result carries explicit caveats
// and forbidden-action statements.

import type {
  AiTaskEntrypoint,
  CaveatsPack,
  ConfidenceLevel,
  DemandContextRow,
  MarketSnapshot,
  MirrorRow,
  PropertySignalRow
} from "./aiContextPackGenerator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskName =
  | "bootstrap"
  | "market_report"
  | "pricing_support"
  | "sold_out_pressure"
  | "property_signal"
  | "data_quality";

export type AiTaskQueryDecision =
  | "ai_task_query_ready"
  | "ai_task_query_basis_caution"
  | "ai_task_query_not_ready";

export const TASK_NAMES: TaskName[] = [
  "bootstrap",
  "market_report",
  "pricing_support",
  "sold_out_pressure",
  "property_signal",
  "data_quality"
];

// Loosely-typed documentation packs (only the fields we surface are read).
export interface ManifestLike {
  known_caveats?: string[];
  recommended_next_tasks?: unknown[];
  paused_tasks?: unknown[];
  forbidden_without_approval?: string[];
  safe_readonly_commands?: string[];
}

export interface DictionaryLike {
  known_misread_risks?: unknown[];
  future_ai_usage_rules?: unknown[];
}

// Everything a recipe may read, loaded once by the CLI (read-only).
export interface ContextBundle {
  snapshot: MarketSnapshot;
  demandRows: DemandContextRow[];
  propertyRows: PropertySignalRow[];
  caveats: CaveatsPack;
  entrypoint: AiTaskEntrypoint;
  manifest: ManifestLike | null;
  dictionary: DictionaryLike | null;
  mirrorRows: MirrorRow[];
}

export interface TaskInputs {
  start_date?: string;
  end_date?: string;
  property_name?: string;
  source?: string;
  limit?: number;
  min_confidence?: ConfidenceLevel;
  include_directional?: boolean;
  own_inventory?: number;
  focus?: string;
}

export interface TaskQueryResult {
  task: TaskName;
  inputs: TaskInputs;
  data_sources_used: string[];
  result: Record<string, unknown>;
  caveats: string[];
  forbidden_actions: string[];
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const FORBIDDEN_ACTIONS: string[] = [
  "No PMS/OTA/Beds24/AirHost update is allowed from this output.",
  "Do not update prices.",
  "Do not write the DB, create tables, or run migrations.",
  "Do not run collectors or perform a live external fetch.",
  "Do not modify the property master or .data/history.",
  "Do not start DP03X or R01X.",
  "Do not use a Booking synthetic base × 1.1."
];

const BASE_CAVEATS: string[] = [
  "B-confidence rows are directional only and are NOT automated-pricing safe.",
  "OTA stock/availability is not actual occupancy.",
  "Underlying DB mirror is thin; treat all output as directional market intelligence."
];

// ---------------------------------------------------------------------------
// Recipe definitions (metadata registry)
// ---------------------------------------------------------------------------

export interface RecipeDefinition {
  task: TaskName;
  purpose: string;
  inputs: string[];
  data_sources: string[];
  output_fields: string[];
  caveats: string[];
  forbidden_actions: string[];
}

export const TASK_RECIPES: Record<TaskName, RecipeDefinition> = {
  bootstrap: {
    task: "bootstrap",
    purpose: "Give future AI the minimal context to start safely.",
    inputs: [],
    data_sources: ["latest_ai_task_entrypoint", "latest_caveats_and_guardrails", "manifest_latest", "data_dictionary_latest"],
    output_fields: ["read_order", "safe_commands", "forbidden_without_approval", "current_data_limitations", "recommended_next_queries"],
    caveats: BASE_CAVEATS,
    forbidden_actions: FORBIDDEN_ACTIONS
  },
  market_report: {
    task: "market_report",
    purpose: "Generate market context for a date range.",
    inputs: ["start_date", "end_date", "min_confidence?", "include_directional?"],
    data_sources: ["latest_market_snapshot", "latest_demand_context", "market_signal_history"],
    output_fields: [
      "date_range",
      "demand_rows",
      "high_demand_dates",
      "weak_demand_dates",
      "sold_out_pressure_dates",
      "price_pressure_dates",
      "source_counts",
      "basis_confidence_summary",
      "dp_usage_summary",
      "human_readable_summary",
      "caveats"
    ],
    caveats: BASE_CAVEATS,
    forbidden_actions: FORBIDDEN_ACTIONS
  },
  pricing_support: {
    task: "pricing_support",
    purpose: "Return evidence for pricing judgment, without making or applying prices.",
    inputs: ["property_name?", "start_date", "end_date", "own_inventory?"],
    data_sources: [
      "latest_market_snapshot",
      "latest_demand_context",
      "latest_property_signal_context",
      "latest_caveats_and_guardrails",
      "market_signal_history"
    ],
    output_fields: [
      "date_range",
      "market_pressure_summary",
      "property_signal_rows",
      "sold_out_pressure_rows",
      "price_pressure_rows",
      "confidence_warnings",
      "human_review_required",
      "forbidden_actions"
    ],
    caveats: [
      "No PMS/OTA/Beds24/AirHost update is allowed from this output.",
      "B-confidence is directional only.",
      ...BASE_CAVEATS
    ],
    forbidden_actions: FORBIDDEN_ACTIONS
  },
  sold_out_pressure: {
    task: "sold_out_pressure",
    purpose: "Return dates with strongest sold-out pressure.",
    inputs: ["start_date?", "end_date?", "limit?"],
    data_sources: ["latest_demand_context", "market_signal_history"],
    output_fields: ["ranked_dates", "sold_out_count", "property_count", "sold_out_ratio", "confidence_level", "caution"],
    caveats: BASE_CAVEATS,
    forbidden_actions: FORBIDDEN_ACTIONS
  },
  property_signal: {
    task: "property_signal",
    purpose: "Return latest source/property signals.",
    inputs: ["property_name?", "source?"],
    data_sources: ["latest_property_signal_context", "market_signal_history"],
    output_fields: [
      "property_rows",
      "source_rows",
      "latest_collected_at",
      "date_count",
      "available_count",
      "sold_out_count",
      "median_total_jpy",
      "basis_confidence_summary",
      "dp_usage_summary",
      "caution"
    ],
    caveats: BASE_CAVEATS,
    forbidden_actions: FORBIDDEN_ACTIONS
  },
  data_quality: {
    task: "data_quality",
    purpose: "Explain current data quality and limitations.",
    inputs: ["focus?"],
    data_sources: ["latest_market_snapshot", "latest_caveats_and_guardrails", "market_data_dictionary_latest"],
    output_fields: [
      "row_counts",
      "source_coverage",
      "confidence_distribution",
      "known_limitations",
      "safe_use",
      "unsafe_use",
      "recommended_next_data_collection"
    ],
    caveats: BASE_CAVEATS,
    forbidden_actions: FORBIDDEN_ACTIONS
  }
};

export function isTaskName(value: string): value is TaskName {
  return (TASK_NAMES as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER: Record<ConfidenceLevel, number> = {
  insufficient: 0,
  low: 1,
  medium: 2,
  high: 3
};

function inDateRange(date: string, start?: string, end?: string): boolean {
  if (date === "") return false;
  if (start !== undefined && start !== "" && date < start) return false;
  if (end !== undefined && end !== "" && date > end) return false;
  return true;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 7.1 bootstrap
// ---------------------------------------------------------------------------

export function runBootstrap(bundle: ContextBundle): TaskQueryResult {
  const def = TASK_RECIPES.bootstrap;
  const snap = bundle.snapshot;
  return {
    task: "bootstrap",
    inputs: {},
    data_sources_used: def.data_sources,
    result: {
      read_order: bundle.entrypoint.read_order,
      safe_commands: bundle.entrypoint.safe_commands,
      forbidden_without_approval: bundle.entrypoint.forbidden_without_approval,
      current_data_limitations: [
        `market_signal_history rows = ${snap.market_signal_history_row_count} (thin).`,
        `Dominated by directional/B-confidence (directional=${snap.directional_row_count}, direct=${snap.direct_row_count}).`,
        `Only ${snap.property_count} distinct properties covered.`,
        ...(bundle.manifest?.known_caveats ?? [])
      ],
      recommended_next_queries: [
        "data_quality",
        "market_report --start <start> --end <end>",
        "sold_out_pressure --limit 10"
      ]
    },
    caveats: def.caveats,
    forbidden_actions: def.forbidden_actions
  };
}

// ---------------------------------------------------------------------------
// 7.2 market_report
// ---------------------------------------------------------------------------

export function runMarketReport(bundle: ContextBundle, inputs: TaskInputs): TaskQueryResult {
  const def = TASK_RECIPES.market_report;
  const includeDirectional = inputs.include_directional ?? true;
  const minConfRank = inputs.min_confidence !== undefined ? CONFIDENCE_ORDER[inputs.min_confidence] : -1;

  let demand = bundle.demandRows.filter((r) => inDateRange(r.checkin_date, inputs.start_date, inputs.end_date));
  if (!includeDirectional) demand = demand.filter((r) => r.demand_signal_level !== "directional");
  if (minConfRank >= 0) demand = demand.filter((r) => CONFIDENCE_ORDER[r.confidence_level] >= minConfRank);

  const mirror = bundle.mirrorRows.filter((r) => inDateRange(r.checkin_date, inputs.start_date, inputs.end_date));

  const highDemand = demand
    .filter((r) => r.demand_signal_level === "strong" || r.sold_out_ratio >= 0.5)
    .sort((a, b) => b.sold_out_ratio - a.sold_out_ratio)
    .map((r) => ({ checkin_date: r.checkin_date, sold_out_ratio: r.sold_out_ratio, signal: r.demand_signal_level }));
  const weakDemand = demand
    .filter((r) => r.demand_signal_level === "weak" || r.demand_signal_level === "insufficient")
    .map((r) => ({ checkin_date: r.checkin_date, signal: r.demand_signal_level }));
  const soldOutPressure = demand
    .filter((r) => r.sold_out_count > 0)
    .sort((a, b) => b.sold_out_ratio - a.sold_out_ratio || b.sold_out_count - a.sold_out_count)
    .slice(0, 10)
    .map((r) => ({ checkin_date: r.checkin_date, sold_out_ratio: r.sold_out_ratio, sold_out_count: r.sold_out_count }));
  const pricePressure = demand
    .filter((r) => r.median_total_jpy !== null)
    .sort((a, b) => (b.median_total_jpy as number) - (a.median_total_jpy as number))
    .slice(0, 10)
    .map((r) => ({ checkin_date: r.checkin_date, median_total_jpy: r.median_total_jpy }));

  return {
    task: "market_report",
    inputs,
    data_sources_used: def.data_sources,
    result: {
      date_range: { start: inputs.start_date ?? null, end: inputs.end_date ?? null },
      demand_rows: demand,
      high_demand_dates: highDemand,
      weak_demand_dates: weakDemand,
      sold_out_pressure_dates: soldOutPressure,
      price_pressure_dates: pricePressure,
      source_counts: countBy(mirror, (r) => r.source),
      basis_confidence_summary: countBy(mirror, (r) => r.basis_confidence),
      dp_usage_summary: countBy(mirror, (r) => r.dp_usage),
      human_readable_summary:
        `${demand.length} check-in dates in range; ` +
        `${highDemand.length} high-pressure, ${weakDemand.length} weak/insufficient. ` +
        `Directional/B-confidence dominated — directional only, not automated-pricing safe.`
    },
    caveats: def.caveats,
    forbidden_actions: def.forbidden_actions
  };
}

// ---------------------------------------------------------------------------
// 7.3 pricing_support
// ---------------------------------------------------------------------------

export function runPricingSupport(bundle: ContextBundle, inputs: TaskInputs): TaskQueryResult {
  const def = TASK_RECIPES.pricing_support;
  const demand = bundle.demandRows.filter((r) => inDateRange(r.checkin_date, inputs.start_date, inputs.end_date));
  let propertyRows = bundle.propertyRows;
  if (inputs.property_name !== undefined && inputs.property_name !== "") {
    propertyRows = propertyRows.filter((r) => r.canonical_property_name.includes(inputs.property_name as string));
  }

  const soldOutRows = demand
    .filter((r) => r.sold_out_count > 0)
    .sort((a, b) => b.sold_out_ratio - a.sold_out_ratio)
    .map((r) => ({ checkin_date: r.checkin_date, sold_out_ratio: r.sold_out_ratio, sold_out_count: r.sold_out_count, confidence_level: r.confidence_level }));
  const priceRows = demand
    .filter((r) => r.median_total_jpy !== null)
    .sort((a, b) => (b.median_total_jpy as number) - (a.median_total_jpy as number))
    .map((r) => ({ checkin_date: r.checkin_date, median_total_jpy: r.median_total_jpy, confidence_level: r.confidence_level }));

  const lowConfidence = demand.filter((r) => r.confidence_level === "low" || r.confidence_level === "insufficient").length;

  return {
    task: "pricing_support",
    inputs,
    data_sources_used: def.data_sources,
    result: {
      date_range: { start: inputs.start_date ?? null, end: inputs.end_date ?? null },
      market_pressure_summary:
        `${demand.length} dates; ${soldOutRows.length} with sold-out pressure, ${priceRows.length} with a price median.`,
      property_signal_rows: propertyRows,
      sold_out_pressure_rows: soldOutRows,
      price_pressure_rows: priceRows,
      confidence_warnings: [
        "B-confidence is directional only.",
        `${lowConfidence}/${demand.length} in-range dates are low/insufficient confidence.`
      ],
      human_review_required: true,
      forbidden_actions: [
        "No PMS/OTA/Beds24/AirHost update is allowed from this output.",
        ...def.forbidden_actions
      ]
    },
    caveats: def.caveats,
    forbidden_actions: def.forbidden_actions
  };
}

// ---------------------------------------------------------------------------
// 7.4 sold_out_pressure
// ---------------------------------------------------------------------------

export function runSoldOutPressure(bundle: ContextBundle, inputs: TaskInputs): TaskQueryResult {
  const def = TASK_RECIPES.sold_out_pressure;
  const limit = inputs.limit !== undefined && inputs.limit > 0 ? inputs.limit : 10;
  const ranked = bundle.demandRows
    .filter((r) => inDateRange(r.checkin_date, inputs.start_date, inputs.end_date))
    .filter((r) => r.sold_out_count > 0)
    .sort((a, b) => b.sold_out_ratio - a.sold_out_ratio || b.sold_out_count - a.sold_out_count)
    .slice(0, limit)
    .map((r) => ({
      checkin_date: r.checkin_date,
      sold_out_count: r.sold_out_count,
      property_count: r.property_count,
      sold_out_ratio: r.sold_out_ratio,
      confidence_level: r.confidence_level,
      caution:
        r.property_count < 3
          ? "Thin property coverage — interpret pressure with caution."
          : "Directional market pressure; not guaranteed demand."
    }));
  return {
    task: "sold_out_pressure",
    inputs,
    data_sources_used: def.data_sources,
    result: { ranked_dates: ranked, returned: ranked.length, limit },
    caveats: def.caveats,
    forbidden_actions: def.forbidden_actions
  };
}

// ---------------------------------------------------------------------------
// 7.5 property_signal
// ---------------------------------------------------------------------------

export function runPropertySignal(bundle: ContextBundle, inputs: TaskInputs): TaskQueryResult {
  const def = TASK_RECIPES.property_signal;
  let rows = bundle.propertyRows;
  if (inputs.property_name !== undefined && inputs.property_name !== "") {
    rows = rows.filter((r) => r.canonical_property_name.includes(inputs.property_name as string));
  }
  if (inputs.source !== undefined && inputs.source !== "") {
    rows = rows.filter((r) => r.source === inputs.source);
  }
  const sourceRows = countBy(rows, (r) => r.source);
  return {
    task: "property_signal",
    inputs,
    data_sources_used: def.data_sources,
    result: {
      property_rows: rows,
      source_rows: sourceRows,
      returned: rows.length
    },
    caveats: def.caveats,
    forbidden_actions: def.forbidden_actions
  };
}

// ---------------------------------------------------------------------------
// 7.6 data_quality
// ---------------------------------------------------------------------------

export function runDataQuality(bundle: ContextBundle): TaskQueryResult {
  const def = TASK_RECIPES.data_quality;
  const snap = bundle.snapshot;
  return {
    task: "data_quality",
    inputs: {},
    data_sources_used: def.data_sources,
    result: {
      row_counts: {
        market_signal_history_row_count: snap.market_signal_history_row_count,
        sync_run_count: snap.sync_run_count,
        property_count: snap.property_count
      },
      source_coverage: snap.source_counts,
      confidence_distribution: snap.basis_confidence_counts,
      known_limitations: [
        snap.data_quality_summary,
        ...bundle.caveats.caveats
      ],
      safe_use: snap.recommended_use,
      unsafe_use: snap.do_not_use_for,
      recommended_next_data_collection: [
        "Broaden direct/A-confidence coverage across more properties.",
        "Increase sync-run frequency to deepen the mirror.",
        "Add cross-source corroboration (rakuten + jalan + booking on the same property/date)."
      ]
    },
    caveats: def.caveats,
    forbidden_actions: def.forbidden_actions
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function runRecipe(task: TaskName, bundle: ContextBundle, inputs: TaskInputs): TaskQueryResult {
  switch (task) {
    case "bootstrap":
      return runBootstrap(bundle);
    case "market_report":
      return runMarketReport(bundle, inputs);
    case "pricing_support":
      return runPricingSupport(bundle, inputs);
    case "sold_out_pressure":
      return runSoldOutPressure(bundle, inputs);
    case "property_signal":
      return runPropertySignal(bundle, inputs);
    case "data_quality":
      return runDataQuality(bundle);
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  task: TaskName;
  inputs: TaskInputs;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        map.set(key, next);
        i++;
      } else {
        map.set(key, "true");
      }
    }
  }
  const taskRaw = map.get("task") ?? "bootstrap";
  if (!isTaskName(taskRaw)) {
    throw new Error(`Unknown task: ${taskRaw}. Valid tasks: ${TASK_NAMES.join(", ")}`);
  }
  const inputs: TaskInputs = {};
  const start = map.get("start");
  if (start !== undefined) inputs.start_date = start;
  const end = map.get("end");
  if (end !== undefined) inputs.end_date = end;
  const propertyName = map.get("property");
  if (propertyName !== undefined) inputs.property_name = propertyName;
  const source = map.get("source");
  if (source !== undefined) inputs.source = source;
  const limit = map.get("limit");
  if (limit !== undefined) inputs.limit = Number(limit);
  const focus = map.get("focus");
  if (focus !== undefined) inputs.focus = focus;
  const ownInventory = map.get("own_inventory");
  if (ownInventory !== undefined) inputs.own_inventory = Number(ownInventory);
  const minConf = map.get("min_confidence");
  if (minConf === "high" || minConf === "medium" || minConf === "low" || minConf === "insufficient") {
    inputs.min_confidence = minConf;
  }
  if (map.has("include_directional")) inputs.include_directional = map.get("include_directional") !== "false";
  return { task: taskRaw, inputs };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function decideAiTaskQuery(input: {
  historyRowCount: number;
  directRowCount: number;
  directionalRowCount: number;
  bConfidenceCount: number;
  distinctSourceCount: number;
  propertyCount: number;
}): AiTaskQueryDecision {
  if (input.historyRowCount === 0) return "ai_task_query_not_ready";
  const directionalHeavy = input.directionalRowCount > input.directRowCount * 3;
  const bHeavy = input.bConfidenceCount > input.historyRowCount / 2;
  const thinCoverage = input.distinctSourceCount < 3 || input.propertyCount < 3;
  if (directionalHeavy || bHeavy || thinCoverage) return "ai_task_query_basis_caution";
  return "ai_task_query_ready";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface TaskQueryReport {
  run_id: string;
  generated_at_jst: string;
  task: TaskName;
  inputs: TaskInputs;
  data_sources_used: string[];
  result: Record<string, unknown>;
  caveats: string[];
  forbidden_actions: string[];
  safety_confirmation: Record<string, boolean>;
  decision: AiTaskQueryDecision;
}

export function renderTaskReport(report: TaskQueryReport): string {
  return [
    "# AI Task Query Output",
    "",
    `Generated at: ${report.generated_at_jst}`,
    `Decision: ${report.decision}`,
    "",
    "## 1. Task",
    "",
    `- ${report.task} — ${TASK_RECIPES[report.task].purpose}`,
    "",
    "## 2. Inputs",
    "",
    `- ${JSON.stringify(report.inputs)}`,
    "",
    "## 3. Data Sources Used",
    "",
    ...report.data_sources_used.map((s) => `- ${s}`),
    "",
    "## 4. Result Summary",
    "",
    "```json",
    JSON.stringify(report.result, null, 2),
    "```",
    "",
    "## 5. Caveats",
    "",
    ...report.caveats.map((c) => `- ${c}`),
    "",
    "## 6. Forbidden Actions",
    "",
    ...report.forbidden_actions.map((f) => `- ${f}`),
    "",
    "## 7. Safety Confirmation",
    "",
    ...Object.entries(report.safety_confirmation).map(([k, v]) => `- ${k}=${v}`),
    ""
  ].join("\n");
}

// Flatten the primary tabular part of a result into a CSV when present.
export function renderTaskCsv(result: TaskQueryResult): string {
  const arrayKey = ["ranked_dates", "demand_rows", "property_rows", "sold_out_pressure_rows", "price_pressure_rows"].find(
    (k) => Array.isArray(result.result[k])
  );
  if (arrayKey === undefined) {
    return `key,value\ntask,${result.task}\n`;
  }
  const rows = result.result[arrayKey] as Record<string, unknown>[];
  if (rows.length === 0) return `${arrayKey}\n`;
  const headers = Object.keys(rows[0]!);
  const body = rows.map((r) =>
    headers
      .map((h) => {
        const v = r[h];
        const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        return /[",\n\r]/u.test(s) ? `"${s.replace(/"/gu, "\"\"")}"` : s;
      })
      .join(",")
  );
  return `${headers.join(",")}\n${body.join("\n")}\n`;
}
