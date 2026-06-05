// Phase AUTO-RUNNER02X - build always-on Mac bootstrap proposal.
//
// Reads local state and writes proposal/debug artifacts only. It does not
// install schedules, launch collectors, modify history, write/sync DB, rebuild
// AI context, install Playwright, or generate pricing/PMS output.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildAiContextRegenerationPlan,
  buildBootstrapPreconditions,
  buildCanonicalHistoryVerificationPlan,
  buildCurrentStateSummary,
  buildDbRegenerationPlan,
  buildDependencyInstallationPlan,
  buildEnvironmentSetupPlan,
  buildFailureHandlingPlan,
  buildFutureBootstrapScriptOutline,
  buildLocalDirectoryLayout,
  buildLoggingBackupPolicy,
  buildRepositoryAcquisitionPlan,
  buildRisks,
  buildSafetyConfirmation,
  decideAutoRunnerBootstrapProposal,
  renderBootstrapCsv,
  renderReport,
  type AutoRunner01xArtifactLike
} from "../services/autoRunnerBootstrapProposal";

const SOURCE_AUTO_RUNNER01X_ARTIFACT_PATH = ".data/reports/automation/auto_runner_migration_proposal_20260605_121138.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-bootstrap-proposal";

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

function summarizeHistory(): { historyRows: number; sourceCounts: Partial<Record<"booking" | "jalan" | "rakuten", number>>; shardFiles: string[] } {
  const historyDir = resolve(".data/history");
  const shardFiles = readdirSync(historyDir).filter((file) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(file)).sort();
  let historyRows = 0;
  const sourceCounts: Partial<Record<"booking" | "jalan" | "rakuten", number>> = {};
  for (const file of shardFiles) {
    const lines = readFileSync(join(historyDir, file), "utf8").trim().split(/\r?\n/u);
    if (lines.length <= 1) continue;
    const header = lines[0]!.split(",");
    const sourceIndex = header.indexOf("source");
    for (const line of lines.slice(1)) {
      if (line.trim() === "") continue;
      historyRows += 1;
      const cols = line.split(",");
      const source = cols[sourceIndex] as "booking" | "jalan" | "rakuten" | undefined;
      if (source === "booking" || source === "jalan" || source === "rakuten") {
        sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
      }
    }
  }
  return { historyRows, sourceCounts, shardFiles };
}

function readAiContextRows(): number {
  try {
    const market = readJson<{ market_signal_history_row_count?: number }>(".data/ai-context/latest_market_snapshot.json");
    return market.market_signal_history_row_count ?? 0;
  } catch {
    return 0;
  }
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `auto_runner_bootstrap_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const sourceAutoRunner01xArtifact = readJson<AutoRunner01xArtifactLike>(SOURCE_AUTO_RUNNER01X_ARTIFACT_PATH);
  const historySummary = summarizeHistory();
  const currentStateSummary = buildCurrentStateSummary({
    autoRunner01x: sourceAutoRunner01xArtifact,
    historyRows: historySummary.historyRows,
    sourceCounts: historySummary.sourceCounts,
    aiContextRows: readAiContextRows()
  });
  const bootstrapPreconditions = buildBootstrapPreconditions();
  const repositoryAcquisitionPlan = buildRepositoryAcquisitionPlan();
  const dependencyInstallationPlan = buildDependencyInstallationPlan();
  const environmentSetupPlan = buildEnvironmentSetupPlan(currentStateSummary.env_example_present);
  const canonicalHistoryVerificationPlan = buildCanonicalHistoryVerificationPlan();
  const dbRegenerationPlan = buildDbRegenerationPlan();
  const aiContextRegenerationPlan = buildAiContextRegenerationPlan();
  const localDirectoryLayout = buildLocalDirectoryLayout();
  const loggingBackupPolicy = buildLoggingBackupPolicy();
  const failureHandlingPlan = buildFailureHandlingPlan();
  const futureBootstrapScriptOutline = buildFutureBootstrapScriptOutline();
  const risks = buildRisks(currentStateSummary);
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideAutoRunnerBootstrapProposal({
    autoRunner01xPresent: sourceAutoRunner01xArtifact.decision !== undefined,
    current: currentStateSummary
  });
  const sourceAutoRunner01xArtifactPath = resolve(SOURCE_AUTO_RUNNER01X_ARTIFACT_PATH);
  const nextPhase = "AUTO-RUNNER03X — Manual end-to-end runner script proposal, disabled collectors by default";

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner01x_artifact: sourceAutoRunner01xArtifactPath,
    current_state_summary: currentStateSummary,
    bootstrap_preconditions: bootstrapPreconditions,
    repository_acquisition_plan: repositoryAcquisitionPlan,
    dependency_installation_plan: dependencyInstallationPlan,
    environment_setup_plan: environmentSetupPlan,
    canonical_history_verification_plan: canonicalHistoryVerificationPlan,
    db_regeneration_plan: dbRegenerationPlan,
    ai_context_regeneration_plan: aiContextRegenerationPlan,
    local_directory_layout: localDirectoryLayout,
    logging_backup_policy: loggingBackupPolicy,
    failure_handling_plan: failureHandlingPlan,
    future_bootstrap_script_outline: futureBootstrapScriptOutline,
    risks,
    safety_confirmation: safetyConfirmation,
    next_phase: nextPhase,
    history_summary: historySummary,
    report_path: "",
    json_path: "",
    csv_path: "",
    debug_artifact_path: debugPath
  };

  const reportPath = resolve(REPORT_DIR, `auto_runner_bootstrap_proposal_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `auto_runner_bootstrap_proposal_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `auto_runner_bootstrap_proposal_${ts}.csv`);
  output.report_path = reportPath;
  output.json_path = jsonPath;
  output.csv_path = csvPath;

  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      sourceArtifactPath: sourceAutoRunner01xArtifactPath,
      current: currentStateSummary,
      preconditions: bootstrapPreconditions,
      repository: repositoryAcquisitionPlan,
      dependencies: dependencyInstallationPlan,
      environment: environmentSetupPlan,
      history: canonicalHistoryVerificationPlan,
      db: dbRegenerationPlan,
      ai: aiContextRegenerationPlan,
      layout: localDirectoryLayout,
      logging: loggingBackupPolicy,
      failure: failureHandlingPlan,
      outline: futureBootstrapScriptOutline,
      risks,
      safety: safetyConfirmation
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderBootstrapCsv({ preconditions: bootstrapPreconditions, failureHandling: failureHandlingPlan, risks }), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner01x_artifact.json"), sourceAutoRunner01xArtifact);
  writeJson(resolve(debugPath, "bootstrap_preconditions.json"), bootstrapPreconditions);
  writeJson(resolve(debugPath, "bootstrap_command_sequence.json"), {
    repository_acquisition_plan: repositoryAcquisitionPlan,
    dependency_installation_plan: dependencyInstallationPlan,
    future_bootstrap_script_outline: futureBootstrapScriptOutline
  });
  writeJson(resolve(debugPath, "history_verification_plan.json"), canonicalHistoryVerificationPlan);
  writeJson(resolve(debugPath, "db_regeneration_plan.json"), dbRegenerationPlan);
  writeJson(resolve(debugPath, "ai_context_regeneration_plan.json"), aiContextRegenerationPlan);
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
