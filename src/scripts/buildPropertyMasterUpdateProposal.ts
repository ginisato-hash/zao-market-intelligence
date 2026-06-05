// Phase D04X-P — build the property master update proposal / approval packet.
//
// Reads the latest D03X review artifact (read-only) and produces an
// approval-gated proposal of what a FUTURE real D04X update WOULD do:
// report/CSV/JSON + debug artifacts.
//
// Mutates nothing and approves nothing: no DB, no properties-master update, no
// alias update, no active promotion, no price-collection-target update, no
// GitHub Actions / GitOps / cron, no version-control commits or pushes, no
// paid sources. The approval gate is always closed (realUpdateAllowed=false);
// no env flag can unlock a real update here.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildApprovalGate,
  buildProposalRows,
  buildRollbackPlan,
  buildTargetArtifactPlan,
  countBy,
  countNoAction,
  decideD04XP,
  renderProposalCsv,
  renderProposalReport,
  type D03XReviewInputRow,
  type ProposalRow,
  type ProposalSummary
} from "../services/propertyMasterUpdateProposal";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/property-master-update-proposal";
const D03X_REPORT_PREFIX = "property_discovery_review_";

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

function resolveLatestD03X(): string {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing artifact directory: ${reportDir}. Stop and report the missing D03X artifact path. Do not re-run collectors.`);
  }
  const jsonFiles = entries.filter((n) => n.startsWith(D03X_REPORT_PREFIX) && n.endsWith(".json")).sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(`Missing D03X artifact (expected ${D03X_REPORT_PREFIX}*.json in ${reportDir}). Stop and report the missing artifact path. Do not re-run collectors.`);
  }
  return resolve(reportDir, latest);
}

interface D03XArtifact {
  summary?: { decision?: string };
  rows: D03XReviewInputRow[];
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  const ts = timestamp();
  const runId = `property_master_update_proposal_${ts}`;
  const debugRootPath = resolve(DEBUG_ROOT, ts);

  // ---- Source D03X artifact (read-only) ----
  const d03xPath = resolveLatestD03X();
  let d03x: D03XArtifact;
  try {
    d03x = JSON.parse(readFileSync(d03xPath, "utf8")) as D03XArtifact;
  } catch (caught) {
    throw new Error(`Malformed D03X artifact ${d03xPath}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const rows = Array.isArray(d03x.rows) ? d03x.rows : [];
  if (rows.length === 0) {
    throw new Error(`D03X artifact ${d03xPath} contains no rows. Stop and report; do not re-run collectors.`);
  }
  const d03xDecision = d03x.summary?.decision ?? "unknown";

  // ---- Build proposal (approval-gated; nothing executed) ----
  const generatedAtJst = nowJst();
  const proposalRows: ProposalRow[] = buildProposalRows({ runId, generatedAtJst, rows });
  const noActionCount = countNoAction(rows);
  const proposedActionCounts = countBy(proposalRows.map((r) => r.proposedUpdateAction));
  const unresolvedCriticalCount = proposalRows.filter((r) => r.reviewSeverity === "critical").length;

  // ---- Approval gate (always closed; env flag observed but NOT honored) ----
  const approvalGate = buildApprovalGate({ envApprovalFlag: process.env["D04X_APPROVE"] });
  const targetPlan = buildTargetArtifactPlan(proposalRows);
  const rollbackPlan = buildRollbackPlan();

  const warnings = proposalRows.filter((r) => r.warning).map((r) => `${r.detectedName}: ${r.warning}`);

  const decision = decideD04XP({
    d03xArtifactLoaded: true,
    proposalRowCount: proposalRows.length,
    realUpdateAllowed: approvalGate.realUpdateAllowed,
    unresolvedCriticalCount
  });

  const reportDir = resolve(REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `property_master_update_proposal_${ts}.md`);
  const csvPath = resolve(reportDir, `property_master_update_proposal_${ts}.csv`);
  const jsonPath = resolve(reportDir, `property_master_update_proposal_${ts}.json`);

  const summary: ProposalSummary = {
    runId,
    generatedAt: generatedAtJst,
    sourceD03xArtifact: d03xPath,
    d03xDecision,
    reviewRowCount: rows.length,
    proposalRowCount: proposalRows.length,
    noActionCount,
    proposedActionCounts,
    unresolvedCriticalCount,
    explicitUserApproved: false,
    realUpdateAllowed: false,
    warnings,
    decision,
    reportPath,
    csvPath,
    jsonPath,
    debugRootPath
  };

  writeFileSync(csvPath, renderProposalCsv(proposalRows), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ summary, rows: proposalRows, approvalGate, targetPlan, rollbackPlan }, null, 2), "utf8");
  writeFileSync(reportPath, renderProposalReport({ summary, rows: proposalRows, approvalGate, targetPlan, rollbackPlan }), "utf8");

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_d03x_artifact.json", { d03xPath, d03xDecision, rowCount: rows.length });
  writeDebug("proposal_rows.json", proposalRows);
  writeDebug("action_summary.json", { proposedActionCounts, noActionCount, proposalRowCount: proposalRows.length });
  writeDebug("target_artifact_plan.json", targetPlan);
  writeDebug("approval_gate_result.json", approvalGate);
  writeDebug("rollback_plan.json", rollbackPlan);
  writeDebug("safety_confirmation.json", {
    modifiedPropertiesMaster: false,
    addedAliases: false,
    activePromotedAnyProperty: false,
    addedPriceCollectionTargets: false,
    dbWrites: false,
    modifiedDataHistory: false,
    executedAnyRealUpdate: false,
    explicitUserApproved: false,
    realUpdateAllowed: false,
    githubActionsOrGitOps: false,
    versionControlCommitsOrPushes: false,
    paidSources: false
  });

  return { reportPath, csvPath, jsonPath, debugRootPath, decision };
}

try {
  const result = build();
  console.log(`report_path=${result.reportPath}`);
  console.log(`csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`decision=${result.decision}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
