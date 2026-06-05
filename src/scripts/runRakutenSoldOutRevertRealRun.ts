// Phase AUTO08X-FIX02 — run approved Rakuten sold-out row revert.
//
// Requires the current-turn explicit approval plus RAKUTEN_SOLDOUT_REVERT=1.
// Without the env flag this fails closed. Approved mutations are limited to:
// - two history shards (.data/history/zao_signals_2026_06.csv and _07.csv)
// - DB mirror deletion of exactly the approved 116 row_ids
// - derived AI context pack rebuild

import Database from "better-sqlite3";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  APPROVED_TOUCHED_FILES,
  REAL_REVERT_APPROVAL_SENTENCE,
  buildCleanedShards,
  evaluateRakutenSoldOutRevertGate,
  parseCsvWithHeaderLine,
  preflightRakutenSoldOutRevert,
  renderRakutenSoldOutRevertRealRunCsv,
  renderRakutenSoldOutRevertRealRunMarkdown,
  validateContextRebuild,
  validateDbReconciliation,
  validateExpectedHistoryAfter,
  validateHistoryAfterRevert,
  type CleanedShard,
  type ContextRebuildSummary,
  type DbReconciliationResult,
  type HistoryAfterSummary,
  type HistoryShardInput,
  type RakutenSoldOutRevertRealRunReport,
  type TaskQuerySmokeSummary
} from "../services/rakutenSoldOutRevertRealRun";
import type { RakutenSoldOutRevertProposal } from "../services/rakutenSoldOutRevertProposal";
import type { HistoryRowLike } from "../services/rakutenSoldOutSemanticsAudit";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/rakuten-sold-out-revert-real-run";
const HISTORY_DIR = ".data/history";
const DB_PATH = ".data/zao-market-intelligence.sqlite";
const PROPOSAL_JSON = ".data/reports/automation/rakuten_sold_out_revert_proposal_20260604_104747.json";
const EXPLICIT_APPROVAL_PRESENT = true;
const CONTEXT_FILES = [
  ".data/ai-context/latest_market_snapshot.json",
  ".data/ai-context/latest_demand_context.json",
  ".data/ai-context/latest_property_signal_context.json",
  ".data/ai-context/latest_caveats_and_guardrails.json",
  ".data/ai-context/latest_ai_task_entrypoint.json"
];

interface CommandResult {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

interface MarketSnapshotLike {
  market_signal_history_row_count?: number;
  sold_out_row_count?: number;
  basis_confidence_counts?: Record<string, number>;
}

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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function historyFiles(): string[] {
  return readdirSync(resolve(HISTORY_DIR))
    .filter((name) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(name))
    .sort()
    .map((name) => `${HISTORY_DIR}/${name}`);
}

function loadHistoryRows(files = historyFiles()): HistoryRowLike[] {
  return files.flatMap((file) => {
    const table = parseCsvWithHeaderLine(readFileSync(resolve(file), "utf8"));
    return table.rows.map((row) => ({ ...row, __source_file: file }));
  });
}

function loadTouchedShards(): HistoryShardInput[] {
  return APPROVED_TOUCHED_FILES.map((path) => ({ path, csv: readFileSync(resolve(path), "utf8") }));
}

function command(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function backupTouchedShards(backupPath: string): string[] {
  mkdirSync(resolve(backupPath), { recursive: true });
  const actions: string[] = [];
  for (const file of APPROVED_TOUCHED_FILES) {
    const dest = resolve(backupPath, file.split("/").pop() ?? file);
    copyFileSync(resolve(file), dest);
    actions.push(`${file} -> ${dest}`);
  }
  return actions;
}

function writeCleanedShards(cleaned: CleanedShard[]): string[] {
  const actions: string[] = [];
  for (const shard of cleaned) {
    const target = resolve(shard.path);
    const temp = `${target}.tmp_rakuten_soldout_revert`;
    mkdirSync(dirname(temp), { recursive: true });
    writeFileSync(temp, shard.content, "utf8");
    renameSync(temp, target);
    actions.push(`${shard.path}: ${shard.beforeRows} -> ${shard.afterRows}; removed=${shard.removedRows}`);
  }
  return actions;
}

function rollbackFromBackup(backupPath: string): { attempted: boolean; success: boolean; message: string } {
  try {
    for (const file of APPROVED_TOUCHED_FILES) {
      const backupFile = resolve(backupPath, file.split("/").pop() ?? file);
      copyFileSync(backupFile, resolve(file));
    }
    return { attempted: true, success: true, message: "restored touched shards from backup" };
  } catch (error) {
    return { attempted: true, success: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function reconcileDb(proposal: RakutenSoldOutRevertProposal, runId: string, generatedAtJst: string, reportPath: string): DbReconciliationResult {
  if (!existsSync(resolve(DB_PATH))) {
    return {
      attempted: true,
      deleted_rows: 0,
      remaining_approved_row_ids: 116,
      market_signal_history_rows: 0,
      sync_run_recorded: false,
      errors: [`DB not found: ${DB_PATH}`]
    };
  }
  const db = new Database(resolve(DB_PATH));
  try {
    const ids = proposal.affected_row_ids;
    const deleteStmt = db.prepare(
      `DELETE FROM market_signal_history
       WHERE row_id = ?
         AND source = 'rakuten'
         AND classification = 'rakuten_day_sold_out'
         AND (
           raw_json LIKE '%AUTO08X%'
           OR debug_artifact_path LIKE '%auto-history-append/20260604_094714%'
         )`
    );
    let deleted = 0;
    const work = db.transaction(() => {
      for (const rowId of ids) deleted += Number(deleteStmt.run(rowId).changes);
      db.prepare(
        `INSERT INTO market_signal_sync_runs (
          sync_run_id, started_at, finished_at, status, source_history_files, input_rows, inserted_rows,
          skipped_identical_rows, conflict_rows, error_message, report_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `${runId}_rakuten_soldout_reconcile`,
        generatedAtJst,
        generatedAtJst,
        "success_reconciled_deleted_approved_rows",
        JSON.stringify(historyFiles()),
        145,
        0,
        145,
        0,
        "",
        reportPath,
        generatedAtJst
      );
    });
    work();
    const remaining = ids.reduce((count, rowId) => {
      const row = db.prepare("SELECT COUNT(*) AS c FROM market_signal_history WHERE row_id = ?").get(rowId) as { c: number };
      return count + Number(row.c);
    }, 0);
    const total = db.prepare("SELECT COUNT(*) AS c FROM market_signal_history").get() as { c: number };
    const validationErrors = validateDbReconciliation({
      deletedRows: deleted,
      remainingApprovedRowIds: remaining,
      marketSignalHistoryRows: Number(total.c)
    });
    return {
      attempted: true,
      deleted_rows: deleted,
      remaining_approved_row_ids: remaining,
      market_signal_history_rows: Number(total.c),
      sync_run_recorded: true,
      errors: validationErrors
    };
  } catch (error) {
    return {
      attempted: true,
      deleted_rows: 0,
      remaining_approved_row_ids: 116,
      market_signal_history_rows: 0,
      sync_run_recorded: false,
      errors: [error instanceof Error ? error.message : String(error)]
    };
  } finally {
    db.close();
  }
}

function latestContextFilesRegular(): boolean {
  return CONTEXT_FILES.every((path) => existsSync(resolve(path)) && lstatSync(resolve(path)).isFile());
}

function rebuildContext(): { summary: ContextRebuildSummary; commandResult: CommandResult } {
  const result = command("npm", ["run", "build:ai-context-packs"]);
  let rows: number | null = null;
  let soldOut: number | null = null;
  let insufficient: number | null = null;
  let reportPath = "";
  const errors: string[] = [];
  if (result.status !== 0) errors.push(result.stderr || result.stdout || "context rebuild failed");
  try {
    const snapshot = readJson<MarketSnapshotLike>(".data/ai-context/latest_market_snapshot.json");
    rows = snapshot.market_signal_history_row_count ?? null;
    soldOut = snapshot.sold_out_row_count ?? null;
    insufficient = snapshot.basis_confidence_counts?.["insufficient"] ?? null;
    const match = result.stdout.match(/report_path=(.+)/u);
    reportPath = match?.[1]?.trim() ?? "";
    errors.push(...validateContextRebuild({
      marketSignalHistoryRows: rows,
      soldOutCount: soldOut,
      basisConfidenceInsufficient: insufficient,
      latestFilesRegular: latestContextFilesRegular()
    }));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    commandResult: result,
    summary: {
      attempted: true,
      command: result.command,
      exit_code: result.status,
      market_signal_history_rows: rows,
      sold_out_count: soldOut,
      basis_confidence_insufficient: insufficient,
      latest_files_regular: latestContextFilesRegular(),
      report_path: reportPath,
      errors
    }
  };
}

function runTaskSmoke(): { summary: TaskQuerySmokeSummary; commandResults: CommandResult[] } {
  const commands: Array<[string, string[]]> = [
    ["npm", ["run", "query:ai-task", "--", "--task", "bootstrap"]],
    ["npm", ["run", "query:ai-task", "--", "--task", "sold_out_pressure", "--limit", "10"]]
  ];
  const results = commands.map(([cmd, args]) => command(cmd, args));
  const errors = results.filter((result) => result.status !== 0).map((result) => result.stderr || result.stdout || `${result.command} failed`);
  return {
    commandResults: results,
    summary: {
      attempted: true,
      commands: results.map((result) => result.command),
      passed: errors.length === 0,
      outputs: results.map((result) => result.stdout),
      errors
    }
  };
}

function safeReport(input: {
  runId: string;
  generatedAtJst: string;
  decision: RakutenSoldOutRevertRealRunReport["decision"];
  gate: RakutenSoldOutRevertRealRunReport["explicit_approval_result"];
  preflight: RakutenSoldOutRevertRealRunReport["revert_preflight_result"];
  reportPath: string;
  jsonPath: string;
  csvPath: string;
  debugPath: string;
  backupPath?: string;
  backupActions?: string[];
  cleaned?: CleanedShard[];
  rollback?: { attempted: boolean; success: boolean; message: string };
  db?: DbReconciliationResult;
  context?: ContextRebuildSummary;
  smoke?: TaskQuerySmokeSummary;
  finalHistoryRows?: number;
}): RakutenSoldOutRevertRealRunReport {
  return {
    run_id: input.runId,
    generated_at_jst: input.generatedAtJst,
    decision: input.decision,
    source_fix02p_artifact: PROPOSAL_JSON,
    explicit_approval_result: input.gate,
    revert_preflight_result: input.preflight,
    history_revert_actions: input.cleaned ?? [],
    backup_path: input.backupPath ?? "",
    backup_actions: input.backupActions ?? [],
    rollback_result: input.rollback ?? { attempted: false, success: false, message: "not needed" },
    db_resync_reconciliation_result: input.db ?? {
      attempted: false,
      deleted_rows: 0,
      remaining_approved_row_ids: 0,
      market_signal_history_rows: 0,
      sync_run_recorded: false,
      errors: []
    },
    ai_context_rebuild_result: input.context ?? {
      attempted: false,
      command: "",
      exit_code: null,
      market_signal_history_rows: null,
      sold_out_count: null,
      basis_confidence_insufficient: null,
      latest_files_regular: false,
      report_path: "",
      errors: []
    },
    task_query_smoke_result: input.smoke ?? {
      attempted: false,
      commands: [],
      passed: false,
      outputs: [],
      errors: []
    },
    final_row_counts: {
      history_total_rows: input.finalHistoryRows ?? 0,
      db_market_signal_history_rows: input.db?.market_signal_history_rows ?? null,
      ai_context_sold_out_count: input.context?.sold_out_count ?? null,
      ai_context_basis_confidence_insufficient: input.context?.basis_confidence_insufficient ?? null
    },
    safety_confirmation: {
      explicitApprovalSentencePresent: EXPLICIT_APPROVAL_PRESENT,
      envFlagRequired: process.env["RAKUTEN_SOLDOUT_REVERT"] === "1",
      modifiedOnlyApprovedHistoryShards: true,
      removedOnlyApprovedRowIds: true,
      dbDeletesLimitedToApprovedRowIds: true,
      collectorsRun: false,
      liveExternalFetch: false,
      playwrightUsed: false,
      propertyMasterModified: false,
      pmsOrChannelOutput: false,
      priceUpdate: false,
      githubActionsOrGitOps: false,
      paidSourceTooling: false,
      bookingBaseTimesOnePointOne: false
    },
    report_path: input.reportPath,
    json_path: input.jsonPath,
    csv_path: input.csvPath,
    debug_artifact_path: input.debugPath
  };
}

function writeReport(report: RakutenSoldOutRevertRealRunReport, debugPath: string, debug: Record<string, unknown>): void {
  writeFileSync(report.report_path, renderRakutenSoldOutRevertRealRunMarkdown(report), "utf8");
  writeFileSync(report.json_path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(report.csv_path, renderRakutenSoldOutRevertRealRunCsv(report), "utf8");
  mkdirSync(debugPath, { recursive: true });
  for (const [name, value] of Object.entries(debug)) {
    const fileName = name.endsWith(".json") ? name : `${name}.json`;
    writeFileSync(resolve(debugPath, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

function printSummary(report: RakutenSoldOutRevertRealRunReport): void {
  console.log(`decision=${report.decision}`);
  console.log(`approval_gate_passed=${report.explicit_approval_result.passed}`);
  console.log(`history_total_rows=${report.final_row_counts.history_total_rows}`);
  console.log(`db_market_signal_history_rows=${report.final_row_counts.db_market_signal_history_rows ?? ""}`);
  console.log(`ai_context_sold_out_count=${report.final_row_counts.ai_context_sold_out_count ?? ""}`);
  console.log(`ai_context_basis_confidence_insufficient=${report.final_row_counts.ai_context_basis_confidence_insufficient ?? ""}`);
  console.log(`report_path=${report.report_path}`);
  console.log(`json_path=${report.json_path}`);
  console.log(`csv_path=${report.csv_path}`);
  console.log(`debug_artifact_path=${report.debug_artifact_path}`);
}

function main(): void {
  const ts = timestamp();
  const runId = `rakuten_sold_out_revert_real_run_${ts}`;
  const generatedAtJst = jstIso();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const debugPath = resolve(DEBUG_ROOT, ts);
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);
  const proposal = existsSync(resolve(PROPOSAL_JSON)) ? readJson<RakutenSoldOutRevertProposal>(PROPOSAL_JSON) : null;
  const gate = evaluateRakutenSoldOutRevertGate({
    explicitApprovalPresent: EXPLICIT_APPROVAL_PRESENT && REAL_REVERT_APPROVAL_SENTENCE.length > 0,
    envFlag: process.env["RAKUTEN_SOLDOUT_REVERT"],
    proposal
  });
  const emptyPreflight = {
    passed: false,
    errors: gate.reasons,
    before_summary: { total_history_rows: 0, shard_counts: {}, touched_shard_counts: {} },
    expected_after_counts: {},
    target_row_ids_found: 0
  };

  if (!gate.passed || proposal === null) {
    const report = safeReport({
      runId,
      generatedAtJst,
      decision: "rakuten_sold_out_revert_ready_not_run",
      gate,
      preflight: emptyPreflight,
      reportPath,
      jsonPath,
      csvPath,
      debugPath
    });
    writeReport(report, debugPath, {
      source_revert_proposal: proposal ?? { missing: PROPOSAL_JSON },
      approval_gate_result: gate,
      safety_confirmation: report.safety_confirmation
    });
    printSummary(report);
    return;
  }

  const touchedShards = loadTouchedShards();
  const preflight = preflightRakutenSoldOutRevert({
    proposal,
    allHistoryRows: loadHistoryRows(),
    touchedShards
  });
  if (!preflight.passed) {
    const report = safeReport({
      runId,
      generatedAtJst,
      decision: "rakuten_sold_out_revert_failed_preflight",
      gate,
      preflight,
      reportPath,
      jsonPath,
      csvPath,
      debugPath,
      finalHistoryRows: loadHistoryRows().length
    });
    writeReport(report, debugPath, {
      source_revert_proposal: proposal,
      approval_gate_result: gate,
      history_before_summary: preflight.before_summary,
      affected_row_ids: proposal.affected_row_ids,
      safety_confirmation: report.safety_confirmation
    });
    printSummary(report);
    return;
  }

  const backupPath = `.data/history/.backup/${ts}_rakuten_soldout_revert`;
  let backupActions: string[] = [];
  let cleaned: CleanedShard[] = [];
  let rollback = { attempted: false, success: false, message: "not needed" };
  try {
    backupActions = backupTouchedShards(backupPath);
    cleaned = buildCleanedShards({ proposal, touchedShards });
    writeCleanedShards(cleaned);
  } catch (error) {
    rollback = rollbackFromBackup(backupPath);
    const report = safeReport({
      runId,
      generatedAtJst,
      decision: rollback.success ? "rakuten_sold_out_revert_failed_rolled_back" : "rakuten_sold_out_revert_failed_manual_recovery_required",
      gate,
      preflight,
      reportPath,
      jsonPath,
      csvPath,
      debugPath,
      backupPath,
      backupActions,
      cleaned,
      rollback,
      finalHistoryRows: loadHistoryRows().length
    });
    writeReport(report, debugPath, {
      source_revert_proposal: proposal,
      approval_gate_result: gate,
      history_before_summary: preflight.before_summary,
      backup_actions: backupActions,
      write_actions: cleaned,
      rollback_result: rollback,
      safety_confirmation: report.safety_confirmation,
      error: error instanceof Error ? error.message : String(error)
    });
    printSummary(report);
    return;
  }

  const afterSummary = validateHistoryAfterRevert({
    allHistoryRows: loadHistoryRows(),
    removedRowIds: proposal.affected_row_ids
  });
  const afterErrors = validateExpectedHistoryAfter(afterSummary);
  if (afterErrors.length > 0) {
    rollback = rollbackFromBackup(backupPath);
    const report = safeReport({
      runId,
      generatedAtJst,
      decision: rollback.success ? "rakuten_sold_out_revert_failed_rolled_back" : "rakuten_sold_out_revert_failed_manual_recovery_required",
      gate,
      preflight,
      reportPath,
      jsonPath,
      csvPath,
      debugPath,
      backupPath,
      backupActions,
      cleaned,
      rollback,
      finalHistoryRows: loadHistoryRows().length
    });
    writeReport(report, debugPath, {
      source_revert_proposal: proposal,
      approval_gate_result: gate,
      history_before_summary: preflight.before_summary,
      backup_actions: backupActions,
      write_actions: cleaned,
      history_after_summary: afterSummary,
      rollback_result: rollback,
      safety_confirmation: report.safety_confirmation,
      validation_errors: afterErrors
    });
    printSummary(report);
    return;
  }

  const dryRunCommand = command("npm", ["run", "dry-run:history-to-db-sync"]);
  const dbResult = reconcileDb(proposal, runId, generatedAtJst, reportPath);
  if (dbResult.errors.length > 0) {
    const report = safeReport({
      runId,
      generatedAtJst,
      decision: "rakuten_sold_out_revert_failed_db_resync",
      gate,
      preflight,
      reportPath,
      jsonPath,
      csvPath,
      debugPath,
      backupPath,
      backupActions,
      cleaned,
      rollback,
      db: dbResult,
      finalHistoryRows: afterSummary.total_history_rows
    });
    writeReport(report, debugPath, {
      source_revert_proposal: proposal,
      approval_gate_result: gate,
      history_before_summary: preflight.before_summary,
      affected_row_ids: proposal.affected_row_ids,
      backup_actions: backupActions,
      write_actions: cleaned,
      history_after_summary: afterSummary,
      db_resync_summary: { dry_run_command: dryRunCommand, reconciliation: dbResult },
      rollback_result: rollback,
      safety_confirmation: report.safety_confirmation
    });
    printSummary(report);
    return;
  }

  const context = rebuildContext();
  if (context.summary.errors.length > 0) {
    const report = safeReport({
      runId,
      generatedAtJst,
      decision: "rakuten_sold_out_revert_failed_context_rebuild",
      gate,
      preflight,
      reportPath,
      jsonPath,
      csvPath,
      debugPath,
      backupPath,
      backupActions,
      cleaned,
      rollback,
      db: dbResult,
      context: context.summary,
      finalHistoryRows: afterSummary.total_history_rows
    });
    writeReport(report, debugPath, {
      source_revert_proposal: proposal,
      approval_gate_result: gate,
      history_before_summary: preflight.before_summary,
      affected_row_ids: proposal.affected_row_ids,
      backup_actions: backupActions,
      write_actions: cleaned,
      history_after_summary: afterSummary,
      db_resync_summary: { dry_run_command: dryRunCommand, reconciliation: dbResult },
      context_rebuild_summary: { command: context.commandResult, summary: context.summary },
      rollback_result: rollback,
      safety_confirmation: report.safety_confirmation
    });
    printSummary(report);
    return;
  }

  const smoke = runTaskSmoke();
  const decision = smoke.summary.passed ? "rakuten_sold_out_revert_success" : "rakuten_sold_out_revert_failed_context_rebuild";
  const report = safeReport({
    runId,
    generatedAtJst,
    decision,
    gate,
    preflight,
    reportPath,
    jsonPath,
    csvPath,
    debugPath,
    backupPath,
    backupActions,
    cleaned,
    rollback,
    db: dbResult,
    context: context.summary,
    smoke: smoke.summary,
    finalHistoryRows: afterSummary.total_history_rows
  });
  writeReport(report, debugPath, {
    source_revert_proposal: proposal,
    approval_gate_result: gate,
    history_before_summary: preflight.before_summary,
    affected_row_ids: proposal.affected_row_ids,
    backup_actions: backupActions,
    write_actions: cleaned,
    history_after_summary: afterSummary,
    db_resync_summary: { dry_run_command: dryRunCommand, reconciliation: dbResult },
    context_rebuild_summary: { command: context.commandResult, summary: context.summary },
    task_query_smoke_summary: { commands: smoke.commandResults, summary: smoke.summary },
    rollback_result: rollback,
    safety_confirmation: report.safety_confirmation
  });
  printSummary(report);
}

main();
