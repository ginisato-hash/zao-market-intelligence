// Phase D04X — run the approved property master update.
//
// Applies ONLY the two approved excluded-audit appends (mark_out_of_scope +
// mark_duplicate) from the latest D04X-P proposal, with backup → temp write →
// validate → atomic rename, and rollback on failure.
//
// Fail-closed: the real write happens ONLY when explicit user approval is
// encoded here AND the runtime flag PROPERTY_MASTER_UPDATE=1 is set. Modifies
// ONLY the excluded audit CSV. No DB, no new properties, no aliases, no active
// promotion, no price targets, no GitHub Actions/GitOps, no commits/pushes, no
// .data/history changes, no paid sources.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  APPROVED_PROPOSAL_ROWS,
  TARGET_EXCLUDED_AUDIT_RELPATH,
  appendAuditRows,
  backupPathFor,
  decideD04X,
  evaluateApprovalGate,
  mapProposalToAuditRow,
  parseCsv,
  preflightProposal,
  renderApprovedUpdateReport,
  renderCsv,
  validateAuditCsv,
  type ApprovedUpdateSummary,
  type AuditRow,
  type PreflightProposalRow
} from "../services/propertyMasterApprovedUpdate";

// Explicit human approval is encoded by the standalone approval directive in the
// approving message (Phase D04X). The runtime env flag is still required.
const EXPLICIT_USER_APPROVED = true;

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/property-master-approved-update";
const PROPOSAL_PREFIX = "property_master_update_proposal_";

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

function resolveLatestProposal(): string {
  const reportDir = resolve(REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(reportDir);
  } catch {
    throw new Error(`Missing artifact directory: ${reportDir}. Stop and report the missing D04X-P proposal path. Do not re-run collectors.`);
  }
  const jsonFiles = entries.filter((n) => n.startsWith(PROPOSAL_PREFIX) && n.endsWith(".json")).sort();
  const latest = jsonFiles.at(-1);
  if (!latest) {
    throw new Error(`Missing D04X-P proposal (expected ${PROPOSAL_PREFIX}*.json in ${reportDir}). Stop and report the missing artifact path. Do not re-run collectors.`);
  }
  return resolve(reportDir, latest);
}

interface ProposalArtifact {
  summary?: { decision?: string };
  rows: PreflightProposalRow[];
}

function build(): { reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string; decision: string } {
  const ts = timestamp();
  const runId = `property_master_approved_update_${ts}`;
  const debugRootPath = resolve(DEBUG_ROOT, ts);

  // ---- Source D04X-P proposal (read-only) ----
  const proposalPath = resolveLatestProposal();
  let proposal: ProposalArtifact;
  try {
    proposal = JSON.parse(readFileSync(proposalPath, "utf8")) as ProposalArtifact;
  } catch (caught) {
    throw new Error(`Malformed D04X-P proposal ${proposalPath}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const proposalRows = Array.isArray(proposal.rows) ? proposal.rows : [];

  // ---- Approval gate ----
  const approvalGate = evaluateApprovalGate({
    explicitUserApproved: EXPLICIT_USER_APPROVED,
    envFlag: process.env["PROPERTY_MASTER_UPDATE"]
  });

  // ---- Preflight ----
  const preflight = preflightProposal(proposalRows);

  // ---- Target artifact ----
  const targetPath = resolve(TARGET_EXCLUDED_AUDIT_RELPATH);
  const backupRelPath = backupPathFor(ts);
  const backupPath = resolve(backupRelPath);

  let rowsBefore = 0;
  let rowsAfter = 0;
  let appended: AuditRow[] = [];
  let skippedExisting: AuditRow[] = [];
  let backupCreated = false;
  let validationOk = false;
  let wrote = false;
  let rolledBack = false;
  let rollbackFailed = false;
  let headers: string[] = [];

  if (existsSync(targetPath)) {
    const parsed = parseCsv(readFileSync(targetPath, "utf8"));
    headers = parsed.headers;
    rowsBefore = parsed.rows.length;
    const newRows = APPROVED_PROPOSAL_ROWS.map((r) => mapProposalToAuditRow(r));
    const result = appendAuditRows({ existingRows: parsed.rows, newRows });
    appended = result.appended;
    skippedExisting = result.skippedExisting;
    rowsAfter = result.merged.length;

    // Validate the prospective merged content regardless of whether we write.
    const validation = validateAuditCsv({ headers, rows: result.merged });
    validationOk = validation.ok;

    if (approvalGate.realUpdateAllowed && preflight.ok && validation.ok) {
      try {
        // 1. Backup.
        mkdirSync(dirname(backupPath), { recursive: true });
        copyFileSync(targetPath, backupPath);
        backupCreated = true;

        // 2. Temp write.
        const tempPath = `${targetPath}.tmp_${ts}`;
        writeFileSync(tempPath, renderCsv(headers, result.merged), "utf8");

        // 3. Validate temp file by re-reading.
        const reparsed = parseCsv(readFileSync(tempPath, "utf8"));
        const tempValidation = validateAuditCsv({ headers: reparsed.headers, rows: reparsed.rows });
        if (!tempValidation.ok || reparsed.rows.length !== result.merged.length) {
          rmSync(tempPath, { force: true });
          throw new Error(`Temp validation failed: ${tempValidation.errors.join("; ")}`);
        }

        // 4. Atomic rename temp -> target.
        renameSync(tempPath, targetPath);
        wrote = true;
      } catch (writeError) {
        // Rollback: restore backup if we made one.
        try {
          if (backupCreated && existsSync(backupPath)) {
            copyFileSync(backupPath, targetPath);
            rolledBack = true;
          }
          const stray = `${targetPath}.tmp_${ts}`;
          if (existsSync(stray)) rmSync(stray, { force: true });
        } catch {
          rollbackFailed = true;
        }
        console.error(`write_error=${writeError instanceof Error ? writeError.message : String(writeError)}`);
      }
    } else {
      // Fail-closed: do not write. rows_after reflects no change.
      rowsAfter = rowsBefore;
      appended = [];
      // Report what WOULD have been appended vs skipped for transparency.
      skippedExisting = result.skippedExisting;
    }
  } else {
    preflight.errors.push(`Target artifact not found: ${targetPath}`);
  }

  const decision = decideD04X({
    realUpdateAllowed: approvalGate.realUpdateAllowed,
    preflightOk: preflight.ok,
    wrote,
    appended: appended.length,
    skippedExisting: skippedExisting.length,
    rolledBack,
    rollbackFailed
  });

  const reportDir = resolve(REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(reportDir, `property_master_approved_update_${ts}.md`);
  const csvPath = resolve(reportDir, `property_master_approved_update_${ts}.csv`);
  const jsonPath = resolve(reportDir, `property_master_approved_update_${ts}.json`);

  const summary: ApprovedUpdateSummary = {
    runId,
    generatedAt: nowJst(),
    sourceD04xProposalArtifact: proposalPath,
    targetArtifact: targetPath,
    decision,
    realUpdateAllowed: approvalGate.realUpdateAllowed,
    explicitUserApproved: approvalGate.explicitUserApproved,
    envFlagPresent: approvalGate.envFlagPresent,
    preflightOk: preflight.ok,
    preflightErrors: preflight.errors,
    rowsBefore,
    rowsAfter,
    rowsAppended: appended.length,
    rowsSkippedExisting: skippedExisting.length,
    backupPath: backupCreated ? backupPath : "",
    backupCreated,
    validationOk,
    rolledBack,
    reportPath,
    csvPath,
    jsonPath,
    debugRootPath
  };

  const appliedRows = [...appended, ...skippedExisting];
  writeFileSync(csvPath, renderCsv([...headersOrDefault(headers)], appliedRows), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ summary, appended, skippedExisting, approvalGate, preflight }, null, 2), "utf8");
  writeFileSync(reportPath, renderApprovedUpdateReport({ summary, appended, skippedExisting }), "utf8");

  // ---- Debug artifacts ----
  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_d04x_proposal.json", { proposalPath, decision: proposal.summary?.decision ?? "unknown", rowCount: proposalRows.length });
  writeDebug("approval_gate_result.json", approvalGate);
  writeDebug("target_artifact_before_summary.json", { targetPath, rowsBefore });
  writeDebug("target_artifact_after_summary.json", { targetPath, rowsAfter, wrote });
  writeDebug("write_actions.json", { wrote, appended, skippedExisting });
  writeDebug("backup_actions.json", { backupCreated, backupPath: backupCreated ? backupPath : "" });
  writeDebug("validation_result.json", { validationOk });
  writeDebug("rollback_result.json", { rolledBack, rollbackFailed });
  writeDebug("safety_confirmation.json", {
    modifiedOnlyExcludedAudit: true,
    createdNewProperties: false,
    addedAliases: false,
    activePromotedAnyProperty: false,
    addedPriceCollectionTargets: false,
    dbWrites: false,
    modifiedDataHistory: false,
    githubActionsOrGitOps: false,
    versionControlCommitsOrPushes: false,
    paidSources: false
  });

  return { reportPath, csvPath, jsonPath, debugRootPath, decision };
}

function headersOrDefault(headers: string[]): string[] {
  return headers.length > 0 ? headers : ["source", "property_name_raw", "property_url", "exclusion_reason", "review_decision"];
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
