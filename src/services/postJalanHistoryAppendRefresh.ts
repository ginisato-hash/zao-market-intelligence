// Phase JALAN-AUTO05B — Post Jalan-history-append refresh (pure layer).
//
// Pure validation / decision / diff / rendering for the DB-mirror sync + AI
// context refresh that follows JALAN-AUTO05X's guarded Jalan history append.
// This module MUTATES NOTHING: no DB access, no fs writes, no collector run, no
// external/live Jalan fetch, no .data/history mutation, no PMS/Beds24/AirHost/OTA
// output, no price update, and no synthetic tax multiplier. The orchestrator
// script feeds it summaries it already gathered from the AUTO05X append + the
// history-to-DB sync + the AI context refresh + the read-only task-query smoke.
//
// Positioning: Booking.com = primary directional price-pressure backbone; Jalan =
// supplementary domestic OTA signal; Rakuten = frozen / caution. Jalan directional
// rows are usable for price-pressure detection, never for direct price-setting;
// Jalan excluded audit rows must never become price-pressure usable.

// ---------------------------------------------------------------------------
// Decision labels
// ---------------------------------------------------------------------------

export type PostJalanRefreshDecision =
  | "post_jalan_history_append_refresh_success"
  | "post_jalan_history_append_refresh_basis_caution"
  | "post_jalan_history_append_refresh_not_ready";

export const AUTO05X_SUCCESS_DECISION = "jalan_history_append_success";
export const DB_SYNC_SUCCESS_DECISION = "history_to_db_sync_success";
export const CONTEXT_CAUTION_DECISION = "ai_context_packs_basis_caution";
export const CONTEXT_READY_DECISIONS: ReadonlySet<string> = new Set([
  "ai_context_packs_ready",
  "ai_context_packs_basis_caution"
]);

// Expected post-append / post-sync target state (documented AUTO05B values).
export const EXPECTED_HISTORY_ROW_COUNT = 210;
export const EXPECTED_INSERTED_ROWS = 25;
export const EXPECTED_SKIPPED_ROWS = 185;
export const EXPECTED_JALAN_TOTAL_ROWS = 38;
export const EXPECTED_JALAN_DIRECTIONAL_ROWS = 8;
export const EXPECTED_JALAN_EXCLUDED_ROWS = 24;
export const EXPECTED_JALAN_DIRECT_ROWS = 6;
export const EXPECTED_JALAN_DIRECTIONAL_APPENDED = 5;
export const EXPECTED_JALAN_EXCLUDED_APPENDED = 20;
export const EXPECTED_JALAN_DIRECT_APPENDED = 0;
export const EXPECTED_JALAN_APPENDED_ROWS = 25;
export const EXPECTED_BOOKING_TOTAL_ROWS = 46;

// ---------------------------------------------------------------------------
// Snapshots and summaries
// ---------------------------------------------------------------------------

export interface DbStateSnapshot {
  market_signal_history_rows: number;
  market_signal_sync_runs: number;
  source_counts: Record<string, number>;
  dp_usage_counts: Record<string, number>;
}

// The AUTO05X append artifact summary (what the guarded append actually wrote).
export interface JalanAppendSummary {
  decision: string;
  appended_row_count: number;
  directional_appended: number;
  excluded_appended: number;
  direct_appended: number;
  conflict_rows: number;
}

// DB-mirror sync evidence for the 185 -> 210 transition that inserted the 25
// Jalan rows.
export interface JalanDbSyncSummary {
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
  artifact_path: string;
}

// Live (read-only) Jalan composition observed in the DB after sync.
export interface JalanRowState {
  total_in_db: number;
  directional_in_db: number;
  excluded_in_db: number;
  direct_in_db: number;
  excluded_leaked_to_usable: number;
}

export interface JalanContextSummary {
  decision: string;
  context_packs_regenerated: boolean;
  context_packs_are_real_files: boolean;
  regenerated_files: string[];
  context_history_row_count: number;
  context_jalan_source_count: number;
  context_booking_source_count: number;
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
  history_modified: boolean;
  history_appended: boolean;
  db_mirror_synced: boolean;
  ai_context_refreshed: boolean;
  query_smoke_run: boolean;
  collector_baseline_unchanged: boolean;
  live_jalan_collection: boolean;
  browser_automation: boolean;
  external_fetch: boolean;
  pricing_csv: boolean;
  pms_output: boolean;
  price_update: boolean;
  base_times_1_1: boolean;
  paid_source_tooling: boolean;
  github_actions_or_cron: boolean;
  auto06x_started: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RefreshValidationInput {
  history_unique_row_id_count: number;
  jalan_history_row_count: number;
  booking_history_row_count: number;
  db_history_row_count_after: number;
  jalan_append: JalanAppendSummary;
  db_sync: JalanDbSyncSummary;
  jalan_rows: JalanRowState;
  context_refresh: JalanContextSummary;
  task_smoke: TaskQuerySmokeSummary;
  dry_run_ok: boolean;
  safety: RefreshSafetyState;
}

export interface RefreshValidationResult {
  ok: boolean;
  checks: Record<string, boolean>;
  failed_checks: string[];
}

export function validateJalanRefresh(input: RefreshValidationInput): RefreshValidationResult {
  const s = input.safety;
  const a = input.jalan_append;
  const sync = input.db_sync;
  const j = input.jalan_rows;
  const ctx = input.context_refresh;
  const checks: Record<string, boolean> = {
    // History stays at 210
    history_unique_row_id_is_210: input.history_unique_row_id_count === EXPECTED_HISTORY_ROW_COUNT,
    history_jalan_is_38: input.jalan_history_row_count === EXPECTED_JALAN_TOTAL_ROWS,
    history_booking_is_46: input.booking_history_row_count === EXPECTED_BOOKING_TOTAL_ROWS,
    // DB becomes 210
    db_row_count_is_210: input.db_history_row_count_after === EXPECTED_HISTORY_ROW_COUNT,
    db_row_count_matches_history: input.db_history_row_count_after === input.history_unique_row_id_count,
    // AUTO05X append evidence
    auto05x_append_was_success: a.decision === AUTO05X_SUCCESS_DECISION,
    auto05x_appended_25: a.appended_row_count === EXPECTED_JALAN_APPENDED_ROWS,
    auto05x_directional_5: a.directional_appended === EXPECTED_JALAN_DIRECTIONAL_APPENDED,
    auto05x_excluded_20: a.excluded_appended === EXPECTED_JALAN_EXCLUDED_APPENDED,
    auto05x_no_direct: a.direct_appended === EXPECTED_JALAN_DIRECT_APPENDED,
    auto05x_conflicts_zero: a.conflict_rows === 0,
    // Dry-run maps 210 with 0 conflicts
    dry_run_maps_210_zero_conflicts: input.dry_run_ok,
    // DB sync 185 -> 210
    db_sync_succeeded: sync.decision === DB_SYNC_SUCCESS_DECISION,
    db_sync_inserted_25: sync.inserted_rows === EXPECTED_INSERTED_ROWS,
    db_sync_skipped_185: sync.skipped_identical_rows === EXPECTED_SKIPPED_ROWS,
    db_sync_conflicts_zero: sync.conflict_rows === 0,
    post_sync_passed: sync.post_sync_passed,
    all_source_row_ids_exist: sync.all_source_row_ids_exist,
    all_row_hashes_match: sync.all_row_hashes_match,
    duplicate_row_id_zero: sync.duplicate_row_id_count === 0,
    sync_run_recorded: sync.sync_run_record_exists,
    db_sync_count_is_210: sync.market_signal_history_count === EXPECTED_HISTORY_ROW_COUNT,
    // Jalan composition in DB
    jalan_total_is_38: j.total_in_db === EXPECTED_JALAN_TOTAL_ROWS,
    jalan_directional_is_8: j.directional_in_db === EXPECTED_JALAN_DIRECTIONAL_ROWS,
    jalan_excluded_is_24: j.excluded_in_db === EXPECTED_JALAN_EXCLUDED_ROWS,
    jalan_direct_is_6: j.direct_in_db === EXPECTED_JALAN_DIRECT_ROWS,
    jalan_excluded_not_price_pressure: j.excluded_leaked_to_usable === 0,
    // AI context
    context_packs_regenerated: ctx.context_packs_regenerated,
    context_packs_are_real_files: ctx.context_packs_are_real_files,
    context_row_count_is_210: ctx.context_history_row_count === EXPECTED_HISTORY_ROW_COUNT,
    context_jalan_source_is_38: ctx.context_jalan_source_count === EXPECTED_JALAN_TOTAL_ROWS,
    context_booking_source_is_46: ctx.context_booking_source_count === EXPECTED_BOOKING_TOTAL_ROWS,
    // Query smoke
    bootstrap_query_succeeded: input.task_smoke.bootstrap_ok,
    // Safety / forbidden
    history_not_modified: !s.history_modified,
    history_not_appended: !s.history_appended,
    db_mirror_synced: s.db_mirror_synced,
    ai_context_refreshed: s.ai_context_refreshed,
    query_smoke_run: s.query_smoke_run,
    collector_baseline_unchanged: s.collector_baseline_unchanged && sync.collector_baseline_unchanged,
    history_mtimes_unchanged: sync.history_mtimes_unchanged,
    no_live_jalan_collection: !s.live_jalan_collection,
    no_browser_automation: !s.browser_automation,
    no_external_fetch: !s.external_fetch,
    no_pricing_csv: !s.pricing_csv,
    no_pms_output: !s.pms_output,
    no_price_update: !s.price_update,
    no_base_times_1_1: !s.base_times_1_1,
    no_paid_source_tooling: !s.paid_source_tooling,
    no_github_actions_or_cron: !s.github_actions_or_cron,
    did_not_start_auto06x: !s.auto06x_started
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

export function decidePostJalanHistoryAppendRefresh(input: {
  db_sync_ok: boolean;
  context_refresh_ok: boolean;
  validation_ok: boolean;
  context_decision_is_caution: boolean;
}): PostJalanRefreshDecision {
  if (!input.db_sync_ok) return "post_jalan_history_append_refresh_not_ready";
  if (!input.context_refresh_ok) return "post_jalan_history_append_refresh_not_ready";
  if (!input.validation_ok) return "post_jalan_history_append_refresh_not_ready";
  if (input.context_decision_is_caution) return "post_jalan_history_append_refresh_basis_caution";
  return "post_jalan_history_append_refresh_success";
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
  jalan_rows: MetricDelta;
  booking_rows: MetricDelta;
  directional_rows: MetricDelta;
  direct_rows: MetricDelta;
  excluded_rows: MetricDelta;
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
    jalan_rows: delta(count(before.source_counts, "jalan"), count(after.source_counts, "jalan")),
    booking_rows: delta(count(before.source_counts, "booking"), count(after.source_counts, "booking")),
    directional_rows: delta(count(before.dp_usage_counts, "directional"), count(after.dp_usage_counts, "directional")),
    direct_rows: delta(count(before.dp_usage_counts, "direct"), count(after.dp_usage_counts, "direct")),
    excluded_rows: delta(count(before.dp_usage_counts, "excluded"), count(after.dp_usage_counts, "excluded"))
  };
}

// ---------------------------------------------------------------------------
// Price-pressure usability note (Jalan = supplementary domestic OTA signal)
// ---------------------------------------------------------------------------

export function buildPricePressureNote(
  jalan: JalanRowState,
  append: JalanAppendSummary
): { headline: string; statements: string[] } {
  return {
    headline:
      "JALAN-AUTO05X added Jalan rows as a supplementary domestic OTA signal; the refreshed mirror remains basis_caution.",
    statements: [
      `Jalan rows in DB: ${jalan.total_in_db} (directional ${jalan.directional_in_db}, excluded ${jalan.excluded_in_db}, direct ${jalan.direct_in_db}).`,
      `AUTO05X appended ${append.appended_row_count} rows (${append.directional_appended} directional price-pressure-usable + ${append.excluded_appended} excluded audit + ${append.direct_appended} direct).`,
      "Jalan directional rows are usable for demand / price-pressure detection, NOT for direct automatic price-setting.",
      `Jalan excluded audit rows (${jalan.excluded_in_db}) carry an exclusion reason and never enter price-pressure or DP usage.`,
      `The ${jalan.direct_in_db} Jalan direct rows are pre-existing A-confidence rows; AUTO05X added zero new direct rows.`,
      "Booking.com remains the primary directional market price-pressure backbone; Rakuten stays frozen / caution."
    ]
  };
}

// ---------------------------------------------------------------------------
// Report assembly + rendering
// ---------------------------------------------------------------------------

export interface PostJalanRefreshReport {
  run_id: string;
  generated_at_jst: string;
  decision: PostJalanRefreshDecision;
  source_auto05x_artifact: string;
  history_unique_row_id_count: number;
  jalan_history_row_count: number;
  booking_history_row_count: number;
  db_before: DbStateSnapshot;
  db_after: DbStateSnapshot;
  snapshot_diff: SnapshotDiff;
  jalan_append: JalanAppendSummary;
  db_sync: JalanDbSyncSummary;
  jalan_rows: JalanRowState;
  context_refresh: JalanContextSummary;
  task_smoke: TaskQuerySmokeSummary;
  validation: RefreshValidationResult;
  price_pressure_note: { headline: string; statements: string[] };
  safety: RefreshSafetyState;
  commands_run: string[];
  report_path: string;
  json_path: string;
  csv_path: string;
  debug_artifact_path: string;
  next_phase: string;
}

export function recommendedNextAction(decision: PostJalanRefreshDecision): string {
  if (
    decision === "post_jalan_history_append_refresh_success" ||
    decision === "post_jalan_history_append_refresh_basis_caution"
  ) {
    return "JALAN-AUTO06X (Jalan price-pressure usability verification). Do not start JALAN-AUTO06X without explicit instruction.";
  }
  return "Investigate the failed step; do not proceed until the refresh reconciles history=210 and DB=210.";
}

export function renderPostJalanRefreshCsv(report: PostJalanRefreshReport): string {
  const d = report.snapshot_diff;
  const headers = ["metric", "before", "after", "delta"];
  const rows: Array<[string, number, number, number]> = [
    ["market_signal_history_rows", d.market_signal_history_rows.before, d.market_signal_history_rows.after, d.market_signal_history_rows.delta],
    ["market_signal_sync_runs", d.market_signal_sync_runs.before, d.market_signal_sync_runs.after, d.market_signal_sync_runs.delta],
    ["jalan_rows", d.jalan_rows.before, d.jalan_rows.after, d.jalan_rows.delta],
    ["booking_rows", d.booking_rows.before, d.booking_rows.after, d.booking_rows.delta],
    ["directional_rows", d.directional_rows.before, d.directional_rows.after, d.directional_rows.delta],
    ["direct_rows", d.direct_rows.before, d.direct_rows.after, d.direct_rows.delta],
    ["excluded_rows", d.excluded_rows.before, d.excluded_rows.after, d.excluded_rows.delta]
  ];
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}

export function renderPostJalanRefreshReport(report: PostJalanRefreshReport): string {
  const d = report.snapshot_diff;
  const sync = report.db_sync;
  const j = report.jalan_rows;
  const ctx = report.context_refresh;
  const checkLine = (name: string, ok: boolean): string => `- ${ok ? "PASS" : "FAIL"} ${name}`;
  const signed = (n: number): string => `${n >= 0 ? "+" : ""}${n}`;
  const lines: string[] = [
    "# Phase JALAN-AUTO05B — Post Jalan-History-Append Refresh",
    "",
    `Generated at (JST): ${report.generated_at_jst}`,
    `Decision: ${report.decision}`,
    "",
    "## 1. Summary",
    "",
    `- Decision: ${report.decision}`,
    `- DB market_signal_history: ${d.market_signal_history_rows.before} → ${d.market_signal_history_rows.after} (now ${report.db_after.market_signal_history_rows})`,
    `- DB sync (185→210): inserted ${sync.inserted_rows}, skipped_identical ${sync.skipped_identical_rows}, conflicts ${sync.conflict_rows}`,
    `- Jalan rows in DB: ${j.total_in_db} (directional ${j.directional_in_db}, excluded ${j.excluded_in_db}, direct ${j.direct_in_db})`,
    `- Booking rows in DB: ${count(report.db_after.source_counts, "booking")} (primary backbone, unchanged)`,
    `- Context packs regenerated: ${ctx.context_packs_regenerated} (decision: ${ctx.decision})`,
    `- Bootstrap query: ${report.task_smoke.bootstrap_decision} (ok=${report.task_smoke.bootstrap_ok})`,
    "",
    "## 2. Source AUTO05X artifact",
    "",
    `- ${report.source_auto05x_artifact}`,
    `- decision: ${report.jalan_append.decision}`,
    `- appended: ${report.jalan_append.appended_row_count} (directional ${report.jalan_append.directional_appended} + excluded ${report.jalan_append.excluded_appended} + direct ${report.jalan_append.direct_appended}); conflicts ${report.jalan_append.conflict_rows}`,
    "",
    "## 3. Commands run",
    "",
    ...report.commands_run.map((c) => `- \`${c}\``),
    "",
    "## 4. History row-count summary",
    "",
    `- .data/history unique row_id count: ${report.history_unique_row_id_count}`,
    `- .data/history Jalan rows: ${report.jalan_history_row_count}`,
    `- .data/history Booking rows: ${report.booking_history_row_count}`,
    `- DB market_signal_history after: ${report.db_after.market_signal_history_rows}`,
    "",
    "## 5. DB sync result (185→210)",
    "",
    `- artifact: ${sync.artifact_path}`,
    `- decision: ${sync.decision}`,
    `- inserted: ${sync.inserted_rows}; skipped_identical: ${sync.skipped_identical_rows}; conflicts: ${sync.conflict_rows}`,
    `- all_source_row_ids_exist: ${sync.all_source_row_ids_exist}`,
    `- all_row_hashes_match: ${sync.all_row_hashes_match}`,
    `- duplicate_row_id_count: ${sync.duplicate_row_id_count}`,
    `- sync_run_record_exists: ${sync.sync_run_record_exists}`,
    `- market_signal_history_count: ${sync.market_signal_history_count}`,
    `- collector_baseline_unchanged: ${sync.collector_baseline_unchanged}`,
    `- history_mtimes_unchanged: ${sync.history_mtimes_unchanged}`,
    "",
    "## 6. DB before / after",
    "",
    `- market_signal_history_rows: ${d.market_signal_history_rows.before} → ${d.market_signal_history_rows.after} (${signed(d.market_signal_history_rows.delta)})`,
    `- jalan_rows: ${d.jalan_rows.before} → ${d.jalan_rows.after} (${signed(d.jalan_rows.delta)})`,
    `- booking_rows: ${d.booking_rows.before} → ${d.booking_rows.after} (${signed(d.booking_rows.delta)})`,
    `- directional_rows: ${d.directional_rows.before} → ${d.directional_rows.after} (${signed(d.directional_rows.delta)})`,
    `- direct_rows: ${d.direct_rows.before} → ${d.direct_rows.after} (${signed(d.direct_rows.delta)})`,
    `- excluded_rows: ${d.excluded_rows.before} → ${d.excluded_rows.after} (${signed(d.excluded_rows.delta)})`,
    "",
    "## 7. Jalan composition in DB",
    "",
    `- total: ${j.total_in_db}; directional: ${j.directional_in_db}; excluded: ${j.excluded_in_db}; direct: ${j.direct_in_db}`,
    `- excluded rows leaked to a usable dp_usage: ${j.excluded_leaked_to_usable} (must be 0)`,
    "",
    "## 8. AI context refresh result",
    "",
    `- decision: ${ctx.decision}`,
    `- regenerated: ${ctx.context_packs_regenerated}; real files (not symlinks): ${ctx.context_packs_are_real_files}`,
    `- context history row count: ${ctx.context_history_row_count}`,
    `- context Jalan source count: ${ctx.context_jalan_source_count}`,
    `- context Booking source count: ${ctx.context_booking_source_count}`,
    ...ctx.regenerated_files.map((f) => `  - ${f}`),
    "",
    "## 9. Task query smoke result",
    "",
    `- bootstrap: ${report.task_smoke.bootstrap_decision} (ok=${report.task_smoke.bootstrap_ok})`,
    ...report.task_smoke.optional_tasks.map((t) => `- ${t.task}: ${t.decision} (ok=${t.ok})`),
    "",
    "## 10. Jalan price-pressure usability note",
    "",
    `- ${report.price_pressure_note.headline}`,
    ...report.price_pressure_note.statements.map((s) => `- ${s}`),
    "",
    "## 11. Validation",
    "",
    `- ok: ${report.validation.ok}`,
    ...Object.entries(report.validation.checks).map(([name, ok]) => checkLine(name, ok)),
    "",
    "## 12. Decision",
    "",
    `- ${report.decision}`,
    "",
    "## 13. Recommended next action",
    "",
    `- ${recommendedNextAction(report.decision)}`,
    ""
  ];
  return lines.join("\n");
}
