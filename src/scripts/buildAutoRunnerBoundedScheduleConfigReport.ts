// Phase AUTO-RUNNER05X - build bounded schedule config report.
//
// Writes schedule config proposal/debug artifacts only. It does not run
// collectors, install schedules, launch browsers, append history, sync DB,
// refresh AI context, query smoke, or generate pricing/PMS output.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildBookingBatchPlans,
  buildCurrentStateSummary,
  buildDateWindowPolicy,
  buildFailureBehavior,
  buildFutureRunnerIntegration,
  buildGateMatrix,
  buildJalanBatchPlans,
  buildRisks,
  buildSafetyConfirmation,
  buildTargetInventory,
  decideAutoRunnerBoundedSchedule,
  renderBatchPlanCsv,
  renderReport,
  type AutoRunner04xArtifactLike
} from "../services/autoRunnerBoundedScheduleConfig";

const SOURCE_AUTO_RUNNER04X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_launchd_schedule_proposal_20260605_153312.json";
const SOURCE_AUTO_RUNNER03X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_manual_workflow_proposal_20260605_131913.json";
const SOURCE_AUTO_RUNNER02X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_bootstrap_proposal_20260605_123418.json";
const BOOKING_SOURCE_ARTIFACT_PATH = ".data/reports/source-discovery/booking_bounded_expanded_collection_20260604_161623.json";
const JALAN_SOURCE_ARTIFACT_PATH = ".data/reports/source-discovery/jalan_bounded_collection_probe_improved_20260605_002941.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-bounded-schedule-config";

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
  const runId = `auto_runner_bounded_schedule_config_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const sourceAutoRunner04xArtifactPath = resolve(SOURCE_AUTO_RUNNER04X_ARTIFACT_PATH);
  const sourceAutoRunner04xArtifact = readJson<AutoRunner04xArtifactLike>(SOURCE_AUTO_RUNNER04X_ARTIFACT_PATH);
  const sourceAutoRunner03xArtifact = readJson<Record<string, unknown>>(SOURCE_AUTO_RUNNER03X_ARTIFACT_PATH);
  const sourceAutoRunner02xArtifact = readJson<Record<string, unknown>>(SOURCE_AUTO_RUNNER02X_ARTIFACT_PATH);
  const sourceBookingArtifact = readJson<Record<string, unknown>>(BOOKING_SOURCE_ARTIFACT_PATH);
  const sourceJalanArtifact = readJson<Record<string, unknown>>(JALAN_SOURCE_ARTIFACT_PATH);
  const currentStateSummary = buildCurrentStateSummary(sourceAutoRunner04xArtifact);
  const targetInventory = buildTargetInventory();
  const dateWindowPolicy = buildDateWindowPolicy();
  const bookingBatchPlans = buildBookingBatchPlans(targetInventory);
  const jalanBatchPlans = buildJalanBatchPlans(targetInventory);
  const gateMatrix = buildGateMatrix();
  const failureBehavior = buildFailureBehavior();
  const futureRunnerIntegration = buildFutureRunnerIntegration();
  const risks = buildRisks(currentStateSummary);
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideAutoRunnerBoundedSchedule({
    sourcePresent: sourceAutoRunner04xArtifact.decision !== undefined,
    inventory: targetInventory,
    bookingPlans: bookingBatchPlans,
    jalanPlans: jalanBatchPlans
  });
  const nextPhase = "AUTO-RUNNER06X — GitHub artifact sync / release archive proposal";

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner04x_artifact: sourceAutoRunner04xArtifactPath,
    current_state_summary: currentStateSummary,
    target_inventory: targetInventory,
    date_window_policy: dateWindowPolicy,
    booking_batch_plans: bookingBatchPlans,
    jalan_batch_plans: jalanBatchPlans,
    gate_matrix: gateMatrix,
    failure_behavior: failureBehavior,
    future_runner_integration: futureRunnerIntegration,
    risks,
    safety_confirmation: safetyConfirmation,
    next_phase: nextPhase,
    report_path: "",
    json_path: "",
    csv_path: "",
    debug_artifact_path: debugPath
  };

  const reportPath = resolve(REPORT_DIR, `auto_runner_bounded_schedule_config_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `auto_runner_bounded_schedule_config_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `auto_runner_bounded_schedule_config_${ts}.csv`);
  output.report_path = reportPath;
  output.json_path = jsonPath;
  output.csv_path = csvPath;

  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      sourceArtifactPath: sourceAutoRunner04xArtifactPath,
      current: currentStateSummary,
      inventory: targetInventory,
      datePolicy: dateWindowPolicy,
      bookingPlans: bookingBatchPlans,
      jalanPlans: jalanBatchPlans,
      gates: gateMatrix,
      failure: failureBehavior,
      integration: futureRunnerIntegration,
      risks,
      safety: safetyConfirmation
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderBatchPlanCsv([...bookingBatchPlans, ...jalanBatchPlans]), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner04x_artifact.json"), sourceAutoRunner04xArtifact);
  writeJson(resolve(debugPath, "source_auto_runner03x_artifact.json"), sourceAutoRunner03xArtifact);
  writeJson(resolve(debugPath, "source_auto_runner02x_artifact.json"), sourceAutoRunner02xArtifact);
  writeJson(resolve(debugPath, "source_booking_artifact.json"), sourceBookingArtifact);
  writeJson(resolve(debugPath, "source_jalan_artifact.json"), sourceJalanArtifact);
  writeJson(resolve(debugPath, "target_inventory.json"), targetInventory);
  writeJson(resolve(debugPath, "date_window_policy.json"), dateWindowPolicy);
  writeJson(resolve(debugPath, "booking_batch_plans.json"), bookingBatchPlans);
  writeJson(resolve(debugPath, "jalan_batch_plans.json"), jalanBatchPlans);
  writeJson(resolve(debugPath, "gate_matrix.json"), gateMatrix);
  writeJson(resolve(debugPath, "failure_behavior.json"), failureBehavior);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

const result = run();
console.log(`report_path=${result.reportPath}`);
console.log(`json_path=${result.jsonPath}`);
console.log(`csv_path=${result.csvPath}`);
console.log(`debug_artifact_path=${result.debugPath}`);
console.log(`decision=${result.decision}`);
