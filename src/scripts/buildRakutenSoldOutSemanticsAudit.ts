// Phase AUTO08X-FIX01 — build Rakuten sold-out semantics audit.
//
// Audit/proposal only. Reads local history shards, DB mirror evidence in
// read-only mode, and existing AI context artifacts. Writes report/debug
// artifacts only. It never mutates .data/history, never writes DB rows, never
// runs a DB sync, never refreshes AI context, never runs collectors, never uses
// Playwright, and never fetches live pages.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvTable } from "../services/historyToDbSyncDryRun";
import {
  AUTO08X_DEBUG_MARKER,
  AUTO08X_REPORT_MARKER,
  buildRakutenSoldOutSemanticsAudit,
  renderRakutenSoldOutSemanticsAuditCsv,
  renderRakutenSoldOutSemanticsAuditMarkdown,
  type HistoryRowLike
} from "../services/rakutenSoldOutSemanticsAudit";

const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/rakuten-sold-out-semantics-audit";
const HISTORY_DIR = ".data/history";
const DB_PATH = ".data/zao-market-intelligence.sqlite";
const BEFORE_CONTEXT_REPORT = ".data/reports/automation/ai_context_packs_20260604_100306.json";
const AFTER_CONTEXT_REPORT = ".data/reports/automation/ai_context_packs_20260604_100452.json";
const LATEST_MARKET_SNAPSHOT = ".data/ai-context/latest_market_snapshot.json";
const LATEST_DEMAND_CONTEXT = ".data/ai-context/latest_demand_context.json";
const AUTO08X_REPORT = ".data/reports/automation/auto_history_append_20260604_094714.json";
const AUTO08X_COLLECTION_RESULT = ".data/debug/auto-history-append/20260604_094714/collection_result.json";
const AUTO08X_REQUEST_5723 = ".data/debug/auto-history-append/20260604_094714/request_5723_20260601.json";
const AUTO08X_REQUEST_39565 = ".data/debug/auto-history-append/20260604_094714/request_39565_20260601.json";

interface ContextPackReportLike {
  market_snapshot_summary?: {
    sold_out_row_count?: number;
    market_signal_history_row_count?: number;
  };
}

interface LatestMarketSnapshotLike {
  sold_out_row_count?: number;
  market_signal_history_row_count?: number;
}

interface LatestDemandContextLike {
  rows?: { sold_out_count?: number; row_count?: number; checkin_date?: string }[];
}

interface DbEvidenceRow {
  row_id?: string;
  row_hash?: string;
  source?: string;
  canonical_property_name?: string;
  source_property_id?: string;
  source_url?: string;
  checkin_date?: string;
  availability_status?: string;
  classification?: string;
  dp_usage?: string;
  debug_artifact_path?: string;
  raw_json?: string;
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

function readJsonOrNull<T>(path: string): T | null {
  return existsSync(resolve(path)) ? readJson<T>(path) : null;
}

function loadHistoryRows(): HistoryRowLike[] {
  const files = readdirSync(resolve(HISTORY_DIR))
    .filter((name) => /^zao_signals_\d{4}_\d{2}\.csv$/.test(name))
    .sort()
    .map((name) => `${HISTORY_DIR}/${name}`);
  const rows: HistoryRowLike[] = [];
  for (const file of files) {
    const table = parseCsvTable(readFileSync(resolve(file), "utf8"));
    for (const row of table.rows) rows.push({ ...row, __source_file: file });
  }
  return rows;
}

function loadDbEvidenceRows(): HistoryRowLike[] {
  if (!existsSync(resolve(DB_PATH))) return [];
  const db = new Database(resolve(DB_PATH), { readonly: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='market_signal_history'")
      .get() as { name: string } | undefined;
    if (table === undefined) return [];
    const rows = db
      .prepare(
        `SELECT row_id, row_hash, source, canonical_property_name, source_property_id, source_url,
                checkin_date, availability_status, classification, dp_usage, debug_artifact_path, raw_json
         FROM market_signal_history
         WHERE source = 'rakuten'
           AND classification = 'rakuten_day_sold_out'
           AND (
             raw_json LIKE '%AUTO08X%'
             OR raw_json LIKE ?
             OR raw_json LIKE ?
             OR debug_artifact_path LIKE '%auto-history-append/20260604_094714%'
           )`
      )
      .all(`%${AUTO08X_DEBUG_MARKER}%`, `%${AUTO08X_REPORT_MARKER}%`) as DbEvidenceRow[];
    return rows.map((row) => ({
      row_id: row.row_id ?? "",
      row_hash: row.row_hash ?? "",
      source: row.source ?? "",
      canonical_property_name: row.canonical_property_name ?? "",
      source_property_id: row.source_property_id ?? "",
      source_url: row.source_url ?? "",
      checkin_date: row.checkin_date ?? "",
      availability_status: row.availability_status ?? "",
      classification: row.classification ?? "",
      dp_usage: row.dp_usage ?? "",
      debug_artifact_path: row.debug_artifact_path ?? "",
      raw_json: row.raw_json ?? ""
    }));
  } finally {
    db.close();
  }
}

function soldOutCountFromReport(path: string): number {
  const json = readJsonOrNull<ContextPackReportLike>(path);
  return json?.market_snapshot_summary?.sold_out_row_count ?? 0;
}

function latestSoldOutCount(): number {
  const latest = readJsonOrNull<LatestMarketSnapshotLike>(LATEST_MARKET_SNAPSHOT);
  const after = readJsonOrNull<ContextPackReportLike>(AFTER_CONTEXT_REPORT);
  return latest?.sold_out_row_count ?? after?.market_snapshot_summary?.sold_out_row_count ?? 0;
}

function latestDemandRows(): { sold_out_count?: number; row_count?: number; checkin_date?: string }[] {
  return readJsonOrNull<LatestDemandContextLike>(LATEST_DEMAND_CONTEXT)?.rows ?? [];
}

function extractSnippet(path: string, pattern: string, context = 2): string {
  if (!existsSync(resolve(path))) return `${path}: missing`;
  const lines = readFileSync(resolve(path), "utf8").split(/\r?\n/u);
  const index = lines.findIndex((line) => line.includes(pattern));
  if (index < 0) return `${path}: pattern not found: ${pattern}`;
  const start = Math.max(0, index - context);
  const end = Math.min(lines.length, index + context + 1);
  return `${path}:${index + 1}\n${lines.slice(start, end).join("\n")}`;
}

function buildCodeSnippets(): string[] {
  return [
    extractSnippet("src/scripts/runAutoHistoryAppendRealRun.ts", "buildHplanCalendarUrl({"),
    extractSnippet("src/services/autoHistoryAppendRealRun.ts", "sourceClassification = priced"),
    extractSnippet("src/services/autoHistoryAppendRealRun.ts", "warningFlags = priced"),
    extractSnippet("src/services/autoHistoryAppendRealRun.ts", "AUTO_HISTORY_APPEND_TARGETS")
  ];
}

function inspectInput(path: string): { path: string; exists: boolean; bytes: number } {
  const full = resolve(path);
  if (!existsSync(full)) return { path, exists: false, bytes: 0 };
  const stat = statSync(full);
  if (stat.isDirectory()) return { path, exists: true, bytes: 0 };
  return { path, exists: true, bytes: readFileSync(full, "utf8").length };
}

function main(): void {
  const ts = timestamp();
  const runId = `rakuten_sold_out_semantics_audit_${ts}`;
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const reportPath = resolve(reportDir, `${runId}.md`);
  const jsonPath = resolve(reportDir, `${runId}.json`);
  const csvPath = resolve(reportDir, `${runId}.csv`);

  const historyRows = loadHistoryRows();
  const dbRows = loadDbEvidenceRows();
  const audit = buildRakutenSoldOutSemanticsAudit({
    runId,
    generatedAtJst: jstIso(),
    historyRows,
    dbRows,
    beforeSoldOutRowCount: soldOutCountFromReport(BEFORE_CONTEXT_REPORT),
    latestSoldOutRowCount: latestSoldOutCount(),
    latestDemandRows: latestDemandRows(),
    codeSnippets: buildCodeSnippets()
  });

  writeFileSync(reportPath, renderRakutenSoldOutSemanticsAuditMarkdown(audit), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderRakutenSoldOutSemanticsAuditCsv(audit), "utf8");

  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugPath, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  writeDebug("affected_rows_history.json", audit.affected_history_rows);
  writeDebug("affected_rows_db.json", audit.affected_db_rows);
  writeDebug("affected_rows_context.json", audit.affected_context);
  writeDebug("contradiction_evidence.json", {
    user_provided_evidence: audit.contradiction_evidence,
    auto08x_report: inspectInput(AUTO08X_REPORT),
    auto08x_collection_result: inspectInput(AUTO08X_COLLECTION_RESULT),
    request_5723: inspectInput(AUTO08X_REQUEST_5723),
    request_39565: inspectInput(AUTO08X_REQUEST_39565)
  });
  writeDebug("code_path_audit.json", audit.code_path_audit);
  writeDebug("quarantine_options.json", audit.quarantine_options);
  writeDebug("recommended_fix_plan.json", audit.recommended_fix_plan);
  writeDebug("collector_fix_proposal.json", audit.collector_fix_proposal);
  writeDebug("safety_confirmation.json", {
    ...audit.safety_confirmation,
    dbOpenedReadOnly: true,
    reportPath,
    jsonPath,
    csvPath
  });
  writeDebug("source_artifacts_used.json", {
    history_dir: inspectInput(HISTORY_DIR),
    db_path: inspectInput(DB_PATH),
    before_context_report: inspectInput(BEFORE_CONTEXT_REPORT),
    after_context_report: inspectInput(AFTER_CONTEXT_REPORT),
    latest_market_snapshot: inspectInput(LATEST_MARKET_SNAPSHOT),
    latest_demand_context: inspectInput(LATEST_DEMAND_CONTEXT),
    auto08x_report: inspectInput(AUTO08X_REPORT),
    auto08x_collection_result: inspectInput(AUTO08X_COLLECTION_RESULT)
  });

  console.log(`decision=${audit.decision}`);
  console.log(`affected_history_rows=${audit.affected_history_rows.count}`);
  console.log(`affected_db_rows=${audit.affected_db_rows.count}`);
  console.log(`context_sold_out_delta=${audit.affected_context.delta_sold_out_row_count}`);
  console.log(`semantics_classification=${audit.semantics_classification}`);
  console.log(`report_path=${reportPath}`);
  console.log(`json_path=${jsonPath}`);
  console.log(`csv_path=${csvPath}`);
  console.log(`debug_artifact_path=${debugPath}`);
}

main();
