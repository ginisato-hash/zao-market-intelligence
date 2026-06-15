// Phase AUTO-RUNNER15X-A - planner-driven market refresh dry-run helpers (pure).
//
// This module converts planner-selected targets into a planned market-refresh
// preview without performing any live collection. It never appends history, syncs
// the DB, refreshes AI context, calls a browser, or emits pricing/PMS output.
// The live runner (autoRunnerMarketRefresh.ts) is untouched.

import { type Bucket, type PageCaps, type PlannerSource, type PlannerTarget, type ScopePlan } from "./collectionScopePlanner";
import { VERIFIED_BOOKING_TARGETS } from "./autoRunnerBookingPreview";
import { VERIFIED_JALAN_TARGETS } from "./autoRunnerMarketRefresh";

export type DryRunAction =
  | "would_collect"
  | "excluded_by_cap"
  | "excluded_disabled_source"
  | "excluded_missing_collector_mapping"
  | "excluded_invalid_target";

export type PlannedMarketRefreshStatus =
  | "planned_market_refresh_dry_run_ready"
  | "planned_market_refresh_no_targets"
  | "planned_market_refresh_mapping_incomplete"
  | "planned_market_refresh_cap_exceeded_blocked"
  | "planned_market_refresh_not_ready";

export interface PlannedTarget {
  source: PlannerSource;
  canonical_property_name: string;
  collector_property_key: string;
  stay_date: string;
  bucket: Bucket;
  priority_score: number;
  reason_codes: string[];
  estimated_page_count: number;
  dry_run_action: DryRunAction;
}

export interface MappingIndex {
  booking: ReadonlyMap<string, string>; // slug -> canonical name (same slug as key)
  jalan: ReadonlyMap<string, string>;   // yadId -> canonical name
}

export interface DryRunSummary {
  run_date_jst: string;
  mode: "planner_driven_dry_run";
  live_collection_executed: false;
  history_append_executed: false;
  db_sync_executed: false;
  ai_context_refresh_executed: false;
  pricing_output_executed: false;
  status: PlannedMarketRefreshStatus;
  total_planner_candidates: number;
  selected: PlannedTarget[];
  excluded_by_cap: PlannedTarget[];
  excluded_disabled_source: PlannedTarget[];
  excluded_missing_mapping: PlannedTarget[];
  estimated_total_pages: number;
  pages_by_source: Record<string, number>;
  pages_by_bucket: Record<string, number>;
  targets_by_bucket: Record<string, number>;
  targets_by_source: Record<string, number>;
  page_caps: PageCaps;
  roadmap: readonly string[];
  recommended_next_action: string;
}

// Collector key lookup from the current verified targets (no network, no DB).
export function buildMappingIndex(): MappingIndex {
  return {
    booking: new Map(VERIFIED_BOOKING_TARGETS.map((t) => [t.slug, t.canonicalPropertyName])),
    jalan: new Map(VERIFIED_JALAN_TARGETS.map((t) => [t.jalanYadId, t.canonicalPropertyName]))
  };
}

function resolveMapping(target: PlannerTarget, index: MappingIndex): { key: string; found: boolean } {
  if (target.source === "booking") {
    return index.booking.has(target.property_slug) ? { key: target.property_slug, found: true } : { key: target.property_slug, found: false };
  }
  if (target.source === "jalan") {
    return index.jalan.has(target.property_slug) ? { key: target.property_slug, found: true } : { key: target.property_slug, found: false };
  }
  return { key: target.property_slug, found: false };
}

function mapTarget(target: PlannerTarget, index: MappingIndex): PlannedTarget {
  if (!target.can_collect) {
    return {
      source: target.source,
      canonical_property_name: target.canonical_property_name,
      collector_property_key: target.property_slug,
      stay_date: target.stay_date,
      bucket: target.bucket,
      priority_score: target.priority_score,
      reason_codes: target.reason_codes,
      estimated_page_count: target.estimated_page_count,
      dry_run_action: "excluded_disabled_source"
    };
  }
  const { key, found } = resolveMapping(target, index);
  return {
    source: target.source,
    canonical_property_name: target.canonical_property_name,
    collector_property_key: key,
    stay_date: target.stay_date,
    bucket: target.bucket,
    priority_score: target.priority_score,
    reason_codes: target.reason_codes,
    estimated_page_count: target.estimated_page_count,
    dry_run_action: found ? "would_collect" : "excluded_missing_collector_mapping"
  };
}

function countPages(targets: readonly PlannedTarget[], key: (t: PlannedTarget) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of targets) out[key(t)] = (out[key(t)] ?? 0) + t.estimated_page_count;
  return out;
}

function countTargets(targets: readonly PlannedTarget[], key: (t: PlannedTarget) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of targets) out[key(t)] = (out[key(t)] ?? 0) + 1;
  return out;
}

export const ROADMAP: readonly string[] = [
  "15X-A complete when committed. Planner-driven target preview is available.",
  "Still deferred: 12X scheduled run verification; 15X-B controlled live expansion; D01-D04 unified property discovery.",
  "Next recommended step: Run 12X after the first scheduled 09:00 execution, then 15X-B to enable planner-driven controlled live expansion."
];

export function buildDryRunSummary(plan: ScopePlan, index: MappingIndex): DryRunSummary {
  const selected = plan.selected.map((t) => mapTarget(t, index));
  const excludedByCap = plan.excluded_by_cap.map((t) => ({ ...mapTarget(t, index), dry_run_action: "excluded_by_cap" as const }));
  const excludedDisabled = plan.excluded_by_disabled_source.map((t) => ({ ...mapTarget(t, index), dry_run_action: "excluded_disabled_source" as const }));

  const wouldCollect = selected.filter((t) => t.dry_run_action === "would_collect");
  const missingMapping = selected.filter((t) => t.dry_run_action === "excluded_missing_collector_mapping");
  const totalPages = wouldCollect.reduce((n, t) => n + t.estimated_page_count, 0);

  let status: PlannedMarketRefreshStatus;
  if (wouldCollect.length === 0 && missingMapping.length === 0) {
    status = "planned_market_refresh_no_targets";
  } else if (missingMapping.length > 0 && wouldCollect.length > 0) {
    status = "planned_market_refresh_mapping_incomplete";
  } else if (missingMapping.length > 0 && wouldCollect.length === 0) {
    status = "planned_market_refresh_not_ready";
  } else {
    status = "planned_market_refresh_dry_run_ready";
  }

  const recommended =
    status === "planned_market_refresh_dry_run_ready" || status === "planned_market_refresh_mapping_incomplete"
      ? "Run AUTO-RUNNER15X-B to enable planner-driven controlled live expansion after 12X confirms scheduled execution."
      : "Inspect missing mappings or disabled sources before proceeding to 15X-B.";

  return {
    run_date_jst: plan.run_date_jst,
    mode: "planner_driven_dry_run",
    live_collection_executed: false,
    history_append_executed: false,
    db_sync_executed: false,
    ai_context_refresh_executed: false,
    pricing_output_executed: false,
    status,
    total_planner_candidates: plan.total_candidates,
    selected,
    excluded_by_cap: excludedByCap,
    excluded_disabled_source: excludedDisabled,
    excluded_missing_mapping: missingMapping,
    estimated_total_pages: totalPages,
    pages_by_source: countPages(wouldCollect, (t) => t.source),
    pages_by_bucket: countPages(wouldCollect, (t) => t.bucket),
    targets_by_bucket: countTargets(wouldCollect, (t) => t.bucket),
    targets_by_source: countTargets(wouldCollect, (t) => t.source),
    page_caps: plan.page_caps,
    roadmap: ROADMAP,
    recommended_next_action: recommended
  };
}

export const DRY_RUN_CSV_HEADERS = [
  "source", "canonical_property_name", "collector_property_key",
  "stay_date", "bucket", "priority_score", "reason_codes",
  "estimated_page_count", "dry_run_action"
] as const;

export function renderDryRunCsv(targets: readonly PlannedTarget[]): string {
  const body = targets.map((t) =>
    [
      t.source, t.canonical_property_name, t.collector_property_key,
      t.stay_date, t.bucket, String(t.priority_score), t.reason_codes.join("|"),
      String(t.estimated_page_count), t.dry_run_action
    ].map(csvCell).join(",")
  );
  return [DRY_RUN_CSV_HEADERS.join(","), ...body].join("\n") + "\n";
}

export function renderDryRunReport(summary: DryRunSummary, generatedAtJst: string): string {
  const w = summary.selected.filter((t) => t.dry_run_action === "would_collect");
  return `# Planned Market Refresh — Dry-Run Preview (AUTO-RUNNER15X-A)

Generated at JST: ${generatedAtJst}
Run date: ${summary.run_date_jst}
Mode: ${summary.mode}

## 1. Decision

- status: ${summary.status}
- recommended_next_action: ${summary.recommended_next_action}

## 2. Safety Confirmation

- live_collection_executed: ${summary.live_collection_executed}
- history_append_executed: ${summary.history_append_executed}
- db_sync_executed: ${summary.db_sync_executed}
- ai_context_refresh_executed: ${summary.ai_context_refresh_executed}
- pricing_output_executed: ${summary.pricing_output_executed}

## 3. Planner Scope

- total_planner_candidates: ${summary.total_planner_candidates}
- selected (would_collect): ${w.length}
- excluded_missing_mapping: ${summary.excluded_missing_mapping.length}
- excluded_by_cap: ${summary.excluded_by_cap.length}
- excluded_disabled_source: ${summary.excluded_disabled_source.length}

## 4. Estimated Pages

- estimated_total_pages: ${summary.estimated_total_pages}
- pages_by_source: ${JSON.stringify(summary.pages_by_source)}
- pages_by_bucket: ${JSON.stringify(summary.pages_by_bucket)}
- targets_by_source: ${JSON.stringify(summary.targets_by_source)}
- targets_by_bucket: ${JSON.stringify(summary.targets_by_bucket)}

## 5. Page Caps

${JSON.stringify(summary.page_caps, null, 2)}

## 6. Top selected targets (would_collect)

${w.slice(0, 25).map((t) => `- [${t.priority_score}] ${t.bucket} ${t.source} ${t.canonical_property_name} ${t.stay_date} (${t.reason_codes.join("|")})`).join("\n") || "- (none)"}

## 7. Missing collector mappings

${summary.excluded_missing_mapping.length > 0 ? summary.excluded_missing_mapping.map((t) => `- ${t.source} ${t.collector_property_key}`).join("\n") : "- (none)"}

## 8. Roadmap

${summary.roadmap.map((line) => `- ${line}`).join("\n")}
`;
}

function csvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}
