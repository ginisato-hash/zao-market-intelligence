// Phase AUTO-RUNNER03X - build manual workflow runner proposal.
//
// Reads package metadata and local proposal artifacts only. Writes proposal/debug
// artifacts only. It does not execute collectors, append history, sync DB,
// refresh AI context, run query smoke, create schedules, or generate pricing/PMS
// output.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCurrentStateSummary,
  buildDryRunBehavior,
  buildFailureHandlingPlan,
  buildFutureRunnerCommandDesign,
  buildGateMatrix,
  buildHumanReviewCheckpoints,
  buildManualWorkflowStages,
  buildRisks,
  buildSafetyConfirmation,
  buildScriptInventoryClassification,
  decideAutoRunnerManualWorkflowProposal,
  renderInventoryCsv,
  renderReport,
  type AutoRunner02xArtifactLike
} from "../services/autoRunnerManualWorkflowProposal";

const SOURCE_AUTO_RUNNER02X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_bootstrap_proposal_20260605_123418.json";
const SOURCE_AUTO_RUNNER01X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_migration_proposal_20260605_121138.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-manual-workflow-proposal";

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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `auto_runner_manual_workflow_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const sourceAutoRunner02xArtifactPath = resolve(SOURCE_AUTO_RUNNER02X_ARTIFACT_PATH);
  const sourceAutoRunner02xArtifact = readJson<AutoRunner02xArtifactLike>(SOURCE_AUTO_RUNNER02X_ARTIFACT_PATH);
  const sourceAutoRunner01xArtifact = readJson<Record<string, unknown>>(SOURCE_AUTO_RUNNER01X_ARTIFACT_PATH);
  const packageJson = readJson<{ scripts?: Record<string, string> }>("package.json");

  const currentStateSummary = buildCurrentStateSummary(sourceAutoRunner02xArtifact);
  const scriptInventoryClassification = buildScriptInventoryClassification(packageJson.scripts ?? {});
  const manualWorkflowStages = buildManualWorkflowStages();
  const gateMatrix = buildGateMatrix();
  const dryRunBehavior = buildDryRunBehavior();
  const failureHandlingPlan = buildFailureHandlingPlan();
  const futureRunnerCommandDesign = buildFutureRunnerCommandDesign();
  const humanReviewCheckpoints = buildHumanReviewCheckpoints();
  const risks = buildRisks(currentStateSummary);
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideAutoRunnerManualWorkflowProposal({
    sourcePresent: sourceAutoRunner02xArtifact.decision !== undefined,
    stages: manualWorkflowStages,
    gates: gateMatrix
  });
  const nextPhase = "AUTO-RUNNER04X — launchd schedule proposal, disabled";

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner02x_artifact: sourceAutoRunner02xArtifactPath,
    current_state_summary: currentStateSummary,
    script_inventory_classification: scriptInventoryClassification,
    manual_workflow_stages: manualWorkflowStages,
    gate_matrix: gateMatrix,
    dry_run_behavior: dryRunBehavior,
    failure_handling_plan: failureHandlingPlan,
    future_runner_command_design: futureRunnerCommandDesign,
    human_review_checkpoints: humanReviewCheckpoints,
    risks,
    safety_confirmation: safetyConfirmation,
    next_phase: nextPhase,
    report_path: "",
    json_path: "",
    csv_path: "",
    debug_artifact_path: debugPath
  };

  const reportPath = resolve(REPORT_DIR, `auto_runner_manual_workflow_proposal_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `auto_runner_manual_workflow_proposal_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `auto_runner_manual_workflow_proposal_${ts}.csv`);
  output.report_path = reportPath;
  output.json_path = jsonPath;
  output.csv_path = csvPath;

  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      sourceArtifactPath: sourceAutoRunner02xArtifactPath,
      current: currentStateSummary,
      inventory: scriptInventoryClassification,
      stages: manualWorkflowStages,
      gates: gateMatrix,
      dryRun: dryRunBehavior,
      failure: failureHandlingPlan,
      review: humanReviewCheckpoints,
      commandDesign: futureRunnerCommandDesign,
      risks,
      safety: safetyConfirmation
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderInventoryCsv(scriptInventoryClassification), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner02x_artifact.json"), sourceAutoRunner02xArtifact);
  writeJson(resolve(debugPath, "source_auto_runner01x_artifact.json"), sourceAutoRunner01xArtifact);
  writeJson(resolve(debugPath, "script_inventory_classification.json"), scriptInventoryClassification);
  writeJson(resolve(debugPath, "manual_workflow_stages.json"), manualWorkflowStages);
  writeJson(resolve(debugPath, "gate_matrix.json"), gateMatrix);
  writeJson(resolve(debugPath, "failure_handling_plan.json"), failureHandlingPlan);
  writeJson(resolve(debugPath, "future_runner_outline.json"), futureRunnerCommandDesign);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

const result = run();
console.log(`report_path=${result.reportPath}`);
console.log(`json_path=${result.jsonPath}`);
console.log(`csv_path=${result.csvPath}`);
console.log(`debug_artifact_path=${result.debugPath}`);
console.log(`decision=${result.decision}`);
