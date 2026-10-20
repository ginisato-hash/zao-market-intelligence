import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { closeDatabase, openLocalDatabase } from "../src/db/client";
import { applyRealSync, ensureMirrorSchema } from "../src/services/historyToDbSyncRealRun";
import {
  evaluateFreshSyncGate,
  evaluateMirrorInvariants,
  isVerifiedSyncOutput,
  runFreshHistoryToDbSync,
  SYNC_PERMIT_MAX_ROWS,
  verifyAppendReceipt,
  writeAppendReceipt,
  type FreshHistoryToDbSyncDecision,
  type FreshHistoryToDbSyncReport
} from "../src/services/freshHistoryToDbSync";
import type { MarketSignalHistoryDryRunRow } from "../src/services/historyToDbSyncDryRun";
import { appendHistoryRowsAtomic, buildAppendReceipt, type AppendReceipt } from "../src/services/autoRunnerMarketRefresh";
import type { HistoryRow } from "../src/services/localHistorySchemaDesign";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/freshHistoryToDbSync.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/syncHistoryToDbFresh.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const VALID_DECISIONS: FreshHistoryToDbSyncDecision[] = [
  "fresh_history_to_db_sync_ready_not_run",
  "fresh_history_to_db_sync_success",
  "fresh_history_to_db_sync_noop",
  "fresh_history_to_db_sync_not_ready",
  "fresh_history_to_db_sync_failed",
  "fresh_history_to_db_sync_conflict"
];
let runSequence = 0;

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "fresh-db-sync-"));
}

// Mimics appendHistoryRowsAtomic on the test schema: .bak backup of the shard,
// append-only write, and the same buildAppendReceipt the production path uses.
function genuineAppend(historyDir: string, runId: string, rows: Array<Record<string, string>>, receiptPath: string, file = "zao_signals_2026_06.csv"): AppendReceipt {
  const path = join(historyDir, file);
  const before = readFileSync(path);
  const headers = before.toString("utf8").split("\n", 1)[0]!.split(",");
  const backupDir = join(historyDir, ".backup", runId);
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, `${file}.bak`), before);
  const after = Buffer.concat([before, Buffer.from(`${rows.map((r) => headers.map((h) => csvCell(r[h] ?? "")).join(",")).join("\n")}\n`, "utf8")]);
  writeFileSync(path, after);
  const receipt = buildAppendReceipt(runId, [{ file, before, after }], rows.map((r) => ({ row_id: r["row_id"]!, row_hash: r["row_hash"]!, shard_file: file })));
  writeAppendReceipt(receiptPath, receipt);
  return receipt;
}

// permit = the row_ids this run genuinely appends (default: all rows, appended
// to a header-only shard); null = no append receipt at all.
function runHelper(root: string, options: { rows?: Array<Record<string, string>>; dbPath?: string; gate?: string; expected?: string; permit?: string[] | null; hooks?: { afterGateEvaluated?: () => void; afterShardParsed?: (file: string) => void } } = {}): FreshHistoryToDbSyncReport {
  const historyDir = join(root, "history");
  const rows = options.rows ?? [historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")];
  const appendIds = new Set(options.permit === null ? [] : (options.permit ?? rows.map((row) => row["row_id"]!)));
  writeHistory(historyDir, rows.filter((row) => !appendIds.has(row["row_id"]!)));
  let receiptPath: string | undefined;
  if (options.permit !== null) {
    receiptPath = join(root, `receipt_${runSequence + 1}.json`);
    genuineAppend(historyDir, `test_append_${runSequence + 1}`, rows.filter((row) => appendIds.has(row["row_id"]!)), receiptPath);
  }
  return runFreshHistoryToDbSync({
    runId: `fresh_test_run_${++runSequence}`,
    generatedAtJst: "2026-06-05T16:40:00+09:00",
    historyDir,
    dbPath: options.dbPath ?? join(root, "test.sqlite"),
    reportPath: join(root, "fresh.md"),
    jsonPath: join(root, "fresh.json"),
    csvPath: join(root, "fresh.csv"),
    debugPath: join(root, "debug"),
    historyToDbSyncGate: options.gate,
    expectedHistoryRowCount: options.expected,
    appendReceiptPath: receiptPath,
    sourceAutoRunner07bArtifact: join(root, "auto07b.json"),
    testHooks: options.hooks
  });
}

function writeHistory(historyDir: string, rows: Array<Record<string, string>>): void {
  mkdirSync(historyDir, { recursive: true });
  const headers = [
    "row_id",
    "row_hash",
    "shard_month",
    "collected_date_jst",
    "collected_at_jst",
    "normalized_at_jst",
    "source",
    "canonical_property_name",
    "source_property_id",
    "checkin",
    "checkout",
    "stay_scope",
    "availability_status",
    "basis_confidence",
    "debug_artifact_path",
    "schema_version",
    "source_url",
    "normalized_total_jpy",
    "price_basis",
    "dp_usage",
    "classification",
    "exclusion_reason"
  ];
  const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header] ?? "")).join(","))].join("\n");
  writeFileSync(join(historyDir, "zao_signals_2026_06.csv"), `${csv}\n`, "utf8");
}

function historyRow(rowId: string, rowHash: string, source = "rakuten"): Record<string, string> {
  return {
    row_id: rowId,
    row_hash: rowHash,
    shard_month: "2026_06",
    collected_date_jst: "2026-06-05",
    collected_at_jst: "2026-06-05T12:00:00+09:00",
    normalized_at_jst: "2026-06-05T12:01:00+09:00",
    source,
    canonical_property_name: source === "booking" ? "蔵王国際ホテル" : "ホテル喜らく",
    source_property_id: source === "booking" ? "zao-kokusai" : "yad325153",
    source_url: "https://example.test/source",
    checkin: "2026-06-13",
    checkout: "2026-06-14",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available",
    basis_confidence: source === "booking" ? "B" : "A",
    debug_artifact_path: ".data/debug/test",
    schema_version: "zao_local_history_v1",
    normalized_total_jpy: "22000",
    price_basis: "tax_included_total",
    dp_usage: source === "booking" ? "directional" : "direct",
    classification: "available_price",
    exclusion_reason: ""
  };
}

function mappedRow(rowId: string, rowHash: string): MarketSignalHistoryDryRunRow {
  return {
    row_id: rowId,
    row_hash: rowHash,
    shard_month: "2026_06",
    collected_date_jst: "2026-06-05",
    collected_at_jst: "2026-06-05T12:00:00+09:00",
    normalized_at_jst: "2026-06-05T12:01:00+09:00",
    source: "rakuten",
    canonical_property_name: "ホテル喜らく",
    source_property_id: "yad325153",
    source_url: "",
    checkin_date: "2026-06-13",
    checkout_date: "2026-06-14",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available",
    sold_out_flag: 0,
    normalized_total_jpy: 22000,
    price_basis: "tax_included_total",
    basis_confidence: "A",
    dp_usage: "direct",
    classification: "available_price",
    exclusion_reason: "",
    debug_artifact_path: ".data/debug/test",
    schema_version: "zao_local_history_v1",
    raw_json: "{}",
    created_at: "2026-06-05T12:00:00+09:00",
    updated_at: "2026-06-05T12:00:00+09:00"
  };
}

function seedDb(dbPath: string, rows: MarketSignalHistoryDryRunRow[], runId = "seed_run"): void {
  const db = openLocalDatabase(dbPath);
  try {
    ensureMirrorSchema(db);
    applyRealSync({
      db,
      runId,
      generatedAtJst: "2026-06-05T12:00:00+09:00",
      reportPath: "seed.md",
      sourceHistoryFiles: ["seed.csv"],
      rows
    });
  } finally {
    closeDatabase(db);
  }
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

describe("fresh history-to-DB sync helper", () => {
  it("builds fresh mapping from current history", () => {
    const report = runHelper(tempRoot());
    expect(report.history_summary.row_count).toBe(2);
    expect(report.fresh_mapping_summary.mapped_row_count).toBe(2);
  });

  it("validates mapped count equals history count", () => {
    const report = runHelper(tempRoot());
    expect(report.fresh_mapping_summary.mapped_count_matches_history).toBe(true);
  });

  it("fails when expected history count env mismatches", () => {
    const report = runHelper(tempRoot(), { expected: "999" });
    expect(report.gate_result.expected_history_row_count_matches).toBe(false);
    expect(report.sync_result.db_write_executed).toBe(false);
  });

  it("fails when duplicate row_id exists", () => {
    const report = runHelper(tempRoot(), { rows: [historyRow("row_1", "hash_1"), historyRow("row_1", "hash_2")] });
    expect(report.decision).toBe("fresh_history_to_db_sync_not_ready");
    expect(report.history_summary.duplicate_row_id_count).toBe(1);
  });

  it("fails when mapping conflict exists", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "old_hash")]);
    const report = runHelper(root, { dbPath, rows: [historyRow("row_1", "new_hash")], gate: "1" });
    expect(report.decision).toBe("fresh_history_to_db_sync_conflict");
    expect(report.sync_result.db_write_executed).toBe(false);
  });

  it("no-env run returns ready_not_run", () => {
    const report = runHelper(tempRoot());
    expect(report.decision).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(report.sync_result.db_write_executed).toBe(false);
  });

  it("gated run can execute sync against temp DB", () => {
    const report = runHelper(tempRoot(), { gate: "1" });
    expect(report.sync_result.db_write_executed).toBe(true);
    expect(report.sync_result.inserted_rows).toBe(2);
    expect(report.db_after_summary.market_signal_history_count).toBe(2);
  });

  it("idempotent DB-up-to-date case gives inserted=0 and skipped=history_count", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    runHelper(root, { dbPath, gate: "1" });
    const second = runHelper(root, { dbPath, gate: "1" });
    expect(second.sync_result.inserted_rows).toBe(0);
    expect(second.sync_result.skipped_identical_rows).toBe(2);
    expect(second.idempotency_summary.already_synced_noop).toBe(true);
  });

  it("DB-behind case inserts missing and skips identical", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "hash_1")]);
    const report = runHelper(root, { dbPath, gate: "1" });
    expect(report.sync_result.inserted_rows).toBe(1);
    expect(report.sync_result.skipped_identical_rows).toBe(1);
  });

  it("write gate fails closed without an append receipt", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    const report = runHelper(root, { dbPath, gate: "1", permit: null });
    expect(report.decision).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(report.gate_result.reasons).toContain("HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH not set; writes require this run's verified append receipt");
    expect(report.sync_result.db_write_executed).toBe(false);
    expect(report.db_after_summary.market_signal_history_count).toBe(0);
  });

  it("stops before writing rows the run did not append", () => {
    // DB behind history by 2 rows, the run appended only row_2: row_1 is a hidden backfill.
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    const report = runHelper(root, { dbPath, gate: "1", permit: ["row_2"] });
    expect(report.gate_result.would_insert_rows).toBe(2);
    expect(report.gate_result.unpermitted_insert_rows).toBe(1);
    expect(report.gate_result.reasons).toContain("would insert 1 rows not appended by this run; backfill requires a separately approved recovery");
    expect(report.sync_result.db_write_executed).toBe(false);
    expect(report.db_after_summary.market_signal_history_count).toBe(0);
  });

  it("allows exactly the rows this run appended", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "hash_1")]);
    const report = runHelper(root, { dbPath, gate: "1", permit: ["row_2"] });
    expect(report.decision).toBe("fresh_history_to_db_sync_success");
    expect(report.sync_result.inserted_rows).toBe(1);
    expect(report.mirror_exact_match).toBe(true);
  });

  it("stops before writing when the DB holds row_ids absent from history", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "hash_1"), mappedRow("rolled_back_row", "hash_x")]);
    const report = runHelper(root, { dbPath, gate: "1" });
    expect(report.gate_result.db_only_row_count).toBe(1);
    expect(report.gate_result.reasons).toContain("DB has 1 row_ids absent from history; approved mirror reconciliation required");
    expect(report.decision).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(report.sync_result.db_write_executed).toBe(false);
    expect(report.db_after_summary.market_signal_history_count).toBe(2);
  });

  it("hash conflict stops and does not overwrite", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "hash_old")]);
    const report = runHelper(root, { dbPath, gate: "1", rows: [historyRow("row_1", "hash_new")] });
    expect(report.decision).toBe("fresh_history_to_db_sync_conflict");
    expect(report.db_after_summary.market_signal_history_count).toBe(1);
  });

  it("does not use hardcoded dry-run artifact pointer", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/history_to_db_sync_dry_run_\d{8}_\d{6}/u);
  });

  it("does not use source-specific AUTO03X constants", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/AUTO03X_JSON|AUTO03X_MAPPED_ROWS/u);
  });

  it("does not require APPROVED_MAPPED_ROW_COUNT", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("APPROVED_MAPPED_ROW_COUNT");
  });

  it("writes report/json/csv/debug artifact shapes", () => {
    const root = tempRoot();
    const report = runHelper(root);
    expect(readFileSync(report.report_path, "utf8")).toContain("Fresh History-to-DB Sync");
    expect(JSON.parse(readFileSync(report.json_path, "utf8"))).toHaveProperty("fresh_mapping_summary");
    expect(readFileSync(report.csv_path, "utf8")).toContain("run_id");
    expect(readFileSync(join(report.debug_artifact_path, "safety_confirmation.json"), "utf8")).toContain("ai_context_refreshed");
  });

  it("safety confirmation includes no AI context refresh", () => {
    expect(runHelper(tempRoot()).safety_confirmation["ai_context_refreshed"]).toBe(false);
  });

  it("safety confirmation includes no collector", () => {
    expect(runHelper(tempRoot()).safety_confirmation["live_collector_run"]).toBe(false);
  });

  it("no history write code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*\.data\/history|appendHistory|realHistoryAppend/u);
  });

  it("no AI context refresh code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("no live collector or Playwright code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/npm run probe:|npm run collect:|from\s+["']playwright|chromium|browser\.launch|newPage/u);
  });

  it("no pricing CSV or PMS output code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/beds24|airhost|GENERATE_PRICE_CSV=1|pricing_recommendation/iu);
  });

  it("decision labels are valid", () => {
    expect(VALID_DECISIONS).toContain(runHelper(tempRoot()).decision);
    const mapped = [{ row_id: "row_1", row_hash: "hash_1" }, { row_id: "row_2", row_hash: "hash_2" }];
    const permit = { rowIds: new Set(["row_1", "row_2"]), error: null };
    expect(evaluateFreshSyncGate({ envFlag: "1", expectedHistoryRowCount: "2", permit, invariants: evaluateMirrorInvariants(mapped, new Map(), permit), historyCount: 2, mapping: runHelper(tempRoot()).fresh_mapping_summary, duplicateRowIdCount: 0, schemaValid: true }).passed).toBe(true);
  });

  it("both live callers pass this run's append receipt and require verified success", () => {
    for (const script of ["runAutoRunnerMarketRefreshRotating.ts", "runAutoRunnerMarketRefresh.ts"]) {
      const src = readFileSync(resolve(__dirname, "../src/scripts", script), "utf8");
      const call = src.slice(src.indexOf('"sync:history-to-db:fresh"'), src.indexOf('"sync:history-to-db:fresh"') + 300);
      expect(call).toContain('HISTORY_TO_DB_SYNC: "1"');
      expect(call).toMatch(/HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: (receiptPath|appendResult === null \? "" : receiptPath)/u);
      expect(src).toMatch(/writeAppendReceipt\(receiptPath, (r|appendResult)\.receipt\)/u);
      expect(src).not.toContain("HISTORY_TO_DB_SYNC_PERMIT_PATH");
      expect(src).not.toContain("EXPECTED_MAX_INSERT_ROWS");
      // AI context refresh only behind the positive success protocol, never on counts alone.
      expect(src).not.toMatch(/status === 0 && Number\([a-zA-Z.]*parsed\["db_after_count"\]\)/u);
      const ctx = src.indexOf('"build:ai-context-packs"');
      expect(src.slice(Math.max(0, ctx - 400), ctx)).toMatch(/isVerifiedSyncOutput\(|if \(dbSynced\)/u);
    }
    const rotating = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerMarketRefreshRotating.ts"), "utf8");
    expect(rotating).toContain("dbSynced = isVerifiedSyncOutput(sync.status, sync.parsed, after.history_rows);");
    expect(rotating).toContain("const aligned = dbSynced && aiContextRefreshed && ");
    expect(rotating).not.toContain("dbSynced = true");
  });

  it("package contains sync script", () => {
    expect(PACKAGE_JSON).toContain("sync:history-to-db:fresh");
  });
});

// ---------------------------------------------------------------------------
// P0-G1 / G2 / G3 (TD review 2026-10-20): point-of-use re-check under the write
// lock, per-run permit instead of a caller-chosen cap, positive success protocol.

const REPO_ROOT = resolve(__dirname, "..");
const TSX_LOADER = pathToFileURL(resolve(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const CLI = resolve(REPO_ROOT, "src/scripts/syncHistoryToDbFresh.ts");

function dbSnapshot(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as { type: string; name: string }[];
    const data = objects.filter((o) => o.type === "table").map((o) => [o.name, db.prepare(`SELECT * FROM "${o.name}" ORDER BY rowid`).raw().all()]);
    return JSON.stringify({ objects, data });
  } finally {
    db.close();
  }
}

// Another OS process mutates the DB (fault injection between gate and writer).
function mutateInChildProcess(dbPath: string, sql: string): void {
  const script = `const D=require("better-sqlite3");const d=new D(${JSON.stringify(dbPath)});d.exec(${JSON.stringify(sql)});d.close();`;
  const r = spawnSync(process.execPath, ["-e", script], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

function runCli(cwd: string, env: Record<string, string>): { status: number | null; parsed: Record<string, string>; stdout: string } {
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI], { cwd, encoding: "utf8", env: { ...process.env, HISTORY_TO_DB_SYNC: "", EXPECTED_HISTORY_ROW_COUNT: "", HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: "", EXPECTED_MAX_INSERT_ROWS: "", ...env } });
  const parsed: Record<string, string> = {};
  for (const line of (r.stdout ?? "").split(/\r?\n/u)) { const i = line.indexOf("="); if (i > 0) parsed[line.slice(0, i)] = line.slice(i + 1); }
  return { status: r.status, parsed, stdout: r.stdout + r.stderr };
}

// CLI fixture: cwd with .data/history and .data/zao-market-intelligence.sqlite.
function cliRoot(rows: Array<Record<string, string>>, dbRows: MarketSignalHistoryDryRunRow[]): { root: string; dbPath: string; historyDir: string } {
  const root = tempRoot();
  writeHistory(join(root, ".data/history"), rows);
  const dbPath = join(root, ".data/zao-market-intelligence.sqlite");
  seedDb(dbPath, dbRows);
  return { root, dbPath, historyDir: join(root, ".data/history") };
}

describe("P0-G1 write-time consistency under a shared write lock", () => {
  function setup(): { root: string; dbPath: string } {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "hash_1")]);
    return { root, dbPath };
  }

  it.each([
    ["DB-only row created by another process", "UPDATE market_signal_history SET row_id = 'injected_db_only' WHERE row_id = 'row_1'", "DB has 1 row_ids absent from history; approved mirror reconciliation required"],
    ["row_hash changed by another process", "UPDATE market_signal_history SET row_hash = 'tampered' WHERE row_id = 'row_1'", "fresh mapping has DB row_hash conflicts"]
  ])("refuses with zero writes when %s after the gate", (_label, sql, reason) => {
    const { root, dbPath } = setup();
    let afterInjection = "";
    const report = runHelper(root, { dbPath, gate: "1", permit: ["row_2"], hooks: { afterGateEvaluated: () => { mutateInChildProcess(dbPath, sql); afterInjection = dbSnapshot(dbPath); } } });
    expect(report.decision).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(report.gate_result.passed).toBe(false);
    expect(report.gate_result.point_of_use_reasons).toContain(reason);
    expect(report.sync_result.db_write_executed).toBe(false);
    expect(dbSnapshot(dbPath)).toBe(afterInjection); // no table data, schema, index or sync_run change by the sync
  });

  it("refuses when history changes between gate and write", () => {
    const { root, dbPath } = setup();
    const before = dbSnapshot(dbPath);
    const report = runHelper(root, { dbPath, gate: "1", permit: ["row_2"], hooks: { afterGateEvaluated: () => appendFileSync(join(root, "history", "zao_signals_2026_06.csv"), `${["row_3", "hash_3"].map(csvCell).join(",")}\n`) } });
    expect(report.gate_result.point_of_use_reasons).toContain("history changed between gate evaluation and write");
    expect(dbSnapshot(dbPath)).toBe(before);
  });

  it("refuses when another writer holds the DB write lock", () => {
    const { root, dbPath } = setup();
    const before = dbSnapshot(dbPath);
    const other = new Database(dbPath);
    try {
      const report = runHelper(root, { dbPath, gate: "1", permit: ["row_2"], hooks: { afterGateEvaluated: () => { other.exec("BEGIN IMMEDIATE"); } } });
      expect(report.gate_result.point_of_use_reasons).toEqual(["DB write lock held by another writer"]);
      expect(report.sync_result.db_write_executed).toBe(false);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect(dbSnapshot(dbPath)).toBe(before);
  });

  it("refuses when the other runner already inserted the rows (insert set changed)", () => {
    const { root, dbPath } = setup();
    let afterInjection = "";
    const report = runHelper(root, { dbPath, gate: "1", permit: ["row_2"], hooks: { afterGateEvaluated: () => { seedDb(dbPath, [mappedRow("row_1", "hash_1"), { ...mappedRow("row_2", "hash_2"), source: "booking" }], "other_runner_sync"); afterInjection = dbSnapshot(dbPath); } } });
    expect(report.decision).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(report.gate_result.point_of_use_reasons).toContain("insert set changed since gate (1 -> 0)");
    expect(dbSnapshot(dbPath)).toBe(afterInjection);
  });
});

describe("P0-G2 insert bound is this run's appended row_ids, not a caller-chosen number", () => {
  const BACKLOG = 68_000;
  const rows = Array.from({ length: BACKLOG + 100 }, (_, i) => historyRow(`row_${String(i).padStart(6, "0")}`, `hash_${i}`));
  const dbRows = rows.slice(0, 100).map((row) => mappedRow(row["row_id"]!, row["row_hash"]!));

  it("refuses a 68,000-row backlog on a DB-only=0 mirror even with EXPECTED_MAX_INSERT_ROWS=68129", () => {
    const { root, dbPath } = cliRoot(rows, dbRows);
    const before = dbSnapshot(dbPath);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", EXPECTED_HISTORY_ROW_COUNT: String(rows.length), EXPECTED_MAX_INSERT_ROWS: "68129" });
    expect(cli.parsed["decision"]).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(cli.parsed["gate_reasons"]).toContain("HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH not set");
    expect(cli.status).toBe(2);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 120_000);

  it("refuses a forged receipt listing the whole 68,000-row backlog", () => {
    const { root, dbPath } = cliRoot(rows, dbRows);
    const before = dbSnapshot(dbPath);
    const receiptPath = join(root, "receipt.json");
    writeAppendReceipt(receiptPath, { version: 1, run_id: "forged", shards: [{ file: "zao_signals_2026_06.csv", before_sha256: "0", before_size: 1, after_sha256: "0", after_size: 1 }], rows: rows.slice(100).map((row) => ({ row_id: row["row_id"]!, row_hash: row["row_hash"]!, shard_file: "zao_signals_2026_06.csv" })) });
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", EXPECTED_HISTORY_ROW_COUNT: String(rows.length), HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: receiptPath });
    expect(cli.parsed["gate_reasons"]).toContain(`append receipt rejected: ${BACKLOG} rows > per-run cap ${SYNC_PERMIT_MAX_ROWS}`);
    expect(cli.status).toBe(2);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 120_000);

  it("refuses the backlog when the genuine receipt only covers this run's 63 rows", () => {
    const { root, dbPath, historyDir } = cliRoot(rows.slice(0, -63), dbRows);
    const receiptPath = join(root, "receipt.json");
    genuineAppend(historyDir, "natural_run", rows.slice(-63), receiptPath);
    const before = dbSnapshot(dbPath);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", EXPECTED_HISTORY_ROW_COUNT: String(rows.length), HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: receiptPath });
    expect(cli.parsed["gate_reasons"]).toContain(`would insert ${BACKLOG - 63} rows not appended by this run`);
    expect(cli.status).toBe(2);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 120_000);

  it("per-run cap equals one run's page cap at the maximum multiplier", () => {
    expect(SYNC_PERMIT_MAX_ROWS).toBe(150);
  });
});

describe("P0-G3 a refused or unverified sync is never success", () => {
  it("CLI: read-only run exits 0; refused write exits 2; verified write exits 0", () => {
    const { root } = cliRoot([historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")], [mappedRow("row_1", "hash_1"), { ...mappedRow("row_2", "hash_2"), source: "booking" }]);
    expect(runCli(root, {}).status).toBe(0);
    const refused = runCli(root, { HISTORY_TO_DB_SYNC: "1" });
    expect(refused.status).toBe(2);
    expect(refused.parsed["sync_write_refused"]).toBe("true");
    const receiptPath = join(root, "receipt.json");
    genuineAppend(join(root, ".data/history"), "natural_run", [historyRow("row_3", "hash_3")], receiptPath);
    const ok = runCli(root, { HISTORY_TO_DB_SYNC: "1", HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: receiptPath });
    expect(ok.status).toBe(0);
    expect(ok.parsed["decision"]).toBe("fresh_history_to_db_sync_success");
    expect(ok.parsed["mirror_exact_match"]).toBe("true");
    expect(isVerifiedSyncOutput(ok.status, ok.parsed, 3)).toBe(true);
  }, 60_000);

  it("equal DB/history counts with a row_hash mismatch is refused and not verified", () => {
    const { root, dbPath } = cliRoot([historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")], [mappedRow("row_1", "hash_1"), mappedRow("row_2", "hash_OTHER")]);
    const before = dbSnapshot(dbPath);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1" });
    expect(cli.parsed["history_count"]).toBe(cli.parsed["db_after_count"]); // counts alone would look "aligned"
    expect(cli.parsed["decision"]).toBe("fresh_history_to_db_sync_conflict");
    expect(cli.parsed["mirror_exact_match"]).toBe("false");
    expect(cli.status).toBe(2);
    expect(isVerifiedSyncOutput(cli.status, cli.parsed, 2)).toBe(false);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 60_000);

  it("equal DB/history counts without an append receipt for the missing row is refused and not verified", () => {
    // DB holds one stale row and lacks row_2: 2 == 2 by count, yet not a mirror.
    const { root, dbPath } = cliRoot([historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")], [mappedRow("row_1", "hash_1"), mappedRow("stale_only", "hash_s")]);
    const before = dbSnapshot(dbPath);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1" });
    expect(cli.parsed["history_count"]).toBe(cli.parsed["db_after_count"]);
    expect(cli.parsed["decision"]).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(cli.status).toBe(2);
    expect(isVerifiedSyncOutput(cli.status, cli.parsed, 2)).toBe(false);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 60_000);

  it("isVerifiedSyncOutput needs status 0, success|noop, exact mirror and matching counts", () => {
    const ok = { decision: "fresh_history_to_db_sync_noop", mirror_exact_match: "true", history_count: "2", db_after_count: "2" };
    expect(isVerifiedSyncOutput(0, ok, 2)).toBe(true);
    for (const decision of ["fresh_history_to_db_sync_ready_not_run", "fresh_history_to_db_sync_not_ready", "fresh_history_to_db_sync_conflict", "fresh_history_to_db_sync_failed"]) {
      expect(isVerifiedSyncOutput(0, { ...ok, decision }, 2)).toBe(false);
    }
    expect(isVerifiedSyncOutput(0, { ...ok, mirror_exact_match: "false" }, 2)).toBe(false);
    expect(isVerifiedSyncOutput(2, ok, 2)).toBe(false);
    expect(isVerifiedSyncOutput(0, ok, 3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TD 2026-10-20 #6279266712: P0-G2 receipt provenance, P0-G1 parsed-bytes digest.

describe("P0-G2 append receipt must prove this run's append", () => {
  // DB-only 0, one old unsynced history row (old_2) that no current run appended.
  function oldBacklog(): { root: string; dbPath: string; historyDir: string } {
    const root = tempRoot();
    const historyDir = join(root, "history");
    writeHistory(historyDir, [historyRow("old_1", "hash_o1"), historyRow("old_2", "hash_o2")]);
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("old_1", "hash_o1")]);
    return { root, dbPath, historyDir };
  }
  function syncWith(root: string, dbPath: string, receiptPath: string | undefined): FreshHistoryToDbSyncReport {
    return runFreshHistoryToDbSync({ runId: `g2_${++runSequence}`, generatedAtJst: "2026-10-20T09:00:00+09:00", historyDir: join(root, "history"), dbPath, reportPath: join(root, "r.md"), jsonPath: join(root, "r.json"), csvPath: join(root, "r.csv"), debugPath: join(root, "debug"), historyToDbSyncGate: "1", expectedHistoryRowCount: undefined, appendReceiptPath: receiptPath, sourceAutoRunner07bArtifact: join(root, "none.json") });
  }
  function expectNoWrite(report: FreshHistoryToDbSyncReport, dbPath: string, before: string, reason: RegExp): void {
    expect(report.decision).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(report.gate_result.reasons.join("|")).toMatch(reason);
    expect(report.sync_result.db_write_executed).toBe(false);
    expect(report.sync_result.inserted_rows).toBe(0);
    expect(dbSnapshot(dbPath)).toBe(before); // all tables, schema and sync_runs unchanged
  }

  it("rejects a forged 1-row receipt for an old unsynced row (no backup evidence)", () => {
    const { root, dbPath } = oldBacklog();
    const before = dbSnapshot(dbPath);
    const receiptPath = join(root, "forged.json");
    writeAppendReceipt(receiptPath, { version: 1, run_id: "forged-or-stale", shards: [{ file: "zao_signals_2026_06.csv", before_sha256: "x", before_size: 10, after_sha256: "y", after_size: 20 }], rows: [{ row_id: "old_2", row_hash: "hash_o2", shard_file: "zao_signals_2026_06.csv" }] });
    expectNoWrite(syncWith(root, dbPath, receiptPath), dbPath, before, /append receipt rejected/u);
  });

  it("rejects the old {run_id,row_ids} permit format", () => {
    const { root, dbPath } = oldBacklog();
    const before = dbSnapshot(dbPath);
    const receiptPath = join(root, "old_format.json");
    writeFileSync(receiptPath, JSON.stringify({ run_id: "forged-or-stale", row_ids: ["old_2"] }));
    expectNoWrite(syncWith(root, dbPath, receiptPath), dbPath, before, /append receipt rejected: bad version or run_id/u);
  });

  it("rejects a forged receipt that reuses a genuine run's backup but claims an older row", () => {
    const { root, dbPath, historyDir } = oldBacklog();
    const genuine = genuineAppend(historyDir, "run_a", [historyRow("new_3", "hash_n3")], join(root, "genuine.json"));
    seedDb(dbPath, [{ ...mappedRow("new_3", "hash_n3") }], "run_a_sync");
    const before = dbSnapshot(dbPath);
    const receiptPath = join(root, "forged.json");
    writeAppendReceipt(receiptPath, { ...genuine, rows: [{ row_id: "old_2", row_hash: "hash_o2", shard_file: "zao_signals_2026_06.csv" }] });
    expectNoWrite(syncWith(root, dbPath, receiptPath), dbPath, before, /appended records do not match the receipt rows/u);
  });

  it("rejects a replayed genuine receipt once the shard was appended again", () => {
    const { root, dbPath, historyDir } = oldBacklog();
    const receiptA = join(root, "a.json");
    genuineAppend(historyDir, "run_a", [historyRow("new_3", "hash_n3")], receiptA); // run_a's own sync never happened
    genuineAppend(historyDir, "run_b", [historyRow("new_4", "hash_n4")], join(root, "b.json"));
    const before = dbSnapshot(dbPath);
    expectNoWrite(syncWith(root, dbPath, receiptA), dbPath, before, /changed after this append \(stale or forged\)/u);
  });

  it("rejects a genuine receipt that is no longer current (append older than the freshness window)", () => {
    const { root, dbPath, historyDir } = oldBacklog();
    seedDb(dbPath, [mappedRow("old_2", "hash_o2")], "old_2_synced"); // DB == history before the append
    const receiptPath = join(root, "a.json");
    genuineAppend(historyDir, "run_a", [historyRow("new_3", "hash_n3")], receiptPath);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(historyDir, ".backup", "run_a", "zao_signals_2026_06.csv.bak"), old, old);
    utimesSync(join(historyDir, "zao_signals_2026_06.csv"), old, old);
    const before = dbSnapshot(dbPath);
    expectNoWrite(syncWith(root, dbPath, receiptPath), dbPath, before, /not from a current append|not written by a current append/u);
  });

  it("still syncs a genuine current append (positive case, 63 rows)", () => {
    const root = tempRoot();
    const historyDir = join(root, "history");
    const base = Array.from({ length: 10 }, (_, i) => historyRow(`base_${i}`, `hb_${i}`));
    writeHistory(historyDir, base);
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, base.map((r) => mappedRow(r["row_id"]!, r["row_hash"]!)));
    const receiptPath = join(root, "natural.json");
    genuineAppend(historyDir, "natural_run", Array.from({ length: 63 }, (_, i) => historyRow(`new_${i}`, `hn_${i}`)), receiptPath);
    const report = syncWith(root, dbPath, receiptPath);
    expect(report.decision).toBe("fresh_history_to_db_sync_success");
    expect(report.sync_result.inserted_rows).toBe(63);
    expect(report.mirror_exact_match).toBe(true);
  });

  it("verifies the receipt produced by the real appendHistoryRowsAtomic", () => {
    const root = tempRoot();
    const historyDir = join(root, "history");
    const dbPath = join(root, "test.sqlite");
    const backup = (runId: string): string => join(historyDir, ".backup", runId);
    const first = appendHistoryRowsAtomic({ rows: [liveHistoryRow("live_1"), liveHistoryRow("live_2")], historyDir, backupDir: backup("run_1"), historyBefore: 0 });
    writeAppendReceipt(join(root, "r1.json"), first.receipt);
    expect(syncWith(root, dbPath, join(root, "r1.json")).decision).toBe("fresh_history_to_db_sync_success");
    const second = appendHistoryRowsAtomic({ rows: [liveHistoryRow("live_3")], historyDir, backupDir: backup("run_2"), historyBefore: 2 });
    writeAppendReceipt(join(root, "r2.json"), second.receipt);
    const before = dbSnapshot(dbPath);
    expect(syncWith(root, dbPath, join(root, "r1.json")).gate_result.reasons.join("|")).toMatch(/changed after this append/u); // replay of run_1
    expect(dbSnapshot(dbPath)).toBe(before);
    const ok = syncWith(root, dbPath, join(root, "r2.json"));
    expect(ok.decision).toBe("fresh_history_to_db_sync_success");
    expect(ok.sync_result.inserted_rows).toBe(1);
    expect(ok.mirror_exact_match).toBe(true);
    expect(verifyAppendReceipt(join(root, "r2.json"), { shards: [] }, historyDir, Date.now()).error).toMatch(/not in history/u);
  });
});

describe("P0-G1 source digest is bound to the parsed bytes", () => {
  it("stops before any write when another process appends between the first shard read and digest finalisation", () => {
    const root = tempRoot();
    const historyDir = join(root, "history");
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "hash_1")]);
    writeHistory(historyDir, [historyRow("row_1", "hash_1")]);
    const receiptPath = join(root, "receipt.json");
    genuineAppend(historyDir, "natural_run", [historyRow("row_2", "hash_2")], receiptPath);
    // A second shard that is read AFTER the first one.
    writeFileSync(join(historyDir, "zao_signals_2026_07.csv"), readFileSync(join(historyDir, "zao_signals_2026_06.csv"), "utf8").split("\n", 1)[0] + "\n");
    const before = dbSnapshot(dbPath);
    let injected = false;
    const report = runFreshHistoryToDbSync({ runId: "g1_race", generatedAtJst: "2026-10-20T09:00:00+09:00", historyDir, dbPath, reportPath: join(root, "r.md"), jsonPath: join(root, "r.json"), csvPath: join(root, "r.csv"), debugPath: join(root, "debug"), historyToDbSyncGate: "1", expectedHistoryRowCount: undefined, appendReceiptPath: receiptPath, sourceAutoRunner07bArtifact: join(root, "none.json"),
      testHooks: { afterShardParsed: (file) => {
        if (injected || !file.endsWith("zao_signals_2026_06.csv")) return;
        injected = true; // another OS process appends to the shard that was just parsed
        const line = `${["row_late", "hash_late"].map(csvCell).join(",")}\n`;
        const r = spawnSync(process.execPath, ["-e", `require("node:fs").appendFileSync(${JSON.stringify(join(historyDir, "zao_signals_2026_06.csv"))}, ${JSON.stringify(line)})`], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(r.stderr);
      } } });
    expect(injected).toBe(true);
    expect(report.history_summary.row_count).toBe(2); // mappedRows = the bytes parsed before the append
    expect(report.decision).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(report.gate_result.point_of_use_reasons).toContain("history changed between gate evaluation and write");
    expect(report.sync_result.db_write_executed).toBe(false);
    expect(dbSnapshot(dbPath)).toBe(before);
  });

  it("rolls the whole write back when an insert fails inside the locked transaction", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "hash_1")]);
    const db = new Database(dbPath);
    db.exec("CREATE TRIGGER inject_fail AFTER INSERT ON market_signal_history WHEN NEW.row_id = 'row_2' BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;");
    db.close();
    const before = dbSnapshot(dbPath);
    expect(() => runHelper(root, { dbPath, gate: "1", permit: ["row_2"] })).toThrow(/injected_failure/u);
    expect(dbSnapshot(dbPath)).toBe(before); // no row, no sync_run, no schema change
  });
});

function liveHistoryRow(rowId: string): HistoryRow {
  return {
    rowId, rowHash: `hash_${rowId}`, shardMonth: "2026_11", collectedDateJst: "2026-10-20", collectedAtJst: "2026-10-20T08:00:00+09:00", normalizedAtJst: "2026-10-20T08:00:00+09:00",
    source: "booking", sourcePhase: "test", collectorStage: "test", canonicalPropertyName: "蔵王国際ホテル", sourcePropertyName: "蔵王国際ホテル", propertyIdentityMatch: true,
    sourcePropertyId: "zao-kokusai", sourceSlugOrCode: "zao-kokusai", checkin: "2026-11-07", checkout: "2026-11-08", stayNights: 1, groupAdults: 2, noRooms: 1, groupChildren: 0,
    currency: "JPY", language: "ja", stayScope: "2_adults_1_room_1_night", availabilityStatus: "available", soldOutStatus: "available", normalizedTotalPrice: 30000,
    normalizedTotalPriceSource: "test", normalizedTotalPriceBasis: "test", normalizedTotalPriceConfidence: "B", basisConfidence: "B", basisNote: "test", sourcePrimaryPrice: 30000,
    sourceSecondaryPriceOrAdder: null, sourceComputedTotal: 30000, sourceTaxOrFeeClassification: "test", sourceClassification: "test", isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: true, isPriceExcludedFromDp: false, dpExclusionReason: null, warningFlags: "", sourceReportPath: "", sourceCsvPath: "", debugArtifactPath: "", schemaVersion: "zao_local_history_v1"
  };
}

// ---------------------------------------------------------------------------
// TD 2026-10-20 follow-up: the pre-append state must be proven, not declared.

describe("P0-G2 before-state proof: before_size=0 is never self-declared", () => {
  const SHARD = "zao_signals_2026_06.csv";
  const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
  // old_1 synced, old_2 unsynced; run_a genuinely appended new_3 (non-empty .bak).
  function scenario(): { root: string; historyDir: string; dbPath: string; current: Buffer } {
    const root = tempRoot();
    const historyDir = join(root, ".data/history");
    writeHistory(historyDir, [historyRow("old_1", "hash_o1"), historyRow("old_2", "hash_o2")]);
    genuineAppend(historyDir, "run_a", [historyRow("new_3", "hash_n3")], join(root, "genuine.json"));
    const dbPath = join(root, ".data/zao-market-intelligence.sqlite");
    seedDb(dbPath, [mappedRow("old_1", "hash_o1")]);
    return { root, historyDir, dbPath, current: readFileSync(join(historyDir, SHARD)) };
  }
  // Counterexample: claim the whole shard is new so every row (incl. old_2) becomes "this run's".
  function wholeShardClaim(runId: string, current: Buffer, beforeSize: unknown = 0): AppendReceipt {
    return { version: 1, run_id: runId, shards: [{ file: SHARD, before_sha256: sha(Buffer.alloc(0)), before_size: beforeSize as number, after_sha256: sha(current), after_size: current.length }],
      rows: [["old_1", "hash_o1"], ["old_2", "hash_o2"], ["new_3", "hash_n3"]].map(([row_id, row_hash]) => ({ row_id: row_id!, row_hash: row_hash!, shard_file: SHARD })) };
  }
  function refusedWithoutChange(root: string, dbPath: string, receipt: AppendReceipt, reason: RegExp): void {
    const receiptPath = join(root, "claim.json");
    writeAppendReceipt(receiptPath, receipt);
    const before = dbSnapshot(dbPath);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: receiptPath });
    expect(cli.parsed["gate_reasons"]).toMatch(reason);
    expect(cli.parsed["decision"]).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(cli.parsed["inserted_rows"]).toBe("0");
    expect(cli.status).toBe(2);
    expect(cli.parsed["sync_write_refused"]).toBe("true");
    // Both runners gate AI context refresh and publish on exactly this check.
    expect(isVerifiedSyncOutput(cli.status, cli.parsed, 3)).toBe(false);
    expect(dbSnapshot(dbPath)).toBe(before); // rows, schema, indexes and sync_runs unchanged
  }

  it("rejects before_size=0 when the run holds a real non-empty backup of the shard", () => {
    const { root, dbPath, current } = scenario();
    refusedWithoutChange(root, dbPath, wholeShardClaim("run_a", current), /backup zao_signals_2026_06\.csv\.bak does not match the receipt's before state/u);
  }, 60_000);

  it("does not treat a missing backup as a new shard", () => {
    const { root, historyDir, dbPath, current } = scenario();
    rmSync(join(historyDir, ".backup", "run_a", `${SHARD}.bak`));
    refusedWithoutChange(root, dbPath, wholeShardClaim("run_a", current), /missing backup zao_signals_2026_06\.csv\.bak/u);
  }, 60_000);

  it("rejects a forged empty backup when another run backed up earlier content of the shard", () => {
    const { root, historyDir, dbPath, current } = scenario();
    mkdirSync(join(historyDir, ".backup", "forged_run"), { recursive: true });
    writeFileSync(join(historyDir, ".backup", "forged_run", `${SHARD}.bak`), "");
    refusedWithoutChange(root, dbPath, wholeShardClaim("forged_run", current), /claims to be new but run run_a backed up earlier content/u);
  }, 60_000);

  it.each([["missing", "omit"], ["negative", -1], ["fractional", 0.5], ["string", "0"]])("rejects a %s before_size instead of taking the new-shard branch", (_label, size) => {
    const { root, dbPath, current } = scenario();
    const receipt = wholeShardClaim("run_a", current, size);
    if (size === "omit") delete (receipt.shards[0] as Partial<AppendReceipt["shards"][number]>).before_size;
    expect(JSON.stringify(receipt).includes('"before_size"')).toBe(size !== "omit");
    refusedWithoutChange(root, dbPath, receipt, /has invalid sizes or hashes/u);
  }, 60_000);

  it("still syncs a normal append to an existing shard", () => {
    const { root, historyDir, dbPath } = scenario();
    seedDb(dbPath, [mappedRow("old_2", "hash_o2"), mappedRow("new_3", "hash_n3")], "caught_up");
    const receiptPath = join(root, "normal.json");
    genuineAppend(historyDir, "run_b", [historyRow("new_4", "hash_n4")], receiptPath);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: receiptPath });
    expect(cli.parsed["decision"]).toBe("fresh_history_to_db_sync_success");
    expect(cli.parsed["inserted_rows"]).toBe("1");
    expect(isVerifiedSyncOutput(cli.status, cli.parsed, 4)).toBe(true);
  }, 60_000);

  it("still syncs a genuinely new shard created by appendHistoryRowsAtomic (empty .bak = empty before state)", () => {
    const root = tempRoot();
    const historyDir = join(root, "history");
    const dbPath = join(root, "test.sqlite");
    const result = appendHistoryRowsAtomic({ rows: [liveHistoryRow("live_1")], historyDir, backupDir: join(historyDir, ".backup", "run_new"), historyBefore: 0 });
    expect(result.receipt.shards[0]!.before_size).toBe(0);
    expect(readFileSync(join(historyDir, ".backup", "run_new", "zao_signals_2026_11.csv.bak")).length).toBe(0);
    expect(result.backups_created).toBe(0); // reported count of content backups is unchanged
    writeAppendReceipt(join(root, "r.json"), result.receipt);
    const report = runFreshHistoryToDbSync({ runId: "new_shard", generatedAtJst: "2026-10-20T09:00:00+09:00", historyDir, dbPath, reportPath: join(root, "r.md"), jsonPath: join(root, "r.json.out"), csvPath: join(root, "r.csv"), debugPath: join(root, "debug"), historyToDbSyncGate: "1", expectedHistoryRowCount: undefined, appendReceiptPath: join(root, "r.json"), sourceAutoRunner07bArtifact: join(root, "none.json") });
    expect(report.decision).toBe("fresh_history_to_db_sync_success");
    expect(report.mirror_exact_match).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TD 2026-10-20 P0-G2 final: receipt + backup are both caller-writable, so their
// mutual consistency cannot prove that a real append happened. These pin the
// counterexamples against e640bc6f. They are `it.fails` (known open hole, see
// private #13): flip to `it` when the trusted in-process append+mirror lands.
describe("P0-G2 OPEN: caller-forged backup + receipt without any append", () => {
  const SHARD = "zao_signals_2026_06.csv";
  const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
  function forged(before: Buffer, claimed: Array<[string, string]>): { root: string; dbPath: string; receiptPath: string } {
    const root = tempRoot();
    const historyDir = join(root, ".data/history");
    writeHistory(historyDir, [historyRow("old_1", "hash_o1"), historyRow("old_2", "hash_o2"), historyRow("new_3", "hash_n3")]); // no append is executed
    const dbPath = join(root, ".data/zao-market-intelligence.sqlite");
    seedDb(dbPath, [mappedRow("old_1", "hash_o1")]); // DB-only 0
    const current = readFileSync(join(historyDir, SHARD));
    const header = Buffer.from(`${current.toString("utf8").split("\n", 1)[0]}\n`);
    const bak = before.length === 0 ? before : Buffer.concat([header, before]);
    mkdirSync(join(historyDir, ".backup", "forged_run"), { recursive: true });
    writeFileSync(join(historyDir, ".backup", "forged_run", `${SHARD}.bak`), bak);
    const receiptPath = join(root, "forged.json");
    writeAppendReceipt(receiptPath, { version: 1, run_id: "forged_run", shards: [{ file: SHARD, before_sha256: sha(bak), before_size: bak.length, after_sha256: sha(current), after_size: current.length }], rows: claimed.map(([row_id, row_hash]) => ({ row_id, row_hash, shard_file: SHARD })) });
    return { root, dbPath, receiptPath };
  }
  function expectRefusedUnchanged(root: string, dbPath: string, receiptPath: string): void {
    const before = dbSnapshot(dbPath);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: receiptPath });
    expect(cli.parsed["inserted_rows"]).toBe("0");
    expect(cli.status).toBe(2);
    expect(isVerifiedSyncOutput(cli.status, cli.parsed, 3)).toBe(false); // no AI context refresh / publish
    expect(dbSnapshot(dbPath)).toBe(before); // rows, schema, sync_runs unchanged
  }

  it.fails("forged .bak = header + old_1 and receipt claiming old_2, new_3 must not authorize any INSERT", () => {
    const { root, dbPath, receiptPath } = forged(Buffer.from(`${historyLine(historyRow("old_1", "hash_o1"))}\n`), [["old_2", "hash_o2"], ["new_3", "hash_n3"]]);
    expectRefusedUnchanged(root, dbPath, receiptPath);
  }, 60_000);

  it.fails("forged empty .bak for a shard never backed up must not promote the whole shard", () => {
    const { root, dbPath, receiptPath } = forged(Buffer.alloc(0), [["old_1", "hash_o1"], ["old_2", "hash_o2"], ["new_3", "hash_n3"]]);
    expectRefusedUnchanged(root, dbPath, receiptPath);
  }, 60_000);

  function historyLine(row: Record<string, string>): string {
    const headers = ["row_id", "row_hash", "shard_month", "collected_date_jst", "collected_at_jst", "normalized_at_jst", "source", "canonical_property_name", "source_property_id", "checkin", "checkout", "stay_scope", "availability_status", "basis_confidence", "debug_artifact_path", "schema_version", "source_url", "normalized_total_jpy", "price_basis", "dp_usage", "classification", "exclusion_reason"];
    return headers.map((h) => csvCell(row[h] ?? "")).join(",");
  }
});
