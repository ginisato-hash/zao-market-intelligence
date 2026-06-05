// Phase AUTO-RUNNER-HANDOFF02X - build Git transfer policy report.
//
// This script writes report/debug artifacts and uses only read-only Git
// inspection commands. It does not stage, commit, push, sync DB, refresh AI
// context, run collectors, or execute always-on Mac checklist commands.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildGitCheckIgnoreResult,
  buildRisks,
  buildSafetyConfirmation,
  buildTransferManifest,
  decideGitTransferPolicy,
  renderReport,
  renderTransferManifestCsv,
  summarizeGitCheckIgnore,
  summarizeGitignorePolicy,
  summarizeHistoryShards,
  type GitCheckIgnoreResult
} from "../services/autoRunnerGitTransferPolicy";

const SOURCE_HANDOFF01X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_always_on_mac_handoff_plan_20260606_000259.json";
const SOURCE_HANDOFF01X_GITIGNORE_SNAPSHOT_PATH = ".data/debug/auto-runner-always-on-mac-handoff-plan/20260606_000259/gitignore_snapshot.txt";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-git-transfer-policy";
const HISTORY_DIR = ".data/history";

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

function gitLines(args: string[]): string[] {
  return execFileSync("git", args, { encoding: "utf8" })
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
}

function gitCheckIgnore(path: string): string {
  try {
    return execFileSync("git", ["check-ignore", "-v", path], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function readHistoryFiles(): Array<{ path: string; text: string }> {
  return readdirSync(resolve(HISTORY_DIR))
    .filter((name) => /^zao_signals_.*\.csv$/u.test(name))
    .sort()
    .map((name) => {
      const path = join(HISTORY_DIR, name);
      return { path, text: readFileSync(resolve(path), "utf8") };
    });
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `auto_runner_git_transfer_policy_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const sourceHandoff01x = readJson<unknown>(SOURCE_HANDOFF01X_ARTIFACT_PATH);
  const beforeGitignoreText = existsSync(SOURCE_HANDOFF01X_GITIGNORE_SNAPSHOT_PATH)
    ? readFileSync(resolve(SOURCE_HANDOFF01X_GITIGNORE_SNAPSHOT_PATH), "utf8")
    : "";
  const afterGitignoreText = readFileSync(resolve(".gitignore"), "utf8");
  const beforeSummary = summarizeGitignorePolicy(beforeGitignoreText);
  const afterSummary = summarizeGitignorePolicy(afterGitignoreText);
  const historyFiles = readHistoryFiles();
  const historySummary = summarizeHistoryShards({ files: historyFiles });
  const manifest = buildTransferManifest();
  const risks = buildRisks();
  const safety = buildSafetyConfirmation();

  const gitStatusSnapshot = gitLines(["status", "--short"]);
  const gitTrackedFiles = gitLines(["ls-files"]);
  const checkResults: GitCheckIgnoreResult[] = [
    ...historyFiles.map((file) =>
      buildGitCheckIgnoreResult({
        path: file.path,
        raw: gitCheckIgnore(file.path),
        expected: "trackable"
      })
    ),
    ...[
      ".data/zao-market-intelligence.sqlite",
      ".data/debug",
      ".data/screenshots",
      ".data/reports",
      ".data/ai-context",
      ".data/run-state",
      ".logs",
      ".env"
    ].map((path) => buildGitCheckIgnoreResult({ path, raw: gitCheckIgnore(path), expected: "ignored" as const }))
  ];
  const gitCheckIgnoreSummary = summarizeGitCheckIgnore(checkResults);

  const decision = decideGitTransferPolicy({
    sourcePresent: sourceHandoff01x !== undefined,
    gitignorePolicyReady: afterSummary.policy_ready,
    gitIgnoreVerificationPassed: gitCheckIgnoreSummary.all_passed,
    historySummaryPassed: historySummary.expected_counts_passed,
    commitPushStillManual: true
  });
  const nextPhase = "Human approval: review transfer manifest and approve git add/commit/push scope. Then AUTO-RUNNER-HANDOFF03X.";
  const sourceHandoff01xPath = resolve(SOURCE_HANDOFF01X_ARTIFACT_PATH);
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_handoff01x_artifact: sourceHandoff01xPath,
    gitignore_before_summary: beforeSummary,
    gitignore_after_summary: afterSummary,
    git_check_ignore_results: gitCheckIgnoreSummary,
    history_summary: historySummary,
    transfer_manifest: manifest,
    risks,
    safety_confirmation: safety,
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
      sourceHandoff01xPath,
      before: beforeSummary,
      after: afterSummary,
      gitCheckIgnoreSummary,
      history: historySummary,
      manifest,
      risks,
      safety,
      nextPhase
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderTransferManifestCsv(manifest), "utf8");

  writeJson(resolve(debugPath, "source_handoff01x_artifact.json"), sourceHandoff01x);
  writeFileSync(resolve(debugPath, "gitignore_before.txt"), beforeGitignoreText, "utf8");
  writeFileSync(resolve(debugPath, "gitignore_after.txt"), afterGitignoreText, "utf8");
  writeJson(resolve(debugPath, "git_status_snapshot.json"), { status_entries: gitStatusSnapshot, tracked_files: gitTrackedFiles });
  writeJson(resolve(debugPath, "git_check_ignore_results.json"), gitCheckIgnoreSummary);
  writeJson(resolve(debugPath, "history_summary.json"), historySummary);
  writeJson(resolve(debugPath, "transfer_manifest.json"), manifest);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safety);

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

const result = run();
console.log(`decision=${result.decision}`);
console.log(`report_path=${result.reportPath}`);
console.log(`json_path=${result.jsonPath}`);
console.log(`csv_path=${result.csvPath}`);
console.log(`debug_artifact_path=${result.debugPath}`);
