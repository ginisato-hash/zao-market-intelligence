// Phase BOOKING-B07B — Post Booking-history-append refresh (pure layer).
//
// Pure validation / decision / diff / rendering for the DB-mirror sync + AI
// context refresh that follows BOOKING-B07X's guarded Booking.com history
// append. This module MUTATES NOTHING: no DB access, no fs writes, no collector
// run, no external/live Booking fetch, no .data/history or property-master
// mutation, no PMS/Beds24/AirHost/OTA output, no price update, and no
// Booking base × 1.1 logic. The orchestrator script feeds it summaries it
// already gathered from the existing AUTO04X sync + AUTO05X/AUTO06X context
// scripts; this module decides nothing beyond what is encoded here.

// ---------------------------------------------------------------------------
// Decision labels
// ---------------------------------------------------------------------------

export type PostBookingRefreshDecision =
  | "post_booking_history_append_refresh_success"
  | "post_booking_history_append_refresh_basis_caution"
  | "post_booking_history_append_refresh_not_ready";

export const B07X_SUCCESS_DECISION = "booking_history_append_success";
export const DB_SYNC_SUCCESS_DECISION = "history_to_db_sync_success";
export const CONTEXT_CAUTION_DECISION = "ai_context_packs_basis_caution";
export const CONTEXT_READY_DECISIONS: ReadonlySet<string> = new Set([
  "ai_context_packs_ready",
  "ai_context_packs_basis_caution"
]);

// Expected post-append target state (documented B07B values).
export const EXPECTED_HISTORY_ROW_COUNT = 160;
export const EXPECTED_CANONICAL_INSERTED_ROWS = 15;
export const EXPECTED_CANONICAL_SKIPPED_ROWS = 145;
export const EXPECTED_BOOKING_TOTAL_ROWS = 21;
export const EXPECTED_BOOKING_DIRECTIONAL_ROWS = 19;
export const EXPECTED_BOOKING_EXCLUDED_ROWS = 2;
export const EXPECTED_BOOKING_DIRECT_ROWS = 0;
export const EXPECTED_BOOKING_DIRECTIONAL_APPENDED = 14;
export const EXPECTED_BOOKING_EXCLUDED_APPENDED = 1;
export const EXPECTED_BOOKING_APPENDED_ROWS = 15;

// ---------------------------------------------------------------------------
// Snapshots and summaries
// ---------------------------------------------------------------------------

export interface DbStateSnapshot {
  market_signal_history_rows: number;
  market_signal_sync_runs: number;
  sold_out_rows: number;
  priced_rows: number;
  source_counts: Record<string, number>;
  basis_confidence_counts: Record<string, number>;
  dp_usage_counts: Record<string, number>;
}

// The B07X append artifact summary (what the guarded append actually wrote).
export interface BookingAppendSummary {
  decision: string;
  appended_row_count: number;
  directional_appended: number;
  excluded_appended: number;
  direct_appended: number;
  conflict_rows: number;
}

// DB-mirror sync evidence. The canonical fields describe the 145→160 transition
// (the FIRST real sync that inserted the 15 Booking rows). The recheck fields
// describe this run's idempotent re-sync (inserted 0, skipped 160).
export interface BookingDbSyncSummary {
  canonical_decision: string;
  canonical_inserted_rows: number;
  canonical_skipped_identical_rows: number;
  canonical_conflict_rows: number;
  canonical_post_sync_passed: boolean;
  canonical_all_source_row_ids_exist: boolean;
  canonical_all_row_hashes_match: boolean;
  canonical_duplicate_row_id_count: number;
  canonical_sync_run_record_exists: boolean;
  canonical_market_signal_history_count: number;
  canonical_collector_baseline_unchanged: boolean;
  canonical_history_mtimes_unchanged: boolean;
  canonical_artifact_path: string;
  recheck_decision: string;
  recheck_inserted_rows: number;
  recheck_skipped_identical_rows: number;
  recheck_conflict_rows: number;
  recheck_artifact_path: string;
}

// Live (read-only) Booking composition observed in the DB after sync.
export interface BookingRowState {
  total_in_db: number;
  directional_in_db: number;
  excluded_in_db: number;
  direct_in_db: number;
  excluded_leaked_to_usable: number;
}

export interface BookingContextSummary {
  decision: string;
  context_packs_regenerated: boolean;
  context_packs_are_real_files: boolean;
  regenerated_files: string[];
  context_history_row_count: number;
  context_booking_source_count: number;
  context_booking_direct_count: number;
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
  external_or_live_booking_fetch: boolean;
  playwright_used: boolean;
  history_append_during_refresh: boolean;
  property_master_mutation: boolean;
  pms_or_ota_output: boolean;
  price_update: boolean;
  booking_times_1_1: boolean;
  github_actions_or_gitops_or_cron: boolean;
  git_commit_or_push: boolean;
  paid_sources: boolean;
  started_next_phase: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RefreshValidationInput {
  history_unique_row_id_count: number;
  db_history_row_count_after: number;
  booking_append: BookingAppendSummary;
  db_sync: BookingDbSyncSummary;
  booking_rows: BookingRowState;
  context_refresh: BookingContextSummary;
  task_smoke: TaskQuerySmokeSummary;
  safety: RefreshSafetyState;
}

export interface RefreshValidationResult {
  ok: boolean;
  checks: Record<string, boolean>;
  failed_checks: string[];
}

export function validateBookingRefresh(input: RefreshValidationInput): RefreshValidationResult {
  const s = input.safety;
  const a = input.booking_append;
  const sync = input.db_sync;
  const b = input.booking_rows;
  const ctx = input.context_refresh;
  const checks: Record<string, boolean> = {
    // History / DB row counts
    db_row_count_is_160: input.db_history_row_count_after === EXPECTED_HISTORY_ROW_COUNT,
    db_row_count_matches_history: input.db_history_row_count_after === input.history_unique_row_id_count,
    history_unique_row_id_is_160: input.history_unique_row_id_count === EXPECTED_HISTORY_ROW_COUNT,
    // B07X append evidence
    b07x_append_was_success: a.decision === B07X_SUCCESS_DECISION,
    b07x_appended_15: a.appended_row_count === EXPECTED_BOOKING_APPENDED_ROWS,
    b07x_directional_14: a.directional_appended === EXPECTED_BOOKING_DIRECTIONAL_APPENDED,
    b07x_excluded_1: a.excluded_appended === EXPECTED_BOOKING_EXCLUDED_APPENDED,
    b07x_no_direct: a.direct_appended === EXPECTED_BOOKING_DIRECT_ROWS,
    b07x_conflicts_zero: a.conflict_rows === 0,
    // Canonical 145→160 sync
    canonical_sync_succeeded: sync.canonical_decision === DB_SYNC_SUCCESS_DECISION,
    canonical_inserted_15: sync.canonical_inserted_rows === EXPECTED_CANONICAL_INSERTED_ROWS,
    canonical_skipped_145: sync.canonical_skipped_identical_rows === EXPECTED_CANONICAL_SKIPPED_ROWS,
    canonical_conflicts_zero: sync.canonical_conflict_rows === 0,
    canonical_post_sync_passed: sync.canonical_post_sync_passed,
    canonical_row_ids_exist: sync.canonical_all_source_row_ids_exist,
    canonical_row_hashes_match: sync.canonical_all_row_hashes_match,
    canonical_duplicate_row_id_zero: sync.canonical_duplicate_row_id_count === 0,
    canonical_sync_run_recorded: sync.canonical_sync_run_record_exists,
    canonical_count_is_160: sync.canonical_market_signal_history_count === EXPECTED_HISTORY_ROW_COUNT,
    // Idempotent re-sync this run
    resync_is_idempotent: sync.recheck_inserted_rows === 0,
    resync_conflicts_zero: sync.recheck_conflict_rows === 0,
    // Booking composition in DB
    booking_total_is_21: b.total_in_db === EXPECTED_BOOKING_TOTAL_ROWS,
    booking_directional_is_19: b.directional_in_db === EXPECTED_BOOKING_DIRECTIONAL_ROWS,
    booking_excluded_is_2: b.excluded_in_db === EXPECTED_BOOKING_EXCLUDED_ROWS,
    booking_no_direct: b.direct_in_db === EXPECTED_BOOKING_DIRECT_ROWS,
    excluded_not_in_price_pressure: b.excluded_leaked_to_usable === 0,
    // AI context
    context_packs_regenerated: ctx.context_packs_regenerated,
    context_packs_are_real_files: ctx.context_packs_are_real_files,
    context_row_count_is_160: ctx.context_history_row_count === EXPECTED_HISTORY_ROW_COUNT,
    context_booking_source_present: ctx.context_booking_source_count === EXPECTED_BOOKING_TOTAL_ROWS,
    context_booking_no_direct: ctx.context_booking_direct_count === EXPECTED_BOOKING_DIRECT_ROWS,
    // Query smoke
    bootstrap_query_succeeded: input.task_smoke.bootstrap_ok,
    // Safety / forbidden
    collector_baseline_unchanged: s.collector_baseline_unchanged && sync.canonical_collector_baseline_unchanged,
    history_unchanged_during_refresh: s.history_unchanged_during_refresh && sync.canonical_history_mtimes_unchanged,
    property_master_unchanged: s.property_master_unchanged,
    no_live_collector: !s.live_collector_run,
    no_external_or_live_booking_fetch: !s.external_or_live_booking_fetch,
    no_playwright: !s.playwright_used,
    no_history_append: !s.history_append_during_refresh,
    no_property_master_mutation: !s.property_master_mutation,
    no_pms_or_ota_output: !s.pms_or_ota_output,
    no_price_update: !s.price_update,
    no_booking_times_1_1: !s.booking_times_1_1,
    no_github_actions_gitops_cron: !s.github_actions_or_gitops_or_cron,
    no_git_commit_or_push: !s.git_commit_or_push,
    no_paid_sources: !s.paid_sources,
    did_not_start_next_phase: !s.started_next_phase
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

export function decidePostBookingHistoryAppendRefresh(input: {
  db_sync_ok: boolean;
  context_refresh_ok: boolean;
  validation_ok: boolean;
  context_decision_is_caution: boolean;
}): PostBookingRefreshDecision {
  if (!input.db_sync_ok) return "post_booking_history_append_refresh_not_ready";
  if (!input.context_refresh_ok) return "post_booking_history_append_refresh_not_ready";
  if (!input.validation_ok) return "post_booking_history_append_refresh_not_ready";
  if (input.context_decision_is_caution) return "post_booking_history_append_refresh_basis_caution";
  return "post_booking_history_append_refresh_success";
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
  booking_rows: MetricDelta;
  directional_rows: MetricDelta;
  direct_rows: MetricDelta;
  excluded_rows: MetricDelta;
  priced_rows: MetricDelta;
}

function delta(before: number, after: number): MetricDelta {
  return { before, after, delta: after - before };
}

function count(map: Record<string, number>, key: string): number {
  return map[key] ?? 0;
}

export function diffSnapshots(before: DbStateSnapshot, after: DbStateSnapshot): SnapshotDiff {
  return {
    market_signal_history_rows: delta(before.market_signal_history_rows, after.market_signal_history_rows),
    market_signal_sync_runs: delta(before.market_signal_sync_runs, after.market_signal_sync_runs),
    booking_rows: delta(count(before.source_counts, "booking"), count(after.source_counts, "booking")),
    directional_rows: delta(count(before.dp_usage_counts, "directional"), count(after.dp_usage_counts, "directional")),
    direct_rows: delta(count(before.dp_usage_counts, "direct"), count(after.dp_usage_counts, "direct")),
    excluded_rows: delta(count(before.dp_usage_counts, "excluded"), count(after.dp_usage_counts, "excluded")),
    priced_rows: delta(before.priced_rows, after.priced_rows)
  };
}

// ---------------------------------------------------------------------------
// Data-quality note (Booking rows are official-visible-adder directional only)
// ---------------------------------------------------------------------------

export function buildDataQualityNote(
  booking: BookingRowState,
  append: BookingAppendSummary
): { headline: string; statements: string[] } {
  return {
    headline:
      "BOOKING-B07X added official-visible-adder Booking rows as directional price-pressure signal only; the refreshed mirror remains basis_caution.",
    statements: [
      `Booking rows in DB: ${booking.total_in_db} (directional ${booking.directional_in_db}, excluded ${booking.excluded_in_db}, direct ${booking.direct_in_db}).`,
      `B07X appended ${append.appended_row_count} rows (${append.directional_appended} directional + ${append.excluded_appended} excluded audit).`,
      "Booking totals = official base + officially visible tax/fee adder; never base × 1.1.",
      "Booking directional rows are usable for demand/price-pressure detection, NOT for direct price-setting.",
      `Excluded Booking rows (${booking.excluded_in_db}) carry an exclusion_reason and do not enter price-pressure or DP usage.`,
      "No Booking row is DP-direct; do not treat Booking signal as authoritative own-rate."
    ]
  };
}

// ---------------------------------------------------------------------------
// Report assembly + rendering
// ---------------------------------------------------------------------------

export interface PostBookingRefreshReport {
  run_id: string;
  generated_at_jst: string;
  decision: PostBookingRefreshDecision;
  source_b07x_artifact: string;
  history_unique_row_id_count: number;
  db_before: DbStateSnapshot;
  db_after: DbStateSnapshot;
  snapshot_diff: SnapshotDiff;
  booking_append: BookingAppendSummary;
  db_sync: BookingDbSyncSummary;
  booking_rows: BookingRowState;
  context_refresh: BookingContextSummary;
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

export function recommendedNextAction(decision: PostBookingRefreshDecision): string {
  if (
    decision === "post_booking_history_append_refresh_success" ||
    decision === "post_booking_history_append_refresh_basis_caution"
  ) {
    return "JALAN-AUTO01X (Jalan read-only normalized probe proposal) or BOOKING-B08X (next Booking discovery batch). Do not start either without explicit instruction.";
  }
  return "Investigate the failed step; do not proceed until the refresh succeeds.";
}

export function renderPostBookingRefreshCsv(report: PostBookingRefreshReport): string {
  const d = report.snapshot_diff;
  const headers = ["metric", "before", "after", "delta"];
  const rows: Array<[string, number, number, number]> = [
    ["market_signal_history_rows", d.market_signal_history_rows.before, d.market_signal_history_rows.after, d.market_signal_history_rows.delta],
    ["market_signal_sync_runs", d.market_signal_sync_runs.before, d.market_signal_sync_runs.after, d.market_signal_sync_runs.delta],
    ["booking_rows", d.booking_rows.before, d.booking_rows.after, d.booking_rows.delta],
    ["directional_rows", d.directional_rows.before, d.directional_rows.after, d.directional_rows.delta],
    ["direct_rows", d.direct_rows.before, d.direct_rows.after, d.direct_rows.delta],
    ["excluded_rows", d.excluded_rows.before, d.excluded_rows.after, d.excluded_rows.delta],
    ["priced_rows", d.priced_rows.before, d.priced_rows.after, d.priced_rows.delta]
  ];
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}

export function renderPostBookingRefreshReport(report: PostBookingRefreshReport): string {
  const d = report.snapshot_diff;
  const sync = report.db_sync;
  const b = report.booking_rows;
  const ctx = report.context_refresh;
  const checkLine = (name: string, ok: boolean): string => `- ${ok ? "PASS" : "FAIL"} ${name}`;
  const lines: string[] = [
    "# Phase BOOKING-B07B — Post Booking-History-Append Refresh",
    "",
    `Generated at: ${report.generated_at_jst}`,
    `Decision: ${report.decision}`,
    "",
    "## 1. Summary",
    "",
    `- Decision: ${report.decision}`,
    `- DB market_signal_history: ${d.market_signal_history_rows.before} → ${d.market_signal_history_rows.after} (now ${report.db_after.market_signal_history_rows})`,
    `- Canonical sync (145→160): inserted ${sync.canonical_inserted_rows}, skipped_identical ${sync.canonical_skipped_identical_rows}, conflicts ${sync.canonical_conflict_rows}`,
    `- Idempotent re-sync this run: inserted ${sync.recheck_inserted_rows}, skipped_identical ${sync.recheck_skipped_identical_rows}, conflicts ${sync.recheck_conflict_rows}`,
    `- Booking rows in DB: ${b.total_in_db} (directional ${b.directional_in_db}, excluded ${b.excluded_in_db}, direct ${b.direct_in_db})`,
    `- Context packs regenerated: ${ctx.context_packs_regenerated} (decision: ${ctx.decision})`,
    `- Bootstrap query: ${report.task_smoke.bootstrap_decision} (ok=${report.task_smoke.bootstrap_ok})`,
    "",
    "## 2. Source B07X artifact",
    "",
    `- ${report.source_b07x_artifact}`,
    `- decision: ${report.booking_append.decision}`,
    `- appended: ${report.booking_append.appended_row_count} (directional ${report.booking_append.directional_appended} + excluded ${report.booking_append.excluded_appended}); conflicts ${report.booking_append.conflict_rows}`,
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
    "## 5. DB sync result (canonical 145→160)",
    "",
    `- artifact: ${sync.canonical_artifact_path}`,
    `- decision: ${sync.canonical_decision}`,
    `- inserted: ${sync.canonical_inserted_rows}; skipped_identical: ${sync.canonical_skipped_identical_rows}; conflicts: ${sync.canonical_conflict_rows}`,
    `- all_source_row_ids_exist: ${sync.canonical_all_source_row_ids_exist}`,
    `- all_row_hashes_match: ${sync.canonical_all_row_hashes_match}`,
    `- duplicate_row_id_count: ${sync.canonical_duplicate_row_id_count}`,
    `- sync_run_record_exists: ${sync.canonical_sync_run_record_exists}`,
    `- market_signal_history_count: ${sync.canonical_market_signal_history_count}`,
    "",
    "## 6. Idempotent re-sync this run",
    "",
    `- artifact: ${sync.recheck_artifact_path}`,
    `- decision: ${sync.recheck_decision}`,
    `- inserted: ${sync.recheck_inserted_rows}; skipped_identical: ${sync.recheck_skipped_identical_rows}; conflicts: ${sync.recheck_conflict_rows}`,
    "",
    "## 7. Booking composition in DB",
    "",
    `- total: ${b.total_in_db}; directional: ${b.directional_in_db}; excluded: ${b.excluded_in_db}; direct: ${b.direct_in_db}`,
    `- excluded rows leaked to a usable dp_usage: ${b.excluded_leaked_to_usable} (must be 0)`,
    "",
    "## 8. AI context refresh result",
    "",
    `- decision: ${ctx.decision}`,
    `- regenerated: ${ctx.context_packs_regenerated}; real files (not symlinks): ${ctx.context_packs_are_real_files}`,
    `- context history row count: ${ctx.context_history_row_count}`,
    `- context Booking source count: ${ctx.context_booking_source_count}`,
    `- context Booking direct count: ${ctx.context_booking_direct_count}`,
    ...ctx.regenerated_files.map((f) => `  - ${f}`),
    "",
    "## 9. Task query smoke result",
    "",
    `- bootstrap: ${report.task_smoke.bootstrap_decision} (ok=${report.task_smoke.bootstrap_ok})`,
    ...report.task_smoke.optional_tasks.map((t) => `- ${t.task}: ${t.decision} (ok=${t.ok})`),
    "",
    "## 10. Before/after comparison",
    "",
    `- market_signal_history_rows: ${d.market_signal_history_rows.before} → ${d.market_signal_history_rows.after} (${d.market_signal_history_rows.delta >= 0 ? "+" : ""}${d.market_signal_history_rows.delta})`,
    `- booking_rows: ${d.booking_rows.before} → ${d.booking_rows.after} (${d.booking_rows.delta >= 0 ? "+" : ""}${d.booking_rows.delta})`,
    `- directional_rows: ${d.directional_rows.before} → ${d.directional_rows.after} (${d.directional_rows.delta >= 0 ? "+" : ""}${d.directional_rows.delta})`,
    `- direct_rows: ${d.direct_rows.before} → ${d.direct_rows.after} (${d.direct_rows.delta >= 0 ? "+" : ""}${d.direct_rows.delta})`,
    `- excluded_rows: ${d.excluded_rows.before} → ${d.excluded_rows.after} (${d.excluded_rows.delta >= 0 ? "+" : ""}${d.excluded_rows.delta})`,
    "",
    "## 11. Data-quality note",
    "",
    `- ${report.data_quality_note.headline}`,
    ...report.data_quality_note.statements.map((s) => `- ${s}`),
    "",
    "## 12. Validation",
    "",
    `- ok: ${report.validation.ok}`,
    ...Object.entries(report.validation.checks).map(([name, ok]) => checkLine(name, ok)),
    "",
    "## 13. Decision",
    "",
    `- ${report.decision}`,
    "",
    "## 14. Recommended next action",
    "",
    `- ${recommendedNextAction(report.decision)}`,
    ""
  ];
  return lines.join("\n");
}
