// Phase M05X — build the first real local history append PROPOSAL.
//
// Reads the latest M03X dry-run artifacts (scenario-A actions + summary) and
// M04X policy artifacts, computes the exact future target-file plan / row
// counts / dedupe counts, documents rollback + preflight, and evaluates the
// approval gate that stays CLOSED by default. Writes a local
// report/CSV/JSON + debug artifacts. Never writes to .data/history.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertNotRealHistoryPath, type AppendActionRecord } from "../services/localHistoryAppendDryRun";
import { HISTORY_SCHEMA_VERSION } from "../services/localHistorySchemaDesign";
import {
  PROPOSED_REAL_RUN_COMMAND,
  REQUIRED_OPT_IN_FLAGS,
  TARGET_HISTORY_DIR,
  aggregateAppendActionsByShard,
  buildPreflightChecklist,
  buildRollbackPlan,
  buildTargetFilePlan,
  decideM05X,
  evaluateRealAppendApproval,
  renderProposalReport,
  renderTargetFilePlanCsv,
  type ProposalSummary
} from "../services/localHistoryRealAppendProposal";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/history-real-append-proposal";
const HISTORY_DIR = ".data/history";

const M03X_REPORT_PREFIX = "local_history_append_dry_run_";
const M03X_DEBUG_ROOT = ".data/debug/history-append-dry-run";
const M04X_REPORT_PREFIX = "local_history_append_validation_policy_";
const M04X_DEBUG_ROOT = ".data/debug/history-append-validation-policy";

// M05X is proposal-only. The approval gate stays CLOSED: real append must never
// run from this phase, even if REAL_HISTORY_APPEND=1 is accidentally set.
const EXPLICIT_USER_APPROVED = false;

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function nowJst(): string {
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
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

function resolveLatest(prefix: string): { jsonPath: string; ts: string } {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing artifact directory: ${reportDir}. Do not re-run collectors; produce the prior-phase artifact first.`);
  }
  const jsonFiles = entries.filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(`Missing source JSON (expected ${prefix}*.json in ${reportDir}). Stop and report the missing artifact path. Do not re-run collectors.`);
  }
  const ts = latest.slice(prefix.length, -".json".length);
  return { jsonPath: resolve(reportDir, latest), ts };
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Missing required artifact: ${path}. Stop and report the missing artifact path.`);
  }
  try {
    return JSON.parse(raw);
  } catch (caught) {
    throw new Error(`Malformed JSON ${path}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

interface M03XSummary {
  hashConflictCount: number;
  uniqueRowIdCount: number;
  duplicateInputRowCount: number;
  schemaVersion: string;
  decision: string;
}

interface M04XSummary {
  decision: string;
  schemaValid: boolean;
  shardIntegrityOk: boolean;
  hashConflictCount: number;
  forbiddenColumnErrors: number;
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  // Safety: capture .data/history state up front; it must not change.
  const historyDir = resolve(HISTORY_DIR);
  const historyExistedBefore = existsSync(historyDir);
  const historyBefore = historyExistedBefore ? readdirSync(historyDir) : [];

  const ts = timestamp();
  const proposalId = `local_history_real_append_proposal_${ts}`;
  const debugRootPath = resolve(DEBUG_ROOT, ts);

  // ---- Source artifacts ----
  const m03x = resolveLatest(M03X_REPORT_PREFIX);
  const m04x = resolveLatest(M04X_REPORT_PREFIX);
  const m03xSummary = readJson(resolve(M03X_DEBUG_ROOT, m03x.ts, "summary.json")) as M03XSummary;
  const m04xSummary = readJson(resolve(M04X_DEBUG_ROOT, m04x.ts, "validation_summary.json")) as M04XSummary;
  const scenarioActions = readJson(resolve(M03X_DEBUG_ROOT, m03x.ts, "scenario_a_actions.json")) as AppendActionRecord[];
  if (!Array.isArray(scenarioActions) || scenarioActions.length === 0) {
    throw new Error(`M03X scenario_a_actions.json is empty or malformed. Stop and report the missing artifact path.`);
  }

  // ---- Per-shard aggregation → target file plan ----
  const shardStats = aggregateAppendActionsByShard(scenarioActions);
  const dryRunShardSourceByMonth: Record<string, string> = {};
  for (const action of scenarioActions) {
    if (!dryRunShardSourceByMonth[action.shardMonth]) {
      dryRunShardSourceByMonth[action.shardMonth] = action.dryRunShardPath;
    }
  }
  const existingHistoryFiles = historyExistedBefore ? historyBefore.filter((n) => n.endsWith(".csv")) : [];
  const targetFilePlan = buildTargetFilePlan({
    shardStats,
    existingHistoryFiles,
    backupTimestamp: ts,
    dryRunShardSourceByMonth
  });

  // ---- Approval gate (closed by default in M05X) ----
  const approval = evaluateRealAppendApproval({
    explicitUserApproved: EXPLICIT_USER_APPROVED,
    envRealHistoryAppend: process.env.REAL_HISTORY_APPEND,
    dryRunDecision: m03xSummary.decision,
    policyDecision: m04xSummary.decision,
    hashConflictCount: m03xSummary.hashConflictCount,
    schemaValid: m04xSummary.schemaValid,
    shardIntegrityPassed: m04xSummary.shardIntegrityOk,
    forbiddenColumnErrors: m04xSummary.forbiddenColumnErrors,
    dbWriteMode: false,
    githubActionsMode: false
  });

  // ---- Rollback + preflight ----
  const rollbackPlan = buildRollbackPlan(ts);
  const preflightChecklist = buildPreflightChecklist();

  // ---- Decision ----
  const historyDirModified = false; // proposal mode never modifies history
  const decision = decideM05X({
    dryRunDecision: m03xSummary.decision,
    policyDecision: m04xSummary.decision,
    hashConflictCount: m03xSummary.hashConflictCount,
    schemaValid: m04xSummary.schemaValid,
    targetFilePlanGenerated: targetFilePlan.length > 0,
    rollbackPlanGenerated: true,
    realAppendCurrentlyAllowed: approval.realAppendCurrentlyAllowed,
    historyDirModified,
    historyDirPreExisted: historyExistedBefore
  });

  const summary: ProposalSummary = {
    proposalId,
    generatedAtJst: nowJst(),
    sourceDryRunArtifact: m03x.jsonPath,
    sourcePolicyArtifact: m04x.jsonPath,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    realAppendDefaultEnabled: false,
    realAppendCurrentlyAllowed: approval.realAppendCurrentlyAllowed,
    requiredOptInFlags: [...REQUIRED_OPT_IN_FLAGS],
    targetHistoryDir: TARGET_HISTORY_DIR,
    targetFiles: targetFilePlan.map((e) => e.targetFile),
    wouldCreateHistoryDir: !historyExistedBefore,
    wouldCreateFiles: targetFilePlan.filter((e) => e.wouldCreateFile).map((e) => e.targetFile),
    wouldModifyFiles: targetFilePlan.filter((e) => e.wouldModifyFile).map((e) => e.targetFile),
    wouldAppendRows: targetFilePlan.reduce((sum, e) => sum + e.wouldAppendRows, 0),
    wouldSkipDuplicates: targetFilePlan.reduce((sum, e) => sum + e.wouldSkipDuplicates, 0),
    wouldBlockConflicts: targetFilePlan.reduce((sum, e) => sum + e.wouldConflictRows, 0),
    decision
  };

  // ---- Output (report/CSV/JSON + debug); guarded against .data/history ----
  const reportDir = resolve(REPORT_DIR);
  assertNotRealHistoryPath(debugRootPath);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `local_history_real_append_proposal_${ts}.md`);
  const csvPath = resolve(reportDir, `local_history_real_append_proposal_${ts}.csv`);
  const jsonPath = resolve(reportDir, `local_history_real_append_proposal_${ts}.json`);

  writeFileSync(csvPath, renderTargetFilePlanCsv(proposalId, targetFilePlan), "utf8");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        summary,
        approval,
        targetFilePlan,
        rollbackPlan,
        preflightChecklist,
        proposedRealRunCommand: PROPOSED_REAL_RUN_COMMAND,
        sourceDryRunSummary: m03xSummary,
        sourcePolicySummary: m04xSummary,
        historyDirExistedBefore: historyExistedBefore,
        historyDirExistingFiles: existingHistoryFiles
      },
      null,
      2
    ),
    "utf8"
  );
  writeFileSync(
    reportPath,
    renderProposalReport({
      summary,
      approval,
      targetFilePlan,
      rollbackPlan,
      preflightChecklist,
      proposedRealRunCommand: PROPOSED_REAL_RUN_COMMAND,
      historyDirExistedBefore: historyExistedBefore,
      historyDirExistingFiles: existingHistoryFiles,
      historyDirModified,
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath
    }),
    "utf8"
  );

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    const target = resolve(debugRootPath, name);
    assertNotRealHistoryPath(target);
    writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_dry_run_summary.json", m03xSummary);
  writeDebug("source_policy_summary.json", m04xSummary);
  writeDebug("proposal_summary.json", summary);
  writeDebug("target_file_plan.json", targetFilePlan);
  writeDebug("row_count_plan.json", {
    wouldAppendRows: summary.wouldAppendRows,
    wouldSkipDuplicates: summary.wouldSkipDuplicates,
    wouldBlockConflicts: summary.wouldBlockConflicts,
    perShard: shardStats
  });
  writeDebug("dedupe_plan.json", {
    uniqueRowIdCount: m03xSummary.uniqueRowIdCount,
    duplicateInputRowCount: m03xSummary.duplicateInputRowCount,
    hashConflictCount: m03xSummary.hashConflictCount
  });
  writeDebug("rollback_plan.json", rollbackPlan);
  writeDebug("preflight_checklist.json", preflightChecklist);
  writeDebug("approval_gate_result.json", { ...approval, requiredOptInFlags: REQUIRED_OPT_IN_FLAGS, explicitUserApproved: EXPLICIT_USER_APPROVED });
  writeDebug("history_dir_state_before.json", { existed: historyExistedBefore, files: historyBefore });

  // Safety: confirm .data/history did not change.
  const historyAfter = existsSync(historyDir) ? readdirSync(historyDir) : [];
  const historyDirCreatedDuringRun = existsSync(historyDir) && !historyExistedBefore;
  writeDebug("history_dir_state_after.json", { existed: existsSync(historyDir), files: historyAfter, createdDuringRun: historyDirCreatedDuringRun });
  if (historyDirCreatedDuringRun || historyAfter.length !== historyBefore.length) {
    throw new Error(
      `Safety violation: ${HISTORY_DIR} changed during M05X (existedBefore=${historyExistedBefore}, before=${historyBefore.length}, after=${historyAfter.length}). M05X is proposal-only and must not touch real history.`
    );
  }

  return { reportPath, csvPath, jsonPath, debugRootPath, decision };
}

try {
  const result = build();
  console.log(`report_path=${result.reportPath}`);
  console.log(`target_file_plan_csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`history_dir_exists=${existsSync(resolve(HISTORY_DIR))}`);
  console.log(`decision=${result.decision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
