// Phase AUTO05X — build AI-readable context packs from the DB mirror.
//
// Reads the DB mirror (market_signal_history + market_signal_sync_runs) STRICTLY
// READ-ONLY and emits 5 AI-facing JSON context packs plus md/csv/json + debug
// reports. This script NEVER writes the DB; NEVER creates tables or runs
// migrations; NEVER runs a collector or live external fetch; NEVER touches
// .data/history or the property master; NEVER produces Beds24/AirHost/PMS/OTA
// output; NEVER updates prices; NEVER uses a Booking base × 1.1; NEVER enables
// GitHub Actions/GitOps/cron; NEVER commits/pushes; and NEVER uses paid sources.
// The DB connection is opened with { readonly: true } so writes are impossible.

import Database from "better-sqlite3";
import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONTEXT_PACK_FILES,
  buildAiTaskEntrypoint,
  buildCaveats,
  buildDemandContext,
  buildMarketSnapshot,
  buildPropertySignalContext,
  countBy,
  decideAiContextPacks,
  renderContextPackReport,
  renderDemandContextCsv,
  signalLevelCounts,
  type ContextPackReport,
  type MirrorRow
} from "../services/aiContextPackGenerator";

const DB_PATH = ".data/zao-market-intelligence.sqlite";
const REPORT_DIR = ".data/reports/automation";
const AI_CONTEXT_DIR = ".data/ai-context";
const DEBUG_ROOT = ".data/debug/ai-context-packs";
const HISTORY_DIR = ".data/history";
const PROPERTY_MASTER = ".data/exports/zao-universe-review/zao_universe_properties_20260531_231933.csv";

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

interface SqliteMasterRow {
  name: string;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as SqliteMasterRow | undefined;
  return row !== undefined;
}

function writeNotReadyReport(reason: string): { reportPath: string; jsonPath: string } {
  const ts = timestamp();
  mkdirSync(resolve(REPORT_DIR), { recursive: true });
  const reportPath = resolve(REPORT_DIR, `ai_context_packs_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `ai_context_packs_${ts}.json`);
  const body = {
    run_id: `ai_context_packs_${ts}`,
    generated_at_jst: jstIso(),
    decision: "ai_context_packs_not_ready" as const,
    reason
  };
  writeFileSync(jsonPath, JSON.stringify(body, null, 2), "utf8");
  writeFileSync(
    reportPath,
    [
      "# AI Context Packs from DB Mirror",
      "",
      `Generated at: ${body.generated_at_jst}`,
      `Decision: ${body.decision}`,
      "",
      "## 1. Executive Summary",
      "",
      `- decision=${body.decision}`,
      `- reason=${reason}`,
      "- No context packs were generated because the DB mirror is empty or missing.",
      ""
    ].join("\n"),
    "utf8"
  );
  return { reportPath, jsonPath };
}

function readMirrorRows(db: Database.Database): MirrorRow[] {
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

function mtimeOrNull(path: string): string | null {
  try {
    return existsSync(path) ? statSync(path).mtime.toISOString() : null;
  } catch {
    return null;
  }
}

function build(): { decision: string; reportPath: string } {
  if (!existsSync(DB_PATH)) {
    const { reportPath } = writeNotReadyReport(`DB not found at ${DB_PATH}`);
    return { decision: "ai_context_packs_not_ready", reportPath };
  }

  const db = new Database(DB_PATH, { readonly: true });
  try {
    if (!tableExists(db, "market_signal_history")) {
      const { reportPath } = writeNotReadyReport("market_signal_history table does not exist");
      return { decision: "ai_context_packs_not_ready", reportPath };
    }

    const rows = readMirrorRows(db);
    const syncRunCount = tableExists(db, "market_signal_sync_runs")
      ? Number((db.prepare("SELECT COUNT(*) AS c FROM market_signal_sync_runs").get() as { c: number }).c)
      : 0;

    if (rows.length === 0 || syncRunCount === 0) {
      const { reportPath } = writeNotReadyReport(
        `DB mirror is empty (history_rows=${rows.length}, sync_runs=${syncRunCount})`
      );
      return { decision: "ai_context_packs_not_ready", reportPath };
    }

    // Snapshot the property-master and history mtimes BEFORE generation so the
    // safety report can confirm we did not touch them.
    const historyMtimeBefore = mtimeOrNull(HISTORY_DIR);
    const masterMtimeBefore = mtimeOrNull(PROPERTY_MASTER);

    const ts = timestamp();
    const runId = `ai_context_packs_${ts}`;
    const generatedAtJst = jstIso();
    const debugRootPath = resolve(DEBUG_ROOT, ts);

    // ---- Build the 5 context packs (pure) ----
    const snapshot = buildMarketSnapshot(rows, { generatedAtJst, syncRunCount });
    const demandContext = buildDemandContext(rows);
    const propertySignalContext = buildPropertySignalContext(rows);
    const caveats = buildCaveats(generatedAtJst);
    const entrypoint = buildAiTaskEntrypoint(generatedAtJst);

    const directRowCount = rows.filter((r) => r.dp_usage === "direct").length;
    const directionalRowCount = rows.filter((r) => r.dp_usage === "directional").length;
    const excludedRowCount = rows.filter((r) => r.dp_usage === "excluded").length;
    const bConfidenceCount = rows.filter((r) => r.basis_confidence === "B").length;
    const distinctSourceCount = new Set(rows.map((r) => r.source)).size;
    const propertyCount = new Set(rows.map((r) => r.canonical_property_name)).size;

    const decision = decideAiContextPacks({
      historyRowCount: rows.length,
      syncRunCount,
      directRowCount,
      directionalRowCount,
      excludedRowCount,
      bConfidenceCount,
      distinctSourceCount,
      propertyCount
    });

    // ---- Write the 5 latest_*.json context packs as REAL files ----
    mkdirSync(resolve(AI_CONTEXT_DIR), { recursive: true });
    const packPayloads: Array<[string, unknown]> = [
      [CONTEXT_PACK_FILES.marketSnapshot, snapshot],
      [CONTEXT_PACK_FILES.demandContext, { generated_at_jst: generatedAtJst, rows: demandContext }],
      [CONTEXT_PACK_FILES.propertySignalContext, { generated_at_jst: generatedAtJst, rows: propertySignalContext }],
      [CONTEXT_PACK_FILES.caveats, caveats],
      [CONTEXT_PACK_FILES.aiTaskEntrypoint, entrypoint]
    ];
    for (const [path, payload] of packPayloads) {
      writeFileSync(resolve(path), JSON.stringify(payload, null, 2), "utf8");
    }

    // ---- Assert the 5 latest files are REAL files (never symlinks) ----
    const symlinkOffenders: string[] = [];
    for (const [path] of packPayloads) {
      if (lstatSync(resolve(path)).isSymbolicLink()) symlinkOffenders.push(path);
    }
    if (symlinkOffenders.length > 0) {
      throw new Error(`Context pack written as symlink (forbidden): ${symlinkOffenders.join(", ")}`);
    }

    // ---- Reports (md/json/csv) ----
    mkdirSync(resolve(REPORT_DIR), { recursive: true });
    mkdirSync(debugRootPath, { recursive: true });
    const reportPath = resolve(REPORT_DIR, `${runId}.md`);
    const jsonPath = resolve(REPORT_DIR, `${runId}.json`);
    const csvPath = resolve(REPORT_DIR, `${runId}.csv`);

    const historyMtimeAfter = mtimeOrNull(HISTORY_DIR);
    const masterMtimeAfter = mtimeOrNull(PROPERTY_MASTER);

    const report: ContextPackReport = {
      run_id: runId,
      generated_at_jst: generatedAtJst,
      decision,
      db_mirror_summary: {
        market_signal_history_row_count: rows.length,
        market_signal_sync_runs_count: syncRunCount,
        source_counts: countBy(rows, (r) => r.source),
        dp_usage_counts: countBy(rows, (r) => r.dp_usage),
        basis_confidence_counts: countBy(rows, (r) => r.basis_confidence)
      },
      context_pack_paths: packPayloads.map(([p]) => p),
      market_snapshot_summary: snapshot,
      demand_context_summary: { row_count: demandContext.length, signal_level_counts: signalLevelCounts(demandContext) },
      property_signal_context_summary: { row_count: propertySignalContext.length },
      caveats_summary: { caveat_count: caveats.caveats.length, guardrail_count: caveats.guardrails.length },
      ai_task_entrypoint_summary: { task_route_count: Object.keys(entrypoint.task_routes).length },
      safety_confirmation: {
        dbOpenedReadOnly: true,
        dbWrites: false,
        tablesCreated: false,
        migrationsExecuted: false,
        collectorReRun: false,
        liveExternalFetch: false,
        propertyMasterModified: masterMtimeBefore === masterMtimeAfter ? false : true,
        dataHistoryModified: historyMtimeBefore === historyMtimeAfter ? false : true,
        priceUpdate: false,
        pmsOutput: false,
        beds24Output: false,
        airhostOutput: false,
        otaUpload: false,
        bookingBaseTimes1_1: false,
        contextPacksAreRealFiles: symlinkOffenders.length === 0,
        githubActionsOrGitOps: false,
        cronActivated: false,
        versionControlCommitsOrPushes: false,
        paidSources: false,
        startedDp03x: false,
        startedR01x: false
      },
      report_path: reportPath,
      json_path: jsonPath,
      csv_path: csvPath,
      debug_artifact_path: debugRootPath,
      next_phase: "AUTO06X — Task-specific AI query recipes / CLI (do not start without explicit instruction)"
    };

    writeFileSync(csvPath, renderDemandContextCsv(demandContext), "utf8");
    writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
    writeFileSync(reportPath, renderContextPackReport(report, caveats, entrypoint), "utf8");

    // ---- Debug artifacts ----
    const writeDebug = (name: string, data: unknown): void => {
      writeFileSync(resolve(debugRootPath, name), JSON.stringify(data, null, 2), "utf8");
    };
    writeDebug("db_mirror_summary.json", report.db_mirror_summary);
    writeDebug("market_snapshot.json", snapshot);
    writeDebug("demand_context.json", demandContext);
    writeDebug("property_signal_context.json", propertySignalContext);
    writeDebug("caveats_and_guardrails.json", caveats);
    writeDebug("ai_task_entrypoint.json", entrypoint);
    writeDebug("decision_inputs.json", {
      historyRowCount: rows.length,
      syncRunCount,
      directRowCount,
      directionalRowCount,
      excludedRowCount,
      bConfidenceCount,
      distinctSourceCount,
      propertyCount,
      decision
    });
    writeDebug("manifest_and_dictionary_presence.json", {
      manifest_present: existsSync(resolve(".data/reports/market-update/ai_readable_market_manifest_latest.json")),
      dictionary_present: existsSync(resolve(".data/reports/market-update/market_data_dictionary_latest.json"))
    });
    writeDebug("safety_confirmation.json", report.safety_confirmation);

    return { decision, reportPath };
  } finally {
    db.close();
  }
}

try {
  const result = build();
  console.log(`decision=${result.decision}`);
  console.log(`report_path=${result.reportPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
