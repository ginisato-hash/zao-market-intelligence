// Phase BOOKING-B07X — run the APPROVED Booking normalized history append.
//
// Reads the latest B06X proposal JSON + its referenced B05X normalized-collection
// JSON, reconstructs the full 45-column history rows for the approved B06X rows,
// validates row policy, runs an append preflight against existing .data/history,
// and — ONLY if the explicit standalone approval sentence is present AND the
// runtime flag BOOKING_HISTORY_APPEND=1 is set — appends the rows using the
// reused M06X write engine (backup → temp → validate → atomic rename → rollback).
//
// Fails closed by default (decision=booking_history_append_ready_not_run): with
// neither approval nor the env flag it writes report/debug artifacts only and
// appends NOTHING.
//
// This script APPENDS HISTORY ONLY. It writes NO database rows, runs NO database
// mirror sync, refreshes NO downstream AI context packs, runs NO live Booking
// probe / headless browser, emits NO property-management or OTA upload output,
// performs NO price update, and uses NO Booking base × 1.1 (totals are carried
// verbatim from B05X = official base + official visible adder).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runRealAppend,
  validatePostWriteShards,
  type PostWriteShardResult,
  type RunRealAppendResult
} from "../services/localHistoryRealAppend";
import {
  B07X_ENV_FLAG,
  computeAppendPreflight,
  decideB07XBeforeWrite,
  evaluateBookingAppendGate,
  groupRowsToSourceShards,
  reconstructHistoryRow,
  renderAppendActionCsv,
  renderB07XReport,
  selectApprovedRowIds,
  validateApprovedHistoryRows,
  type AppendActionRow,
  type B05XFullRow,
  type B07XDecision,
  type ExistingHistoryKey,
  type ProposalRowLite
} from "../services/bookingHistoryAppendRealRun";
import { type HistoryRow } from "../services/localHistorySchemaDesign";

const AUTOMATION_REPORT_DIR = ".data/reports/automation";
const HISTORY_DIR = ".data/history";
const DEBUG_ROOT = ".data/debug/booking-history-append-real-run";
const B06X_PROPOSAL_PREFIX = "booking_history_append_proposal_";

// GOVERNANCE: the agent sets this true ONLY when the CURRENT user instruction
// contains the exact standalone approval sentence required by the B07X spec.
// It is NOT set true by quoting the sentence inside a spec/template. When the
// sentence is absent, this stays false and the run fails closed (no append).
// 2026-06-04: set true — the current user instruction contains the exact
// standalone approval sentence authorizing the B07X append.
const APPROVAL_SENTENCE_PRESENT = true;

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

// Pick the most recent B06X proposal JSON artifact.
function findLatestB06XJson(): string {
  const dir = resolve(AUTOMATION_REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`Missing automation report dir: ${dir}. Produce the B06X proposal first.`);
  }
  const jsons = entries
    .filter((f) => f.startsWith(B06X_PROPOSAL_PREFIX) && f.endsWith(".json"))
    .sort();
  const latest = jsons.at(-1);
  if (!latest) throw new Error(`No B06X proposal JSON (${B06X_PROPOSAL_PREFIX}*.json) found in ${dir}.`);
  return resolve(dir, latest);
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Missing required artifact: ${path}.`);
  }
  try {
    return JSON.parse(raw);
  } catch (caught) {
    throw new Error(`Malformed JSON ${path}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

// Read existing .data/history shard row identities (row_id, row_hash, shard_month).
function readExistingHistoryKeys(): { keys: ExistingHistoryKey[]; rowCount: number } {
  const dir = resolve(HISTORY_DIR);
  let shardFiles: string[] = [];
  try {
    shardFiles = readdirSync(dir).filter((f) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(f));
  } catch {
    return { keys: [], rowCount: 0 };
  }
  const keys: ExistingHistoryKey[] = [];
  for (const file of shardFiles) {
    const text = readFileSync(resolve(dir, file), "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const rowId = cols[0] ?? "";
      const rowHash = cols[1] ?? "";
      const shardMonth = cols[2] ?? "";
      if (rowId) keys.push({ row_id: rowId, row_hash: rowHash, shard_month: shardMonth });
    }
  }
  return { keys, rowCount: keys.length };
}

interface B06XProposalFile {
  decision: string;
  sourceB05XJsonPath: string;
  rows: ProposalRowLite[];
}

interface B05XCollectionFile {
  rows: B05XFullRow[];
}

// Map the M06X write-engine decision onto a B07X decision label.
function mapWriteDecision(result: RunRealAppendResult): B07XDecision {
  if (result.decision === "local_history_real_append_success") return "booking_history_append_success";
  if (result.rowsConflict > 0) return "booking_history_append_failed_conflicts";
  return "booking_history_append_failed_write";
}

function run(): { decision: B07XDecision; reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string } {
  const ts = timestamp();
  const runId = `booking_b07x_${ts}`;
  const generatedAtJst = nowJst();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  const reportDir = resolve(AUTOMATION_REPORT_DIR);
  const historyDir = resolve(HISTORY_DIR);

  // ---- Source artifacts ----
  const sourceB06XJsonPath = findLatestB06XJson();
  const b06x = readJson(sourceB06XJsonPath) as B06XProposalFile;
  const sourceB05XJsonPath = b06x.sourceB05XJsonPath;
  const b05x = readJson(resolve(sourceB05XJsonPath)) as B05XCollectionFile;

  // ---- Select approved rows + reconstruct full history rows ----
  const { approvedRowIds, blockedRowIds } = selectApprovedRowIds(b06x.rows);
  const approvedSet = new Set(approvedRowIds);
  const b05xByRowId = new Map<string, B05XFullRow>();
  for (const r of b05x.rows) b05xByRowId.set(r.row_id, r);

  const ctx = {
    sourceReportPath: sourceB05XJsonPath.replace(/\.json$/u, ".md"),
    sourceCsvPath: sourceB05XJsonPath.replace(/\.json$/u, ".csv")
  };

  const historyRows: HistoryRow[] = [];
  const missingRowIds: string[] = [];
  for (const rowId of approvedRowIds) {
    const src = b05xByRowId.get(rowId);
    if (!src) {
      missingRowIds.push(rowId);
      continue;
    }
    historyRows.push(reconstructHistoryRow(src, ctx));
  }

  // ---- Row policy validation + preflight ----
  const validation = validateApprovedHistoryRows(historyRows);
  if (missingRowIds.length > 0) {
    validation.errors.push(`missing_b05x_source_rows:${JSON.stringify(missingRowIds)}`);
  }
  const validationOk = validation.ok && missingRowIds.length === 0;

  const { keys: existingKeys, rowCount: existingHistoryRowCount } = readExistingHistoryKeys();
  const preflight = computeAppendPreflight(historyRows, existingKeys, existingHistoryRowCount);

  // ---- Approval gate ----
  const envFlag = process.env[B07X_ENV_FLAG];
  const gate = evaluateBookingAppendGate({ approvalSentencePresent: APPROVAL_SENTENCE_PRESENT, envFlag });

  // ---- Decide whether to write ----
  let decision = decideB07XBeforeWrite({
    gateAllowed: gate.allowed,
    validationOk,
    conflictCount: preflight.conflict_count
  });

  // Per-shard expected counts (existing + newly appended), for post-write checks.
  const existingCountByShard = new Map<string, number>();
  for (const k of existingKeys) existingCountByShard.set(k.shard_month, (existingCountByShard.get(k.shard_month) ?? 0) + 1);
  const newCountByShard = new Map<string, number>();
  for (const r of historyRows) newCountByShard.set(r.shardMonth, (newCountByShard.get(r.shardMonth) ?? 0) + 1);

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

  let writeResult: RunRealAppendResult = emptyWriteResult;
  let postWrite: { ok: boolean; results: PostWriteShardResult[] } = { ok: false, results: [] };
  let historyRowCountAfter = existingHistoryRowCount;

  if (decision === "booking_history_append_success") {
    // Gate allowed, validation ok, no conflicts → perform the real append.
    const sourceShards = groupRowsToSourceShards(historyRows);
    writeResult = runRealAppend({ historyDir, runId, backupTimestamp: ts, sourceShards });
    decision = mapWriteDecision(writeResult);

    if (decision === "booking_history_append_success") {
      const written = preflight.touched_shards.map((shardMonth) => {
        const fileName = `zao_signals_${shardMonth}.csv`;
        return {
          fileName,
          csv: readFileSync(resolve(historyDir, fileName), "utf8"),
          expectedRowCount: (existingCountByShard.get(shardMonth) ?? 0) + (newCountByShard.get(shardMonth) ?? 0)
        };
      });
      postWrite = validatePostWriteShards(written);
      if (!postWrite.ok) decision = "booking_history_append_failed_validation";
      else historyRowCountAfter = existingHistoryRowCount + writeResult.rowsWritten;
    }
  } else {
    writeResult = {
      ...emptyWriteResult,
      message:
        decision === "booking_history_append_ready_not_run"
          ? `Fail-closed: ${JSON.stringify(gate.failedConditions)}. Nothing appended.`
          : decision === "booking_history_append_failed_conflicts"
            ? `Aborted: ${preflight.conflict_count} conflict(s). Nothing appended.`
            : `Aborted: row policy validation failed (${validation.errors.length} error(s)). Nothing appended.`
    };
  }

  // ---- Append-action rows (for CSV + report) ----
  const recByRowId = new Map<string, ProposalRowLite>();
  for (const r of b06x.rows) recByRowId.set(r.row_id, r);
  const appendActions: AppendActionRow[] = historyRows.map((r) => {
    const rec = recByRowId.get(r.rowId);
    return {
      row_id: r.rowId,
      canonical_property_name: r.canonicalPropertyName,
      checkin: r.checkin,
      shard_month: r.shardMonth,
      normalized_total_price: r.normalizedTotalPrice,
      basis_confidence: r.basisConfidence,
      history_action: rec?.history_action ?? "append_new",
      append_recommendation: rec?.append_recommendation ?? ""
    };
  });

  // ---- Output paths ----
  const fileBase = `booking_history_append_real_run_${ts}`;
  const reportPath = resolve(reportDir, `${fileBase}.md`);
  const csvPath = resolve(reportDir, `${fileBase}.csv`);
  const jsonPath = resolve(reportDir, `${fileBase}.json`);

  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const safetyConfirmation = {
    history_appended: decision === "booking_history_append_success",
    db_writes: false,
    db_mirror_sync: false,
    ai_context_refreshed: false,
    live_booking_fetch: false,
    headless_browser_used: false,
    property_management_or_ota_output: false,
    price_update: false,
    github_actions_or_cron: false,
    paid_source_tooling_used: false,
    base_times_1_1_used: false,
    approval_sentence_present: APPROVAL_SENTENCE_PRESENT,
    env_flag_set: envFlag === "1"
  };

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_b06x_proposal.json", { sourceB06XJsonPath, sourceB05XJsonPath, proposalDecision: b06x.decision, approvedRowIds, blockedRowIds, missingRowIds });
  writeDebug("approval_gate_result.json", { ...gate, approvalSentencePresent: APPROVAL_SENTENCE_PRESENT, envFlag: envFlag ?? null });
  writeDebug("preflight_summary.json", preflight);
  writeDebug("append_rows.json", historyRows);
  writeDebug("backup_actions.json", writeResult.shardActions.filter((a) => a.backupPath !== "").map((a) => ({ target: a.targetFile, backup: a.backupPath })));
  writeDebug("history_append_actions.json", writeResult.shardActions);
  writeDebug("validation_result.json", { ...validation, missingRowIds });
  writeDebug("rollback_result.json", { rollbackPerformed: writeResult.rollbackPerformed, rollbackActions: writeResult.rollbackActions });
  writeDebug("safety_confirmation.json", safetyConfirmation);

  // ---- Reports ----
  writeFileSync(csvPath, renderAppendActionCsv(appendActions), "utf8");

  const reportInput = {
    generatedAtJst,
    runId,
    decision,
    gate,
    sourceB06XJsonPath,
    sourceB05XJsonPath,
    preflight,
    validation,
    appendActions,
    backupDir: writeResult.backupDir,
    backupsCreated: writeResult.backupsCreated,
    filesUpdated: writeResult.filesUpdated,
    filesCreated: writeResult.filesCreated,
    rowsWritten: writeResult.rowsWritten,
    rowsSkippedDuplicate: writeResult.rowsSkippedDuplicate,
    rollbackPerformed: writeResult.rollbackPerformed,
    postWriteOk: postWrite.ok,
    historyRowCountBefore: existingHistoryRowCount,
    historyRowCountAfter,
    reportPath,
    jsonPath,
    csvPath,
    debugRootPath
  };
  writeFileSync(reportPath, renderB07XReport(reportInput), "utf8");

  const summary = {
    runId,
    generatedAtJst,
    decision,
    schemaVersion: "zao_local_history_v1",
    pricePolicyVersion: "booking_official_visible_adder_v1",
    gate,
    sourceB06XJsonPath,
    sourceB05XJsonPath,
    preflight,
    validation,
    appendActions,
    writeResult,
    postWrite,
    safetyConfirmation
  };
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");

  return { decision, reportPath, csvPath, jsonPath, debugRootPath };
}

try {
  const result = run();
  console.log(`report_path=${result.reportPath}`);
  console.log(`json_summary_path=${result.jsonPath}`);
  console.log(`csv_path=${result.csvPath}`);
  console.log(`debug_root=${result.debugRootPath}`);
  console.log(`decision=${result.decision}`);
  const ok =
    result.decision === "booking_history_append_success" ||
    result.decision === "booking_history_append_ready_not_run";
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
