// Phase AUTO-RUNNER10X - integrated Booking/Jalan market refresh runner.
//
// Fail-closed by default. Approved live mode runs bounded Booking then bounded
// Jalan collection sequentially, appends only policy-approved rows, syncs the
// DB mirror, rebuilds AI context, and writes automation artifacts. It never
// generates pricing CSV/PMS output and never installs launchd.

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  appendHistoryRowsAtomic,
  buildAppendPlan,
  buildBookingPlan,
  buildBookingSourceLevelCheck,
  buildJalanSourceLevelCheck,
  buildJalanTargetMatrix,
  buildPlannerDrivenBookingPlan,
  buildPlannerDrivenJalanMatrix,
  buildSafetyConfirmation,
  decideMarketRefresh,
  evaluateMarketRefreshGates,
  renderMarketRefreshCsv,
  renderMarketRefreshReport,
  totalPageCapRespected,
  type AppendPlan,
  type AutoRunnerMarketRefreshDecision,
  type ExistingHistoryKey,
  type HistoryAppendResult,
  type MarketStateSummary,
  type SourceLevelCheck
} from "../services/autoRunnerMarketRefresh";
import { buildScopePlan, type DemandConfig, type PlannerProperty } from "../services/collectionScopePlanner";
import { buildMappingIndex } from "../services/plannedMarketRefresh";
import { type PreviewResult, type PreviewRow as BookingPreviewRow } from "../services/autoRunnerBookingPreview";
import {
  buildImprovedSummaries,
  renderImprovedPreviewRowsCsv,
  type JalanImprovedPreviewRow
} from "../services/jalanBoundedCollectionProbeImproved";
import { collectTarget, type PageResult } from "./probeJalanBoundedCollectionImproved";

const HISTORY_DIR = ".data/history";
const DB_PATH = ".data/zao-market-intelligence.sqlite";
const AI_CONTEXT_PATH = ".data/ai-context/latest_market_snapshot.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/auto-runner-market-refresh";

// Phase AUTO-RUNNER15X-B demand config (mirrors runCollectionScopePlanner.ts).
const PLANNER_DEMAND_CONFIG: DemandConfig = {
  public_holidays: {
    "2026-07-20": "海の日", "2026-08-11": "山の日", "2026-09-21": "敬老の日",
    "2026-09-22": "国民の休日", "2026-09-23": "秋分の日", "2026-10-12": "スポーツの日",
    "2026-11-03": "文化の日", "2026-11-23": "勤労感謝の日", "2027-01-01": "元日"
  },
  long_weekend_dates: new Set([
    "2026-07-18", "2026-07-19", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22",
    "2026-10-10", "2026-10-11", "2026-11-21", "2026-11-22"
  ]),
  peak_periods: [
    { code: "obon", from: "2026-08-08", to: "2026-08-16" },
    { code: "autumn_foliage_saturday", from: "2026-10-10", to: "2026-11-08", saturday_only: true },
    { code: "ski_season_saturday", from: "2026-12-19", to: "2027-03-15", saturday_only: true },
    { code: "year_end_peak", from: "2026-12-28", to: "2027-01-03" }
  ]
};

interface CommandResult {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
  parsed: Record<string, unknown>;
}

interface RunnerOutput {
  run_id: string;
  generated_at_jst: string;
  decision: AutoRunnerMarketRefreshDecision;
  gate_result: ReturnType<typeof evaluateMarketRefreshGates>;
  preflight_state: MarketStateSummary;
  post_run_state: MarketStateSummary;
  booking_plan: ReturnType<typeof buildBookingPlan>;
  jalan_target_matrix: ReturnType<typeof buildJalanTargetMatrix>;
  booking_result: Record<string, unknown>;
  jalan_result: Record<string, unknown>;
  booking_source_check: SourceLevelCheck;
  jalan_source_check: SourceLevelCheck;
  classification_summary: Record<string, unknown>;
  append_plan: AppendPlan;
  append_result: HistoryAppendResult | null;
  db_sync_result: CommandResult | { skipped: true; reason: string };
  ai_context_result: CommandResult | { skipped: true; reason: string };
  post_run_validation: Record<string, unknown>;
  safety_confirmation: ReturnType<typeof buildSafetyConfirmation>;
  report_path: string;
  json_path: string;
  csv_path: string;
  debug_artifact_path: string;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

function todayUtcYmd(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseKeyValueOutput(text: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/u)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        parsed[key] = JSON.parse(raw);
      } catch {
        parsed[key] = raw;
      }
    } else if (/^-?\d+$/u.test(raw)) {
      parsed[key] = Number(raw);
    } else if (raw === "true" || raw === "false") {
      parsed[key] = raw === "true";
    } else {
      parsed[key] = raw;
    }
  }
  return parsed;
}

function runCommand(command: string, args: string[], env: Record<string, string | undefined> = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed: parseKeyValueOutput(result.stdout)
  };
}

function readState(): MarketStateSummary {
  const history = readHistoryInventory();
  let dbRows = 0;
  if (existsSync(DB_PATH)) {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try {
      dbRows = (db.prepare("SELECT COUNT(*) AS c FROM market_signal_history").get() as { c: number }).c;
    } finally {
      db.close();
    }
  }
  let aiContextRows = 0;
  if (existsSync(AI_CONTEXT_PATH)) {
    aiContextRows = (JSON.parse(readFileSync(AI_CONTEXT_PATH, "utf8")) as { market_signal_history_row_count?: number }).market_signal_history_row_count ?? 0;
  }
  return {
    history_rows: history.total,
    db_rows: dbRows,
    ai_context_rows: aiContextRows,
    source_counts: history.sources,
    duplicate_row_id_count: history.duplicateRowIds
  };
}

function readHistoryInventory(): { total: number; sources: Record<string, number>; duplicateRowIds: number; keys: ExistingHistoryKey[] } {
  const files = readdirSync(HISTORY_DIR).filter((name) => /^zao_signals_.*\.csv$/u.test(name)).sort();
  const ids = new Map<string, number>();
  const sources: Record<string, number> = {};
  const keys: ExistingHistoryKey[] = [];
  let total = 0;
  for (const file of files) {
    const lines = readFileSync(join(HISTORY_DIR, file), "utf8").split(/\r?\n/u).filter((line) => line.length > 0);
    const headers = parseCsvLine(lines[0] ?? "");
    const rowIdIdx = headers.indexOf("row_id");
    const rowHashIdx = headers.indexOf("row_hash");
    const shardIdx = headers.indexOf("shard_month");
    const sourceIdx = headers.indexOf("source");
    const priceIdx = headers.indexOf("normalized_total_price");
    const availabilityIdx = headers.indexOf("availability_status");
    const basisIdx = headers.indexOf("basis_confidence");
    const dpDirectionalIdx = headers.indexOf("is_price_usable_for_dp_directional");
    const dpExcludedIdx = headers.indexOf("is_price_excluded_from_dp");
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      const rowId = cells[rowIdIdx] ?? "";
      const source = cells[sourceIdx] ?? "unknown";
      total += 1;
      ids.set(rowId, (ids.get(rowId) ?? 0) + 1);
      sources[source] = (sources[source] ?? 0) + 1;
      const rawPrice = priceIdx >= 0 ? (cells[priceIdx] ?? "") : "";
      keys.push({
        row_id: rowId,
        row_hash: cells[rowHashIdx] ?? "",
        shard_month: cells[shardIdx] ?? "",
        normalized_total_price: rawPrice.trim() === "" ? null : Number(rawPrice),
        availability_status: availabilityIdx >= 0 ? cells[availabilityIdx] ?? "" : undefined,
        basis_confidence: basisIdx >= 0 ? cells[basisIdx] ?? "" : undefined,
        dp_directional: dpDirectionalIdx >= 0 ? (cells[dpDirectionalIdx] ?? "").toLowerCase() === "true" : undefined,
        dp_excluded: dpExcludedIdx >= 0 ? (cells[dpExcludedIdx] ?? "").toLowerCase() === "true" : undefined
      });
    }
  }
  return { total, sources, duplicateRowIds: [...ids.values()].filter((count) => count > 1).length, keys };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === "\"" && inQuotes && next === "\"") {
      current += "\"";
      i += 1;
    } else if (char === "\"") {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function runBookingCollection(): { rows: BookingPreviewRow[]; artifact: PreviewResult | null; command: CommandResult } {
  const command = runCommand("npm", ["run", "auto-runner:booking-preview"], { COLLECT_BOOKING: "1" });
  const jsonPath = typeof command.parsed["json_path"] === "string" ? command.parsed["json_path"] : "";
  const artifact = jsonPath !== "" && existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")) as PreviewResult : null;
  return { rows: artifact?.preview_rows ?? [], artifact, command };
}

async function runJalanCollection(input: {
  runId: string;
  generatedAtJst: string;
  debugPath: string;
  reportPath: string;
  csvPath: string;
  targets: ReturnType<typeof buildJalanTargetMatrix>;
}): Promise<{ rows: JalanImprovedPreviewRow[]; pageResults: PageResult[]; summary: Record<string, unknown> }> {
  mkdirSync(resolve(input.debugPath, "jalan", "screenshots"), { recursive: true });
  mkdirSync(resolve(input.debugPath, "jalan", "html"), { recursive: true });
  mkdirSync(resolve(input.debugPath, "jalan", "text"), { recursive: true });
  mkdirSync(resolve(input.debugPath, "jalan", "errors"), { recursive: true });
  mkdirSync(resolve(input.debugPath, "jalan", "evidence_flags"), { recursive: true });
  mkdirSync(resolve(input.debugPath, "jalan", "classification_decisions"), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const rows: JalanImprovedPreviewRow[] = [];
  const pageResults: PageResult[] = [];
  try {
    for (const target of input.targets) {
      const result = await collectTarget({
        browser,
        target,
        runId: input.runId,
        checkedAt: input.generatedAtJst,
        debugPath: resolve(input.debugPath, "jalan"),
        reportPath: input.reportPath,
        csvPath: input.csvPath
      });
      rows.push(result.row);
      pageResults.push(result.pageResult);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  const summaries = buildImprovedSummaries({ targets: input.targets, rows });
  writeJson(resolve(input.debugPath, "jalan_preview_rows.json"), rows);
  writeJson(resolve(input.debugPath, "jalan_page_results.json"), pageResults);
  writeFileSync(resolve(input.debugPath, "jalan_preview_rows.csv"), renderImprovedPreviewRowsCsv(rows), "utf8");
  return { rows, pageResults, summary: summaries };
}

async function run(): Promise<RunnerOutput> {
  const ts = timestamp();
  const runId = `auto_runner_market_refresh_${ts}`;
  const generatedAtJst = jstIso();
  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(REPORT_DIR, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const gate = evaluateMarketRefreshGates(process.env);
  const preflight = readState();
  const preflightOk = preflight.history_rows > 0 && preflight.duplicate_row_id_count === 0;
  const plannerDriven = process.env["PLANNER_DRIVEN_MARKET_REFRESH"] === "1";
  let bookingPlan: ReturnType<typeof buildBookingPlan>;
  let jalanTargets: ReturnType<typeof buildJalanTargetMatrix>;
  if (plannerDriven) {
    // Phase AUTO-RUNNER15X-B: use planner-selected targets.
    const props: PlannerProperty[] = [
      ...Array.from(buildMappingIndex().booking.entries()).map(([slug, name]) => ({ source: "booking" as const, property_slug: slug, canonical_property_name: name })),
      ...Array.from(buildMappingIndex().jalan.entries()).map(([yadId, name]) => ({ source: "jalan" as const, property_slug: yadId, canonical_property_name: name }))
    ];
    const scopePlan = buildScopePlan({ runDateIso: todayUtcYmd(), properties: props, config: PLANNER_DEMAND_CONFIG });
    const bookingSlugs = scopePlan.selected.filter((t) => t.source === "booking" && t.can_collect).map((t) => t.property_slug);
    const jalanYadIds = scopePlan.selected.filter((t) => t.source === "jalan" && t.can_collect).map((t) => t.property_slug);
    const plannerBooking = buildPlannerDrivenBookingPlan(bookingSlugs, todayUtcYmd());
    const plannerJalan = buildPlannerDrivenJalanMatrix(jalanYadIds, todayUtcYmd());
    bookingPlan = plannerBooking;
    jalanTargets = plannerJalan.targets;
  } else {
    // Fixed live target behavior (unchanged from AUTO-RUNNER10X/11Y).
    bookingPlan = buildBookingPlan(todayUtcYmd());
    jalanTargets = buildJalanTargetMatrix(todayUtcYmd());
  }

  let bookingRows: BookingPreviewRow[] = [];
  let bookingResult: Record<string, unknown> = { skipped: true, reason: "live_mode_not_authorized" };
  let jalanRows: JalanImprovedPreviewRow[] = [];
  let jalanResult: Record<string, unknown> = { skipped: true, reason: "live_mode_not_authorized" };

  if (gate.live_mode_authorized && preflightOk) {
    const booking = runBookingCollection();
    bookingRows = booking.rows;
    bookingResult = {
      command_status: booking.command.status,
      decision: booking.artifact?.decision ?? "missing_artifact",
      page_count: booking.rows.length,
      classification_summary: booking.artifact?.classification_summary ?? {},
      report_path: booking.artifact?.report_path ?? "",
      json_path: booking.artifact?.json_path ?? "",
      csv_path: booking.artifact?.csv_path ?? "",
      debug_artifact_path: booking.artifact?.debug_artifact_path ?? "",
      stderr: booking.command.stderr
    };

    const jalan = await runJalanCollection({ runId, generatedAtJst, debugPath, reportPath, csvPath, targets: jalanTargets });
    jalanRows = jalan.rows;
    jalanResult = {
      page_count: jalanRows.length,
      summary: jalan.summary
    };
  }

  const bookingSourceCheck = buildBookingSourceLevelCheck(bookingRows);
  const jalanSourceCheck = buildJalanSourceLevelCheck(jalanRows);
  const appendPlan = buildAppendPlan({
    bookingRows,
    jalanRows,
    existingKeys: readHistoryInventory().keys,
    bookingSourceCheck,
    jalanSourceCheck,
    bookingReportPath: String(bookingResult["report_path"] ?? ""),
    bookingCsvPath: String(bookingResult["csv_path"] ?? "")
  });

  let appendResult: HistoryAppendResult | null = null;
  if (gate.live_mode_authorized && preflightOk && appendPlan.append_allowed && appendPlan.new_row_count > 0) {
    appendResult = appendHistoryRowsAtomic({
      rows: appendPlan.approved_rows,
      historyDir: HISTORY_DIR,
      backupDir: resolve(HISTORY_DIR, ".backup", runId),
      historyBefore: preflight.history_rows
    });
  }

  let dbSyncResult: RunnerOutput["db_sync_result"] = { skipped: true, reason: "no_append_or_not_authorized" };
  let aiContextResult: RunnerOutput["ai_context_result"] = { skipped: true, reason: "db_sync_not_run" };
  const stateAfterAppend = readState();
  if (appendResult !== null || (gate.live_mode_authorized && stateAfterAppend.history_rows !== stateAfterAppend.db_rows)) {
    dbSyncResult = runCommand("npm", ["run", "sync:history-to-db:fresh"], {
      HISTORY_TO_DB_SYNC: "1",
      EXPECTED_HISTORY_ROW_COUNT: String(stateAfterAppend.history_rows)
    });
    if (dbSyncResult.status === 0 && Number(dbSyncResult.parsed["db_after_count"]) === stateAfterAppend.history_rows) {
      aiContextResult = runCommand("npm", ["run", "build:ai-context-packs"]);
    }
  }

  const postState = readState();
  const contextSucceeded = !("skipped" in aiContextResult) && aiContextResult.status === 0;
  const dbSyncSucceeded = !("skipped" in dbSyncResult) && dbSyncResult.status === 0 && postState.db_rows === postState.history_rows;
  const postCountsAligned = postState.history_rows === postState.db_rows && postState.db_rows === postState.ai_context_rows;
  const sourceCaution = !bookingSourceCheck.append_allowed || !jalanSourceCheck.append_allowed || appendPlan.rejected_rows.length > 0;
  const decision = decideMarketRefresh({
    liveMode: gate.live_mode_authorized,
    preflightOk,
    appendConflict: appendPlan.conflict_rows.length > 0 && appendPlan.new_row_count === 0,
    appendAttempted: appendPlan.new_row_count > 0,
    appendSucceeded: appendResult !== null || appendPlan.new_row_count === 0,
    dbSyncSucceeded,
    contextSucceeded,
    postCountsAligned,
    sourceCaution
  });
  const safety = buildSafetyConfirmation({
    liveBooking: gate.live_mode_authorized && bookingRows.length > 0,
    liveJalan: gate.live_mode_authorized && jalanRows.length > 0,
    historyAppended: appendResult !== null,
    dbSynced: dbSyncSucceeded,
    aiContextRefreshed: contextSucceeded
  });

  const output: RunnerOutput & { planner_driven: boolean } = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    planner_driven: plannerDriven,
    gate_result: gate,
    preflight_state: preflight,
    post_run_state: postState,
    booking_plan: bookingPlan,
    jalan_target_matrix: jalanTargets,
    booking_result: bookingResult,
    jalan_result: jalanResult,
    booking_source_check: bookingSourceCheck,
    jalan_source_check: jalanSourceCheck,
    classification_summary: {
      booking: countBy(bookingRows.map((row) => row.classification)),
      jalan: countBy(jalanRows.map((row) => row.dp_usage))
    },
    append_plan: appendPlan,
    append_result: appendResult,
    db_sync_result: dbSyncResult,
    ai_context_result: aiContextResult,
    post_run_validation: {
      post_counts_aligned: postCountsAligned,
      duplicate_row_id_count: postState.duplicate_row_id_count,
      total_page_cap_respected: totalPageCapRespected({ bookingPages: bookingRows.length, jalanPages: jalanRows.length })
    },
    safety_confirmation: safety,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };

  writeJson(resolve(debugPath, "gate_result.json"), gate);
  writeJson(resolve(debugPath, "preflight_state.json"), preflight);
  writeJson(resolve(debugPath, "booking_target_matrix.json"), bookingPlan.selected_targets);
  writeJson(resolve(debugPath, "jalan_target_matrix.json"), jalanTargets);
  writeJson(resolve(debugPath, "booking_preview_rows.json"), bookingRows);
  writeJson(resolve(debugPath, "classification_summary.json"), output.classification_summary);
  writeJson(resolve(debugPath, "approved_append_rows.json"), appendPlan.approved_rows);
  writeJson(resolve(debugPath, "conflict_classification.json"), {
    intraday_price_changes: appendPlan.intraday_rows,
    metadata_only_diffs: appendPlan.metadata_only_diffs,
    basis_or_classification_diffs: appendPlan.basis_or_classification_diffs,
    hard_conflicts: appendPlan.hard_conflicts
  });
  writeJson(resolve(debugPath, "append_result.json"), appendResult);
  writeJson(resolve(debugPath, "db_sync_result.json"), dbSyncResult);
  writeJson(resolve(debugPath, "ai_context_result.json"), aiContextResult);
  writeJson(resolve(debugPath, "post_run_validation.json"), output.post_run_validation);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safety);
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderMarketRefreshCsv(appendPlan.approved_rows), "utf8");
  writeFileSync(
    reportPath,
    renderMarketRefreshReport({
      runId,
      generatedAtJst,
      decision,
      preflight,
      postState,
      bookingSummary: bookingResult,
      jalanSummary: jalanResult,
      appendPlan,
      appendResult,
      dbSyncResult,
      aiContextResult,
      safety,
      reportPath,
      jsonPath,
      csvPath,
      debugPath
    }),
    "utf8"
  );

  return output;
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

run()
  .then((result) => {
    console.log(`decision=${result.decision}`);
    console.log(`planner_driven=${(result as unknown as Record<string,unknown>)["planner_driven"] === true}`);
    console.log(`live_collection_executed=${result.safety_confirmation.live_booking_collection || result.safety_confirmation.live_jalan_collection}`);
    console.log(`booking_pages=${(result.booking_result["page_count"] as number | undefined) ?? 0}`);
    console.log(`jalan_pages=${(result.jalan_result["page_count"] as number | undefined) ?? 0}`);
    console.log(`history_appended=${result.safety_confirmation.history_appended}`);
    console.log(`rows_appended=${result.append_result?.rows_written ?? 0}`);
    console.log(`db_synced=${result.safety_confirmation.db_synced}`);
    console.log(`ai_context_refreshed=${result.safety_confirmation.ai_context_refreshed}`);
    console.log(`history_rows=${result.post_run_state.history_rows}`);
    console.log(`db_rows=${result.post_run_state.db_rows}`);
    console.log(`ai_context_rows=${result.post_run_state.ai_context_rows}`);
    console.log(`pricing_output_generated=${result.safety_confirmation.pricing_csv_generated}`);
    console.log(`pms_output_generated=${result.safety_confirmation.pms_output_generated}`);
    console.log(`report_path=${result.report_path}`);
    console.log(`json_path=${result.json_path}`);
    console.log(`csv_path=${result.csv_path}`);
    console.log(`debug_artifact_path=${result.debug_artifact_path}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
