// Phase AUTO-RUNNER07D - build DB update runner integration proposal.
//
// Writes proposal/report artifacts only. It does not run sync commands,
// append history, write DB, refresh AI context, run collectors, or generate
// pricing/PMS output.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildAiContextFollowupPolicy,
  buildCompatibilityPlan,
  buildCurrentStateSummary,
  buildDbSyncIntegrationPolicy,
  buildFailureHandlingPlan,
  buildFreshSyncHelperSummary,
  buildGateMatrix,
  buildPriceOutputSeparation,
  buildRisks,
  buildSafetyConfirmation,
  buildUpdatedPipelineStages,
  decideAutoRunnerDbUpdateIntegration,
  renderPipelineCsv,
  renderReport,
  type Source07cLike,
  type Source07xLike
} from "../services/autoRunnerDbUpdateIntegrationProposal";

const SOURCE_AUTO_RUNNER07C_ARTIFACT_PATH = ".data/reports/automation/fresh_history_to_db_sync_20260605_230258.json";
const SOURCE_AUTO_RUNNER07X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_db_update_runner_proposal_20260605_162306.json";
const SOURCE_AUTO_RUNNER07B_ARTIFACT_PATH = ".data/reports/automation/auto_runner_fresh_db_sync_proposal_20260605_162934.json";
const SOURCE_SCHEDULE_CONFIG_ARTIFACT_PATH = ".data/reports/automation/auto_runner_bounded_schedule_config_20260605_154449.json";
const LATEST_MARKET_SNAPSHOT_PATH = ".data/ai-context/latest_market_snapshot.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-db-update-integration-proposal";

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
  const runId = `auto_runner_db_update_integration_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const source07c = readJson<Source07cLike>(SOURCE_AUTO_RUNNER07C_ARTIFACT_PATH);
  const source07x = readJson<Source07xLike>(SOURCE_AUTO_RUNNER07X_ARTIFACT_PATH);
  const source07cPath = resolve(SOURCE_AUTO_RUNNER07C_ARTIFACT_PATH);
  const source07xPath = resolve(SOURCE_AUTO_RUNNER07X_ARTIFACT_PATH);

  const currentStateSummary = buildCurrentStateSummary(source07x.current_state_summary);
  const freshSyncHelperSummary = buildFreshSyncHelperSummary(source07c);
  const updatedPipelineStages = buildUpdatedPipelineStages();
  const gateMatrix = buildGateMatrix();
  const dbSyncIntegrationPolicy = buildDbSyncIntegrationPolicy();
  const aiContextFollowupPolicy = buildAiContextFollowupPolicy();
  const priceOutputSeparation = buildPriceOutputSeparation();
  const failureHandlingPlan = buildFailureHandlingPlan();
  const compatibilityPlan = buildCompatibilityPlan();
  const risks = buildRisks();
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideAutoRunnerDbUpdateIntegration({
    source07cPresent: source07c.decision !== undefined,
    source07xPresent: source07x.decision !== undefined,
    executionDisabled: true
  });
  const nextPhase =
    "AUTO-RUNNER08X — Miuraya pricing CSV generation proposal, gated; or AUTO-RUNNER07E — disabled end-to-end DB update runner implementation stub";

  const reportPath = resolve(REPORT_DIR, `auto_runner_db_update_integration_proposal_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `auto_runner_db_update_integration_proposal_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `auto_runner_db_update_integration_proposal_${ts}.csv`);

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner07c_artifact: source07cPath,
    source_auto_runner07x_artifact: source07xPath,
    current_state_summary: currentStateSummary,
    fresh_sync_helper_summary: freshSyncHelperSummary,
    updated_pipeline_stages: updatedPipelineStages,
    gate_matrix: gateMatrix,
    db_sync_integration_policy: dbSyncIntegrationPolicy,
    ai_context_followup_policy: aiContextFollowupPolicy,
    price_output_separation: priceOutputSeparation,
    failure_handling_plan: failureHandlingPlan,
    compatibility_plan: compatibilityPlan,
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
      source07cPath,
      source07xPath,
      current: currentStateSummary,
      fresh: freshSyncHelperSummary,
      stages: updatedPipelineStages,
      gates: gateMatrix,
      dbSyncPolicy: dbSyncIntegrationPolicy,
      aiContextPolicy: aiContextFollowupPolicy,
      priceSeparation: priceOutputSeparation,
      failure: failureHandlingPlan,
      compatibility: compatibilityPlan,
      risks,
      safety: safetyConfirmation
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderPipelineCsv(updatedPipelineStages), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner07c_artifact.json"), source07c);
  writeJson(resolve(debugPath, "source_auto_runner07x_artifact.json"), source07x);
  writeJson(resolve(debugPath, "source_auto_runner07b_artifact.json"), readJsonIfExists(SOURCE_AUTO_RUNNER07B_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_auto_runner05x_schedule_config.json"), readJsonIfExists(SOURCE_SCHEDULE_CONFIG_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "latest_market_snapshot.json"), readJsonIfExists(LATEST_MARKET_SNAPSHOT_PATH));
  writeJson(resolve(debugPath, "fresh_sync_helper_summary.json"), freshSyncHelperSummary);
  writeJson(resolve(debugPath, "updated_pipeline_stages.json"), updatedPipelineStages);
  writeJson(resolve(debugPath, "gate_matrix.json"), gateMatrix);
  writeJson(resolve(debugPath, "failure_behavior.json"), failureHandlingPlan);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

const result = run();
console.log(`report_path=${result.reportPath}`);
console.log(`json_path=${result.jsonPath}`);
console.log(`csv_path=${result.csvPath}`);
console.log(`debug_artifact_path=${result.debugPath}`);
console.log(`decision=${result.decision}`);
