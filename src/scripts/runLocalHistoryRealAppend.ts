// Phase M06X — run the first guarded REAL local history append.
//
// Reads the latest M03X dry-run, M04X policy, and M05X proposal artifacts plus
// the M03X deduped dry-run shard CSVs, evaluates the hard approval gate, runs
// preflight, and — only if everything passes AND REAL_HISTORY_APPEND=1 — writes
// the monthly shard files into .data/history using temp-file + atomic rename,
// with backups + rollback. Report/CSV/JSON + debug artifacts are written under
// .data/reports and .data/debug (never under .data/history).
//
// This is the approved real-run entry point. It still fails closed without the
// REAL_HISTORY_APPEND=1 environment flag.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertNotRealHistoryPath } from "../services/localHistoryAppendDryRun";
import { shardMonthFromFileName } from "../services/localHistoryAppendValidationPolicy";
import {
  EXPECTED_SHARD_ROW_COUNTS,
  EXPECTED_TOTAL_ROWS,
  evaluateRealAppendGate,
  renderRealAppendReport,
  renderWriteActionCsv,
  runPreflight,
  runRealAppend,
  validatePostWriteShards,
  type M06XDecision,
  type PostWriteShardResult,
  type RunRealAppendResult
} from "../services/localHistoryRealAppend";

const REPORT_DIR = ".data/reports/source-discovery";
const DEBUG_ROOT = ".data/debug/history-real-append";
const HISTORY_DIR = ".data/history";

const M03X_REPORT_PREFIX = "local_history_append_dry_run_";
const M03X_DEBUG_ROOT = ".data/debug/history-append-dry-run";
const M04X_REPORT_PREFIX = "local_history_append_validation_policy_";
const M04X_DEBUG_ROOT = ".data/debug/history-append-validation-policy";
const M05X_REPORT_PREFIX = "local_history_real_append_proposal_";
const M05X_DEBUG_ROOT = ".data/debug/history-real-append-proposal";

// Explicit user approval for Phase M06X is present in the approving message:
// "Approve Phase M06X real history append. You may create .data/history monthly
// shard files." The gate ALSO requires REAL_HISTORY_APPEND=1 at runtime.
const EXPLICIT_USER_APPROVED = true;

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
  schemaVersion: string;
  decision: string;
}
interface M04XSummary {
  decision: string;
  schemaValid: boolean;
  shardIntegrityOk: boolean;
  forbiddenColumnErrors: number;
}
interface M05XSummary {
  decision: string;
}

function readSourceShards(shardsDir: string): { shardMonth: string; csv: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(shardsDir);
  } catch {
    throw new Error(`Missing M03X dry-run shard dir: ${shardsDir}. Stop and report the missing artifact path. Do not re-run collectors.`);
  }
  const csvs = entries.filter((n) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(n)).sort();
  if (csvs.length === 0) {
    throw new Error(`No dry-run shard CSVs found in ${shardsDir}. Stop and report the missing artifact path.`);
  }
  return csvs.map((name) => ({
    shardMonth: shardMonthFromFileName(name),
    csv: readFileSync(resolve(shardsDir, name), "utf8")
  }));
}

function run(): { decision: M06XDecision; reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string } {
  const historyDir = resolve(HISTORY_DIR);
  const historyExistedBefore = existsSync(historyDir);
  const historyFilesBefore = historyExistedBefore ? readdirSync(historyDir) : [];

  const ts = timestamp();
  const runId = `local_history_real_append_${ts}`;
  const debugRootPath = resolve(DEBUG_ROOT, ts);

  // ---- Source artifacts ----
  const m03x = resolveLatest(M03X_REPORT_PREFIX);
  const m04x = resolveLatest(M04X_REPORT_PREFIX);
  const m05x = resolveLatest(M05X_REPORT_PREFIX);
  const m03xSummary = readJson(resolve(M03X_DEBUG_ROOT, m03x.ts, "summary.json")) as M03XSummary;
  const m04xSummary = readJson(resolve(M04X_DEBUG_ROOT, m04x.ts, "validation_summary.json")) as M04XSummary;
  const m05xSummary = readJson(resolve(M05X_DEBUG_ROOT, m05x.ts, "proposal_summary.json")) as M05XSummary;

  const dryRunShardDir = resolve(M03X_DEBUG_ROOT, m03x.ts, "shards");
  const sourceShards = readSourceShards(dryRunShardDir);

  // ---- Hard approval gate ----
  const gate = evaluateRealAppendGate({
    explicitUserApproved: EXPLICIT_USER_APPROVED,
    envRealHistoryAppend: process.env.REAL_HISTORY_APPEND,
    m03xDecision: m03xSummary.decision,
    m04xDecision: m04xSummary.decision,
    m05xDecision: m05xSummary.decision,
    hashConflictCount: m03xSummary.hashConflictCount,
    schemaValid: m04xSummary.schemaValid,
    shardIntegrityPassed: m04xSummary.shardIntegrityOk,
    forbiddenColumnErrors: m04xSummary.forbiddenColumnErrors,
    dbWriteMode: false,
    githubActionsMode: false
  });

  // ---- Preflight ----
  const preflight = runPreflight({
    gate,
    sourceShards,
    expectedCountsByShard: EXPECTED_SHARD_ROW_COUNTS,
    expectedTotalRows: EXPECTED_TOTAL_ROWS
  });

  // Output dirs (never .data/history).
  const reportDir = resolve(REPORT_DIR);
  assertNotRealHistoryPath(debugRootPath);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });
  const writeDebug = (name: string, data: unknown): void => {
    const target = resolve(debugRootPath, name);
    assertNotRealHistoryPath(target);
    writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("history_dir_state_before.json", { existed: historyExistedBefore, files: historyFilesBefore });
  writeDebug("approval_gate_result.json", { ...gate, explicitUserApproved: EXPLICIT_USER_APPROVED, envRealHistoryAppend: process.env.REAL_HISTORY_APPEND ?? null });
  writeDebug("preflight_result.json", preflight);

  // ---- Decide whether to write ----
  let decision: M06XDecision;
  let writeResult: RunRealAppendResult;
  let postWrite: { ok: boolean; results: PostWriteShardResult[] };

  const emptyWriteResult: RunRealAppendResult = {
    runId,
    historyDir,
    lockFilePath: resolve(historyDir, ".append.lock"),
    lockAcquired: false,
    lockRemoved: false,
    backupDir: resolve(historyDir, ".backup", ts),
    backupsCreated: 0,
    filesCreated: 0,
    filesUpdated: 0,
    rowsWritten: 0,
    rowsSkippedDuplicate: 0,
    rowsConflict: 0,
    shardActions: [],
    rollbackPerformed: false,
    rollbackActions: [],
    decision: "local_history_real_append_ready_not_run",
    message: ""
  };

  if (!gate.realAppendAllowed) {
    decision = "local_history_real_append_ready_not_run";
    writeResult = { ...emptyWriteResult, message: `Gate not satisfied: ${JSON.stringify(gate.failedConditions)}. Nothing written.` };
    postWrite = { ok: false, results: [] };
  } else if (!preflight.ok) {
    decision = "local_history_real_append_failed_preflight";
    writeResult = { ...emptyWriteResult, decision, message: `Preflight failed: ${JSON.stringify(preflight.failedChecks)}. Nothing written.` };
    postWrite = { ok: false, results: [] };
  } else {
    // ---- Real write ----
    writeResult = runRealAppend({ historyDir, runId, backupTimestamp: ts, sourceShards });
    decision = writeResult.decision;

    if (decision === "local_history_real_append_success") {
      const written = sourceShards.map((s) => {
        const fileName = `zao_signals_${s.shardMonth}.csv`;
        return {
          fileName,
          csv: readFileSync(resolve(historyDir, fileName), "utf8"),
          expectedRowCount: EXPECTED_SHARD_ROW_COUNTS[s.shardMonth] ?? -1
        };
      });
      postWrite = validatePostWriteShards(written);
      if (!postWrite.ok) {
        decision = "local_history_real_append_failed_manual_recovery_required";
      }
    } else {
      postWrite = { ok: false, results: [] };
    }
  }

  // ---- Debug artifacts ----
  writeDebug("target_file_plan.json", sourceShards.map((s) => ({
    shardMonth: s.shardMonth,
    targetFile: `${HISTORY_DIR}/zao_signals_${s.shardMonth}.csv`,
    expectedRowCount: EXPECTED_SHARD_ROW_COUNTS[s.shardMonth] ?? null,
    dryRunShardSource: resolve(dryRunShardDir, `zao_signals_${s.shardMonth}.csv`)
  })));
  writeDebug("write_actions.json", writeResult.shardActions);
  writeDebug("backup_actions.json", writeResult.shardActions.filter((a) => a.backupPath !== "").map((a) => ({ target: a.targetFile, backup: a.backupPath })));
  writeDebug("validation_after_write.json", postWrite);
  writeDebug("rollback_result.json", { rollbackPerformed: writeResult.rollbackPerformed, rollbackActions: writeResult.rollbackActions });

  const historyFilesAfter = existsSync(historyDir) ? readdirSync(historyDir) : [];
  writeDebug("history_dir_state_after.json", { existed: existsSync(historyDir), files: historyFilesAfter });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const csvPath = resolve(reportDir, `${runId}.csv`);
  const jsonPath = resolve(reportDir, `${runId}.json`);

  const generatedAtJst = nowJst();
  const finalSummary = {
    runId,
    generatedAtJst,
    decision,
    gate,
    preflightOk: preflight.ok,
    rowsWritten: writeResult.rowsWritten,
    filesCreated: writeResult.filesCreated,
    filesUpdated: writeResult.filesUpdated,
    backupsCreated: writeResult.backupsCreated,
    postWriteOk: postWrite.ok,
    historyDirExistedBefore: historyExistedBefore,
    historyFilesAfter,
    sourceArtifacts: { m03xJson: m03x.jsonPath, m04xJson: m04x.jsonPath, m05xJson: m05x.jsonPath, dryRunShardDir }
  };
  writeDebug("final_summary.json", finalSummary);

  writeFileSync(csvPath, renderWriteActionCsv(runId, writeResult.shardActions), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ ...finalSummary, writeResult, postWrite }, null, 2), "utf8");
  writeFileSync(
    reportPath,
    renderRealAppendReport({
      generatedAtJst,
      runId,
      decision,
      gate,
      preflight,
      writeResult,
      postWrite,
      sourceArtifacts: { m03xJson: m03x.jsonPath, m04xJson: m04x.jsonPath, m05xJson: m05x.jsonPath, dryRunShardDir },
      historyDirExistedBefore: historyExistedBefore,
      historyDirFilesAfter: historyFilesAfter,
      reportPath,
      csvPath,
      jsonPath,
      debugRootPath
    }),
    "utf8"
  );

  return { decision, reportPath, csvPath, jsonPath, debugRootPath };
}

try {
  const result = run();
  console.log(`report_path=${result.reportPath}`);
  console.log(`write_action_csv_path=${result.csvPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`history_dir_exists=${existsSync(resolve(HISTORY_DIR))}`);
  console.log(`decision=${result.decision}`);
  if (result.decision !== "local_history_real_append_success" && result.decision !== "local_history_real_append_ready_not_run") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
