// Phase BOOKING-B11X — run the APPROVED Booking bounded append with identity policy.
//
// Reads the latest B10Z bounded-append-with-identity proposal JSON + its referenced
// B09X bounded-expanded-collection JSON, reconstructs the full 45-column history
// rows for the 25 approved B10Z rows (15 append_new + 10
// append_new_observation_after_identity_fix), validates row policy, runs an append
// preflight against existing .data/history, and — ONLY if the explicit standalone
// approval sentence is present AND the runtime flag
// BOOKING_BOUNDED_APPEND_WITH_IDENTITY=1 is set — appends the rows using the reused
// M06X write engine (backup -> temp -> validate -> atomic rename -> rollback).
//
// Fails closed by default (decision=booking_bounded_append_with_identity_ready_not_run):
// with neither approval nor the env flag it writes report/debug artifacts only and
// appends NOTHING.
//
// This script APPENDS HISTORY ONLY. It writes NO database rows, runs NO database
// mirror sync, refreshes NO downstream AI context packs, runs NO live Booking
// request / browser automation, emits NO property-management or channel-manager
// upload output, performs NO price update, and applies NO synthetic Booking tax
// multiplier (totals are carried verbatim from B09X = official base + official
// visible adder).

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runRealAppend,
  validatePostWriteShards,
  type PostWriteShardResult,
  type RunRealAppendResult
} from "../services/localHistoryRealAppend";
import {
  B11X_ENV_FLAG,
  computeAppendPreflight,
  decideB11XBeforeWrite,
  evaluateBookingAppendGate,
  groupRowsToSourceShards,
  reconstructHistoryRow,
  renderAppendActionCsv,
  renderB11XReport,
  selectAppendRows,
  validateApprovedHistoryRows,
  type AppendActionRow,
  type B09XFullRow,
  type B10ZProposalRowLite,
  type B11XDecision,
  type ExistingHistoryKey,
  type IdentityMetadataRow
} from "../services/bookingBoundedAppendWithIdentityRealRun";
import { buildRowId, type HistoryRow } from "../services/localHistorySchemaDesign";

const AUTOMATION_REPORT_DIR = ".data/reports/automation";
const HISTORY_DIR = ".data/history";
const DEBUG_ROOT = ".data/debug/booking-bounded-append-with-identity-real-run";
const B10Z_PROPOSAL_PREFIX = "booking_bounded_append_with_identity_proposal_";

// GOVERNANCE: the agent sets this true ONLY when the CURRENT user instruction
// contains the exact standalone approval sentence required by the B11X spec. It is
// NOT set true by quoting the sentence inside a spec/template. When the sentence is
// absent, this stays false and the run fails closed (no append).
// 2026-06-04: set true — the current user instruction contains the exact standalone
// approval sentence authorizing the B11X bounded append with identity policy.
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
  const get = (t: string): string => parts.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+09:00`;
}

// Pick the most recent B10Z proposal JSON artifact.
function findLatestB10ZJson(): string {
  const dir = resolve(AUTOMATION_REPORT_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`Missing automation report dir: ${dir}. Produce the B10Z proposal first.`);
  }
  const jsons = entries.filter((f) => f.startsWith(B10Z_PROPOSAL_PREFIX) && f.endsWith(".json")).sort();
  const latest = jsons.at(-1);
  if (!latest) throw new Error(`No B10Z proposal JSON (${B10Z_PROPOSAL_PREFIX}*.json) found in ${dir}.`);
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

// Count duplicate row_ids across ALL history shards after the write (spec section 9
// requires this to be 0; the identity policy guarantees distinct row_ids).
function countDuplicateRowIds(): number {
  const dir = resolve(HISTORY_DIR);
  let shardFiles: string[] = [];
  try {
    shardFiles = readdirSync(dir).filter((f) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(f));
  } catch {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const file of shardFiles) {
    const text = readFileSync(resolve(dir, file), "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines.slice(1)) {
      const rowId = line.split(",")[0] ?? "";
      if (rowId) counts.set(rowId, (counts.get(rowId) ?? 0) + 1);
    }
  }
  let dupes = 0;
  for (const c of counts.values()) if (c > 1) dupes += c - 1;
  return dupes;
}

interface B10ZProposalRowFull extends B10ZProposalRowLite {
  market_identity_key: string;
  market_value_hash: string;
  observation_hash: string;
}

interface B10ZProposalFile {
  decision: string;
  source_artifacts: { b09x: { path: string } };
  proposal_rows: B10ZProposalRowFull[];
}

interface B09XCollectionFile {
  normalized_rows_preview: B09XFullRow[];
}

// Map the M06X write-engine decision onto a B11X decision label.
function mapWriteDecision(result: RunRealAppendResult): B11XDecision {
  if (result.decision === "local_history_real_append_success") return "booking_bounded_append_with_identity_success";
  if (result.rowsConflict > 0) return "booking_bounded_append_with_identity_failed_conflicts";
  return "booking_bounded_append_with_identity_failed_write";
}

function run(): { decision: B11XDecision; reportPath: string; csvPath: string; jsonPath: string; debugRootPath: string } {
  const ts = timestamp();
  const runId = `booking_b11x_${ts}`;
  const generatedAtJst = nowJst();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  const reportDir = resolve(AUTOMATION_REPORT_DIR);
  const historyDir = resolve(HISTORY_DIR);

  // ---- Source artifacts ----
  const sourceB10ZJsonPath = findLatestB10ZJson();
  const b10z = readJson(sourceB10ZJsonPath) as B10ZProposalFile;
  const sourceB09XJsonPath = b10z.source_artifacts.b09x.path;
  const b09x = readJson(resolve(sourceB09XJsonPath)) as B09XCollectionFile;

  // ---- Select appendable rows (25 = 15 append_new + 10 identity-fix) ----
  const { appendRowIds, skippedRowIds, blockedRowIds } = selectAppendRows(b10z.proposal_rows);
  const proposalByRowId = new Map<string, B10ZProposalRowFull>();
  for (const r of b10z.proposal_rows) proposalByRowId.set(r.new_row_id, r);
  const b09xByRowId = new Map<string, B09XFullRow>();
  for (const r of b09x.normalized_rows_preview) b09xByRowId.set(r.row_id, r);

  const ctx = {
    sourceReportPath: sourceB09XJsonPath.replace(/\.json$/u, ".md"),
    sourceCsvPath: sourceB09XJsonPath.replace(/\.json$/u, ".csv")
  };

  // ---- Reconstruct full history rows + track which rows are identity-fixes ----
  const historyRows: HistoryRow[] = [];
  const identityFixRowIds = new Set<string>();
  const identityMetadata: IdentityMetadataRow[] = [];
  const missingRowIds: string[] = [];
  for (const legacyRowId of appendRowIds) {
    const proposal = proposalByRowId.get(legacyRowId);
    const src = b09xByRowId.get(legacyRowId);
    if (!proposal || !src) {
      missingRowIds.push(legacyRowId);
      continue;
    }
    const reconstructed = reconstructHistoryRow(src, proposal, ctx);
    historyRows.push(reconstructed);
    const isFix = proposal.history_action === "append_new_observation_after_identity_fix";
    if (isFix) identityFixRowIds.add(reconstructed.rowId);
    identityMetadata.push({
      legacy_row_id: buildRowId({
        collectedDateJst: src.collected_date_jst,
        source: "booking",
        canonicalPropertyName: src.canonical_property_name,
        sourceSlugOrCode: src.source_slug_or_code,
        sourcePropertyId: src.source_property_id,
        checkin: src.checkin,
        checkout: src.checkout,
        stayScope: src.stay_scope
      }),
      new_row_id: reconstructed.rowId,
      history_action: proposal.history_action,
      observation_id: proposal.observation_id,
      market_identity_key: proposal.market_identity_key,
      market_value_hash: proposal.market_value_hash,
      observation_hash: proposal.observation_hash,
      identity_changed: isFix
    });
  }

  // ---- Row policy validation + preflight ----
  const validation = validateApprovedHistoryRows(historyRows, identityFixRowIds);
  if (missingRowIds.length > 0) {
    validation.errors.push(`missing_b09x_source_rows:${JSON.stringify(missingRowIds)}`);
  }
  const validationOk = validation.ok && missingRowIds.length === 0;

  const { keys: existingKeys, rowCount: existingHistoryRowCount } = readExistingHistoryKeys();
  const preflight = computeAppendPreflight(historyRows, existingKeys, existingHistoryRowCount);

  // ---- Approval gate ----
  const envFlag = process.env[B11X_ENV_FLAG];
  const gate = evaluateBookingAppendGate({ approvalSentencePresent: APPROVAL_SENTENCE_PRESENT, envFlag });

  // ---- Decide whether to write ----
  let decision = decideB11XBeforeWrite({
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
  let postWriteDuplicateRowIdCount = 0;

  if (decision === "booking_bounded_append_with_identity_success") {
    // Gate allowed, validation ok, no conflicts → perform the real append.
    const sourceShards = groupRowsToSourceShards(historyRows);
    writeResult = runRealAppend({ historyDir, runId, backupTimestamp: ts, sourceShards });
    decision = mapWriteDecision(writeResult);

    if (decision === "booking_bounded_append_with_identity_success") {
      const written = preflight.touched_shards.map((shardMonth) => {
        const fileName = `zao_signals_${shardMonth}.csv`;
        return {
          fileName,
          csv: readFileSync(resolve(historyDir, fileName), "utf8"),
          expectedRowCount: (existingCountByShard.get(shardMonth) ?? 0) + (newCountByShard.get(shardMonth) ?? 0)
        };
      });
      postWrite = validatePostWriteShards(written);
      postWriteDuplicateRowIdCount = countDuplicateRowIds();
      if (!postWrite.ok || postWriteDuplicateRowIdCount > 0) {
        decision = "booking_bounded_append_with_identity_failed_validation";
      } else {
        historyRowCountAfter = existingHistoryRowCount + writeResult.rowsWritten;
      }
    }
  } else {
    writeResult = {
      ...emptyWriteResult,
      message:
        decision === "booking_bounded_append_with_identity_ready_not_run"
          ? `Fail-closed: ${JSON.stringify(gate.failedConditions)}. Nothing appended.`
          : decision === "booking_bounded_append_with_identity_failed_conflicts"
            ? `Aborted: ${preflight.conflict_count} conflict(s). Nothing appended.`
            : `Aborted: row policy validation failed (${validation.errors.length} error(s)). Nothing appended.`
    };
  }

  // ---- Append-action rows (for CSV + report) ----
  const appendActions: AppendActionRow[] = historyRows.map((r) => {
    const meta = identityMetadata.find((m) => m.new_row_id === r.rowId);
    return {
      new_row_id: r.rowId,
      legacy_row_id: meta?.legacy_row_id ?? r.rowId,
      canonical_property_name: r.canonicalPropertyName,
      checkin: r.checkin,
      shard_month: r.shardMonth,
      normalized_total_price: r.normalizedTotalPrice,
      basis_confidence: r.basisConfidence,
      history_action: meta?.history_action ?? "append_new",
      append_recommendation: proposalByRowId.get(meta?.legacy_row_id ?? "")?.append_recommendation ?? "",
      identity_changed: meta?.identity_changed ?? false
    };
  });

  // ---- Output paths ----
  const fileBase = `booking_bounded_append_with_identity_real_run_${ts}`;
  const reportPath = resolve(reportDir, `${fileBase}.md`);
  const csvPath = resolve(reportDir, `${fileBase}.csv`);
  const jsonPath = resolve(reportDir, `${fileBase}.json`);

  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const safetyConfirmation = {
    history_appended: decision === "booking_bounded_append_with_identity_success",
    db_writes: false,
    db_mirror_sync: false,
    ai_context_refreshed: false,
    live_booking_fetch: false,
    browser_automation_used: false,
    property_management_or_channel_manager_output: false,
    price_update: false,
    github_actions_or_cron: false,
    paid_source_tooling_used: false,
    synthetic_booking_tax_multiplier_used: false,
    approval_sentence_present: APPROVAL_SENTENCE_PRESENT,
    env_flag_set: envFlag === "1"
  };

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("source_b10z_artifact.json", {
    sourceB10ZJsonPath,
    sourceB09XJsonPath,
    proposalDecision: b10z.decision,
    appendRowIds,
    skippedRowIds,
    blockedRowIds,
    missingRowIds
  });
  writeDebug("approval_gate_result.json", { ...gate, approvalSentencePresent: APPROVAL_SENTENCE_PRESENT, envFlag: envFlag ?? null });
  writeDebug("selected_append_rows.json", { appendRowIds, identityFixRowIds: Array.from(identityFixRowIds), identityMetadata });
  writeDebug("skipped_rows.json", { skippedRowIds, skippedRowCount: skippedRowIds.length });
  writeDebug("preflight_summary.json", preflight);
  writeDebug("history_before_summary.json", { existingHistoryRowCount, existingCountByShard: Object.fromEntries(existingCountByShard) });
  writeDebug("history_append_actions.json", writeResult.shardActions);
  writeDebug("backup_actions.json", writeResult.shardActions.filter((a) => a.backupPath !== "").map((a) => ({ target: a.targetFile, backup: a.backupPath })));
  writeDebug("post_write_validation.json", { postWriteOk: postWrite.ok, postWriteDuplicateRowIdCount, results: postWrite.results, validation: { ...validation, missingRowIds } });
  writeDebug("rollback_result.json", { rollbackPerformed: writeResult.rollbackPerformed, rollbackActions: writeResult.rollbackActions });
  writeDebug("safety_confirmation.json", safetyConfirmation);

  // ---- Reports ----
  writeFileSync(csvPath, renderAppendActionCsv(appendActions), "utf8");

  const reportInput = {
    generatedAtJst,
    runId,
    decision,
    gate,
    sourceB10ZJsonPath,
    sourceB09XJsonPath,
    preflight,
    validation,
    appendActions,
    identityMetadata,
    backupDir: writeResult.backupDir,
    backupsCreated: writeResult.backupsCreated,
    filesUpdated: writeResult.filesUpdated,
    filesCreated: writeResult.filesCreated,
    rowsWritten: writeResult.rowsWritten,
    rowsSkippedDuplicate: writeResult.rowsSkippedDuplicate,
    rollbackPerformed: writeResult.rollbackPerformed,
    postWriteOk: postWrite.ok,
    postWriteDuplicateRowIdCount,
    historyRowCountBefore: existingHistoryRowCount,
    historyRowCountAfter,
    skippedRowCount: skippedRowIds.length,
    reportPath,
    jsonPath,
    csvPath,
    debugRootPath
  };
  writeFileSync(reportPath, renderB11XReport(reportInput), "utf8");

  const summary = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    schema_version: "zao_local_history_v1",
    price_policy_version: "booking_official_visible_adder_v1",
    identity_policy_version: "id02x_option_c",
    approval_gate_result: gate,
    source_artifacts: { b10z: sourceB10ZJsonPath, b09x: sourceB09XJsonPath },
    selected_append_summary: {
      appendable_count: appendRowIds.length,
      append_new_count: appendActions.filter((a) => a.history_action === "append_new").length,
      append_new_observation_after_identity_fix_count: identityFixRowIds.size,
      append_directional_count: appendActions.filter((a) => a.append_recommendation === "append_directional").length,
      append_excluded_audit_count: appendActions.filter((a) => a.append_recommendation === "append_excluded_audit").length
    },
    skipped_summary: { skipped_benign_duplicate_count: skippedRowIds.length, skippedRowIds },
    blocked_summary: { blocked_count: blockedRowIds.length, blockedRowIds },
    preflight_summary: preflight,
    row_policy_validation: validation,
    history_before_summary: { existing_history_row_count: existingHistoryRowCount },
    history_after_summary: { history_row_count_after: historyRowCountAfter },
    append_actions: appendActions,
    identity_metadata: identityMetadata,
    backup_actions: writeResult.shardActions.filter((a) => a.backupPath !== "").map((a) => ({ target: a.targetFile, backup: a.backupPath })),
    history_append_actions: writeResult.shardActions,
    post_write_validation: { post_write_ok: postWrite.ok, post_write_duplicate_row_id_count: postWriteDuplicateRowIdCount, results: postWrite.results },
    rollback_result: { rollback_performed: writeResult.rollbackPerformed, rollback_actions: writeResult.rollbackActions },
    write_result: writeResult,
    safety_confirmation: safetyConfirmation,
    next_phase: decision === "booking_bounded_append_with_identity_success" ? "BOOKING-B11B (do not start without explicit instruction)" : "n/a"
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
    result.decision === "booking_bounded_append_with_identity_success" ||
    result.decision === "booking_bounded_append_with_identity_ready_not_run";
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
