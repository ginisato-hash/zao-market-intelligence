// Phase AUTO-RUNNER06X - build GitHub artifact sync proposal.
//
// Writes report/debug artifacts only. It reads Git status/ls-files snapshots
// and filesystem sizes, but does not mutate Git, create archives, run
// collectors, append history, sync DB, refresh AI context, or generate pricing
// output.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildAlwaysOnMacRestorePlan,
  buildArtifactCategoryMatrix,
  buildCurrentStateSummary,
  buildGithubTransferOptions,
  buildGitStatusSummary,
  buildGitignoreRecommendations,
  buildIntegrityChecks,
  buildRecommendedTransferStrategy,
  buildReleaseArchivePolicy,
  buildRisks,
  buildSafetyConfirmation,
  decideAutoRunnerArtifactSync,
  renderCategoryCsv,
  renderReport,
  type CurrentStateSummary,
  type DataSizeSummary
} from "../services/autoRunnerArtifactSyncProposal";

const SOURCE_AUTO_RUNNER05X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_bounded_schedule_config_20260605_154449.json";
const SOURCE_AUTO_RUNNER04X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_launchd_schedule_proposal_20260605_153312.json";
const SOURCE_AUTO_RUNNER03X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_manual_workflow_proposal_20260605_131913.json";
const SOURCE_AUTO_RUNNER02X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_bootstrap_proposal_20260605_123418.json";
const SOURCE_AUTO_RUNNER01X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_migration_proposal_20260605_121138.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-artifact-sync-proposal";

interface SourceAutoRunner05xArtifact {
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readOnlyGit(args: string[]): string[] {
  const output = execFileSync("git", args, { encoding: "utf8" });
  return output.split(/\r?\n/u).filter(Boolean);
}

function directorySize(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  const stat = statSync(path);
  if (stat.isFile()) {
    return stat.size;
  }
  let total = 0;
  for (const entry of readdirSync(path)) {
    total += directorySize(join(path, entry));
  }
  return total;
}

function matchingFileSize(dir: string, pattern: RegExp): number {
  if (!existsSync(dir)) {
    return 0;
  }
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isFile() && pattern.test(entry)) {
      total += stat.size;
    }
  }
  return total;
}

function humanBytes(bytes: number): string {
  const units = ["B", "K", "M", "G"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index === 0 ? `${value}${units[index]}` : `${value.toFixed(1)}${units[index]}`;
}

function buildDataSizeSummary(): DataSizeSummary {
  const sqliteBytes = matchingFileSize(".data", /\.sqlite$/u);
  return {
    data_total: humanBytes(directorySize(".data")),
    history: humanBytes(directorySize(".data/history")),
    sqlite: humanBytes(sqliteBytes),
    ai_context: humanBytes(directorySize(".data/ai-context")),
    reports: humanBytes(directorySize(".data/reports")),
    debug: humanBytes(directorySize(".data/debug")),
    screenshots: humanBytes(directorySize(".data/screenshots"))
  };
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `auto_runner_artifact_sync_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const sourceAutoRunner05xArtifact = readJson<SourceAutoRunner05xArtifact>(SOURCE_AUTO_RUNNER05X_ARTIFACT_PATH);
  const sourceAutoRunner05xArtifactPath = resolve(SOURCE_AUTO_RUNNER05X_ARTIFACT_PATH);
  const gitignoreText = readFileSync(resolve(".gitignore"), "utf8");
  const trackedFiles = readOnlyGit(["ls-files"]);
  const statusLines = readOnlyGit(["status", "--short"]);
  const currentStateSummary = buildCurrentStateSummary(sourceAutoRunner05xArtifact.current_state_summary);
  const gitStatusSummary = buildGitStatusSummary({ trackedFiles, statusLines, gitignoreText });
  const dataSizeSummary = buildDataSizeSummary();
  const artifactCategoryMatrix = buildArtifactCategoryMatrix();
  const githubTransferOptions = buildGithubTransferOptions();
  const recommendedTransferStrategy = buildRecommendedTransferStrategy();
  const gitignoreRecommendations = buildGitignoreRecommendations();
  const releaseArchivePolicy = buildReleaseArchivePolicy();
  const alwaysOnMacRestorePlan = buildAlwaysOnMacRestorePlan();
  const integrityChecks = buildIntegrityChecks();
  const risks = buildRisks(gitStatusSummary);
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideAutoRunnerArtifactSync({
    sourcePresent: sourceAutoRunner05xArtifact.decision !== undefined,
    gitignoreBlanketIgnoresData: gitStatusSummary.gitignore_blanket_ignores_data,
    broadUncommittedTree: gitStatusSummary.broad_uncommitted_tree
  });
  const nextPhase = "AUTO-RUNNER07X — price decision report runner, no CSV";

  const reportPath = resolve(REPORT_DIR, `auto_runner_artifact_sync_proposal_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `auto_runner_artifact_sync_proposal_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `auto_runner_artifact_sync_proposal_${ts}.csv`);
  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner05x_artifact: sourceAutoRunner05xArtifactPath,
    current_state_summary: currentStateSummary,
    git_status_summary: gitStatusSummary,
    data_size_summary: dataSizeSummary,
    artifact_category_matrix: artifactCategoryMatrix,
    github_transfer_options: githubTransferOptions,
    recommended_transfer_strategy: recommendedTransferStrategy,
    gitignore_recommendations: gitignoreRecommendations,
    release_archive_policy: releaseArchivePolicy,
    always_on_mac_restore_plan: alwaysOnMacRestorePlan,
    integrity_checks: integrityChecks,
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
      sourceArtifactPath: sourceAutoRunner05xArtifactPath,
      current: currentStateSummary,
      git: gitStatusSummary,
      sizes: dataSizeSummary,
      categories: artifactCategoryMatrix,
      options: githubTransferOptions,
      recommendedStrategy: recommendedTransferStrategy,
      gitignore: gitignoreRecommendations,
      release: releaseArchivePolicy,
      restore: alwaysOnMacRestorePlan,
      integrity: integrityChecks,
      risks,
      safety: safetyConfirmation
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderCategoryCsv(artifactCategoryMatrix), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner05x_artifact.json"), sourceAutoRunner05xArtifact);
  writeJson(resolve(debugPath, "source_auto_runner04x_artifact.json"), readJsonIfExists(SOURCE_AUTO_RUNNER04X_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_auto_runner03x_artifact.json"), readJsonIfExists(SOURCE_AUTO_RUNNER03X_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_auto_runner02x_artifact.json"), readJsonIfExists(SOURCE_AUTO_RUNNER02X_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_auto_runner01x_artifact.json"), readJsonIfExists(SOURCE_AUTO_RUNNER01X_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "git_status_snapshot.json"), { status_lines: statusLines });
  writeFileSync(resolve(debugPath, "gitignore_snapshot.txt"), gitignoreText, "utf8");
  writeJson(resolve(debugPath, "repo_tracking_summary.json"), { tracked_files: trackedFiles, tracked_file_count: trackedFiles.length });
  writeJson(resolve(debugPath, "data_size_summary.json"), dataSizeSummary);
  writeJson(resolve(debugPath, "artifact_category_matrix.json"), artifactCategoryMatrix);
  writeJson(resolve(debugPath, "github_transfer_options.json"), githubTransferOptions);
  writeJson(resolve(debugPath, "gitignore_recommendations.json"), gitignoreRecommendations);
  writeJson(resolve(debugPath, "restore_plan.json"), alwaysOnMacRestorePlan);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

const result = run();
console.log(`report_path=${result.reportPath}`);
console.log(`json_path=${result.jsonPath}`);
console.log(`csv_path=${result.csvPath}`);
console.log(`debug_artifact_path=${result.debugPath}`);
console.log(`decision=${result.decision}`);
