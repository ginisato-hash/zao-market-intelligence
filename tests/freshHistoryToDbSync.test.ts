import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  writeSyncPermit,
  type FreshHistoryToDbSyncDecision,
  type FreshHistoryToDbSyncReport
} from "../src/services/freshHistoryToDbSync";
import type { MarketSignalHistoryDryRunRow } from "../src/services/historyToDbSyncDryRun";

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

// permit defaults to every history row_id (as if this run appended them all);
// pass null to omit the permit, or a list for an explicit per-run permit.
function runHelper(root: string, options: { rows?: Array<Record<string, string>>; dbPath?: string; gate?: string; expected?: string; permit?: string[] | null; hooks?: { afterGateEvaluated?: () => void }; skipHistoryWrite?: boolean } = {}): FreshHistoryToDbSyncReport {
  const historyDir = join(root, "history");
  const rows = options.rows ?? [historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")];
  if (options.skipHistoryWrite !== true) writeHistory(historyDir, rows);
  let permitPath: string | undefined;
  if (options.permit !== null) {
    permitPath = join(root, `permit_${runSequence + 1}.json`);
    writeSyncPermit(permitPath, "test", options.permit ?? rows.map((row) => row["row_id"]!));
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
    syncPermitPath: permitPath,
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

  it("write gate fails closed without a sync permit", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    const report = runHelper(root, { dbPath, gate: "1", permit: null });
    expect(report.decision).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(report.gate_result.reasons).toContain("HISTORY_TO_DB_SYNC_PERMIT_PATH not set; writes require this run's appended row_ids");
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

  it("rejects a permit naming row_ids that are not in history", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "hash_1")]);
    const report = runHelper(root, { dbPath, gate: "1", permit: ["row_2", "not_in_history"] });
    expect(report.gate_result.reasons).toContain("sync permit lists 1 row_ids absent from history");
    expect(report.sync_result.db_write_executed).toBe(false);
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

  it("both live callers pass a per-run permit and require verified success", () => {
    for (const script of ["runAutoRunnerMarketRefreshRotating.ts", "runAutoRunnerMarketRefresh.ts"]) {
      const src = readFileSync(resolve(__dirname, "../src/scripts", script), "utf8");
      const call = src.slice(src.indexOf('"sync:history-to-db:fresh"'), src.indexOf('"sync:history-to-db:fresh"') + 300);
      expect(call).toContain('HISTORY_TO_DB_SYNC: "1"');
      expect(call).toContain("HISTORY_TO_DB_SYNC_PERMIT_PATH: permitPath");
      expect(src).toMatch(/writeSyncPermit\(permitPath, runId, .*approved_rows\.map\(\(row\) => row\.rowId\)/u);
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
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI], { cwd, encoding: "utf8", env: { ...process.env, HISTORY_TO_DB_SYNC: "", EXPECTED_HISTORY_ROW_COUNT: "", HISTORY_TO_DB_SYNC_PERMIT_PATH: "", EXPECTED_MAX_INSERT_ROWS: "", ...env } });
  const parsed: Record<string, string> = {};
  for (const line of (r.stdout ?? "").split(/\r?\n/u)) { const i = line.indexOf("="); if (i > 0) parsed[line.slice(0, i)] = line.slice(i + 1); }
  return { status: r.status, parsed, stdout: r.stdout + r.stderr };
}

// CLI fixture: cwd with .data/history and .data/zao-market-intelligence.sqlite.
function cliRoot(rows: Array<Record<string, string>>, dbRows: MarketSignalHistoryDryRunRow[]): { root: string; dbPath: string } {
  const root = tempRoot();
  writeHistory(join(root, ".data/history"), rows);
  const dbPath = join(root, ".data/zao-market-intelligence.sqlite");
  seedDb(dbPath, dbRows);
  return { root, dbPath };
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
    expect(cli.parsed["gate_reasons"]).toContain("HISTORY_TO_DB_SYNC_PERMIT_PATH not set");
    expect(cli.status).toBe(2);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 120_000);

  it("refuses a permit listing the whole 68,000-row backlog (over the per-run cap)", () => {
    const { root, dbPath } = cliRoot(rows, dbRows);
    const before = dbSnapshot(dbPath);
    const permitPath = join(root, "permit.json");
    writeSyncPermit(permitPath, "forged", rows.slice(100).map((row) => row["row_id"]!));
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", EXPECTED_HISTORY_ROW_COUNT: String(rows.length), HISTORY_TO_DB_SYNC_PERMIT_PATH: permitPath });
    expect(cli.parsed["gate_reasons"]).toContain(`sync permit lists ${BACKLOG} rows > per-run cap ${SYNC_PERMIT_MAX_ROWS}`);
    expect(cli.status).toBe(2);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 120_000);

  it("refuses the backlog when the permit only covers this run's 63 rows", () => {
    const { root, dbPath } = cliRoot(rows, dbRows);
    const before = dbSnapshot(dbPath);
    const permitPath = join(root, "permit.json");
    writeSyncPermit(permitPath, "natural", rows.slice(-63).map((row) => row["row_id"]!));
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", EXPECTED_HISTORY_ROW_COUNT: String(rows.length), HISTORY_TO_DB_SYNC_PERMIT_PATH: permitPath });
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
    const { root } = cliRoot([historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")], [mappedRow("row_1", "hash_1")]);
    expect(runCli(root, {}).status).toBe(0);
    const refused = runCli(root, { HISTORY_TO_DB_SYNC: "1" });
    expect(refused.status).toBe(2);
    expect(refused.parsed["sync_write_refused"]).toBe("true");
    const permitPath = join(root, "permit.json");
    writeSyncPermit(permitPath, "natural", ["row_2"]);
    const ok = runCli(root, { HISTORY_TO_DB_SYNC: "1", HISTORY_TO_DB_SYNC_PERMIT_PATH: permitPath });
    expect(ok.status).toBe(0);
    expect(ok.parsed["decision"]).toBe("fresh_history_to_db_sync_success");
    expect(ok.parsed["mirror_exact_match"]).toBe("true");
    expect(isVerifiedSyncOutput(ok.status, ok.parsed, 2)).toBe(true);
  }, 60_000);

  it("equal DB/history counts with a row_hash mismatch is refused and not verified", () => {
    const { root, dbPath } = cliRoot([historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")], [mappedRow("row_1", "hash_1"), mappedRow("row_2", "hash_OTHER")]);
    const before = dbSnapshot(dbPath);
    const permitPath = join(root, "permit.json");
    writeSyncPermit(permitPath, "natural", []);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", HISTORY_TO_DB_SYNC_PERMIT_PATH: permitPath });
    expect(cli.parsed["history_count"]).toBe(cli.parsed["db_after_count"]); // counts alone would look "aligned"
    expect(cli.parsed["decision"]).toBe("fresh_history_to_db_sync_conflict");
    expect(cli.parsed["mirror_exact_match"]).toBe("false");
    expect(cli.status).toBe(2);
    expect(isVerifiedSyncOutput(cli.status, cli.parsed, 2)).toBe(false);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 60_000);

  it("equal DB/history counts with an insufficient permit is refused and not verified", () => {
    // DB holds one stale row and lacks row_2: 2 == 2 by count, yet not a mirror.
    const { root, dbPath } = cliRoot([historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")], [mappedRow("row_1", "hash_1"), mappedRow("stale_only", "hash_s")]);
    const before = dbSnapshot(dbPath);
    const permitPath = join(root, "permit.json");
    writeSyncPermit(permitPath, "natural", []);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", HISTORY_TO_DB_SYNC_PERMIT_PATH: permitPath });
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
