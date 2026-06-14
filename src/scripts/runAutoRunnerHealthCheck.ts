// Phase AUTO-RUNNER07F - dry-run-only auto-runner health check.
//
// This command reads state and runner-stub artifacts, writes health reports,
// run-state, and logs. It does not execute collectors, sync, context refresh,
// query smoke, pricing output, launchd, cron, or GitHub Actions.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildCurrentStateSnapshot,
  buildMutationCheck,
  buildSafetyConfirmation,
  decideAutoRunnerHealthCheck,
  evaluateGates,
  renderHealthCheckCsv,
  renderHealthCheckLog,
  renderReport,
  summarizeRunnerStub,
  type AutoRunnerHealthCheckOutput
} from "../services/autoRunnerHealthCheck";
import { buildRunnerStubSummaryInProcess, type AutoRunnerDbUpdateStubOutput } from "../services/autoRunnerDbUpdateStub";

const SOURCE_AUTO_RUNNER07E_ARTIFACT_PATH = ".data/reports/automation/auto_runner_db_update_stub_20260605_234414.json";
const SOURCE_AUTO_RUNNER07D_ARTIFACT_PATH = ".data/reports/automation/auto_runner_db_update_integration_proposal_20260605_232803.json";
const SOURCE_FRESH_SYNC_ARTIFACT_PATH = ".data/reports/automation/fresh_history_to_db_sync_20260605_230258.json";
const HISTORY_DIR = ".data/history";
const DB_PATH = ".data/zao-market-intelligence.sqlite";
const LATEST_MARKET_SNAPSHOT_PATH = ".data/ai-context/latest_market_snapshot.json";
const LATEST_AI_TASK_ENTRYPOINT_PATH = ".data/ai-context/latest_ai_task_entrypoint.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-health-check";
const RUN_STATE_DIR = ".data/run-state";
const LOG_DIR = ".logs";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function timestampForLog(ts: string): string {
  return ts.replace("_", "-");
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

// Locate the latest matching artifact so a fresh clone (which lacks the
// original hardcoded timestamped file) can still resolve a source.
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(): AutoRunnerHealthCheckOutput {
  const ts = timestamp();
  const runId = `auto_runner_health_check_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  const runStatePath = resolve(RUN_STATE_DIR, `${runId}.json`);
  const latestRunStatePath = resolve(RUN_STATE_DIR, "auto_runner_health_check_latest.json");
  const logPath = resolve(LOG_DIR, `auto-runner-health-check-${timestampForLog(ts)}.log`);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });
  mkdirSync(resolve(RUN_STATE_DIR), { recursive: true });
  mkdirSync(resolve(LOG_DIR), { recursive: true });

  // Prefer the original hardcoded artifact, then any latest matching artifact,
  // then derive the runner summary directly in-process so this command works on
  // a fresh clone without previously generated .data/reports artifacts.
  const source07ePath = existsSync(SOURCE_AUTO_RUNNER07E_ARTIFACT_PATH)
    ? resolve(SOURCE_AUTO_RUNNER07E_ARTIFACT_PATH)
    : findLatestArtifact(REPORT_DIR, "auto_runner_db_update_stub_");
  const currentStateBefore = buildCurrentStateSnapshot({ historyDir: HISTORY_DIR, dbPath: DB_PATH, aiContextPath: LATEST_MARKET_SNAPSHOT_PATH });
  const gateEvaluation = evaluateGates(process.env);
  const runnerStubSummary = source07ePath
    ? summarizeRunnerStub(readJson<AutoRunnerDbUpdateStubOutput>(source07ePath))
    : buildRunnerStubSummaryInProcess({ historyDir: HISTORY_DIR, dbPath: DB_PATH, aiContextPath: LATEST_MARKET_SNAPSHOT_PATH, env: process.env });
  const sourceArtifactDescriptor = source07ePath ? source07ePath : "in_process_runner_plan";
  const currentStateAfter = buildCurrentStateSnapshot({ historyDir: HISTORY_DIR, dbPath: DB_PATH, aiContextPath: LATEST_MARKET_SNAPSHOT_PATH });
  const mutationCheck = buildMutationCheck(currentStateBefore, currentStateAfter);
  const safetyConfirmation = buildSafetyConfirmation();
  // Expected canonical baseline after 15X-B controlled planner-driven live run
  // (270 -> 275; +5 intraday Booking price-change rows). Then scheduled 09:00
  // planner-driven runs appended 24 rows each on 2026-06-09 through 2026-06-13
  // (275 -> 299 -> 323 -> 347 -> 371 -> 395), then the AUTO-RUNNER16X-D manual
  // gated live-append pilot appended 11 rows per run x2 on 2026-06-14
  // (395 -> 406 -> 417), then the AUTO-RUNNER16X-E2 rotating-live cutover
  // kickstart appended 10 rows (417 -> 427), then the AUTO-RUNNER16X-F expanded
  // universe + cap-24 cutover kickstarts appended jalan 12 then booking 12 +
  // jalan 12 (427 -> 439 -> 463), then ongoing 2-hourly rotating-live scheduled
  // runs (463 -> 596).
  const EXPECTED_BASELINE_ROW_COUNT = 596;
  const before = currentStateBefore.current_state_summary;
  const after = currentStateAfter.current_state_summary;
  const stateCountsMatchExpected =
    before.history_rows === EXPECTED_BASELINE_ROW_COUNT &&
    before.db_rows === EXPECTED_BASELINE_ROW_COUNT &&
    before.ai_context_rows === EXPECTED_BASELINE_ROW_COUNT &&
    after.history_rows === EXPECTED_BASELINE_ROW_COUNT &&
    after.db_rows === EXPECTED_BASELINE_ROW_COUNT &&
    after.ai_context_rows === EXPECTED_BASELINE_ROW_COUNT;
  const decision = decideAutoRunnerHealthCheck({
    stateCountsMatchExpected,
    gates: gateEvaluation,
    runnerStub: runnerStubSummary,
    mutation: mutationCheck,
    sourceArtifactPresent: runnerStubSummary.decision.length > 0
  });
  const nextPhase = "AUTO-RUNNER08X — Miuraya pricing CSV generation proposal, gated; or AUTO-RUNNER07G — always-on Mac launchd dry-run health-check installation proposal";
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const output: AutoRunnerHealthCheckOutput = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto_runner07e_artifact: sourceArtifactDescriptor,
    current_state_before: currentStateBefore,
    current_state_after: currentStateAfter,
    gate_evaluation: gateEvaluation,
    runner_stub_summary: runnerStubSummary,
    mutation_check: mutationCheck,
    run_state_artifact: runStatePath,
    log_artifact: logPath,
    safety_confirmation: safetyConfirmation,
    next_phase: nextPhase,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };

  writeFileSync(reportPath, renderReport(output), "utf8");
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderHealthCheckCsv(output), "utf8");
  writeJson(runStatePath, output);
  writeJson(latestRunStatePath, output);
  writeFileSync(logPath, renderHealthCheckLog(output), "utf8");

  writeJson(resolve(debugPath, "source_auto_runner07e_artifact.json"), source07ePath ? readJsonIfExists(source07ePath) : { runner_stub_summary: runnerStubSummary });
  writeJson(resolve(debugPath, "source_auto_runner07d_artifact.json"), readJsonIfExists(SOURCE_AUTO_RUNNER07D_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "source_fresh_sync_artifact.json"), readJsonIfExists(SOURCE_FRESH_SYNC_ARTIFACT_PATH));
  writeJson(resolve(debugPath, "latest_market_snapshot.json"), readJsonIfExists(LATEST_MARKET_SNAPSHOT_PATH));
  writeJson(resolve(debugPath, "latest_ai_task_entrypoint.json"), readJsonIfExists(LATEST_AI_TASK_ENTRYPOINT_PATH));
  writeJson(resolve(debugPath, "current_state_before.json"), currentStateBefore);
  writeJson(resolve(debugPath, "current_state_after.json"), currentStateAfter);
  writeJson(resolve(debugPath, "gate_evaluation.json"), gateEvaluation);
  writeJson(resolve(debugPath, "runner_stub_summary.json"), runnerStubSummary);
  writeJson(resolve(debugPath, "mutation_check.json"), mutationCheck);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  return output;
}

const result = run();
console.log(`decision=${result.decision}`);
console.log(`history_count=${result.current_state_after.current_state_summary.history_rows}`);
console.log(`db_count=${result.current_state_after.current_state_summary.db_rows}`);
console.log(`ai_context_count=${result.current_state_after.current_state_summary.ai_context_rows}`);
console.log(`runner_stub_decision=${result.runner_stub_summary.decision}`);
console.log(`risky_stages_enabled=${result.runner_stub_summary.risky_stages_enabled}`);
console.log(`mutation_detected=${result.mutation_check.mutation_detected}`);
console.log(`report_path=${result.report_path}`);
console.log(`json_path=${result.json_path}`);
console.log(`csv_path=${result.csv_path}`);
console.log(`debug_artifact_path=${result.debug_artifact_path}`);
console.log(`run_state_path=${result.run_state_artifact}`);
console.log(`log_path=${result.log_artifact}`);
