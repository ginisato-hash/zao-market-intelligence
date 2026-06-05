// Phase JALAN-AUTO05X — run the APPROVED Jalan history append.
//
// Reads the latest JALAN-AUTO04X proposal JSON + its referenced JALAN-AUTO03B
// improved-preview JSON, reconstructs the full 45-column history rows for the
// approved AUTO04X rows (history_action ∈ {append_directional,
// append_excluded_audit}), validates row policy, runs an append preflight against
// existing .data/history, and — ONLY if the explicit standalone approval sentence
// is present AND the runtime flag JALAN_HISTORY_APPEND=1 is set — appends the
// rows using the reused M06X write engine (backup → temp → validate → atomic
// rename → rollback).
//
// Fails closed by default (decision=jalan_history_append_ready_not_run): with
// neither approval nor the env flag it writes report/debug artifacts only and
// appends NOTHING to .data/history.
//
// This script APPENDS HISTORY ONLY. It writes NO database rows, runs NO database
// mirror sync, refreshes NO downstream AI context packs, runs NO live Jalan probe
// / headless browser, emits NO property-management or OTA upload output, performs
// NO price update, generates NO pricing CSV, collects NO other source, and uses
// NO synthetic tax multiplier (Jalan totals are the visible tax-included total).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runRealAppend,
  validatePostWriteShards,
  type PostWriteShardResult,
  type RunRealAppendResult
} from "../services/localHistoryRealAppend";
import {
  AUTO05X_ENV_FLAG,
  computeAppendPreflight,
  decideBeforeWrite,
  evaluateGate,
  groupRowsToSourceShards,
  reconstructHistoryRow,
  renderAppendActionCsv,
  renderReport,
  selectApprovedRowIds,
  validateApprovedHistoryRows,
  type AppendActionRow,
  type ApprovedRowRecord,
  type ExistingHistoryKey,
  type JalanRealAppendDecision
} from "../services/jalanHistoryAppendRealRun";
import { deriveIdentity, type JalanAppendProposalRow } from "../services/jalanHistoryAppendProposal";
import { type JalanImprovedPreviewRow } from "../services/jalanBoundedCollectionProbeImproved";
import { type HistoryRow } from "../services/localHistorySchemaDesign";

const AUTOMATION_REPORT_DIR = ".data/reports/automation";
const HISTORY_DIR = ".data/history";
const DEBUG_ROOT = ".data/debug/jalan-history-append-real-run";
const AUTO04X_PROPOSAL_PREFIX = "jalan_history_append_proposal_";

// GOVERNANCE: the agent sets this true ONLY when the CURRENT user instruction
// contains the exact standalone approval sentence required by the AUTO05X spec.
// It is NOT set true by quoting the sentence inside a spec/template. When the
// sentence is absent this stays false and the run fails closed (no append).
// 2026-06-05: set true — the current user instruction contains the exact
// standalone approval sentence authorizing the JALAN-AUTO05X append.
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

function findLatestAuto04xJson(): string {
  const dir = resolve(AUTOMATION_REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`Missing automation report dir: ${dir}. Produce the JALAN-AUTO04X proposal first.`);
  }
  const jsons = entries.filter((f) => f.startsWith(AUTO04X_PROPOSAL_PREFIX) && f.endsWith(".json")).sort();
  const latest = jsons.at(-1);
  if (!latest) throw new Error(`No AUTO04X proposal JSON (${AUTO04X_PROPOSAL_PREFIX}*.json) found in ${dir}.`);
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

// Read existing .data/history shard row identities + per-source counts.
function readExistingHistory(): {
  keys: ExistingHistoryKey[];
  rowCount: number;
  countByShard: Map<string, number>;
  countBySource: Map<string, number>;
} {
  const dir = resolve(HISTORY_DIR);
  let shardFiles: string[] = [];
  try {
    shardFiles = readdirSync(dir).filter((f) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(f));
  } catch {
    return { keys: [], rowCount: 0, countByShard: new Map(), countBySource: new Map() };
  }
  const keys: ExistingHistoryKey[] = [];
  const countByShard = new Map<string, number>();
  const countBySource = new Map<string, number>();
  for (const file of shardFiles.sort()) {
    const text = readFileSync(resolve(dir, file), "utf8");
    const lines = text.split(/\r?\n/u).filter((l) => l.trim().length > 0);
    const shardMonth = /^zao_signals_(\d{4}_\d{2})\.csv$/u.exec(file)?.[1] ?? "unknown";
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const rowId = cols[0] ?? "";
      const rowHash = cols[1] ?? "";
      const source = cols[6] ?? "";
      if (!rowId) continue;
      keys.push({ row_id: rowId, row_hash: rowHash, shard_month: shardMonth });
      countByShard.set(shardMonth, (countByShard.get(shardMonth) ?? 0) + 1);
      countBySource.set(source, (countBySource.get(source) ?? 0) + 1);
    }
  }
  return { keys, rowCount: keys.length, countByShard, countBySource };
}

interface Auto04xProposalFile {
  decision: string;
  source_auto03b_artifact: string;
  proposal_rows: JalanAppendProposalRow[];
}

interface Auto03bPreviewFile {
  normalized_preview_rows: JalanImprovedPreviewRow[];
}

function mapWriteDecision(result: RunRealAppendResult): JalanRealAppendDecision {
  if (result.decision === "local_history_real_append_success") return "jalan_history_append_success";
  if (result.rowsConflict > 0) return "jalan_history_append_failed_conflicts";
  return "jalan_history_append_failed_write";
}

function run(): {
  decision: JalanRealAppendDecision;
  reportPath: string;
  csvPath: string;
  jsonPath: string;
  debugRootPath: string;
} {
  const ts = timestamp();
  const runId = `jalan_auto05x_${ts}`;
  const generatedAtJst = nowJst();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  const reportDir = resolve(AUTOMATION_REPORT_DIR);
  const historyDir = resolve(HISTORY_DIR);

  // ---- Source artifacts ----
  const sourceAuto04xJsonPath = findLatestAuto04xJson();
  const auto04x = readJson(sourceAuto04xJsonPath) as Auto04xProposalFile;
  const sourceAuto03bJsonPath = resolve(auto04x.source_auto03b_artifact);
  const auto03b = readJson(sourceAuto03bJsonPath) as Auto03bPreviewFile;
  const previewRows = auto03b.normalized_preview_rows ?? [];

  // ---- Select approved rows + reconstruct full history rows ----
  const { approvedRowIds, blockedRowIds } = selectApprovedRowIds(auto04x.proposal_rows);

  // Index proposal rows + preview rows by canonical row_id.
  const proposalByRowId = new Map<string, JalanAppendProposalRow>();
  for (const r of auto04x.proposal_rows) proposalByRowId.set(r.row_id, r);
  const previewByRowId = new Map<string, JalanImprovedPreviewRow>();
  for (const pr of previewRows) previewByRowId.set(deriveIdentity(pr).row_id, pr);

  const ctx = {
    sourceReportPath: sourceAuto03bJsonPath.replace(/\.json$/u, ".md"),
    sourceCsvPath: sourceAuto03bJsonPath.replace(/\.json$/u, ".csv")
  };

  const historyRows: HistoryRow[] = [];
  const records: ApprovedRowRecord[] = [];
  const missingSourceRows: string[] = [];
  for (const rowId of approvedRowIds) {
    const proposal = proposalByRowId.get(rowId);
    const preview = previewByRowId.get(rowId);
    if (!proposal || !preview) {
      missingSourceRows.push(rowId);
      continue;
    }
    const historyRow = reconstructHistoryRow(preview, ctx);
    historyRows.push(historyRow);
    records.push({ historyRow, proposal, preview });
  }

  // ---- Row policy validation ----
  const validation = validateApprovedHistoryRows(records);
  if (missingSourceRows.length > 0) {
    validation.errors.push(`missing_source_rows:${JSON.stringify(missingSourceRows)}`);
  }
  const validationOk = validation.ok && missingSourceRows.length === 0;

  // ---- Preflight against existing history ----
  const existing = readExistingHistory();
  const preflight = computeAppendPreflight(historyRows, existing.keys, existing.rowCount);
  const jalanRowsBefore = existing.countBySource.get("jalan") ?? 0;

  // ---- Approval gate ----
  const envFlag = process.env[AUTO05X_ENV_FLAG];
  const gate = evaluateGate({ approvalSentencePresent: APPROVAL_SENTENCE_PRESENT, envFlag });

  // ---- Decide whether to write ----
  let decision = decideBeforeWrite({
    gateAllowed: gate.allowed,
    validationOk,
    conflictCount: preflight.conflict_count
  });

  // Per-shard expected counts (existing + newly appended) for post-write checks.
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
  let historyRowCountAfter = existing.rowCount;
  let jalanRowsAfter = jalanRowsBefore;

  if (decision === "jalan_history_append_success") {
    // Gate allowed, validation ok, no conflicts → perform the real append.
    const sourceShards = groupRowsToSourceShards(historyRows);
    writeResult = runRealAppend({ historyDir, runId, backupTimestamp: ts, sourceShards });
    decision = mapWriteDecision(writeResult);

    if (decision === "jalan_history_append_success") {
      const written = preflight.touched_shards.map((shardMonth) => {
        const fileName = `zao_signals_${shardMonth}.csv`;
        return {
          fileName,
          csv: readFileSync(resolve(historyDir, fileName), "utf8"),
          expectedRowCount: (existing.countByShard.get(shardMonth) ?? 0) + (newCountByShard.get(shardMonth) ?? 0)
        };
      });
      postWrite = validatePostWriteShards(written);
      if (!postWrite.ok) {
        decision = "jalan_history_append_failed_validation";
      } else {
        historyRowCountAfter = existing.rowCount + writeResult.rowsWritten;
        jalanRowsAfter = jalanRowsBefore + writeResult.rowsWritten;
      }
    }
  } else {
    writeResult = {
      ...emptyWriteResult,
      message:
        decision === "jalan_history_append_ready_not_run"
          ? `Fail-closed: ${JSON.stringify(gate.failedConditions)}. Nothing appended.`
          : decision === "jalan_history_append_failed_conflicts"
            ? `Aborted: ${preflight.conflict_count} conflict(s). Nothing appended.`
            : `Aborted: row policy validation failed (${validation.errors.length} error(s)). Nothing appended.`
    };
  }

  // ---- Append-action rows (for CSV + report) ----
  const appendActions: AppendActionRow[] = records.map(({ historyRow: r, proposal }) => ({
    row_id: r.rowId,
    canonical_property_name: r.canonicalPropertyName,
    checkin: r.checkin,
    shard_month: r.shardMonth,
    normalized_total_price: r.normalizedTotalPrice,
    basis_confidence: r.basisConfidence,
    dp_usage: proposal.dp_usage,
    history_action: proposal.history_action,
    price_pressure_usable: proposal.price_pressure_usable
  }));

  // ---- Output paths ----
  const fileBase = `jalan_history_append_real_run_${ts}`;
  const reportPath = resolve(reportDir, `${fileBase}.md`);
  const csvPath = resolve(reportDir, `${fileBase}.csv`);
  const jsonPath = resolve(reportDir, `${fileBase}.json`);

  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const safetyConfirmation = {
    history_appended: decision === "jalan_history_append_success",
    db_writes: false,
    db_mirror_sync: false,
    ai_context_refreshed: false,
    live_jalan_fetch: false,
    playwright_used: false,
    browser_automation: false,
    external_fetch: false,
    collector_run: false,
    query_smoke_run: false,
    pricing_csv_generated: false,
    pms_beds24_airhost_output: false,
    price_update: false,
    other_source_collection: false,
    github_actions_or_cron: false,
    paid_source_tooling_used: false,
    captcha_bypass_or_stealth: false,
    login_or_cookies: false,
    base_times_1_1_used: false,
    existing_rows_overwritten: false,
    auto05b_started: false,
    approval_sentence_present: APPROVAL_SENTENCE_PRESENT,
    env_flag_set: envFlag === "1"
  };

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("source_auto04x_proposal.json", {
    sourceAuto04xJsonPath,
    sourceAuto03bJsonPath,
    proposalDecision: auto04x.decision,
    approvedRowIds,
    blockedRowIds,
    missingSourceRows
  });
  writeDebug("approval_gate_result.json", { ...gate, envFlag: envFlag ?? null });
  writeDebug("selected_append_rows.json", historyRows);
  writeDebug("skipped_rows.json", { blockedRowIds, count: blockedRowIds.length });
  writeDebug("preflight_summary.json", preflight);
  writeDebug("history_before_summary.json", {
    total_rows: existing.rowCount,
    rows_by_shard: Object.fromEntries(existing.countByShard),
    rows_by_source: Object.fromEntries(existing.countBySource)
  });
  writeDebug(
    "backup_actions.json",
    writeResult.shardActions.filter((a) => a.backupPath !== "").map((a) => ({ target: a.targetFile, backup: a.backupPath }))
  );
  writeDebug("history_append_actions.json", writeResult.shardActions);
  writeDebug("post_write_validation.json", postWrite);
  writeDebug("rollback_result.json", {
    rollbackPerformed: writeResult.rollbackPerformed,
    rollbackActions: writeResult.rollbackActions
  });
  writeDebug("validation_result.json", { ...validation, missingSourceRows });
  writeDebug("safety_confirmation.json", safetyConfirmation);

  // ---- Reports ----
  writeFileSync(csvPath, renderAppendActionCsv(appendActions), "utf8");

  const selectionSummary = { approved: approvedRowIds.length, blocked: blockedRowIds.length, missingSourceRows };

  const reportMd = renderReport({
    generatedAtJst,
    runId,
    decision,
    gate,
    sourceAuto04xJsonPath,
    sourceAuto03bJsonPath,
    selectionSummary,
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
    historyRowCountBefore: existing.rowCount,
    historyRowCountAfter,
    jalanRowsBefore,
    jalanRowsAfter,
    reportPath,
    jsonPath,
    csvPath,
    debugRootPath
  });
  writeFileSync(reportPath, reportMd, "utf8");

  const summary = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    approval_gate: gate,
    source_auto04x_proposal: {
      json_path: sourceAuto04xJsonPath,
      auto03b_preview_json: sourceAuto03bJsonPath,
      proposal_decision: auto04x.decision,
      approved_row_ids: approvedRowIds,
      blocked_row_ids: blockedRowIds,
      missing_source_rows: missingSourceRows
    },
    selection_summary: selectionSummary,
    row_policy_validation: validation,
    preflight_summary: preflight,
    history_before_summary: {
      total_rows: existing.rowCount,
      rows_by_shard: Object.fromEntries(existing.countByShard),
      rows_by_source: Object.fromEntries(existing.countBySource)
    },
    write_result: writeResult,
    post_write_validation: postWrite,
    rollback_result: { rollbackPerformed: writeResult.rollbackPerformed, rollbackActions: writeResult.rollbackActions },
    history_after_summary: {
      total_rows: historyRowCountAfter,
      jalan_rows_before: jalanRowsBefore,
      jalan_rows_after: jalanRowsAfter
    },
    safety_confirmation: safetyConfirmation,
    next_phase:
      "JALAN-AUTO05B — DB mirror sync + AI context refresh after Jalan append. Do not start JALAN-AUTO05B without explicit instruction.",
    schema_version: "zao_local_history_v1"
  };
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`decision=${decision}`);
  console.log(`approved_selected=${approvedRowIds.length} blocked=${blockedRowIds.length}`);
  console.log(`validation_ok=${validation.ok} directional=${validation.directionalCount} excluded=${validation.excludedCount} direct=${validation.directCount}`);
  console.log(`preflight new=${preflight.new_row_count} skip=${preflight.skip_identical_count} conflict=${preflight.conflict_count} touched=${preflight.touched_shards.join(",")}`);
  console.log(`history_before=${existing.rowCount} history_after=${historyRowCountAfter} jalan_before=${jalanRowsBefore} jalan_after=${jalanRowsAfter}`);
  console.log(`rows_written=${writeResult.rowsWritten} files_created=${writeResult.filesCreated} files_updated=${writeResult.filesUpdated} backups=${writeResult.backupsCreated} rollback=${writeResult.rollbackPerformed}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_summary_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_root=${debugRootPath}`);

  return { decision, reportPath, csvPath, jsonPath, debugRootPath };
}

try {
  const result = run();
  const ok =
    result.decision === "jalan_history_append_success" ||
    result.decision === "jalan_history_append_ready_not_run";
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
