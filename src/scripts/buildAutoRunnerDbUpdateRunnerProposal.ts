// Phase AUTO-RUNNER07X - build automated market signal DB update runner proposal.
//
// Writes design/report artifacts only. It does not run collectors, append
// history, sync DB, refresh AI context, run query smoke, create schedules, or
// generate price report / CSV / PMS output.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildAiContextPolicy,
  buildAppendPolicy,
  buildBatchSelectionPolicy,
  buildCurrentStateSummary,
  buildDbSyncPolicy,
  buildDbUpdatePipelineStages,
  buildFailureHandlingPlan,
  buildFutureRunnerCommandDesign,
  buildGateMatrix,
  buildPriceOutputSeparation,
  buildRisks,
  buildSafetyConfirmation,
  buildUsabilityIntegrityPolicy,
  decideAutoRunnerDbUpdateRunner,
  renderPipelineCsv,
  renderReport,
  type CurrentStateSummary,
  type ScheduleConfigLike
} from "../services/autoRunnerDbUpdateRunnerProposal";

const SOURCE_AUTO_RUNNER06X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_artifact_sync_proposal_20260605_155852.json";
const SOURCE_SCHEDULE_CONFIG_ARTIFACT_PATH = ".data/reports/automation/auto_runner_bounded_schedule_config_20260605_154449.json";
const SOURCE_AUTO_RUNNER03X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_manual_workflow_proposal_20260605_131913.json";
const SOURCE_AUTO_RUNNER04X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_launchd_schedule_proposal_20260605_153312.json";
const BOOKING_USABILITY_ARTIFACT_PATH = ".data/reports/automation/booking_price_pressure_usability_20260604_213713.json";
const JALAN_USABILITY_ARTIFACT_PATH = ".data/reports/automation/jalan_price_pressure_usability_20260605_110311.json";
const BOOKING_COLLECTION_ARTIFACT_PATH = ".data/reports/source-discovery/booking_bounded_expanded_collection_20260604_161623.json";
const JALAN_COLLECTION_ARTIFACT_PATH = ".data/reports/source-discovery/jalan_bounded_collection_probe_improved_20260605_002941.json";
const LATEST_MARKET_SNAPSHOT_PATH = ".data/ai-context/latest_market_snapshot.json";
const LATEST_AI_TASK_ENTRYPOINT_PATH = ".data/ai-context/latest_ai_task_entrypoint.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-db-update-runner-proposal";

interface SourceArtifactLike {
  decision?: string;
  current_state_summary?: Partial<CurrentStateSummary>;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function readJsonIfExists(path: string): unknown {
  return existsSync(path) ? readJson(path) : { missing: path };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `auto_runner_db_update_runner_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const sourceAutoRunner06xArtifact = readJson<SourceArtifactLike>(SOURCE_AUTO_RUNNER06X_ARTIFACT_PATH);
  const sourceScheduleConfigArtifact = readJson<ScheduleConfigLike>(SOURCE_SCHEDULE_CONFIG_ARTIFACT_PATH);
  const currentStateSummary = buildCurrentStateSummary(sourceAutoRunner06xArtifact.current_state_summary);
  const dbUpdatePipelineStages = buildDbUpdatePipelineStages();
  const gateMatrix = buildGateMatrix();
  const batchSelectionPolicy = buildBatchSelectionPolicy(sourceScheduleConfigArtifact);
  const appendPolicy = buildAppendPolicy();
  const dbSyncPolicy = buildDbSyncPolicy();
  const aiContextPolicy = buildAiContextPolicy();
  const usabilityIntegrityPolicy = buildUsabilityIntegrityPolicy();
  const priceOutputSeparation = buildPriceOutputSeparation();
  const failureHandlingPlan = buildFailureHandlingPlan();
  const futureRunnerCommandDesign = buildFutureRunnerCommandDesign();
  const risks = buildRisks();
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideAutoRunnerDbUpdateRunner({
    source06Present: sourceAutoRunner06xArtifact.decision !== undefined,
    schedulePresent: sourceScheduleConfigArtifact.decision !== undefined,
    executionDisabled: true
  });
  const nextPhase = "AUTO-RUNNER08X — Miuraya pricing CSV generation proposal, gated; or AUTO-RUNNER07B — generic fresh DB sync helper proposal";

  const sourceAutoRunner06xArtifactPath = resolve(SOURCE_AUTO_RUNNER06X_ARTIFACT_PATH);
  const sourceScheduleConfigArtifactPath = resolve(SOURCE_SCHEDULE_CONFIG_ARTIFACT_PATH);
  const reportPath = resolve(REPORT_DIR, `auto_runner_db_update_runner_proposal_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `auto_runner_db_update_runner_proposal_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `auto_runner_db_update_runner_proposal_${ts}.csv`);

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner06x_artifact: sourceAutoRunner06xArtifactPath,
    source_schedule_config_artifact: sourceScheduleConfigArtifactPath,
    current_state_summary: currentStateSummary,
    db_update_pipeline_stages: dbUpdatePipelineStages,
    gate_matrix: gateMatrix,
    batch_selection_policy: batchSelectionPolicy,
    append_policy: appendPolicy,
    db_sync_policy: dbSyncPolicy,
    ai_context_policy: aiContextPolicy,
    usability_integrity_policy: usabilityIntegrityPolicy,
    price_output_separation: priceOutputSeparation,
    failure_handling_plan: failureHandlingPlan,
    future_runner_command_design: futureRunnerCommandDesign,
    risks,
    safety_confirmation: safetyConfirmation,
    next_phase: nextPhase,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };

  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      source06Path: sourceAutoRunner06xArtifactPath,
      source05Path: sourceScheduleConfigArtifactPath,
      current: currentStateSummary,
      stages: dbUpdatePipelineStages,
      gates: gateMatrix,
      batchPolicy: batchSelectionPolicy,
      appendPolicy,
      dbSyncPolicy,
      aiContextPolicy,
      usabilityPolicy: usabilityIntegrityPolicy,
      priceSeparation: priceOutputSeparation,
      failure: failureHandlingPlan,
      commandDesign: futureRunnerCommandDesign,
      risks,
      safety: safetyConfirmation
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderPipelineCsv(dbUpdatePipelineStages), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner06x_artifact.json"), sourceAutoRunner06xArtifact);
  writeJson(resolve(debugPath, "source_auto_runner05x_schedule_config.json"), sourceScheduleConfigArtifact);
  writeJson(resolve(debugPath, "source_auto_runner03x_artifact.json"), readJsonIfExists(SOURCE_AUTO_RUNNER03X_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_auto_runner04x_artifact.json"), readJsonIfExists(SOURCE_AUTO_RUNNER04X_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_booking_usability_artifact.json"), readJsonIfExists(BOOKING_USABILITY_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_jalan_usability_artifact.json"), readJsonIfExists(JALAN_USABILITY_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_booking_collection_artifact.json"), readJsonIfExists(BOOKING_COLLECTION_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_jalan_collection_artifact.json"), readJsonIfExists(JALAN_COLLECTION_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "latest_market_snapshot.json"), readJsonIfExists(LATEST_MARKET_SNAPSHOT_PATH));
  writeJson(resolve(debugPath, "latest_ai_task_entrypoint.json"), readJsonIfExists(LATEST_AI_TASK_ENTRYPOINT_PATH));
  writeJson(resolve(debugPath, "pipeline_stages.json"), dbUpdatePipelineStages);
  writeJson(resolve(debugPath, "gate_matrix.json"), gateMatrix);
  writeJson(resolve(debugPath, "batch_selection_policy.json"), batchSelectionPolicy);
  writeJson(resolve(debugPath, "append_sync_context_policy.json"), { append_policy: appendPolicy, db_sync_policy: dbSyncPolicy, ai_context_policy: aiContextPolicy });
  writeJson(resolve(debugPath, "price_output_separation.json"), priceOutputSeparation);
  writeJson(resolve(debugPath, "failure_handling_plan.json"), failureHandlingPlan);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

const result = run();
console.log(`report_path=${result.reportPath}`);
console.log(`json_path=${result.jsonPath}`);
console.log(`csv_path=${result.csvPath}`);
console.log(`debug_artifact_path=${result.debugPath}`);
console.log(`decision=${result.decision}`);
