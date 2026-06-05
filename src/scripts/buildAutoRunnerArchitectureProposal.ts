// Phase AUTO-RUNNER00X — Always-on Mac / GitHub artifact transfer / scheduled
// execution architecture PROPOSAL (report).
//
// PROPOSAL / DESIGN ONLY, read-only orchestrator. Reads the current verified
// system state (history shard row counts, DB mirror counts in readonly mode, AI
// context snapshot, presence of key reports), assembles the architecture design,
// and writes a md/json/csv proposal plus debug artifacts.
//
// This script enables NO automation: it writes NO history, NO DB rows, runs NO
// live request / browser automation / collector, registers NO cron or launchd
// job, creates NO GitHub Actions workflow, emits NO property-management or
// channel-manager output, and performs NO price update.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildProposal,
  buildSourceRoles,
  decideProposal,
  renderProposalCsv,
  renderProposalReport,
  type SourceStateSummary
} from "../services/autoRunnerArchitectureProposal";

const DB_PATH = ".data/zao-market-intelligence.sqlite";
const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-architecture-proposal";
const AI_CONTEXT_SNAPSHOT = ".data/ai-context/latest_market_snapshot.json";

const KEY_INPUT_ARTIFACTS = [
  ".data/reports/automation/jalan_price_pressure_usability_20260605_110311.json",
  ".data/reports/automation/post_jalan_history_append_refresh_20260605_104956.json",
  ".data/reports/automation/booking_price_pressure_usability_20260604_213713.json",
  ".data/reports/automation/post_booking_history_append_refresh_20260604_155005.json",
  ".data/ai-context/latest_market_snapshot.json",
  ".data/ai-context/latest_ai_task_entrypoint.json"
];

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

function countHistoryRows(): number {
  const dir = resolve(HISTORY_DIR);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir).filter((n) => /^zao_signals_.*\.csv$/.test(n))) {
    const lines = readFileSync(resolve(dir, name), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    total += Math.max(0, lines.length - 1);
  }
  return total;
}

interface DbCounts {
  total: number;
  booking: number;
  jalan: number;
  rakuten: number;
}

function readDbCounts(): DbCounts {
  // READ-ONLY: open the existing DB in readonly mode; never migrate or write.
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    const total = (db.prepare("SELECT COUNT(*) AS c FROM market_signal_history").get() as { c: number }).c;
    const bySource = db
      .prepare("SELECT source, COUNT(*) AS c FROM market_signal_history GROUP BY source")
      .all() as Array<{ source: string; c: number }>;
    const get = (src: string): number => bySource.find((r) => r.source === src)?.c ?? 0;
    return { total, booking: get("booking"), jalan: get("jalan"), rakuten: get("rakuten") };
  } finally {
    db.close();
  }
}

function readAiContextRows(): number {
  const path = resolve(AI_CONTEXT_SNAPSHOT);
  if (!existsSync(path)) return 0;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { market_signal_history_row_count?: number };
    return j.market_signal_history_row_count ?? 0;
  } catch {
    return 0;
  }
}

// Inventory of npm scripts, lightly categorized for the proposal.
function readScriptsInventory(): {
  totalScripts: number;
  collectors: string[];
  proposalsAndReports: number;
  syncAndContext: string[];
  pricing: string[];
} {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const names = Object.keys(scripts);
  return {
    totalScripts: names.length,
    collectors: names.filter((n) => n.startsWith("collect:") || n.startsWith("probe:")),
    proposalsAndReports: names.filter((n) => n.startsWith("report:") || n.startsWith("proposal:")).length,
    syncAndContext: names.filter(
      (n) =>
        n.includes("history-to-db-sync") ||
        n.includes("ai-context") ||
        n.startsWith("refresh:") ||
        n.startsWith("query:")
    ),
    pricing: names.filter((n) => n.startsWith("pricing:") || n.includes("pricing-review") || n.includes("approved-preview"))
  };
}

function writeDebug(debugPath: string, name: string, data: unknown): void {
  writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function main(): void {
  const ts = timestamp();
  const runId = `auto_runner_architecture_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);

  const historyRows = countHistoryRows();
  const dbCounts = readDbCounts();
  const aiContextRows = readAiContextRows();
  const inputArtifactsPresent = KEY_INPUT_ARTIFACTS.every((p) => existsSync(resolve(p)));
  const scriptsInventory = readScriptsInventory();

  const state: SourceStateSummary = {
    historyRows,
    dbRows: dbCounts.total,
    bookingRows: dbCounts.booking,
    jalanRows: dbCounts.jalan,
    rakutenRows: dbCounts.rakuten,
    aiContextRows,
    inputArtifactsPresent,
    roles: buildSourceRoles()
  };

  const proposal = buildProposal(state);
  const decision = decideProposal(state);

  const safetyConfirmation = {
    no_live_collection: true,
    no_playwright: true,
    no_browser_automation: true,
    no_external_fetch: true,
    no_history_mutation: true,
    no_db_write: true,
    no_db_sync: true,
    no_ai_context_refresh: true,
    no_cron_registration: true,
    no_launchd_installation: true,
    no_github_actions_activation: true,
    no_commit_or_push: true,
    no_pricing_csv: true,
    no_pms_beds24_airhost_output: true,
    no_price_update: true,
    no_paid_sources: true
  };

  const reportInput = {
    generatedAtJst,
    runId,
    decision,
    proposal,
    reportPath,
    jsonPath,
    csvPath,
    debugRootPath: debugPath
  };

  const jsonPayload = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_state_summary: state,
    available_scripts_inventory: scriptsInventory,
    architecture_principles: proposal.architecturePrinciples,
    manual_workflow_design: proposal.manualWorkflowDesign,
    schedule_design: proposal.scheduleDesign,
    bot_risk_assessment: proposal.botRiskAssessment,
    github_transfer_plan: proposal.githubTransferPlan,
    local_mac_setup_checklist: proposal.localMacSetupChecklist,
    fail_closed_gates: proposal.failClosedGates,
    data_retention_policy: proposal.dataRetentionPolicy,
    future_phase_plan: proposal.futurePhasePlan,
    risks: proposal.risks,
    safety_confirmation: safetyConfirmation,
    next_phase: "AUTO-RUNNER01X (do not start without explicit instruction)"
  };

  writeFileSync(reportPath, renderProposalReport(reportInput), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderProposalCsv(proposal.manualWorkflowDesign), "utf8");

  writeDebug(debugPath, "source_state_summary.json", state);
  writeDebug(debugPath, "available_scripts_inventory.json", scriptsInventory);
  writeDebug(debugPath, "manual_workflow_design.json", proposal.manualWorkflowDesign);
  writeDebug(debugPath, "schedule_design.json", proposal.scheduleDesign);
  writeDebug(debugPath, "github_transfer_plan.json", proposal.githubTransferPlan);
  writeDebug(debugPath, "local_mac_setup_checklist.json", proposal.localMacSetupChecklist);
  writeDebug(debugPath, "fail_closed_gates.json", proposal.failClosedGates);
  writeDebug(debugPath, "future_phase_plan.json", proposal.futurePhasePlan);
  writeDebug(debugPath, "safety_confirmation.json", safetyConfirmation);

  console.log(`decision=${decision}`);
  console.log(`history_rows=${historyRows} db_rows=${dbCounts.total} ai_context_rows=${aiContextRows}`);
  console.log(`booking=${dbCounts.booking} jalan=${dbCounts.jalan} rakuten=${dbCounts.rakuten}`);
  console.log(`input_artifacts_present=${inputArtifactsPresent}`);
  console.log(`total_scripts=${scriptsInventory.totalScripts} collectors=${scriptsInventory.collectors.length}`);
  console.log(`workflow_stages=${proposal.manualWorkflowDesign.length} future_phases=${proposal.futurePhasePlan.length}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

if (process.argv[1]?.endsWith("buildAutoRunnerArchitectureProposal.ts")) {
  main();
}
