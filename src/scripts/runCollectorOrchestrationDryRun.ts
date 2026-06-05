// Phase AUTO07X — collector orchestration dry-run runner.
//
// Emits the orchestration PLAN + low-bot-risk strategy as md/json/csv + debug.
// This script NEVER runs a collector; NEVER performs a live external fetch;
// NEVER writes the DB or executes SQL/migrations; NEVER appends to .data/history;
// NEVER mutates .data/ai-context/latest_*; NEVER modifies the property master;
// NEVER produces Beds24/AirHost/PMS/OTA output; NEVER updates prices; NEVER uses
// a Booking base × 1.1; NEVER enables GitHub Actions/GitOps/cron; NEVER commits/
// pushes; and NEVER uses paid sources. Output goes only to .data/reports and
// .data/debug. The optional DB read is opened { readonly: true }.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildApprovalGates,
  buildCollectionMethodComparison,
  buildCollectorInventory,
  buildDateWindowPlan,
  buildDownstreamPipelinePlan,
  buildDryRunActions,
  buildMicroBatchConstraints,
  buildNormalizedRowContract,
  buildRecommendedStrategy,
  buildRisks,
  buildSourceStrategies,
  decideCollectorOrchestration,
  renderInventoryCsv,
  renderOrchestrationReport,
  type CollectionMethod,
  type OrchestrationDryRun
} from "../services/collectorOrchestrationDryRun";

const DB_PATH = ".data/zao-market-intelligence.sqlite";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/collector-orchestration-dry-run";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstParts(): { iso: string; date: string } {
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
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { iso: `${date}T${get("hour")}:${get("minute")}:${get("second")}+09:00`, date };
}

// Optional, read-only DB-mirror row count to annotate the plan. Never writes.
function readMirrorRowCount(): number {
  if (!existsSync(DB_PATH)) return 0;
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='market_signal_history'").get();
    if (exists === undefined) return 0;
    return Number((db.prepare("SELECT COUNT(*) AS c FROM market_signal_history").get() as { c: number }).c);
  } finally {
    db.close();
  }
}

function paidRejected(methods: CollectionMethod[]): boolean {
  return methods.some((m) => m.id === "F" && m.status === "forbidden");
}

function build(): { decision: string; reportPath: string; jsonPath: string; csvPath: string; debugRootPath: string } {
  const ts = timestamp();
  const runId = `collector_orchestration_dry_run_${ts}`;
  const jst = jstParts();
  const debugRootPath = resolve(DEBUG_ROOT, ts);

  const methods = buildCollectionMethodComparison();
  const inventory = buildCollectorInventory();
  const candidates = inventory.filter((r) => r.category === "source_collector_candidate" || r.category === "source_probe");
  const mirrorRowCount = readMirrorRowCount();

  const decision = decideCollectorOrchestration({
    methodCount: methods.length,
    paidRejected: paidRejected(methods),
    inventoryCount: inventory.length,
    liveCollectorsExecuted: false
  });

  const plan: OrchestrationDryRun = {
    run_id: runId,
    generated_at_jst: jst.iso,
    decision,
    collection_method_comparison: methods,
    recommended_collection_strategy: buildRecommendedStrategy(),
    collector_inventory: inventory,
    candidate_collectors: candidates,
    source_specific_strategy: buildSourceStrategies(),
    date_window_plan: buildDateWindowPlan(jst.date),
    micro_batch_constraints: buildMicroBatchConstraints(),
    normalized_row_contract: buildNormalizedRowContract(),
    dry_run_actions: buildDryRunActions(),
    downstream_pipeline_plan: buildDownstreamPipelinePlan(),
    approval_gates: buildApprovalGates(),
    risks: [
      ...buildRisks(),
      `Current DB mirror row count (read-only): ${mirrorRowCount}.`
    ],
    safety_confirmation: {
      liveCollectorsExecuted: false,
      liveExternalFetch: false,
      dbWrites: false,
      sqlExecuted: false,
      migrationsExecuted: false,
      tablesCreated: false,
      dbOpenedReadOnly: true,
      historyAppended: false,
      aiContextLatestMutated: false,
      propertyMasterModified: false,
      pricesUpdated: false,
      pmsOutput: false,
      beds24Output: false,
      airhostOutput: false,
      otaUpload: false,
      bookingBaseTimes1_1: false,
      githubActionsActivated: false,
      cronActivated: false,
      gitOpsPush: false,
      versionControlCommitsOrPushes: false,
      paidSources: false,
      captchaBypass: false,
      stealthPlugin: false,
      loginOrCookieInjection: false,
      startedDp03x: false,
      startedR01x: false
    },
    next_phase: "AUTO08X — First guarded auto history append real run (explicit approval required; do not start without instruction)."
  };

  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  writeFileSync(jsonPath, JSON.stringify(plan, null, 2), "utf8");
  writeFileSync(csvPath, renderInventoryCsv(inventory), "utf8");
  writeFileSync(reportPath, renderOrchestrationReport(plan), "utf8");

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("collector_inventory.json", inventory);
  writeDebug("collection_method_comparison.json", methods);
  writeDebug("source_strategy_recommendation.json", plan.source_specific_strategy);
  writeDebug("source_script_inventory.json", candidates);
  writeDebug("date_window_plan.json", plan.date_window_plan);
  writeDebug("micro_batch_plan.json", plan.micro_batch_constraints);
  writeDebug("normalized_row_contract.json", plan.normalized_row_contract);
  writeDebug("dry_run_actions.json", plan.dry_run_actions);
  writeDebug("downstream_pipeline_plan.json", plan.downstream_pipeline_plan);
  writeDebug("safety_confirmation.json", plan.safety_confirmation);

  return { decision, reportPath, jsonPath, csvPath, debugRootPath };
}

try {
  const out = build();
  console.log(`decision=${out.decision}`);
  console.log(`report_path=${out.reportPath}`);
  console.log(`json_path=${out.jsonPath}`);
  console.log(`csv_path=${out.csvPath}`);
  console.log(`debug_root=${out.debugRootPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
