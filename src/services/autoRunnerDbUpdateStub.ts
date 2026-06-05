// Phase AUTO-RUNNER07E - disabled end-to-end DB update runner stub.
//
// This module builds a dry-run run plan. It does not execute collectors,
// append history, sync DB, refresh AI context, run query smoke, or generate
// pricing/PMS output.

import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AutoRunnerDbUpdateStubDecision =
  | "auto_runner_db_update_stub_ready_not_run"
  | "auto_runner_db_update_stub_plan_ready"
  | "auto_runner_db_update_stub_not_ready";

export interface CurrentStateSummary {
  history_rows: number;
  db_rows: number;
  ai_context_rows: number;
  booking: { rows: number; directional: number; excluded: number; direct: number; role: string };
  jalan: { rows: number; directional: number; excluded: number; direct: number; role: string };
  rakuten: { rows: number; role: string };
  history_files: string[];
}

export interface GateEvaluation {
  gate: string;
  value: "0" | "1";
  enabled: boolean;
  source: "env" | "default";
}

export interface SourceStageLike {
  stage_id: number;
  name: string;
  candidate_commands?: string[];
  required_gates?: string[];
  mutation_level?: StagePlan["mutation_level"];
}

export interface StagePlan {
  stage_id: number;
  stage_name: string;
  enabled: boolean;
  disabled_reason: string;
  required_gates: string[];
  candidate_command: string;
  mutation_level: "none" | "preview_artifacts" | "history_write_gated" | "db_write_gated" | "context_write_gated" | "summary_artifact";
  would_execute: boolean;
  actual_executed: false;
  safety_notes: string[];
}

export interface PriceOutputSeparation {
  price_report_out_of_scope: true;
  csv_pms_output_out_of_scope: true;
  ignored_even_if_requested: string[];
  rule: string;
}

export interface SafetyConfirmation {
  mutation_executed: false;
  risky_stages_enabled: number;
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

export interface AutoRunnerDbUpdateStubOutput {
  run_id: string;
  generated_at_jst: string;
  decision: AutoRunnerDbUpdateStubDecision;
  source_auto_runner07d_artifact: string;
  source_schedule_config_artifact: string;
  current_state_summary: CurrentStateSummary;
  gate_evaluation: GateEvaluation[];
  stage_plan: StagePlan[];
  price_output_separation: PriceOutputSeparation;
  safety_confirmation: SafetyConfirmation;
  next_phase: string;
  report_path?: string;
  json_path?: string;
  csv_path?: string;
  debug_artifact_path?: string;
}

export const DB_UPDATE_STUB_GATES = [
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
] as const;

export function buildCurrentStateSummary(input: {
  history: HistoryStateSummary;
  dbRows: number;
  aiContextRows: number;
}): CurrentStateSummary {
  const booking = input.history.sources["booking"] ?? emptySourceCounts();
  const jalan = input.history.sources["jalan"] ?? emptySourceCounts();
  return {
    history_rows: input.history.row_count,
    db_rows: input.dbRows,
    ai_context_rows: input.aiContextRows,
    booking: { rows: booking.rows, directional: booking.directional, excluded: booking.excluded, direct: booking.direct, role: "primary directional backbone" },
    jalan: { rows: jalan.rows, directional: jalan.directional, excluded: jalan.excluded, direct: jalan.direct, role: "supplementary domestic OTA signal" },
    rakuten: { rows: input.history.sources["rakuten"]?.rows ?? 0, role: "frozen / caution" },
    history_files: input.history.files
  };
}

export function evaluateGates(env: Record<string, string | undefined>): GateEvaluation[] {
  return DB_UPDATE_STUB_GATES.map((gate) => {
    const raw = env[gate];
    const value = raw === "1" ? "1" : "0";
    return { gate, value, enabled: value === "1", source: raw === undefined ? "default" : "env" };
  });
}

export function buildStagePlan(stages: SourceStageLike[], gates: GateEvaluation[]): StagePlan[] {
  return stages.map((item) => {
    const candidateCommand = candidateCommandForStage(item);
    const requiredGates = item.required_gates ?? ["none"];
    const enabled = requiredGatesSatisfied(requiredGates, gates);
    const mutationLevel = item.mutation_level ?? "summary_artifact";
    return {
      stage_id: item.stage_id,
      stage_name: item.name,
      enabled,
      disabled_reason: enabled ? "" : disabledReason(requiredGates, gates),
      required_gates: requiredGates,
      candidate_command: candidateCommand,
      mutation_level: mutationLevel,
      would_execute: enabled,
      actual_executed: false,
      safety_notes: safetyNotesForStage(item.stage_id, mutationLevel, candidateCommand)
    };
  });
}

export function buildPriceOutputSeparation(): PriceOutputSeparation {
  return {
    price_report_out_of_scope: true,
    csv_pms_output_out_of_scope: true,
    ignored_even_if_requested: ["GENERATE_PRICE_REPORT", "GENERATE_PRICE_CSV"],
    rule: "AUTO-RUNNER07E writes a machine-readable run plan only; pricing reports, CSV files, PMS output, and price updates are separate future/on-demand work."
  };
}

export function buildSafetyConfirmation(stagePlan: readonly StagePlan[]): SafetyConfirmation {
  const riskyStageIds = new Set([3, 4, 7, 8, 9]);
  const riskyStagesEnabled = stagePlan.filter((stage) => stage.enabled && riskyStageIds.has(stage.stage_id)).length;
  return {
    mutation_executed: false,
    risky_stages_enabled: riskyStagesEnabled,
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

export function decideAutoRunnerDbUpdateStub(input: { sourceArtifactsPresent: boolean; currentStateReady: boolean; riskyStagesEnabled: number }): AutoRunnerDbUpdateStubDecision {
  if (!input.sourceArtifactsPresent || !input.currentStateReady) return "auto_runner_db_update_stub_not_ready";
  if (input.riskyStagesEnabled > 0) return "auto_runner_db_update_stub_plan_ready";
  return "auto_runner_db_update_stub_ready_not_run";
}

export interface HistoryStateSummary {
  row_count: number;
  files: string[];
  sources: Record<string, SourceCounts>;
}

interface SourceCounts {
  rows: number;
  directional: number;
  excluded: number;
  direct: number;
}

export function summarizeHistoryState(historyDir: string): HistoryStateSummary {
  const files = readdirSync(historyDir)
    .filter((name) => /^zao_signals_.*\.csv$/u.test(name))
    .sort()
    .map((name) => join(historyDir, name));
  const sources: Record<string, SourceCounts> = {};
  let rowCount = 0;

  for (const file of files) {
    const lines = readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.length > 0);
    const headerLine = lines[0];
    if (headerLine === undefined) continue;
    const headers = parseCsvLine(headerLine);
    const sourceIndex = headers.indexOf("source");
    const dpUsageIndex = headers.indexOf("dp_usage");
    const directIndex = headers.indexOf("is_price_usable_for_dp_direct");
    const directionalIndex = headers.indexOf("is_price_usable_for_dp_directional");
    const excludedIndex = headers.indexOf("is_price_excluded_from_dp");
    for (const line of lines.slice(1)) {
      rowCount += 1;
      const cells = parseCsvLine(line);
      const source = cells[sourceIndex] ?? "unknown";
      const dpUsage = cells[dpUsageIndex] ?? "";
      const counts = (sources[source] ??= emptySourceCounts());
      counts.rows += 1;
      const excluded = dpUsage === "excluded" || isTruthyCell(cells[excludedIndex]);
      const direct = dpUsage === "direct" || isTruthyCell(cells[directIndex]);
      const directional = dpUsage === "directional" || isTruthyCell(cells[directionalIndex]);
      if (excluded) counts.excluded += 1;
      else if (direct) counts.direct += 1;
      else if (directional) counts.directional += 1;
    }
  }

  return { row_count: rowCount, files, sources };
}

export function summarizeDbRowsReadOnly(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM market_signal_history").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

export function summarizeAiContextRows(snapshotPath: string): number {
  if (!existsSync(snapshotPath)) return 0;
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { market_signal_history_row_count?: number };
  return snapshot.market_signal_history_row_count ?? 0;
}

export function renderStagePlanCsv(stagePlan: readonly StagePlan[]): string {
  const rows = [["stage_id", "stage_name", "enabled", "disabled_reason", "required_gates", "candidate_command", "mutation_level", "would_execute", "actual_executed"]];
  for (const stage of stagePlan) {
    rows.push([
      String(stage.stage_id),
      stage.stage_name,
      String(stage.enabled),
      stage.disabled_reason,
      stage.required_gates.join("; "),
      stage.candidate_command,
      stage.mutation_level,
      String(stage.would_execute),
      String(stage.actual_executed)
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function renderReport(input: AutoRunnerDbUpdateStubOutput): string {
  return `# Auto Runner DB Update Stub

Generated at JST: ${input.generated_at_jst}

## 1. Executive Summary
AUTO-RUNNER07E implements the first executable DB update runner stub. It inspects state, evaluates gates, writes a dry-run plan, and executes no risky stage.

## 2. Source AUTO-RUNNER07D Result
- AUTO-RUNNER07D artifact: ${input.source_auto_runner07d_artifact}
- Schedule config artifact: ${input.source_schedule_config_artifact}

## 3. Current State
- History rows: ${input.current_state_summary.history_rows}
- DB rows: ${input.current_state_summary.db_rows}
- AI context rows: ${input.current_state_summary.ai_context_rows}
- Booking: ${input.current_state_summary.booking.rows} rows, ${input.current_state_summary.booking.directional} directional, ${input.current_state_summary.booking.excluded} excluded, ${input.current_state_summary.booking.direct} direct
- Jalan: ${input.current_state_summary.jalan.rows} rows, ${input.current_state_summary.jalan.directional} directional, ${input.current_state_summary.jalan.excluded} excluded, ${input.current_state_summary.jalan.direct} direct
- Rakuten: ${input.current_state_summary.rakuten.rows} rows, role ${input.current_state_summary.rakuten.role}

## 4. Gate Evaluation
${input.gate_evaluation.map((gate) => `- ${gate.gate}: ${gate.value} (${gate.source})`).join("\n")}

## 5. Stage Plan
${input.stage_plan.map((stage) => `- Stage ${stage.stage_id} - ${stage.stage_name}: enabled=${stage.enabled}; would_execute=${stage.would_execute}; actual_executed=${stage.actual_executed}; command=${stage.candidate_command || "none"}; disabled_reason=${stage.disabled_reason || "none"}`).join("\n")}

## 6. Price Output Separation
- Price report out of scope: ${input.price_output_separation.price_report_out_of_scope}
- CSV/PMS output out of scope: ${input.price_output_separation.csv_pms_output_out_of_scope}
- Rule: ${input.price_output_separation.rule}

## 7. Safety Confirmation
${Object.entries(input.safety_confirmation).map(([key, value]) => `- ${key}: ${value}`).join("\n")}

## 8. Decision
${input.decision}

## 9. Next Phase
${input.next_phase}
`;
}

function requiredGatesSatisfied(requiredGates: readonly string[], gates: readonly GateEvaluation[]): boolean {
  if (requiredGates.length === 0 || requiredGates.every((gate) => gate === "none")) return true;
  const gateMap = new Map(gates.map((gate) => [gate.gate, gate.enabled]));
  return requiredGates.every((required) => {
    if (required === "none") return true;
    if (required.includes(" or ")) {
      return required.split(" or ").some((part) => gateMap.get(part.replace("=1", "")) === true);
    }
    if (required.endsWith("=0")) return gateMap.get(required.replace("=0", "")) !== true;
    if (required.endsWith("=1")) return gateMap.get(required.replace("=1", "")) === true;
    return false;
  });
}

function disabledReason(requiredGates: readonly string[], gates: readonly GateEvaluation[]): string {
  if (requiredGates.length === 0 || requiredGates.every((gate) => gate === "none")) return "";
  const gateMap = new Map(gates.map((gate) => [gate.gate, gate.enabled]));
  const missing = requiredGates.filter((required) => {
    if (required === "none") return false;
    if (required.includes(" or ")) {
      return !required.split(" or ").some((part) => gateMap.get(part.replace("=1", "")) === true);
    }
    if (required.endsWith("=0")) return gateMap.get(required.replace("=0", "")) === true;
    if (required.endsWith("=1")) return gateMap.get(required.replace("=1", "")) !== true;
    return true;
  });
  return missing.length === 0 ? "" : `disabled because required gate(s) are not satisfied: ${missing.join(", ")}`;
}

function candidateCommandForStage(stage: SourceStageLike): string {
  if (stage.stage_id === 3) return "npm run probe:booking-bounded-expanded";
  if (stage.stage_id === 4) return "npm run probe:jalan-bounded-collection-improved";
  if (stage.stage_id === 8) return "npm run sync:history-to-db:fresh";
  if (stage.stage_id === 9) return "npm run build:ai-context-packs";
  return stage.candidate_commands?.[0]?.replace(/^future: /u, "") ?? "";
}

function safetyNotesForStage(stageId: number, mutationLevel: StagePlan["mutation_level"], candidateCommand: string): string[] {
  const notes = ["AUTO-RUNNER07E is planner-only; actual_executed remains false."];
  if (mutationLevel !== "none" && mutationLevel !== "summary_artifact") notes.push("Risky execution is deferred to a future explicitly approved phase.");
  if (stageId === 12) notes.push("Price report, CSV, and PMS output are out of scope even if gates are present.");
  if (candidateCommand.length > 0) notes.push("Candidate command is inert text in this phase.");
  return notes;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function emptySourceCounts(): SourceCounts {
  return { rows: 0, directional: 0, excluded: 0, direct: 0 };
}

function isTruthyCell(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
