// Phase AUTO06X — read-only task-specific AI query CLI.
//
// Loads the read-only context packs and DB mirror, executes the selected task
// recipe, and writes a timestamped md/json/csv + debug report. This script NEVER
// writes the DB (it opens with { readonly: true }); NEVER creates tables or runs
// migrations; NEVER runs a collector or live external fetch; NEVER updates
// prices; NEVER mutates .data/ai-context/latest_*.json, the property master, or
// .data/history; NEVER produces Beds24/AirHost/PMS/OTA output; NEVER uses a
// Booking base × 1.1; NEVER enables GitHub Actions/GitOps/cron; NEVER commits/
// pushes; and NEVER uses paid sources.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideAiTaskQuery,
  parseArgs,
  renderTaskCsv,
  renderTaskReport,
  runRecipe,
  type ContextBundle,
  type DictionaryLike,
  type ManifestLike,
  type TaskQueryReport
} from "../services/aiTaskQueryRecipes";
import type {
  AiTaskEntrypoint,
  CaveatsPack,
  DemandContextRow,
  MarketSnapshot,
  MirrorRow,
  PropertySignalRow
} from "../services/aiContextPackGenerator";

const DB_PATH = ".data/zao-market-intelligence.sqlite";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/ai-task-query";
const AI_CONTEXT_DIR = ".data/ai-context";
const MANIFEST_PATH = ".data/reports/market-update/ai_readable_market_manifest_latest.json";
const DICTIONARY_PATH = ".data/reports/market-update/market_data_dictionary_latest.json";

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

function readMirrorRows(db: Database.Database): MirrorRow[] {
  if ((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='market_signal_history'").get()) === undefined) {
    return [];
  }
  const raw = db
    .prepare(
      `SELECT row_id, source, canonical_property_name, source_property_id, source_url,
              checkin_date, checkout_date, stay_scope, availability_status, sold_out_flag,
              normalized_total_jpy, price_basis, basis_confidence, dp_usage, classification,
              exclusion_reason, collected_at_jst
       FROM market_signal_history`
    )
    .all() as Record<string, unknown>[];
  return raw.map((r) => ({
    row_id: String(r["row_id"] ?? ""),
    source: String(r["source"] ?? ""),
    canonical_property_name: String(r["canonical_property_name"] ?? ""),
    source_property_id: String(r["source_property_id"] ?? ""),
    source_url: String(r["source_url"] ?? ""),
    checkin_date: String(r["checkin_date"] ?? ""),
    checkout_date: String(r["checkout_date"] ?? ""),
    stay_scope: String(r["stay_scope"] ?? ""),
    availability_status: String(r["availability_status"] ?? ""),
    sold_out_flag: Number(r["sold_out_flag"] ?? 0),
    normalized_total_jpy: r["normalized_total_jpy"] === null || r["normalized_total_jpy"] === undefined ? null : Number(r["normalized_total_jpy"]),
    price_basis: String(r["price_basis"] ?? ""),
    basis_confidence: String(r["basis_confidence"] ?? ""),
    dp_usage: String(r["dp_usage"] ?? ""),
    classification: String(r["classification"] ?? ""),
    exclusion_reason: String(r["exclusion_reason"] ?? ""),
    collected_at_jst: String(r["collected_at_jst"] ?? "")
  }));
}

function build(): { decision: string; reportPath: string; jsonPath: string; csvPath: string; debugRootPath: string } {
  const { task, inputs } = parseArgs(process.argv.slice(2));

  // ---- Load read-only context packs ----
  const snapshot = readJson<MarketSnapshot>(`${AI_CONTEXT_DIR}/latest_market_snapshot.json`);
  const demandPack = readJson<{ rows: DemandContextRow[] }>(`${AI_CONTEXT_DIR}/latest_demand_context.json`);
  const propertyPack = readJson<{ rows: PropertySignalRow[] }>(`${AI_CONTEXT_DIR}/latest_property_signal_context.json`);
  const caveats = readJson<CaveatsPack>(`${AI_CONTEXT_DIR}/latest_caveats_and_guardrails.json`);
  const entrypoint = readJson<AiTaskEntrypoint>(`${AI_CONTEXT_DIR}/latest_ai_task_entrypoint.json`);
  const manifest = readJsonOrNull<ManifestLike>(MANIFEST_PATH);
  const dictionary = readJsonOrNull<DictionaryLike>(DICTIONARY_PATH);

  // ---- DB mirror (read-only) ----
  const db = new Database(DB_PATH, { readonly: true });
  let mirrorRows: MirrorRow[];
  try {
    mirrorRows = readMirrorRows(db);
  } finally {
    db.close();
  }

  const bundle: ContextBundle = {
    snapshot,
    demandRows: demandPack.rows,
    propertyRows: propertyPack.rows,
    caveats,
    entrypoint,
    manifest,
    dictionary,
    mirrorRows
  };

  const result = runRecipe(task, bundle, inputs);

  const decision = decideAiTaskQuery({
    historyRowCount: snapshot.market_signal_history_row_count,
    directRowCount: snapshot.direct_row_count,
    directionalRowCount: snapshot.directional_row_count,
    bConfidenceCount: snapshot.basis_confidence_counts["B"] ?? 0,
    distinctSourceCount: Object.keys(snapshot.source_counts).length,
    propertyCount: snapshot.property_count
  });

  // ---- Output paths ----
  const ts = timestamp();
  const runId = `ai_task_query_${ts}`;
  const generatedAtJst = jstIso();
  const debugRootPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  mkdirSync(debugRootPath, { recursive: true });

  const reportPath = resolve(REPORT_DIR, `${runId}.md`);
  const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
  const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

  const report: TaskQueryReport = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    task,
    inputs,
    data_sources_used: result.data_sources_used,
    result: result.result,
    caveats: result.caveats,
    forbidden_actions: result.forbidden_actions,
    safety_confirmation: {
      dbOpenedReadOnly: true,
      dbWrites: false,
      tablesCreated: false,
      migrationsExecuted: false,
      collectorReRun: false,
      liveExternalFetch: false,
      pricesUpdated: false,
      aiContextLatestMutated: false,
      propertyMasterModified: false,
      dataHistoryModified: false,
      pmsOutput: false,
      beds24Output: false,
      airhostOutput: false,
      otaUpload: false,
      bookingBaseTimes1_1: false,
      githubActionsOrGitOps: false,
      cronActivated: false,
      versionControlCommitsOrPushes: false,
      paidSources: false,
      startedDp03x: false,
      startedR01x: false
    },
    decision
  };

  writeFileSync(jsonPath, JSON.stringify({ ...report }, null, 2), "utf8");
  writeFileSync(csvPath, renderTaskCsv(result), "utf8");
  writeFileSync(reportPath, renderTaskReport(report), "utf8");

  // ---- Debug ----
  const writeDebug = (name: string, data: unknown): void => {
    writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
  };
  writeDebug("parsed_args.json", { task, inputs });
  writeDebug("data_sources_used.json", result.data_sources_used);
  writeDebug("result.json", result.result);
  writeDebug("decision.json", { decision });
  writeDebug("safety_confirmation.json", report.safety_confirmation);

  return { decision, reportPath, jsonPath, csvPath, debugRootPath };
}

try {
  const out = build();
  console.log(`decision=${out.decision}`);
  console.log(`report_path=${out.reportPath}`);
  console.log(`json_path=${out.jsonPath}`);
  console.log(`csv_path=${out.csvPath}`);
  console.log(`debug_root=${out.debugRootPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
