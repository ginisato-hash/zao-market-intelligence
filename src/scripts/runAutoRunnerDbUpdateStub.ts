// Phase AUTO-RUNNER07E - disabled DB update runner stub.
//
// This command writes a dry-run plan only. It does not execute collectors,
// appends, DB sync, AI context refresh, query smoke, pricing reports, CSV, or
// PMS output.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildCurrentStateSummary,
  buildDefaultPipelineStages,
  buildPriceOutputSeparation,
  buildSafetyConfirmation,
  buildStagePlan,
  decideAutoRunnerDbUpdateStub,
  evaluateGates,
  renderReport,
  renderStagePlanCsv,
  summarizeAiContextRows,
  summarizeDbRowsReadOnly,
  summarizeHistoryState,
  type AutoRunnerDbUpdateStubOutput,
  type SourceStageLike
} from "../services/autoRunnerDbUpdateStub";

const SOURCE_AUTO_RUNNER07D_ARTIFACT_PATH = ".data/reports/automation/auto_runner_db_update_integration_proposal_20260605_232803.json";
const SOURCE_SCHEDULE_CONFIG_ARTIFACT_PATH = ".data/reports/automation/auto_runner_bounded_schedule_config_20260605_154449.json";
const SOURCE_FRESH_SYNC_ARTIFACT_PATH = ".data/reports/automation/fresh_history_to_db_sync_20260605_230258.json";
const LATEST_MARKET_SNAPSHOT_PATH = ".data/ai-context/latest_market_snapshot.json";
const LATEST_AI_TASK_ENTRYPOINT_PATH = ".data/ai-context/latest_ai_task_entrypoint.json";
const HISTORY_DIR = ".data/history";
const DB_PATH = ".data/zao-market-intelligence.sqlite";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-db-update-stub";

interface Source07dLike {
  decision?: string;
  updated_pipeline_stages?: SourceStageLike[];
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

// Locate the latest matching artifact in a directory so a fresh clone (which
// lacks the original hardcoded timestamped file) can still resolve a source.
// Read-only directory listing; never spawns a process.
function findLatestArtifact(dir: string, prefix: string): string | undefined {
  const absoluteDir = resolve(dir);
  if (!existsSync(absoluteDir)) {
    return undefined;
  }
  const matches = readdirSync(absoluteDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  const latest = matches[matches.length - 1];
  return latest ? join(absoluteDir, latest) : undefined;
}

function readJsonIfExists(path: string): unknown {
  return existsSync(path) ? readJson(path) : { missing: path };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(): AutoRunnerDbUpdateStubOutput {
  const ts = timestamp();
  const runId = `auto_runner_db_update_stub_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  // Prefer the original hardcoded artifact, then any latest matching artifact,
  // then fall back to the built-in default pipeline model so this command works
  // on a fresh clone without previously generated .data/reports artifacts.
  const source07dPath = existsSync(SOURCE_AUTO_RUNNER07D_ARTIFACT_PATH)
    ? resolve(SOURCE_AUTO_RUNNER07D_ARTIFACT_PATH)
    : findLatestArtifact(REPORT_DIR, "auto_runner_db_update_integration_proposal_");
  const source07d: Source07dLike = source07dPath ? readJson<Source07dLike>(source07dPath) : {};
  const sourceStages = source07d.updated_pipeline_stages ?? buildDefaultPipelineStages();
  const sourceArtifactDescriptor = source07dPath ? source07dPath : "default_pipeline_model";
  const historySummary = summarizeHistoryState(HISTORY_DIR);
  const dbRows = summarizeDbRowsReadOnly(DB_PATH);
  const aiContextRows = summarizeAiContextRows(LATEST_MARKET_SNAPSHOT_PATH);
  const currentStateSummary = buildCurrentStateSummary({ history: historySummary, dbRows, aiContextRows });
  const gateEvaluation = evaluateGates(process.env);
  const stagePlan = buildStagePlan(sourceStages, gateEvaluation);
  const priceOutputSeparation = buildPriceOutputSeparation();
  const safetyConfirmation = buildSafetyConfirmation(stagePlan);
  const decision = decideAutoRunnerDbUpdateStub({
    sourceArtifactsPresent: stagePlan.length > 0,
    currentStateReady: currentStateSummary.history_rows > 0 && currentStateSummary.db_rows > 0 && currentStateSummary.ai_context_rows > 0,
    riskyStagesEnabled: safetyConfirmation.risky_stages_enabled
  });
  const nextPhase = "AUTO-RUNNER08X — Miuraya pricing CSV generation proposal, gated; or AUTO-RUNNER07F — enable selected dry-run-only runner checks on always-on Mac";
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const output: AutoRunnerDbUpdateStubOutput = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner07d_artifact: sourceArtifactDescriptor,
    source_schedule_config_artifact: resolve(SOURCE_SCHEDULE_CONFIG_ARTIFACT_PATH),
    current_state_summary: currentStateSummary,
    gate_evaluation: gateEvaluation,
    stage_plan: stagePlan,
    price_output_separation: priceOutputSeparation,
    safety_confirmation: safetyConfirmation,
    next_phase: nextPhase,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };

  writeFileSync(reportPath, renderReport(output), "utf8");
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderStagePlanCsv(stagePlan), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner07d_artifact.json"), source07d);
  writeJson(resolve(debugPath, "source_schedule_config_artifact.json"), readJsonIfExists(SOURCE_SCHEDULE_CONFIG_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_fresh_sync_artifact.json"), readJsonIfExists(SOURCE_FRESH_SYNC_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "latest_market_snapshot.json"), readJsonIfExists(LATEST_MARKET_SNAPSHOT_PATH));
  writeJson(resolve(debugPath, "latest_ai_task_entrypoint.json"), readJsonIfExists(LATEST_AI_TASK_ENTRYPOINT_PATH));
  writeJson(resolve(debugPath, "current_state_summary.json"), currentStateSummary);
  writeJson(resolve(debugPath, "gate_evaluation.json"), gateEvaluation);
  writeJson(resolve(debugPath, "stage_plan.json"), stagePlan);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  return output;
}

const result = run();
console.log(`decision=${result.decision}`);
console.log(`mutation_executed=${result.safety_confirmation.mutation_executed}`);
console.log(`risky_stages_enabled=${result.safety_confirmation.risky_stages_enabled}`);
console.log(`history_rows=${result.current_state_summary.history_rows}`);
console.log(`db_rows=${result.current_state_summary.db_rows}`);
console.log(`ai_context_rows=${result.current_state_summary.ai_context_rows}`);
console.log(`report_path=${result.report_path}`);
console.log(`json_path=${result.json_path}`);
console.log(`csv_path=${result.csv_path}`);
console.log(`debug_artifact_path=${result.debug_artifact_path}`);
