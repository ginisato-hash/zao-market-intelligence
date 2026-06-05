// Phase AUTO-RUNNER07F - dry-run-only auto-runner health check.
//
// This module verifies state and runner-plan safety. It does not execute
// collectors, appends, DB sync, AI context refresh, query smoke, pricing
// reports, CSV, PMS output, launchd, cron, or GitHub Actions.

import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildCurrentStateSummary,
  summarizeAiContextRows,
  summarizeDbRowsReadOnly,
  summarizeHistoryState,
  type AutoRunnerDbUpdateStubOutput,
  type CurrentStateSummary,
  type GateEvaluation
} from "./autoRunnerDbUpdateStub";

export { evaluateGates } from "./autoRunnerDbUpdateStub";

export type AutoRunnerHealthCheckDecision = "auto_runner_health_check_ready" | "auto_runner_health_check_basis_caution" | "auto_runner_health_check_not_ready";

export interface CurrentStateSnapshot {
  current_state_summary: CurrentStateSummary;
  history_mtimes: Record<string, number>;
  collector_baseline: CollectorBaseline;
}

export interface CollectorBaseline {
  collector_runs_count: number;
  rate_snapshots_count: number;
  inventory_snapshots_count: number;
}

export interface RunnerStubSummary {
  run_id: string;
  decision: string;
  mutation_executed: boolean;
  risky_stages_enabled: number;
  risky_actual_executed_count: number;
  all_risky_actual_executed_false: boolean;
}

export interface MutationCheck {
  history_count_unchanged: boolean;
  db_count_unchanged: boolean;
  ai_context_count_unchanged: boolean;
  history_mtimes_unchanged: boolean;
  collector_baseline_unchanged: boolean;
  mutation_detected: boolean;
  details: string[];
}

export interface SafetyConfirmation {
  live_booking_collection: false;
  live_jalan_collection: false;
  collector_command_executed: false;
  sync_command_executed: false;
  db_write: false;
  db_sync: false;
  ai_context_refresh: false;
  query_smoke: false;
  history_modification: false;
  history_append: false;
  playwright_launch: false;
  browser_automation: false;
  external_fetch: false;
  price_decision_report_generation: false;
  beds24_csv_generation: false;
  airhost_csv_generation: false;
  pms_ota_channel_manager_output: false;
  price_update: false;
  launchd_cron_github_actions_creation: false;
  git_add_commit_push: false;
  started_next_phase: false;
}

export interface AutoRunnerHealthCheckOutput {
  run_id: string;
  generated_at_jst: string;
  decision: AutoRunnerHealthCheckDecision;
  source_auto_runner07e_artifact: string;
  current_state_before: CurrentStateSnapshot;
  current_state_after: CurrentStateSnapshot;
  gate_evaluation: GateEvaluation[];
  runner_stub_summary: RunnerStubSummary;
  mutation_check: MutationCheck;
  run_state_artifact: string;
  log_artifact: string;
  safety_confirmation: SafetyConfirmation;
  next_phase: string;
  report_path?: string;
  json_path?: string;
  csv_path?: string;
  debug_artifact_path?: string;
}

const RISKY_GATES = new Set([
  "ZMI_AUTORUN_ENABLED",
  "COLLECT_BOOKING",
  "COLLECT_JALAN",
  "ALLOW_HISTORY_APPEND",
  "BOOKING_HISTORY_APPEND",
  "JALAN_HISTORY_APPEND",
  "HISTORY_TO_DB_SYNC",
  "BUILD_AI_CONTEXT",
  "RUN_USABILITY_CHECK",
  "GENERATE_PRICE_REPORT",
  "GENERATE_PRICE_CSV"
]);

export function buildCurrentStateSnapshot(input: { historyDir: string; dbPath: string; aiContextPath: string }): CurrentStateSnapshot {
  const history = summarizeHistoryState(input.historyDir);
  return {
    current_state_summary: buildCurrentStateSummary({
      history,
      dbRows: summarizeDbRowsReadOnly(input.dbPath),
      aiContextRows: summarizeAiContextRows(input.aiContextPath)
    }),
    history_mtimes: historyMtimes(input.historyDir),
    collector_baseline: readCollectorBaselineReadOnly(input.dbPath)
  };
}

export function summarizeRunnerStub(stub: AutoRunnerDbUpdateStubOutput): RunnerStubSummary {
  const riskyActualExecuted = stub.stage_plan.filter((stage) => [3, 4, 7, 8, 9].includes(stage.stage_id) && (stage.actual_executed as boolean)).length;
  return {
    run_id: stub.run_id,
    decision: stub.decision,
    mutation_executed: stub.safety_confirmation.mutation_executed,
    risky_stages_enabled: stub.safety_confirmation.risky_stages_enabled,
    risky_actual_executed_count: riskyActualExecuted,
    all_risky_actual_executed_false: riskyActualExecuted === 0
  };
}

export function buildMutationCheck(before: CurrentStateSnapshot, after: CurrentStateSnapshot): MutationCheck {
  const details: string[] = [];
  const historyCountUnchanged = before.current_state_summary.history_rows === after.current_state_summary.history_rows;
  const dbCountUnchanged = before.current_state_summary.db_rows === after.current_state_summary.db_rows;
  const aiContextCountUnchanged = before.current_state_summary.ai_context_rows === after.current_state_summary.ai_context_rows;
  const historyMtimesUnchanged = JSON.stringify(before.history_mtimes) === JSON.stringify(after.history_mtimes);
  const collectorBaselineUnchanged = JSON.stringify(before.collector_baseline) === JSON.stringify(after.collector_baseline);
  if (!historyCountUnchanged) details.push("history row count changed");
  if (!dbCountUnchanged) details.push("DB row count changed");
  if (!aiContextCountUnchanged) details.push("AI context row count changed");
  if (!historyMtimesUnchanged) details.push("history shard mtimes changed");
  if (!collectorBaselineUnchanged) details.push("collector baseline changed");
  return {
    history_count_unchanged: historyCountUnchanged,
    db_count_unchanged: dbCountUnchanged,
    ai_context_count_unchanged: aiContextCountUnchanged,
    history_mtimes_unchanged: historyMtimesUnchanged,
    collector_baseline_unchanged: collectorBaselineUnchanged,
    mutation_detected: details.length > 0,
    details
  };
}

export function decideAutoRunnerHealthCheck(input: {
  stateCountsMatchExpected: boolean;
  gates: GateEvaluation[];
  runnerStub: RunnerStubSummary;
  mutation: MutationCheck;
  sourceArtifactPresent: boolean;
}): AutoRunnerHealthCheckDecision {
  if (!input.sourceArtifactPresent || !input.stateCountsMatchExpected || input.mutation.mutation_detected) return "auto_runner_health_check_not_ready";
  if (input.runnerStub.mutation_executed || input.runnerStub.risky_actual_executed_count > 0 || input.runnerStub.risky_stages_enabled > 0) return "auto_runner_health_check_not_ready";
  const unexpectedEnabledGate = input.gates.some((gate) => RISKY_GATES.has(gate.gate) && gate.enabled);
  if (unexpectedEnabledGate) return "auto_runner_health_check_basis_caution";
  if (input.runnerStub.decision !== "auto_runner_db_update_stub_ready_not_run") return "auto_runner_health_check_basis_caution";
  return "auto_runner_health_check_ready";
}

export function buildSafetyConfirmation(): SafetyConfirmation {
  return {
    live_booking_collection: false,
    live_jalan_collection: false,
    collector_command_executed: false,
    sync_command_executed: false,
    db_write: false,
    db_sync: false,
    ai_context_refresh: false,
    query_smoke: false,
    history_modification: false,
    history_append: false,
    playwright_launch: false,
    browser_automation: false,
    external_fetch: false,
    price_decision_report_generation: false,
    beds24_csv_generation: false,
    airhost_csv_generation: false,
    pms_ota_channel_manager_output: false,
    price_update: false,
    launchd_cron_github_actions_creation: false,
    git_add_commit_push: false,
    started_next_phase: false
  };
}

export function renderHealthCheckCsv(output: AutoRunnerHealthCheckOutput): string {
  const rows = [
    ["metric", "value"],
    ["decision", output.decision],
    ["history_before", String(output.current_state_before.current_state_summary.history_rows)],
    ["history_after", String(output.current_state_after.current_state_summary.history_rows)],
    ["db_before", String(output.current_state_before.current_state_summary.db_rows)],
    ["db_after", String(output.current_state_after.current_state_summary.db_rows)],
    ["ai_context_before", String(output.current_state_before.current_state_summary.ai_context_rows)],
    ["ai_context_after", String(output.current_state_after.current_state_summary.ai_context_rows)],
    ["runner_stub_decision", output.runner_stub_summary.decision],
    ["risky_stages_enabled", String(output.runner_stub_summary.risky_stages_enabled)],
    ["mutation_detected", String(output.mutation_check.mutation_detected)]
  ];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function renderHealthCheckLog(output: AutoRunnerHealthCheckOutput): string {
  return [
    `run_id=${output.run_id}`,
    `generated_at_jst=${output.generated_at_jst}`,
    `decision=${output.decision}`,
    `history_count=${output.current_state_after.current_state_summary.history_rows}`,
    `db_count=${output.current_state_after.current_state_summary.db_rows}`,
    `ai_context_count=${output.current_state_after.current_state_summary.ai_context_rows}`,
    `runner_stub_decision=${output.runner_stub_summary.decision}`,
    `risky_stages_enabled=${output.runner_stub_summary.risky_stages_enabled}`,
    `mutation_detected=${output.mutation_check.mutation_detected}`,
    `report_path=${output.report_path ?? ""}`,
    `json_path=${output.json_path ?? ""}`
  ].join("\n") + "\n";
}

export function renderReport(output: AutoRunnerHealthCheckOutput): string {
  return `# Auto Runner Health Check

Generated at JST: ${output.generated_at_jst}

## 1. Executive Summary
AUTO-RUNNER07F verifies always-on-Mac readiness in dry-run-only mode. It reads state, gates, and the latest runner-stub artifact, checks for mutation, and writes health-check, run-state, and log artifacts.

## 2. Source AUTO-RUNNER07E Result
- Source artifact: ${output.source_auto_runner07e_artifact}
- Stub decision: ${output.runner_stub_summary.decision}

## 3. Current State Before
- History rows: ${output.current_state_before.current_state_summary.history_rows}
- DB rows: ${output.current_state_before.current_state_summary.db_rows}
- AI context rows: ${output.current_state_before.current_state_summary.ai_context_rows}

## 4. Gate Evaluation
${output.gate_evaluation.map((gate) => `- ${gate.gate}: ${gate.value} (${gate.source})`).join("\n")}

## 5. Runner Stub Summary
- Run id: ${output.runner_stub_summary.run_id}
- Risky stages enabled: ${output.runner_stub_summary.risky_stages_enabled}
- Risky actual executed count: ${output.runner_stub_summary.risky_actual_executed_count}
- Mutation executed: ${output.runner_stub_summary.mutation_executed}

## 6. Mutation Check
- History count unchanged: ${output.mutation_check.history_count_unchanged}
- DB count unchanged: ${output.mutation_check.db_count_unchanged}
- AI context count unchanged: ${output.mutation_check.ai_context_count_unchanged}
- History mtimes unchanged: ${output.mutation_check.history_mtimes_unchanged}
- Collector baseline unchanged: ${output.mutation_check.collector_baseline_unchanged}
- Mutation detected: ${output.mutation_check.mutation_detected}
- Details: ${output.mutation_check.details.join("; ") || "none"}

## 7. Run-State / Log Artifacts
- Run-state artifact: ${output.run_state_artifact}
- Log artifact: ${output.log_artifact}

## 8. Safety Confirmation
${Object.entries(output.safety_confirmation).map(([key, value]) => `- ${key}: ${value}`).join("\n")}

## 9. Decision
${output.decision}

## 10. Next Phase
${output.next_phase}
`;
}

function historyMtimes(historyDir: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const name of readdirSync(historyDir).filter((item) => /^zao_signals_.*\.csv$/u.test(item)).sort()) {
    const path = join(historyDir, name);
    result[path] = statSync(path).mtimeMs;
  }
  return result;
}

function readCollectorBaselineReadOnly(dbPath: string): CollectorBaseline {
  if (!existsSync(dbPath)) return { collector_runs_count: 0, rate_snapshots_count: 0, inventory_snapshots_count: 0 };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      collector_runs_count: countTable(db, "collector_runs"),
      rate_snapshots_count: countTable(db, "rate_snapshots"),
      inventory_snapshots_count: countTable(db, "inventory_snapshots")
    };
  } finally {
    db.close();
  }
}

function countTable(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
