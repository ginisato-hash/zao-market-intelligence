// Phase PD-FIX02X — real approved Matsukaneya canonical merge.
//
// This script is a tightly scoped real update for four approved local master
// artifacts only. It performs no DB writes, no collectors/probes, no external
// fetches, no GitHub Actions/GitOps, no commits/pushes, and no upload exports.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  APPROVED_TARGET_ARTIFACTS,
  PROPOSAL_JSON_PATH,
  applyApprovedMatsukaneyaMerge,
  backupTargets,
  createBackupDir,
  evaluateMatsukaneyaMergeGate,
  renderMergeCsv,
  renderMergeReport,
  restoreTargetsFromBackup,
  summarizeTargets,
  validateMergedArtifacts,
  writeTargetsAtomically,
  type MatsukaneyaMergeDecision,
  type TargetContents
} from "../services/matsukaneyaCanonicalMerge";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/matsukaneya-canonical-merge";

const EXPLICIT_USER_APPROVED = true;

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

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function readTargets(): TargetContents {
  const [universe, alias, candidates, multi] = APPROVED_TARGET_ARTIFACTS;
  return {
    universeCsv: readFileSync(resolve(universe), "utf8"),
    aliasJson: readFileSync(resolve(alias), "utf8"),
    sourceCandidatesCsv: readFileSync(resolve(candidates), "utf8"),
    multiSourceCandidatesCsv: readFileSync(resolve(multi), "utf8")
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main(): void {
  const ts = timestamp();
  const runId = `matsukaneya_canonical_merge_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const csvPath = resolve(reportDir, `${runId}.csv`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const backupPath = createBackupDir(process.cwd(), ts);

  let decision: MatsukaneyaMergeDecision = "matsukaneya_canonical_merge_failed_preflight";
  let backupActions: string[] = [];
  let writeActions: string[] = [];
  let rollbackActions: string[] = [];
  let rollbackResult: Record<string, unknown> = { attempted: false, restored: false };
  let validation = validateMergedArtifacts(applyApprovedMatsukaneyaMerge(readTargets()));
  const safetyConfirmation = {
    dbWrites: false,
    collectorsOrProbesRun: false,
    externalFetch: false,
    githubActionsOrGitOps: false,
    gitCommitOrPush: false,
    dataHistoryModified: false,
    excludedAuditModified: false,
    beds24AirhostPmsOutput: false,
    demandIndexRecomputed: false
  };

  let proposal: unknown = {};
  try {
    proposal = readJson(PROPOSAL_JSON_PATH);
  } catch {
    proposal = {};
  }
  writeJson(resolve(debugPath, "source_proposal.json"), proposal);

  const gate = evaluateMatsukaneyaMergeGate({
    explicitUserApproved: EXPLICIT_USER_APPROVED,
    envMatsukaneyaMerge: process.env["MATSUKANEYA_MERGE"],
    proposal,
    targetArtifactPaths: APPROVED_TARGET_ARTIFACTS
  });
  writeJson(resolve(debugPath, "approval_gate_result.json"), gate);

  const before = readTargets();
  writeJson(resolve(debugPath, "target_artifacts_before_summary.json"), summarizeTargets(before));

  try {
    if (!gate.realUpdateAllowed) {
      decision = "matsukaneya_canonical_merge_ready_not_run";
      validation = validateMergedArtifacts(applyApprovedMatsukaneyaMerge(before));
    } else {
      const merged = applyApprovedMatsukaneyaMerge(before);
      validation = validateMergedArtifacts(merged);
      if (!validation.valid) {
        decision = "matsukaneya_canonical_merge_failed_preflight";
      } else {
        backupActions = backupTargets(process.cwd(), APPROVED_TARGET_ARTIFACTS, backupPath);
        const [universe, alias, candidates, multi] = APPROVED_TARGET_ARTIFACTS;
        writeActions = writeTargetsAtomically(process.cwd(), {
          [universe]: merged.universeCsv,
          [alias]: merged.aliasJson,
          [candidates]: merged.sourceCandidatesCsv,
          [multi]: merged.multiSourceCandidatesCsv
        });
        const after = readTargets();
        validation = validateMergedArtifacts(after);
        decision = validation.valid ? "matsukaneya_canonical_merge_success" : "matsukaneya_canonical_merge_failed_preflight";
      }
    }
  } catch (error) {
    rollbackResult = { attempted: true, restored: false, error: String(error) };
    try {
      if (backupActions.length > 0) {
        rollbackActions = restoreTargetsFromBackup(process.cwd(), APPROVED_TARGET_ARTIFACTS, backupPath);
        rollbackResult = { attempted: true, restored: true, actions: rollbackActions };
        decision = "matsukaneya_canonical_merge_failed_rolled_back";
      }
    } catch (rollbackError) {
      rollbackResult = { attempted: true, restored: false, error: String(rollbackError) };
      decision = "matsukaneya_canonical_merge_failed_manual_recovery_required";
    }
  }

  const after = readTargets();
  writeJson(resolve(debugPath, "target_artifacts_after_summary.json"), summarizeTargets(after));
  writeJson(resolve(debugPath, "write_actions.json"), writeActions);
  writeJson(resolve(debugPath, "backup_actions.json"), backupActions);
  writeJson(resolve(debugPath, "validation_result.json"), validation);
  writeJson(resolve(debugPath, "rollback_result.json"), rollbackResult);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  const summary = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    explicit_user_approved: EXPLICIT_USER_APPROVED,
    real_update_allowed: gate.realUpdateAllowed,
    validation_valid: validation.valid,
    backup_path: backupActions.length > 0 ? backupPath : "",
    report_path: reportPath,
    csv_path: csvPath,
    json_path: jsonPath,
    debug_artifact_path: debugPath
  };

  writeFileSync(csvPath, renderMergeCsv(summary), "utf8");
  writeJson(jsonPath, { summary, gate, validation, backupActions, writeActions, rollbackResult, safetyConfirmation });
  writeFileSync(
    reportPath,
    renderMergeReport({
      generatedAtJst,
      decision,
      gate,
      validation,
      backupPath: backupActions.length > 0 ? backupPath : "",
      reportPath,
      csvPath,
      jsonPath,
      debugPath,
      writeActions
    }),
    "utf8"
  );

  console.log(`decision=${decision}`);
  console.log(`real_update_allowed=${gate.realUpdateAllowed ? "true" : "false"}`);
  console.log(`validation_valid=${validation.valid ? "true" : "false"}`);
  console.log(`report_path=${reportPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
  if (backupActions.length > 0) console.log(`backup_path=${backupPath}`);
}

main();
