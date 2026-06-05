// Phase AUTO01X — build automated DB update + AI retrieval architecture plan.
//
// Reads local artifacts and package scripts only. Writes design artifacts under
// .data/reports/automation and .data/debug. No DB write, collector, workflow,
// history/master mutation, external fetch, GitOps push, commit, or schedule.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildAutomatedDbAiRetrievalPlan,
  renderAutomatedDbAiRetrievalCsv,
  renderAutomatedDbAiRetrievalReport,
  type CurrentState
} from "../services/automatedDbAiRetrievalPlan";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/automated-db-ai-retrieval-plan";
const HISTORY_DIR = ".data/history";

const AI_MANIFEST_JSON = ".data/reports/market-update/ai_readable_market_manifest_latest.json";
const DATA_DICTIONARY_JSON = ".data/reports/market-update/market_data_dictionary_latest.json";
const GITOPS_JSON = ".data/reports/source-discovery/gitops_data_repo_design_20260602_094108.json";
const HISTORY_REAL_APPEND_JSON = ".data/reports/source-discovery/local_history_real_append_20260602_092832.json";
const HISTORY_VALIDATION_JSON = ".data/reports/source-discovery/local_history_append_validation_policy_20260602_085818.json";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
}

function decisionFrom(json: Record<string, unknown>): string {
  const summary = json["summary"] as Record<string, unknown> | undefined;
  return String(json["decision"] ?? summary?.["decision"] ?? "unknown");
}

function countHistoryRows(): { fileCount: number; rowCount: number; files: string[] } {
  const files = readdirSync(resolve(HISTORY_DIR))
    .filter((name) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(name))
    .sort();
  let rowCount = 0;
  for (const file of files) {
    const text = readFileSync(resolve(HISTORY_DIR, file), "utf8").trim();
    if (text !== "") rowCount += Math.max(0, text.split(/\r?\n/).length - 1);
  }
  return { fileCount: files.length, rowCount, files };
}

function packageScripts(): Record<string, string> {
  const pkg = readJson("package.json");
  return (pkg["scripts"] as Record<string, string>) ?? {};
}

function main(): void {
  const ts = timestamp();
  const runId = `automated_db_ai_retrieval_plan_${ts}`;
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const aiManifest = readJson(AI_MANIFEST_JSON);
  const dataDictionary = readJson(DATA_DICTIONARY_JSON);
  const gitops = readJson(GITOPS_JSON);
  const historyAppend = readJson(HISTORY_REAL_APPEND_JSON);
  const historyValidation = readJson(HISTORY_VALIDATION_JSON);
  const history = countHistoryRows();
  const scripts = packageScripts();

  const currentState: CurrentState = {
    aiManifestDecision: decisionFrom(aiManifest),
    dataDictionaryDecision: decisionFrom(dataDictionary),
    gitopsDesignDecision: decisionFrom(gitops),
    localHistoryRealAppendDecision: decisionFrom(historyAppend),
    localHistoryValidationPolicyDecision: decisionFrom(historyValidation),
    historyFileCount: history.fileCount,
    historyRowCount: history.rowCount,
    dbRelatedScriptCount: Object.keys(scripts).filter((s) => s.includes("db:") || s.includes("cf:d1") || s === "market:compute" || s === "quality:compute").length,
    dbBaseline: {
      collectorRunsCount: 42,
      rateSnapshotsCount: 210,
      inventorySnapshotsCount: 210,
      collectionJobAttemptsCount: 166
    }
  };

  const plan = buildAutomatedDbAiRetrievalPlan({
    runId,
    generatedAtJst: jstIso(),
    currentState,
    packageScripts: scripts
  });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);
  writeFileSync(reportPath, renderAutomatedDbAiRetrievalReport(plan), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderAutomatedDbAiRetrievalCsv(plan), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("input_artifacts_used.json", {
    AI_MANIFEST_JSON,
    DATA_DICTIONARY_JSON,
    GITOPS_JSON,
    HISTORY_REAL_APPEND_JSON,
    HISTORY_VALIDATION_JSON,
    HISTORY_DIR
  });
  writeDebug("current_state.json", currentState);
  writeDebug("package_script_classification.json", plan.existing_assets);
  writeDebug("history_files.json", history);
  writeDebug("safety_confirmation.json", plan.safety_confirmation);

  console.log(`decision=${plan.decision}`);
  console.log(`final_goal=${plan.final_goal}`);
  console.log(`option_count=${plan.option_comparison.length}`);
  console.log(`ai_view_count=${plan.ai_readable_views.length}`);
  console.log(`context_pack_count=${plan.context_packs.length}`);
  console.log(`roadmap_count=${plan.phased_roadmap.length}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

main();
