// Phase AUTO08B — Post auto-history-append refresh (pure layer).
//
// Pure validation / decision / diff / rendering for the DB-mirror sync + AI
// context refresh that follows AUTO08X's guarded history append. This module
// MUTATES NOTHING: no DB access, no fs writes, no collector run, no external
// fetch, no .data/history or property-master mutation, no PMS/Beds24/AirHost/OTA
// output, no price update, and no Booking base × 1.1 logic. The orchestrator
// script feeds it summaries it already gathered from existing AUTO04X/AUTO05X/
// AUTO06X scripts and decides nothing on its own beyond what is encoded here.

// ---------------------------------------------------------------------------
// Decision labels
// ---------------------------------------------------------------------------

export type PostRefreshDecision =
  | "post_auto_history_append_refresh_success"
  | "post_auto_history_append_refresh_basis_caution"
  | "post_auto_history_append_refresh_failed_db_sync"
  | "post_auto_history_append_refresh_failed_context_refresh"
  | "post_auto_history_append_refresh_failed_validation";

export const DB_SYNC_SUCCESS_DECISION = "history_to_db_sync_success";
export const CONTEXT_CAUTION_DECISION = "ai_context_packs_basis_caution";
export const CONTEXT_READY_DECISIONS: ReadonlySet<string> = new Set([
  "ai_context_packs_ready",
  "ai_context_packs_basis_caution"
]);

// ---------------------------------------------------------------------------
// Snapshots and summaries
// ---------------------------------------------------------------------------

export interface DbStateSnapshot {
  market_signal_history_rows: number;
  market_signal_sync_runs: number;
  sold_out_rows: number;
  priced_rows: number;
  availability_counts: Record<string, number>;
  basis_confidence_counts: Record<string, number>;
  dp_usage_counts: Record<string, number>;
}

export interface DbSyncSummary {
  decision: string;
  inserted_rows: number;
  skipped_identical_rows: number;
  conflict_rows: number;
  post_sync_passed: boolean;
  all_source_row_ids_exist: boolean;
  all_row_hashes_match: boolean;
  duplicate_row_id_count: number;
  sync_run_record_exists: boolean;
  market_signal_history_count: number;
  collector_baseline_unchanged: boolean;
  history_mtimes_unchanged: boolean;
}

export interface ContextRefreshSummary {
  decision: string;
  context_packs_regenerated: boolean;
  context_packs_are_real_files: boolean;
  regenerated_files: string[];
}

export interface TaskSmokeResult {
  task: string;
  decision: string;
  ok: boolean;
}

export interface TaskQuerySmokeSummary {
  bootstrap_decision: string;
  bootstrap_ok: boolean;
  optional_tasks: TaskSmokeResult[];
}

export interface RefreshSafetyState {
  collector_baseline_unchanged: boolean;
  history_unchanged_during_refresh: boolean;
  property_master_unchanged: boolean;
  live_collector_run: boolean;
  external_fetch: boolean;
  history_append_during_refresh: boolean;
  property_master_mutation: boolean;
  pms_or_ota_output: boolean;
  github_actions_or_gitops_or_cron: boolean;
  git_commit_or_push: boolean;
  paid_sources: boolean;
  started_auto09x: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RefreshValidationInput {
  history_unique_row_id_count: number;
  db_history_row_count_after: number;
  db_sync: DbSyncSummary;
  context_refresh: ContextRefreshSummary;
  task_smoke: TaskQuerySmokeSummary;
  safety: RefreshSafetyState;
}

export interface RefreshValidationResult {
  ok: boolean;
  checks: Record<string, boolean>;
  failed_checks: string[];
}

export function validateRefresh(input: RefreshValidationInput): RefreshValidationResult {
  const s = input.safety;
  const checks: Record<string, boolean> = {
    db_row_count_matches_history: input.db_history_row_count_after === input.history_unique_row_id_count,
    db_sync_post_validation_passed: input.db_sync.post_sync_passed,
    new_rows_present_in_db: input.db_sync.all_source_row_ids_exist,
    row_hash_equality: input.db_sync.all_row_hashes_match,
    conflicts_zero: input.db_sync.conflict_rows === 0,
    duplicate_row_id_zero: input.db_sync.duplicate_row_id_count === 0,
    sync_run_recorded: input.db_sync.sync_run_record_exists,
    context_packs_regenerated: input.context_refresh.context_packs_regenerated,
    context_packs_are_real_files: input.context_refresh.context_packs_are_real_files,
    bootstrap_query_succeeded: input.task_smoke.bootstrap_ok,
    collector_baseline_unchanged: s.collector_baseline_unchanged && input.db_sync.collector_baseline_unchanged,
    history_unchanged_during_refresh: s.history_unchanged_during_refresh && input.db_sync.history_mtimes_unchanged,
    property_master_unchanged: s.property_master_unchanged,
    no_live_collector: !s.live_collector_run,
    no_external_fetch: !s.external_fetch,
    no_history_append: !s.history_append_during_refresh,
    no_property_master_mutation: !s.property_master_mutation,
    no_pms_or_ota_output: !s.pms_or_ota_output,
    no_github_actions_gitops_cron: !s.github_actions_or_gitops_or_cron,
    no_git_commit_or_push: !s.git_commit_or_push,
    no_paid_sources: !s.paid_sources,
    did_not_start_auto09x: !s.started_auto09x
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return { ok: failed.length === 0, checks, failed_checks: failed };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function isDbSyncOk(decision: string): boolean {
  return decision === DB_SYNC_SUCCESS_DECISION;
}

export function isContextRefreshOk(decision: string): boolean {
  return CONTEXT_READY_DECISIONS.has(decision);
}

export function decidePostAutoHistoryAppendRefresh(input: {
  db_sync_ok: boolean;
  context_refresh_ok: boolean;
  validation_ok: boolean;
  context_decision_is_caution: boolean;
}): PostRefreshDecision {
  if (!input.db_sync_ok) return "post_auto_history_append_refresh_failed_db_sync";
  if (!input.context_refresh_ok) return "post_auto_history_append_refresh_failed_context_refresh";
  if (!input.validation_ok) return "post_auto_history_append_refresh_failed_validation";
  if (input.context_decision_is_caution) return "post_auto_history_append_refresh_basis_caution";
  return "post_auto_history_append_refresh_success";
}

// ---------------------------------------------------------------------------
// Snapshot diff
// ---------------------------------------------------------------------------

export interface MetricDelta {
  before: number;
  after: number;
  delta: number;
}

export interface SnapshotDiff {
  market_signal_history_rows: MetricDelta;
  market_signal_sync_runs: MetricDelta;
  sold_out_rows: MetricDelta;
  priced_rows: MetricDelta;
  insufficient_confidence_rows: MetricDelta;
  direct_rows: MetricDelta;
  directional_rows: MetricDelta;
}

function delta(before: number, after: number): MetricDelta {
  return { before, after, delta: after - before };
}

export function diffSnapshots(before: DbStateSnapshot, after: DbStateSnapshot): SnapshotDiff {
  const count = (map: Record<string, number>, key: string): number => map[key] ?? 0;
  return {
    market_signal_history_rows: delta(before.market_signal_history_rows, after.market_signal_history_rows),
    market_signal_sync_runs: delta(before.market_signal_sync_runs, after.market_signal_sync_runs),
    sold_out_rows: delta(before.sold_out_rows, after.sold_out_rows),
    priced_rows: delta(before.priced_rows, after.priced_rows),
    insufficient_confidence_rows: delta(
      count(before.basis_confidence_counts, "insufficient"),
      count(after.basis_confidence_counts, "insufficient")
    ),
    direct_rows: delta(count(before.dp_usage_counts, "direct"), count(after.dp_usage_counts, "direct")),
    directional_rows: delta(count(before.dp_usage_counts, "directional"), count(after.dp_usage_counts, "directional"))
  };
}

// ---------------------------------------------------------------------------
// Data-quality note (AUTO08X rows are sold-out pressure only)
// ---------------------------------------------------------------------------

export function buildDataQualityNote(diff: SnapshotDiff): { headline: string; statements: string[] } {
  return {
    headline:
      "AUTO08X improved sold-out pressure coverage but did not add priced rows; the refreshed mirror remains basis_caution.",
    statements: [
      `market_signal_history rows: ${diff.market_signal_history_rows.before} → ${diff.market_signal_history_rows.after} (+${diff.market_signal_history_rows.delta}).`,
      `sold_out rows: ${diff.sold_out_rows.before} → ${diff.sold_out_rows.after} (+${diff.sold_out_rows.delta}).`,
      `insufficient basis_confidence rows: ${diff.insufficient_confidence_rows.before} → ${diff.insufficient_confidence_rows.after} (+${diff.insufficient_confidence_rows.delta}).`,
      `priced rows: ${diff.priced_rows.before} → ${diff.priced_rows.after} (delta ${diff.priced_rows.delta}).`,
      "Useful for congestion / demand-pressure detection.",
      "Not sufficient for direct price-setting.",
      "Do not treat sold-out pressure as actual occupancy.",
      "Do not treat sold-out pressure as direct pricing data."
    ]
  };
}

// ---------------------------------------------------------------------------
// Report assembly + rendering
// ---------------------------------------------------------------------------

export interface PostRefreshReport {
  run_id: string;
  generated_at_jst: string;
  decision: PostRefreshDecision;
  source_auto08x_artifact: string;
  history_unique_row_id_count: number;
  db_before: DbStateSnapshot;
  db_after: DbStateSnapshot;
  snapshot_diff: SnapshotDiff;
  db_sync: DbSyncSummary;
  context_refresh: ContextRefreshSummary;
  task_smoke: TaskQuerySmokeSummary;
  validation: RefreshValidationResult;
  data_quality_note: { headline: string; statements: string[] };
  safety: RefreshSafetyState;
  commands_run: string[];
  report_path: string;
  json_path: string;
  csv_path: string;
  debug_artifact_path: string;
  next_phase: string;
}

export function recommendedNextAction(decision: PostRefreshDecision): string {
  if (
    decision === "post_auto_history_append_refresh_success" ||
    decision === "post_auto_history_append_refresh_basis_caution"
  ) {
    return "AUTO09X — GitHub Actions / cloud WAF smoke test proposal (do not start without explicit instruction).";
  }
  return "Investigate the failed step; do not proceed to the next phase until the refresh succeeds.";
}

export function renderPostRefreshCsv(report: PostRefreshReport): string {
  const d = report.snapshot_diff;
  const headers = ["metric", "before", "after", "delta"];
  const rows: Array<[string, number, number, number]> = [
    ["market_signal_history_rows", d.market_signal_history_rows.before, d.market_signal_history_rows.after, d.market_signal_history_rows.delta],
    ["market_signal_sync_runs", d.market_signal_sync_runs.before, d.market_signal_sync_runs.after, d.market_signal_sync_runs.delta],
    ["sold_out_rows", d.sold_out_rows.before, d.sold_out_rows.after, d.sold_out_rows.delta],
    ["priced_rows", d.priced_rows.before, d.priced_rows.after, d.priced_rows.delta],
    ["insufficient_confidence_rows", d.insufficient_confidence_rows.before, d.insufficient_confidence_rows.after, d.insufficient_confidence_rows.delta],
    ["direct_rows", d.direct_rows.before, d.direct_rows.after, d.direct_rows.delta],
    ["directional_rows", d.directional_rows.before, d.directional_rows.after, d.directional_rows.delta]
  ];
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}

export function renderPostRefreshReport(report: PostRefreshReport): string {
  const d = report.snapshot_diff;
  const checkLine = (name: string, ok: boolean): string => `- ${ok ? "PASS" : "FAIL"} ${name}`;
  const lines: string[] = [
    "# Phase AUTO08B — Post Auto-History-Append Refresh",
    "",
    `Generated at: ${report.generated_at_jst}`,
    `Decision: ${report.decision}`,
    "",
    "## 1. Summary",
    "",
    `- Decision: ${report.decision}`,
    `- DB mirror market_signal_history: ${d.market_signal_history_rows.before} → ${d.market_signal_history_rows.after} (+${d.market_signal_history_rows.delta})`,
    `- Inserted rows: ${report.db_sync.inserted_rows}; skipped identical: ${report.db_sync.skipped_identical_rows}; conflicts: ${report.db_sync.conflict_rows}`,
    `- Context packs regenerated: ${report.context_refresh.context_packs_regenerated} (decision: ${report.context_refresh.decision})`,
    `- Bootstrap query: ${report.task_smoke.bootstrap_decision} (ok=${report.task_smoke.bootstrap_ok})`,
    "",
    "## 2. Source AUTO08X artifact",
    "",
    `- ${report.source_auto08x_artifact}`,
    "",
    "## 3. Commands run",
    "",
    ...report.commands_run.map((c) => `- \`${c}\``),
    "",
    "## 4. History row-count summary",
    "",
    `- .data/history unique row_id count: ${report.history_unique_row_id_count}`,
    `- DB market_signal_history after: ${report.db_after.market_signal_history_rows}`,
    "",
    "## 5. DB sync result",
    "",
    `- decision: ${report.db_sync.decision}`,
    `- inserted: ${report.db_sync.inserted_rows}; skipped_identical: ${report.db_sync.skipped_identical_rows}; conflicts: ${report.db_sync.conflict_rows}`,
    `- all_source_row_ids_exist: ${report.db_sync.all_source_row_ids_exist}`,
    `- all_row_hashes_match: ${report.db_sync.all_row_hashes_match}`,
    `- duplicate_row_id_count: ${report.db_sync.duplicate_row_id_count}`,
    `- sync_run_record_exists: ${report.db_sync.sync_run_record_exists}`,
    "",
    "## 6. AI context refresh result",
    "",
    `- decision: ${report.context_refresh.decision}`,
    `- regenerated: ${report.context_refresh.context_packs_regenerated}; real files (not symlinks): ${report.context_refresh.context_packs_are_real_files}`,
    ...report.context_refresh.regenerated_files.map((f) => `  - ${f}`),
    "",
    "## 7. Task query smoke result",
    "",
    `- bootstrap: ${report.task_smoke.bootstrap_decision} (ok=${report.task_smoke.bootstrap_ok})`,
    ...report.task_smoke.optional_tasks.map((t) => `- ${t.task}: ${t.decision} (ok=${t.ok})`),
    "",
    "## 8. Before/after comparison",
    "",
    `- market_signal_history_rows: ${d.market_signal_history_rows.before} → ${d.market_signal_history_rows.after} (+${d.market_signal_history_rows.delta})`,
    `- sold_out_rows: ${d.sold_out_rows.before} → ${d.sold_out_rows.after} (+${d.sold_out_rows.delta})`,
    `- insufficient_confidence_rows: ${d.insufficient_confidence_rows.before} → ${d.insufficient_confidence_rows.after} (+${d.insufficient_confidence_rows.delta})`,
    `- priced_rows: ${d.priced_rows.before} → ${d.priced_rows.after} (${d.priced_rows.delta})`,
    `- direct_rows: ${d.direct_rows.before} → ${d.direct_rows.after} (${d.direct_rows.delta})`,
    `- directional_rows: ${d.directional_rows.before} → ${d.directional_rows.after} (${d.directional_rows.delta})`,
    "",
    "## 9. Data-quality note",
    "",
    `- ${report.data_quality_note.headline}`,
    ...report.data_quality_note.statements.map((s) => `- ${s}`),
    "",
    "## 10. Validation",
    "",
    `- ok: ${report.validation.ok}`,
    ...Object.entries(report.validation.checks).map(([name, ok]) => checkLine(name, ok)),
    "",
    "## 11. Decision",
    "",
    `- ${report.decision}`,
    "",
    "## 12. Recommended next action",
    "",
    `- ${recommendedNextAction(report.decision)}`,
    ""
  ];
  return lines.join("\n");
}
