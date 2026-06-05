// Phase AUTO-RUNNER04X - build launchd schedule proposal.
//
// Writes proposal/debug artifacts only. It does not create plist files, call
// scheduling tools, run collectors, sync DB, refresh context, query smoke, or
// generate pricing/PMS output.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCurrentStateSummary,
  buildFailureHandlingPlan,
  buildGateMatrix,
  buildLaunchdTemplateDesign,
  buildNotificationPlan,
  buildRisks,
  buildRunStateLoggingDesign,
  buildSafetyConfirmation,
  buildScheduleTiers,
  decideAutoRunnerLaunchdScheduleProposal,
  renderReport,
  renderScheduleCsv,
  type AutoRunner03xArtifactLike
} from "../services/autoRunnerLaunchdScheduleProposal";

const SOURCE_AUTO_RUNNER03X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_manual_workflow_proposal_20260605_131913.json";
const SOURCE_AUTO_RUNNER02X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_bootstrap_proposal_20260605_123418.json";
const SOURCE_AUTO_RUNNER01X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_migration_proposal_20260605_121138.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-launchd-schedule-proposal";

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
  const runId = `auto_runner_launchd_schedule_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const sourceAutoRunner03xArtifactPath = resolve(SOURCE_AUTO_RUNNER03X_ARTIFACT_PATH);
  const sourceAutoRunner03xArtifact = readJson<AutoRunner03xArtifactLike>(SOURCE_AUTO_RUNNER03X_ARTIFACT_PATH);
  const sourceAutoRunner02xArtifact = readJson<Record<string, unknown>>(SOURCE_AUTO_RUNNER02X_ARTIFACT_PATH);
  const sourceAutoRunner01xArtifact = readJson<Record<string, unknown>>(SOURCE_AUTO_RUNNER01X_ARTIFACT_PATH);
  const currentStateSummary = buildCurrentStateSummary(sourceAutoRunner03xArtifact);
  const scheduleTiers = buildScheduleTiers();
  const launchdTemplateDesign = buildLaunchdTemplateDesign(resolve("."));
  const gateMatrix = buildGateMatrix();
  const runStateLoggingDesign = buildRunStateLoggingDesign();
  const failureHandlingPlan = buildFailureHandlingPlan();
  const notificationPlan = buildNotificationPlan();
  const risks = buildRisks(currentStateSummary);
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideAutoRunnerLaunchdScheduleProposal({
    sourcePresent: sourceAutoRunner03xArtifact.decision !== undefined,
    tiers: scheduleTiers,
    templates: launchdTemplateDesign
  });
  const nextPhase = "AUTO-RUNNER05X — bounded collector schedule implementation, disabled by default";

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner03x_artifact: sourceAutoRunner03xArtifactPath,
    current_state_summary: currentStateSummary,
    schedule_tiers: scheduleTiers,
    launchd_template_design: launchdTemplateDesign,
    gate_matrix: gateMatrix,
    run_state_logging_design: runStateLoggingDesign,
    failure_handling_plan: failureHandlingPlan,
    notification_plan: notificationPlan,
    risks,
    safety_confirmation: safetyConfirmation,
    next_phase: nextPhase,
    report_path: "",
    json_path: "",
    csv_path: "",
    debug_artifact_path: debugPath
  };

  const reportPath = resolve(REPORT_DIR, `auto_runner_launchd_schedule_proposal_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `auto_runner_launchd_schedule_proposal_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `auto_runner_launchd_schedule_proposal_${ts}.csv`);
  output.report_path = reportPath;
  output.json_path = jsonPath;
  output.csv_path = csvPath;

  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      sourceArtifactPath: sourceAutoRunner03xArtifactPath,
      current: currentStateSummary,
      tiers: scheduleTiers,
      templates: launchdTemplateDesign,
      gates: gateMatrix,
      logging: runStateLoggingDesign,
      failure: failureHandlingPlan,
      notification: notificationPlan,
      risks,
      safety: safetyConfirmation
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderScheduleCsv(launchdTemplateDesign), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner03x_artifact.json"), sourceAutoRunner03xArtifact);
  writeJson(resolve(debugPath, "source_auto_runner02x_artifact.json"), sourceAutoRunner02xArtifact);
  writeJson(resolve(debugPath, "source_auto_runner01x_artifact.json"), sourceAutoRunner01xArtifact);
  writeJson(resolve(debugPath, "schedule_tiers.json"), scheduleTiers);
  writeJson(resolve(debugPath, "launchd_template_design.json"), launchdTemplateDesign);
  writeJson(resolve(debugPath, "gate_matrix.json"), gateMatrix);
  writeJson(resolve(debugPath, "run_state_logging_design.json"), runStateLoggingDesign);
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
