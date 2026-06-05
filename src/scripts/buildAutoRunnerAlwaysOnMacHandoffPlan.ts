// Phase AUTO-RUNNER-HANDOFF01X - build always-on Mac handoff plan.
//
// Runs on the current implementation Mac only. Writes proposal/report artifacts
// and does not execute future always-on Mac checklist commands.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildAcceptanceCriteria,
  buildAlwaysOnMacBootstrapChecklist,
  buildCurrentStateSummary,
  buildFailureHandling,
  buildFutureGitignoreRecommendation,
  buildGitStatusSummary,
  buildGitignoreSummary,
  buildHandoffFileMatrix,
  buildRisks,
  buildSafetyConfirmation,
  decideHandoffPlan,
  renderMatrixCsv,
  renderReport,
  type Source07fLike
} from "../services/autoRunnerAlwaysOnMacHandoffPlan";

const SOURCE_AUTO_RUNNER07F_ARTIFACT_PATH = ".data/reports/automation/auto_runner_health_check_20260605_235224.json";
const SOURCE_ARTIFACT_SYNC_PROPOSAL_PATH = ".data/reports/automation/auto_runner_artifact_sync_proposal_20260605_155852.json";
const SOURCE_MIGRATION_PROPOSAL_PATH = ".data/reports/automation/auto_runner_migration_proposal_20260605_121138.json";
const SOURCE_DB_UPDATE_STUB_PATH = ".data/reports/automation/auto_runner_db_update_stub_20260605_234414.json";
const SOURCE_FRESH_SYNC_ARTIFACT_PATH = ".data/reports/automation/fresh_history_to_db_sync_20260605_230258.json";
const LATEST_MARKET_SNAPSHOT_PATH = ".data/ai-context/latest_market_snapshot.json";
const LATEST_AI_TASK_ENTRYPOINT_PATH = ".data/ai-context/latest_ai_task_entrypoint.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-always-on-mac-handoff-plan";

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

function gitLines(args: string[]): string[] {
  return execFileSync("git", args, { encoding: "utf8" })
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `auto_runner_always_on_mac_handoff_plan_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const source07f = readJson<Source07fLike>(SOURCE_AUTO_RUNNER07F_ARTIFACT_PATH);
  const gitignoreText = readFileSync(resolve(".gitignore"), "utf8");
  const gitStatusSummary = buildGitStatusSummary({
    statusEntries: gitLines(["status", "--short"]),
    trackedFiles: gitLines(["ls-files"]),
    gitignoreText
  });
  const gitignoreSummary = buildGitignoreSummary(gitignoreText);
  const currentStateSummary = buildCurrentStateSummary(source07f);
  const handoffFileMatrix = buildHandoffFileMatrix();
  const futureGitignoreRecommendation = buildFutureGitignoreRecommendation();
  const alwaysOnMacBootstrapChecklist = buildAlwaysOnMacBootstrapChecklist();
  const acceptanceCriteria = buildAcceptanceCriteria();
  const failureHandling = buildFailureHandling();
  const risks = buildRisks();
  const safetyConfirmation = buildSafetyConfirmation();
  const currentStateReady = currentStateSummary.history_rows === 210 && currentStateSummary.db_rows === 210 && currentStateSummary.ai_context_rows === 210;
  const decision = decideHandoffPlan({
    source07fPresent: source07f.decision !== undefined,
    currentStateReady,
    handoffMatrixReady: handoffFileMatrix.length > 0,
    futureManualActionsRemain: true
  });
  const nextPhase =
    "Human review GitHub transfer policy and .gitignore history exception, then manually execute the checklist on the always-on Mac. After that passes: AUTO-RUNNER07G.";
  const source07fPath = resolve(SOURCE_AUTO_RUNNER07F_ARTIFACT_PATH);
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner07f_artifact: source07fPath,
    current_state_summary: currentStateSummary,
    git_status_summary: gitStatusSummary,
    gitignore_summary: gitignoreSummary,
    handoff_file_matrix: handoffFileMatrix,
    future_gitignore_recommendation: futureGitignoreRecommendation,
    always_on_mac_bootstrap_checklist: alwaysOnMacBootstrapChecklist,
    acceptance_criteria: acceptanceCriteria,
    failure_handling: failureHandling,
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
      source07fPath,
      current: currentStateSummary,
      gitStatus: gitStatusSummary,
      gitignore: gitignoreSummary,
      matrix: handoffFileMatrix,
      gitignoreRecommendation: futureGitignoreRecommendation,
      checklist: alwaysOnMacBootstrapChecklist,
      acceptance: acceptanceCriteria,
      failureHandling,
      risks,
      safety: safetyConfirmation,
      nextPhase
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderMatrixCsv(handoffFileMatrix), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner07f_artifact.json"), source07f);
  writeJson(resolve(debugPath, "source_artifact_sync_proposal.json"), readJsonIfExists(SOURCE_ARTIFACT_SYNC_PROPOSAL_PATH));
  writeJson(resolve(debugPath, "source_migration_proposal.json"), readJsonIfExists(SOURCE_MIGRATION_PROPOSAL_PATH));
  writeJson(resolve(debugPath, "source_db_update_stub.json"), readJsonIfExists(SOURCE_DB_UPDATE_STUB_PATH));
  writeJson(resolve(debugPath, "source_fresh_sync_artifact.json"), readJsonIfExists(SOURCE_FRESH_SYNC_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "latest_market_snapshot.json"), readJsonIfExists(LATEST_MARKET_SNAPSHOT_PATH));
  writeJson(resolve(debugPath, "latest_ai_task_entrypoint.json"), readJsonIfExists(LATEST_AI_TASK_ENTRYPOINT_PATH));
  writeFileSync(resolve(debugPath, "gitignore_snapshot.txt"), gitignoreText, "utf8");
  writeJson(resolve(debugPath, "git_status_snapshot.json"), gitStatusSummary);
  writeJson(resolve(debugPath, "current_state_summary.json"), currentStateSummary);
  writeJson(resolve(debugPath, "handoff_file_matrix.json"), handoffFileMatrix);
  writeJson(resolve(debugPath, "bootstrap_checklist.json"), alwaysOnMacBootstrapChecklist);
  writeJson(resolve(debugPath, "acceptance_criteria.json"), acceptanceCriteria);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

const result = run();
console.log(`decision=${result.decision}`);
console.log(`report_path=${result.reportPath}`);
console.log(`json_path=${result.jsonPath}`);
console.log(`csv_path=${result.csvPath}`);
console.log(`debug_artifact_path=${result.debugPath}`);
