// Phase AUTO-RUNNER13X - operations summary helpers (pure).
//
// This module is pure: no filesystem, no subprocess, no browser, no DB. The
// companion script gathers read-only evidence (git, launchctl inspection,
// read-only counts, latest artifact) and passes it here for classification and
// rendering. It never runs collectors, appends history, syncs the DB, refreshes
// AI context, or emits pricing/PMS output.

export const EXPECTED_BASELINE_ROW_COUNT = 246;

export const EXPECTED_LAUNCHD_JOBS = [
  "com.yuge.zmi.health-check",
  "com.yuge.zmi.db-update-dry-run",
  "com.yuge.zmi.market-refresh-live"
] as const;

export const FORBIDDEN_LAUNCHD_JOB = "com.yuge.zmi.market-refresh-gated";

export type OpsStatus =
  | "ops_healthy"
  | "ops_waiting_first_scheduled_run"
  | "ops_baseline_stale_after_safe_append"
  | "ops_blocked_hard_conflict"
  | "ops_db_ai_mismatch"
  | "ops_duplicate_row_id_detected"
  | "ops_launchd_not_ready"
  | "ops_unknown";

export type RunTrigger = "scheduled" | "manual_kickstart" | "none";

export interface LaunchdPresence {
  health_check: boolean;
  db_update_dry_run: boolean;
  market_refresh_live: boolean;
  gated_absent: boolean;
}

export interface LatestRunEvidence {
  artifact_timestamp: string;
  artifact_path: string;
  trigger: RunTrigger;
  decision: string;
  append_count: number;
  skipped_identical_count: number;
  intraday_price_change_count: number;
  hard_conflict_count: number;
  pricing_pms_output_count: number;
}

export interface OpsCounts {
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  booking: number;
  jalan: number;
  rakuten: number;
  duplicate_row_id_count: number;
}

export interface OpsSummaryInput {
  now_jst: string;
  git_head: string;
  working_tree_clean: boolean;
  launchd: LaunchdPresence;
  latest_run: LatestRunEvidence;
  counts: OpsCounts;
  baseline_expected: number;
  scheduled_run_observed: boolean;
  health_check_status: string;
  db_update_status: string;
}

export interface OpsSummaryResult {
  status: OpsStatus;
  baseline_stale: boolean;
  recommended_next_action: string;
  forbidden_output_detected: boolean;
}

export function launchdReady(launchd: LaunchdPresence): boolean {
  return launchd.health_check && launchd.db_update_dry_run && launchd.market_refresh_live && launchd.gated_absent;
}

export function decideOpsStatus(input: OpsSummaryInput): OpsStatus {
  const c = input.counts;
  if (c.duplicate_row_id_count > 0) return "ops_duplicate_row_id_detected";
  if (!launchdReady(input.launchd)) return "ops_launchd_not_ready";
  if (c.history_rows !== c.db_rows || c.db_rows !== c.ai_context_rows) return "ops_db_ai_mismatch";
  if (input.latest_run.hard_conflict_count > 0) return "ops_blocked_hard_conflict";
  if (c.history_rows !== input.baseline_expected) return "ops_baseline_stale_after_safe_append";
  if (!input.scheduled_run_observed) return "ops_waiting_first_scheduled_run";
  return "ops_healthy";
}

export function recommendedActionFor(status: OpsStatus): string {
  switch (status) {
    case "ops_healthy":
      return "No action needed. Continue observing the daily scheduled run.";
    case "ops_waiting_first_scheduled_run":
      return "Wait for the first scheduled 09:00 JST run, then run AUTO-RUNNER12X-RETRY to verify it.";
    case "ops_baseline_stale_after_safe_append":
      return "A safe append changed canonical counts. Run AUTO-RUNNER12Y-COMMIT to update baseline and commit canonical history.";
    case "ops_blocked_hard_conflict":
      return "Hard conflict in the latest run. Review the conflict_classification artifact; do not auto-repair.";
    case "ops_db_ai_mismatch":
      return "history/DB/AI-context counts diverge. Investigate the last sync/context step; do not mutate without review.";
    case "ops_duplicate_row_id_detected":
      return "Duplicate row_id detected. Stop and investigate history integrity before any further run.";
    case "ops_launchd_not_ready":
      return "Expected launchd jobs are not all present (or the gated job lingers). Inspect launchctl; repair only with approval.";
    default:
      return "Unknown ops state. Inspect manually.";
  }
}

export function buildOpsSummaryResult(input: OpsSummaryInput): OpsSummaryResult {
  const status = decideOpsStatus(input);
  return {
    status,
    baseline_stale: input.counts.history_rows !== input.baseline_expected,
    recommended_next_action: recommendedActionFor(status),
    forbidden_output_detected: input.latest_run.pricing_pms_output_count > 0
  };
}

export const ROADMAP_NOTE = [
  "12X deferred: verify the first real scheduled 09:00 run after it occurs.",
  "13X completed: ops summary tool implemented.",
  "14X completed: time-bucketed dry-run collection scope planner implemented.",
  "Next: 15X planner-driven controlled live expansion; D01-D04 unified property discovery."
] as const;

export function renderOpsSummaryReport(input: OpsSummaryInput, result: OpsSummaryResult): string {
  const c = input.counts;
  const r = input.latest_run;
  return `# Auto Runner Ops Summary (AUTO-RUNNER13X)

Generated at JST: ${input.now_jst}

## 1. Status

- status: ${result.status}
- recommended_next_action: ${result.recommended_next_action}

## 2. Git

- HEAD: ${input.git_head}
- working_tree_clean: ${input.working_tree_clean}

## 3. Launchd Jobs

- com.yuge.zmi.health-check: ${input.launchd.health_check}
- com.yuge.zmi.db-update-dry-run: ${input.launchd.db_update_dry_run}
- com.yuge.zmi.market-refresh-live: ${input.launchd.market_refresh_live}
- com.yuge.zmi.market-refresh-gated absent: ${input.launchd.gated_absent}

## 4. Latest market-refresh-live Run

- trigger: ${r.trigger}
- scheduled_run_observed: ${input.scheduled_run_observed}
- artifact_timestamp: ${r.artifact_timestamp}
- artifact_path: ${r.artifact_path}
- decision: ${r.decision}
- append_count: ${r.append_count}
- skipped_identical_count: ${r.skipped_identical_count}
- intraday_price_change_count: ${r.intraday_price_change_count}
- hard_conflict_count: ${r.hard_conflict_count}
- pricing_pms_output_count: ${r.pricing_pms_output_count}

## 5. Counts

- history_rows: ${c.history_rows}
- db_rows: ${c.db_rows}
- ai_context_rows: ${c.ai_context_rows}
- baseline_expected: ${input.baseline_expected}
- baseline_stale: ${result.baseline_stale}
- duplicate_row_id_count: ${c.duplicate_row_id_count}
- Booking: ${c.booking}
- Jalan: ${c.jalan}
- Rakuten: ${c.rakuten}

## 6. Runner Status

- health_check_status: ${input.health_check_status}
- db_update_status: ${input.db_update_status}

## 7. Roadmap

${ROADMAP_NOTE.map((line) => `- ${line}`).join("\n")}
`;
}
