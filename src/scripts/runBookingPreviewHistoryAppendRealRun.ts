// Phase AUTO-RUNNER08Z - run approved Booking preview history append.
//
// Reads the fixed AUTO-RUNNER08Y proposal, validates the approved 9 Booking
// directional rows, and appends them to .data/history only when the current
// approval is present and BOOKING_PREVIEW_HISTORY_APPEND=1 is set. No DB write,
// DB sync, AI context refresh, live collection, or pricing/PMS output occurs.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runRealAppend,
  validatePostWriteShards,
  type RunRealAppendResult
} from "../services/localHistoryRealAppend";
import {
  BOOKING_PREVIEW_APPEND_ENV_FLAG,
  buildSafetyConfirmation,
  computeAppendPreflight,
  decideBeforeWrite,
  evaluateGate,
  groupRowsToSourceShards,
  renderAppendActionCsv,
  renderReport,
  selectApprovedRows,
  validateAfterAppend,
  type BookingPreviewHistoryAppendDecision,
  type ExistingHistoryKey,
  type HistoryInventory,
  type PostAppendValidation
} from "../services/bookingPreviewHistoryAppendRealRun";
import { type BookingPreviewReviewRow } from "../services/bookingPreviewAppendProposal";
import { HISTORY_CSV_HEADERS, type HistoryRow } from "../services/localHistorySchemaDesign";
import { historyRowFromCsvRecord, parseCsv } from "../services/localHistoryAppendValidationPolicy";

const SOURCE_PROPOSAL_PATH =
  ".data/reports/automation/booking_preview_append_proposal_20260606_131529.json";
const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/booking-preview-history-append-real-run";
const DB_PATH = ".data/zao-market-intelligence.sqlite";
const AI_CONTEXT_MARKET_SNAPSHOT_PATH = ".data/ai-context/latest_market_snapshot.json";

// GOVERNANCE: the current user instruction is AUTO-RUNNER08Z and explicitly
// approves appending the 9 AUTO-RUNNER08Y Booking preview rows to local history
// only. Env gate is still required for actual write.
const APPROVAL_SENTENCE_PRESENT = true;

interface ProposalFile {
  decision: string;
  append_action_summary: {
    append_directional: number;
    block_conflict: number;
    manual_review: number;
    exclude_audit: number;
    expected_total_after_append_if_approved: number;
    touched_shards: string[];
  };
  preview_rows_review: BookingPreviewReviewRow[];
  proposed_history_rows: HistoryRow[];
}

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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function readHistoryInventory(historyDir: string): { keys: ExistingHistoryKey[]; inventory: HistoryInventory; rows: HistoryRow[] } {
  const dir = resolve(historyDir);
  const files = existsSync(dir)
    ? readdirSync(dir).filter((file) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(file)).sort()
    : [];
  const keys: ExistingHistoryKey[] = [];
  const rows: HistoryRow[] = [];
  const rowsByShard: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const rowIdCounts = new Map<string, number>();
  let emptyRowHashCount = 0;
  let shardMonthMismatchCount = 0;

  for (const file of files) {
    const shardMonth = /^zao_signals_(\d{4}_\d{2})\.csv$/u.exec(file)?.[1] ?? "unknown";
    const records = parseCsv(readFileSync(resolve(dir, file), "utf8")).filter((r) => !(r.length === 1 && r[0] === ""));
    const header = records[0] ?? [];
    if (header.join(",") !== HISTORY_CSV_HEADERS.join(",")) {
      throw new Error(`history header mismatch: ${file}`);
    }
    let count = 0;
    for (const rec of records.slice(1)) {
      const row = historyRowFromCsvRecord(rec);
      rows.push(row);
      keys.push({ row_id: row.rowId, row_hash: row.rowHash, shard_month: row.shardMonth, source: row.source });
      sourceCounts[row.source] = (sourceCounts[row.source] ?? 0) + 1;
      rowIdCounts.set(row.rowId, (rowIdCounts.get(row.rowId) ?? 0) + 1);
      if (row.rowHash === "") emptyRowHashCount += 1;
      if (row.shardMonth !== shardMonth) shardMonthMismatchCount += 1;
      count += 1;
    }
    rowsByShard[shardMonth] = count;
  }

  return {
    keys,
    rows,
    inventory: {
      total_rows: rows.length,
      booking_rows: sourceCounts["booking"] ?? 0,
      jalan_rows: sourceCounts["jalan"] ?? 0,
      rakuten_rows: sourceCounts["rakuten"] ?? 0,
      duplicate_row_id_count: [...rowIdCounts.values()].filter((count) => count > 1).length,
      empty_row_hash_count: emptyRowHashCount,
      shard_month_mismatch_count: shardMonthMismatchCount,
      rows_by_shard: rowsByShard,
      source_files: files.map((file) => `${historyDir}/${file}`)
    }
  };
}

function readDbMarketSignalRows(): number | null {
  if (!existsSync(resolve(DB_PATH))) return null;
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3") as new (path: string, options: { readonly: boolean }) => {
    prepare: (sql: string) => { get: () => { c: number } };
    close: () => void;
  };
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS c FROM market_signal_history").get().c);
  } finally {
    db.close();
  }
}

function readAiContextRows(): number | null {
  if (!existsSync(resolve(AI_CONTEXT_MARKET_SNAPSHOT_PATH))) return null;
  const j = readJson<{ market_signal_history_row_count?: number }>(AI_CONTEXT_MARKET_SNAPSHOT_PATH);
  return typeof j.market_signal_history_row_count === "number" ? j.market_signal_history_row_count : null;
}

function emptyWriteResult(runId: string, historyDir: string, ts: string): RunRealAppendResult {
  return {
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
    message: "Fail-closed: gate not allowed or preflight failed. Nothing appended."
  };
}

function run(): { decision: BookingPreviewHistoryAppendDecision; reportPath: string; jsonPath: string; csvPath: string; debugPath: string } {
  const ts = timestamp();
  const runId = `booking_preview_history_append_real_run_${ts}`;
  const generatedAtJst = nowJst();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);
  const historyDir = resolve(HISTORY_DIR);

  const sourceProposal = readJson<ProposalFile>(SOURCE_PROPOSAL_PATH);
  const before = readHistoryInventory(HISTORY_DIR);
  const dbRowsBefore = readDbMarketSignalRows();
  const aiRowsBefore = readAiContextRows();
  const gate = evaluateGate({
    approvalSentencePresent: APPROVAL_SENTENCE_PRESENT,
    envFlag: process.env[BOOKING_PREVIEW_APPEND_ENV_FLAG]
  });
  const selection = selectApprovedRows(sourceProposal.preview_rows_review);
  const preflight = computeAppendPreflight(selection.approved_rows, before.keys, before.inventory.total_rows);
  let decision = decideBeforeWrite({
    gateAllowed: gate.allowed,
    selection,
    preflight,
    expectedApprovedRows: 9
  });

  let writeResult = emptyWriteResult(runId, historyDir, ts);
  let postValidation: PostAppendValidation | null = null;
  let after = before;

  if (decision === "booking_preview_history_append_success") {
    writeResult = runRealAppend({
      historyDir,
      runId,
      backupTimestamp: ts,
      sourceShards: groupRowsToSourceShards(selection.approved_rows)
    });
    if (writeResult.decision !== "local_history_real_append_success") {
      decision = "booking_preview_history_append_not_ready";
    } else {
      const touched = preflight.touched_shards.map((shardMonth) => ({
        fileName: `zao_signals_${shardMonth}.csv`,
        csv: readFileSync(resolve(historyDir, `zao_signals_${shardMonth}.csv`), "utf8"),
        expectedRowCount: (before.inventory.rows_by_shard[shardMonth] ?? 0) +
          selection.approved_rows.filter((row) => row.shardMonth === shardMonth).length
      }));
      const shardPost = validatePostWriteShards(touched);
      after = readHistoryInventory(HISTORY_DIR);
      postValidation = validateAfterAppend({
        before: before.inventory,
        after: after.inventory,
        approvedRows: selection.approved_rows,
        expectedTouchedShards: ["2026_06", "2026_08"]
      });
      if (!shardPost.ok || !postValidation.ok || writeResult.rowsWritten !== 9) {
        decision = "booking_preview_history_append_not_ready";
      }
    }
  } else {
    after = readHistoryInventory(HISTORY_DIR);
  }

  const dbRowsAfter = readDbMarketSignalRows();
  const aiRowsAfter = readAiContextRows();
  const safety = buildSafetyConfirmation({
    appended: decision === "booking_preview_history_append_success",
    envFlagSet: gate.envFlagPresent,
    approvalSentencePresent: gate.approvalSentencePresent
  });

  const reportMd = renderReport({
    generatedAtJst,
    runId,
    decision,
    gate,
    sourceProposalPath: SOURCE_PROPOSAL_PATH,
    preflight,
    selection,
    before: before.inventory,
    after: after.inventory,
    rowsWritten: writeResult.rowsWritten,
    filesUpdated: writeResult.filesUpdated,
    backupsCreated: writeResult.backupsCreated,
    rollbackPerformed: writeResult.rollbackPerformed,
    postValidation,
    dbRowsBefore,
    dbRowsAfter,
    aiContextRowsBefore: aiRowsBefore,
    aiContextRowsAfter: aiRowsAfter,
    reportPath,
    jsonPath,
    csvPath,
    debugPath
  });
  writeFileSync(reportPath, reportMd, "utf8");
  writeFileSync(jsonPath, `${JSON.stringify({
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_append_proposal: SOURCE_PROPOSAL_PATH,
    approval_gate: gate,
    approved_rows_count: selection.approved_rows.length,
    selection,
    preflight,
    history_before: before.inventory,
    history_after: after.inventory,
    write_result: writeResult,
    post_write_validation: postValidation,
    db_state: { before: dbRowsBefore, after: dbRowsAfter },
    ai_context_state: { before: aiRowsBefore, after: aiRowsAfter },
    safety_confirmation: safety,
    next_phase: "AUTO-RUNNER08AA — Sync updated history to DB and rebuild AI context. Do not start without explicit instruction.",
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  }, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderAppendActionCsv(selection.approved_rows), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_append_proposal.json", sourceProposal);
  writeDebug("approved_rows.json", selection.approved_rows);
  writeDebug("history_preflight.json", { before: before.inventory, preflight, dbRowsBefore, aiRowsBefore });
  writeDebug("append_result.json", writeResult);
  writeDebug("post_write_validation.json", postValidation);
  writeDebug("safety_confirmation.json", safety);

  console.log(`decision=${decision}`);
  console.log(`rows_written=${writeResult.rowsWritten}`);
  console.log(`history_before=${before.inventory.total_rows}`);
  console.log(`history_after=${after.inventory.total_rows}`);
  console.log(`booking_before=${before.inventory.booking_rows}`);
  console.log(`booking_after=${after.inventory.booking_rows}`);
  console.log(`duplicate_row_id_count=${after.inventory.duplicate_row_id_count}`);
  console.log(`touched_shards=${preflight.touched_shards.join(",")}`);
  console.log(`db_rows_before=${dbRowsBefore ?? ""}`);
  console.log(`db_rows_after=${dbRowsAfter ?? ""}`);
  console.log(`ai_context_rows_before=${aiRowsBefore ?? ""}`);
  console.log(`ai_context_rows_after=${aiRowsAfter ?? ""}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);

  return { decision, reportPath, jsonPath, csvPath, debugPath };
}

try {
  const result = run();
  if (
    result.decision !== "booking_preview_history_append_success" &&
    result.decision !== "booking_preview_history_append_ready_not_run"
  ) {
    process.exitCode = 1;
  }
} catch (caught) {
  console.error(caught instanceof Error ? caught.message : String(caught));
  process.exitCode = 1;
}
