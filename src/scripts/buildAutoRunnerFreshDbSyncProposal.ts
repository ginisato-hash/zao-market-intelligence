// Phase AUTO-RUNNER07B - build fresh history-to-DB sync helper proposal.
//
// Writes proposal/debug artifacts only. It does not run dry-run sync, run real
// sync, write DB, refresh AI context, mutate history, run collectors, or produce
// pricing/PMS output.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCompatibilityPlan,
  buildCurrentStateSummary,
  buildExistingSyncFlowInventory,
  buildFailureBehavior,
  buildFreshSyncWorkflowDesign,
  buildFutureCommandDesign,
  buildGateMatrix,
  buildIdempotencyPolicy,
  buildRisks,
  buildSafetyConfirmation,
  buildSyncRiskAnalysis,
  decideAutoRunnerFreshDbSync,
  renderReport,
  renderWorkflowCsv,
  type CurrentStateSummary
} from "../services/autoRunnerFreshDbSyncProposal";

const SOURCE_AUTO_RUNNER07X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_db_update_runner_proposal_20260605_162306.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-fresh-db-sync-proposal";

const REAL_RUN_SCRIPT_PATH = "src/scripts/runHistoryToDbSyncRealRun.ts";
const REAL_RUN_SERVICE_PATH = "src/services/historyToDbSyncRealRun.ts";
const REAL_RUN_TEST_PATH = "tests/historyToDbSyncRealRun.test.ts";
const DRY_RUN_SCRIPT_PATH = "src/scripts/runHistoryToDbSyncDryRun.ts";
const DRY_RUN_SERVICE_PATH = "src/services/historyToDbSyncDryRun.ts";

interface SourceAutoRunner07xArtifact {
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function listReports(prefix: string): string[] {
  return readdirSync(resolve(REPORT_DIR))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .map((name) => `${REPORT_DIR}/${name}`);
}

function historySummary(): { row_count: number; shards: Record<string, number> } {
  const shards: Record<string, number> = {};
  let rowCount = 0;
  for (const name of readdirSync(resolve(".data/history")).filter((file) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(file)).sort()) {
    const count = readFileSync(resolve(".data/history", name), "utf8").trim().split(/\r?\n/u).filter(Boolean).length - 1;
    shards[name] = count;
    rowCount += count;
  }
  return { row_count: rowCount, shards };
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `auto_runner_fresh_db_sync_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const sourceAutoRunner07xArtifactPath = resolve(SOURCE_AUTO_RUNNER07X_ARTIFACT_PATH);
  const sourceAutoRunner07xArtifact = readJson<SourceAutoRunner07xArtifact>(SOURCE_AUTO_RUNNER07X_ARTIFACT_PATH);
  const currentStateSummary = buildCurrentStateSummary(sourceAutoRunner07xArtifact.current_state_summary);
  const realRunScriptSource = readFileSync(resolve(REAL_RUN_SCRIPT_PATH), "utf8");
  const realRunServiceSource = readFileSync(resolve(REAL_RUN_SERVICE_PATH), "utf8");
  const realRunTestSource = readFileSync(resolve(REAL_RUN_TEST_PATH), "utf8");
  const dryRunScriptSource = readFileSync(resolve(DRY_RUN_SCRIPT_PATH), "utf8");
  const dryRunServiceSource = readFileSync(resolve(DRY_RUN_SERVICE_PATH), "utf8");
  const existingSyncFlowInventory = buildExistingSyncFlowInventory({
    dryRunArtifacts: listReports("history_to_db_sync_dry_run_"),
    realRunArtifacts: listReports("history_to_db_sync_real_run_"),
    realRunScriptSource,
    realRunServiceSource,
    realRunTestSource
  });
  const syncRiskAnalysis = buildSyncRiskAnalysis();
  const freshSyncWorkflowDesign = buildFreshSyncWorkflowDesign();
  const gateMatrix = buildGateMatrix();
  const idempotencyPolicy = buildIdempotencyPolicy();
  const failureBehavior = buildFailureBehavior();
  const futureCommandDesign = buildFutureCommandDesign();
  const compatibilityPlan = buildCompatibilityPlan();
  const risks = buildRisks();
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideAutoRunnerFreshDbSync({
    source07xPresent: sourceAutoRunner07xArtifact.decision !== undefined,
    inspectedExistingFlow: existingSyncFlowInventory.observed_risks.length > 0,
    writeCapableImplementationDeferred: true
  });
  const nextPhase = "AUTO-RUNNER07C — Write-capable fresh DB sync helper implementation, gated";

  const reportPath = resolve(REPORT_DIR, `auto_runner_fresh_db_sync_proposal_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `auto_runner_fresh_db_sync_proposal_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `auto_runner_fresh_db_sync_proposal_${ts}.csv`);
  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner07x_artifact: sourceAutoRunner07xArtifactPath,
    current_state_summary: currentStateSummary,
    existing_sync_flow_inventory: existingSyncFlowInventory,
    sync_risk_analysis: syncRiskAnalysis,
    fresh_sync_workflow_design: freshSyncWorkflowDesign,
    gate_matrix: gateMatrix,
    idempotency_policy: idempotencyPolicy,
    failure_behavior: failureBehavior,
    future_command_design: futureCommandDesign,
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
      source07xPath: sourceAutoRunner07xArtifactPath,
      current: currentStateSummary,
      inventory: existingSyncFlowInventory,
      riskAnalysis: syncRiskAnalysis,
      workflow: freshSyncWorkflowDesign,
      gates: gateMatrix,
      idempotency: idempotencyPolicy,
      failure: failureBehavior,
      futureCommand: futureCommandDesign,
      compatibility: compatibilityPlan,
      risks,
      safety: safetyConfirmation
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderWorkflowCsv(freshSyncWorkflowDesign), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner07x_artifact.json"), sourceAutoRunner07xArtifact);
  writeJson(resolve(debugPath, "existing_sync_flow_inventory.json"), existingSyncFlowInventory);
  writeJson(resolve(debugPath, "sync_risk_analysis.json"), syncRiskAnalysis);
  writeJson(resolve(debugPath, "fresh_sync_workflow_design.json"), freshSyncWorkflowDesign);
  writeJson(resolve(debugPath, "gate_matrix.json"), gateMatrix);
  writeJson(resolve(debugPath, "idempotency_policy.json"), idempotencyPolicy);
  writeJson(resolve(debugPath, "failure_behavior.json"), failureBehavior);
  writeJson(resolve(debugPath, "future_command_design.json"), futureCommandDesign);
  writeJson(resolve(debugPath, "compatibility_plan.json"), compatibilityPlan);
  writeJson(resolve(debugPath, "current_history_summary.json"), existsSync(resolve(".data/history")) ? historySummary() : { missing: ".data/history" });
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);
  writeFileSync(resolve(debugPath, "real_run_script_excerpt.txt"), realRunScriptSource.slice(0, 6000), "utf8");
  writeFileSync(resolve(debugPath, "real_run_service_excerpt.txt"), realRunServiceSource.slice(0, 6000), "utf8");
  writeFileSync(resolve(debugPath, "real_run_test_excerpt.txt"), realRunTestSource.slice(0, 6000), "utf8");
  writeFileSync(resolve(debugPath, "dry_run_script_excerpt.txt"), dryRunScriptSource.slice(0, 4000), "utf8");
  writeFileSync(resolve(debugPath, "dry_run_service_excerpt.txt"), dryRunServiceSource.slice(0, 4000), "utf8");

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

const result = run();
console.log(`report_path=${result.reportPath}`);
console.log(`json_path=${result.jsonPath}`);
console.log(`csv_path=${result.csvPath}`);
console.log(`debug_artifact_path=${result.debugPath}`);
console.log(`decision=${result.decision}`);
