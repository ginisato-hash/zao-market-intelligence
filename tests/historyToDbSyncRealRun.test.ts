import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openLocalDatabase, type LocalDatabase } from "../src/db/client";
import {
  APPROVED_TARGET_TABLES,
  applyRealSync,
  buildSuccessReport,
  ensureMirrorSchema,
  evaluateApprovalGate,
  preflightSyncActions,
  readCollectorBaseline,
  renderHistoryToDbSyncRealRunReport,
  schemaStatements,
  validatePostSync,
  type DryRunSourceSummary
} from "../src/services/historyToDbSyncRealRun";
import type { MarketSignalHistoryDryRunRow } from "../src/services/historyToDbSyncDryRun";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/historyToDbSyncRealRun.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runHistoryToDbSyncRealRun.ts"), "utf8");

let db: LocalDatabase | undefined;

afterEach(() => {
  if (db !== undefined) {
    closeDatabase(db);
    db = undefined;
  }
});

function openTempDb(): LocalDatabase {
  return openLocalDatabase(join(mkdtempSync(join(tmpdir(), "zao-auto04x-")), "test.sqlite"));
}

const DRY_RUN: DryRunSourceSummary = {
  decision: "history_to_db_sync_dry_run_ready",
  // JALAN-AUTO05B: pinned to 210 to match APPROVED_MAPPED_ROW_COUNT after the
  // 25-row Jalan AUTO05X history append (185 -> 210).
  mapped_row_count: 210,
  dedupe_summary: {
    would_insert_rows: 210,
    would_skip_identical_rows: 0,
    would_conflict_rows: 0
  }
};

function row(id = "row_1", hash = "hash_1", source = "rakuten"): MarketSignalHistoryDryRunRow {
  return {
    row_id: id,
    row_hash: hash,
    shard_month: "2026_06",
    collected_date_jst: "2026-06-01",
    collected_at_jst: "2026-06-01T20:00:00+09:00",
    normalized_at_jst: "2026-06-01T20:10:00+09:00",
    source,
    canonical_property_name: "蔵王国際ホテル",
    source_property_id: source === "booking" ? "zao-kokusai" : "5723",
    source_url: "",
    checkin_date: "2026-06-03",
    checkout_date: "2026-06-04",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available",
    sold_out_flag: 0,
    normalized_total_jpy: 64790,
    price_basis: "per_person_tax_included_times_2",
    basis_confidence: source === "booking" ? "A" : "B",
    dp_usage: source === "booking" ? "direct" : "directional",
    classification: "available_price",
    exclusion_reason: "",
    debug_artifact_path: ".data/debug/example",
    schema_version: "history_v1",
    raw_json: JSON.stringify({ row_id: id, row_hash: hash, source }),
    created_at: "2026-06-03T22:20:00+09:00",
    updated_at: "2026-06-03T22:20:00+09:00"
  };
}

function gate(overrides: Partial<Parameters<typeof evaluateApprovalGate>[0]> = {}) {
  return evaluateApprovalGate({
    explicitUserApproved: true,
    envFlag: "1",
    dryRun: DRY_RUN,
    targetTables: [...APPROVED_TARGET_TABLES],
    collectorTableWriteMode: false,
    liveCollectorMode: false,
    githubActionsMode: false,
    ...overrides
  });
}

describe("AUTO04X approval gate", () => {
  it("approval gate is false without env flag", () => {
    const result = gate({ envFlag: undefined });
    expect(result.passed).toBe(false);
    expect(result.decision).toBe("history_to_db_sync_ready_not_run");
  });

  it("approval gate is true only with explicit approval and env flag", () => {
    expect(gate().passed).toBe(true);
    expect(gate({ explicitUserApproved: false }).passed).toBe(false);
  });

  it("gate requires AUTO03X dry-run ready", () => {
    expect(gate({ dryRun: { ...DRY_RUN, decision: "history_to_db_sync_dry_run_not_ready" } }).passed).toBe(false);
  });

  it("gate requires zero dry-run conflicts", () => {
    expect(gate({ dryRun: { ...DRY_RUN, dedupe_summary: { ...DRY_RUN.dedupe_summary, would_conflict_rows: 1 } } }).passed).toBe(false);
  });

  it("gate blocks unexpected target tables", () => {
    const result = gate({ targetTables: ["market_signal_history", "collector_runs"] });
    expect(result.passed).toBe(false);
    expect(result.reasons.join("\n")).toContain("unexpected target tables");
  });
});

describe("AUTO04X DB mirror sync", () => {
  it("schema SQL only includes market_signal_history and market_signal_sync_runs", () => {
    const sql = schemaStatements().join("\n");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS market_signal_history");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS market_signal_sync_runs");
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS (collector_runs|rate_snapshots|inventory_snapshots|collection_job_attempts)/u);
  });

  it("has no collector table writes", () => {
    expect(SERVICE_SOURCE).not.toMatch(/INSERT\s+INTO\s+(collector_runs|rate_snapshots|inventory_snapshots|collection_job_attempts)/iu);
  });

  it("preflight detects same row_id/same hash as skip", () => {
    db = openTempDb();
    ensureMirrorSchema(db);
    applyRealSync(baseRun([row()]));
    const preflight = preflightSyncActions("run_2", db, [row()]);
    expect(preflight.actions[0]!.action).toBe("would_skip_identical");
  });

  it("preflight detects same row_id/different hash as conflict", () => {
    db = openTempDb();
    ensureMirrorSchema(db);
    applyRealSync(baseRun([row("row_1", "hash_a")]));
    const preflight = preflightSyncActions("run_2", db, [row("row_1", "hash_b")]);
    expect(preflight.actions[0]!.action).toBe("would_conflict_block");
  });

  it("conflict blocks inserts", () => {
    db = openTempDb();
    ensureMirrorSchema(db);
    applyRealSync(baseRun([row("row_1", "hash_a")]));
    const result = applyRealSync(baseRun([row("row_1", "hash_b")], "run_conflict"));
    expect(result.conflict_rows).toBe(1);
    expect(count("market_signal_history")).toBe(1);
  });

  it("first run inserts new rows", () => {
    db = openTempDb();
    ensureMirrorSchema(db);
    const result = applyRealSync(baseRun([row("row_1"), row("row_2", "hash_2", "booking")]));
    expect(result.inserted_rows).toBe(2);
    expect(count("market_signal_history")).toBe(2);
  });

  it("idempotent second run skips identical rows", () => {
    db = openTempDb();
    ensureMirrorSchema(db);
    const rows = [row("row_1"), row("row_2", "hash_2", "booking")];
    applyRealSync(baseRun(rows, "run_1"));
    const second = applyRealSync(baseRun(rows, "run_2"));
    expect(second.inserted_rows).toBe(0);
    expect(second.skipped_identical_rows).toBe(2);
    expect(count("market_signal_history")).toBe(2);
  });

  it("sync run record is generated", () => {
    db = openTempDb();
    ensureMirrorSchema(db);
    const result = applyRealSync(baseRun([row()]));
    expect(result.sync_run_record.sync_run_id).toBe("run_1");
    expect(count("market_signal_sync_runs")).toBe(1);
  });

  it("post-sync validation checks row count and row_hash equality", () => {
    db = openTempDb();
    ensureMirrorSchema(db);
    const rows = [row("row_1"), row("row_2", "hash_2", "booking")];
    const baseline = readCollectorBaseline(db);
    const result = applyRealSync(baseRun(rows));
    const validation = validatePostSync({
      db,
      sourceRows: rows,
      syncRunId: result.sync_run_record.sync_run_id,
      collectorBaselineBefore: baseline,
      historyMtimesUnchanged: true
    });
    expect(validation.market_signal_history_count).toBe(2);
    expect(validation.all_row_hashes_match).toBe(true);
    expect(validation.passed).toBe(true);
  });

  it("post-sync validation checks source, dp_usage, and basis_confidence counts", () => {
    db = openTempDb();
    ensureMirrorSchema(db);
    const rows = [row("row_1"), row("row_2", "hash_2", "booking")];
    const baseline = readCollectorBaseline(db);
    const result = applyRealSync(baseRun(rows));
    const validation = validatePostSync({
      db,
      sourceRows: rows,
      syncRunId: result.sync_run_record.sync_run_id,
      collectorBaselineBefore: baseline,
      historyMtimesUnchanged: true
    });
    expect(validation.source_counts).toEqual({ booking: 1, rakuten: 1 });
    expect(validation.dp_usage_counts).toEqual({ direct: 1, directional: 1 });
    expect(validation.basis_confidence_counts).toEqual({ A: 1, B: 1 });
  });

  it("collector baseline remains unchanged", () => {
    db = openTempDb();
    ensureMirrorSchema(db);
    const before = readCollectorBaseline(db);
    const result = applyRealSync(baseRun([row()]));
    const validation = validatePostSync({
      db,
      sourceRows: [row()],
      syncRunId: result.sync_run_record.sync_run_id,
      collectorBaselineBefore: before,
      historyMtimesUnchanged: true
    });
    expect(validation.collector_baseline_unchanged).toBe(true);
  });

  it(".data/history is not modified", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/(writeFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/history/u);
  });

  it("has no live collector code", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/collect:Jalan|runJalan|Playwright|chromium|fetch\(/u);
  });

  it("has no GitHub Actions/GitOps activation code", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\.github\/workflows|git\s+commit|git\s+push|workflow_dispatch|schedule:/u);
    }
  });

  it("has no PMS/Beds24/AirHost output code", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/Beds24|AirHost|PMS upload|OTA upload/u);
    }
  });

  it("has no paid-source tooling", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs|paid proxy/i);
    }
  });

  it("decision success on valid run", () => {
    db = openTempDb();
    const schema = ensureMirrorSchema(db);
    const rows = [row()];
    const baseline = readCollectorBaseline(db);
    const sync = applyRealSync(baseRun(rows));
    const validation = validatePostSync({
      db,
      sourceRows: rows,
      syncRunId: sync.sync_run_record.sync_run_id,
      collectorBaselineBefore: baseline,
      historyMtimesUnchanged: true
    });
    const report = buildSuccessReport({
      runId: "run_report",
      generatedAtJst: "2026-06-03T22:20:00+09:00",
      gate: gate(),
      sourceArtifact: "auto03.json",
      schemaPreflight: schema,
      syncResult: sync,
      postSyncValidation: validation,
      reportPath: "r.md",
      jsonPath: "r.json",
      csvPath: "r.csv",
      debugPath: "debug"
    });
    expect(report.decision).toBe("history_to_db_sync_success");
    expect(renderHistoryToDbSyncRealRunReport(report)).toContain("# History-to-DB Sync Real Run");
  });
});

function baseRun(rows: MarketSignalHistoryDryRunRow[], runId = "run_1") {
  if (db === undefined) throw new Error("db not open");
  return {
    db,
    runId,
    generatedAtJst: "2026-06-03T22:20:00+09:00",
    reportPath: "r.md",
    sourceHistoryFiles: [".data/history/zao_signals_2026_06.csv"],
    rows
  };
}

function count(table: string): number {
  if (db === undefined) throw new Error("db not open");
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
