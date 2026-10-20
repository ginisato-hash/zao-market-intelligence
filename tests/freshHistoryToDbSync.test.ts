import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { closeDatabase, openLocalDatabase } from "../src/db/client";
import { APPROVED_MAPPED_ROW_COUNT, applyRealSync, ensureMirrorSchema } from "../src/services/historyToDbSyncRealRun";
import {
  evaluateFreshSyncGate,
  evaluateMirrorInvariants,
  isVerifiedSyncOutput,
  runFreshHistoryToDbSync,
  SYNC_PERMIT_MAX_ROWS,
  historyWriterLockPath,
  isVerifiedTrustedMirror,
  combineAppendOutcomes,
  rowsActuallyAppended,
  TRUSTED_APPEND_COLLECTED_STATUSES,
  TRUSTED_MIRROR_FLAG,
  trustedAppendAndMirror,
  type TrustedAppendResult,
  type FreshHistoryToDbSyncDecision,
  type FreshHistoryToDbSyncReport
} from "../src/services/freshHistoryToDbSync";
import type { MarketSignalHistoryDryRunRow } from "../src/services/historyToDbSyncDryRun";
import { appendHistoryRowsAtomic } from "../src/services/autoRunnerMarketRefresh";
import { runRealAppend } from "../src/services/localHistoryRealAppend";
import { groupRowsToSourceShards } from "../src/services/bookingPreviewHistoryAppendRealRun";
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

// Mimics an append on the test schema (.bak backup + append-only write) and
// leaves a receipt-style JSON artifact next to it. Since P0-G2 final, such
// artifacts are untrusted: nothing reads them to authorize an INSERT.
function genuineAppend(historyDir: string, runId: string, rows: Array<Record<string, string>>, artifactPath: string, file = "zao_signals_2026_06.csv"): void {
  const path = join(historyDir, file);
  const before = readFileSync(path);
  const headers = before.toString("utf8").split("\n", 1)[0]!.split(",");
  const backupDir = join(historyDir, ".backup", runId);
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, `${file}.bak`), before);
  const after = Buffer.concat([before, Buffer.from(`${rows.map((r) => headers.map((h) => csvCell(r[h] ?? "")).join(",")).join("\n")}\n`, "utf8")]);
  writeFileSync(path, after);
  writeFileSync(artifactPath, JSON.stringify({ version: 1, run_id: runId, shards: [{ file, before_sha256: sha256Hex(before), before_size: before.length, after_sha256: sha256Hex(after), after_size: after.length }], rows: rows.map((r) => ({ row_id: r["row_id"], row_hash: r["row_hash"], shard_file: file })) }));
}

function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

// permit = the row_ids this run genuinely appends (default: all rows, appended
// to a header-only shard), handed over IN MEMORY as trustedRowIds; null = none.
function runHelper(root: string, options: { rows?: Array<Record<string, string>>; dbPath?: string; gate?: string; expected?: string; permit?: string[] | null; hooks?: { afterGateEvaluated?: () => void; afterShardParsed?: (file: string) => void } } = {}): FreshHistoryToDbSyncReport {
  const historyDir = join(root, "history");
  const rows = options.rows ?? [historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")];
  const appendIds = new Set(options.permit === null ? [] : (options.permit ?? rows.map((row) => row["row_id"]!)));
  writeHistory(historyDir, rows.filter((row) => !appendIds.has(row["row_id"]!)));
  if (options.permit !== null) genuineAppend(historyDir, `test_append_${runSequence + 1}`, rows.filter((row) => appendIds.has(row["row_id"]!)), join(root, `artifact_${runSequence + 1}.json`));
  return runFreshHistoryToDbSync({
    runId: `fresh_test_run_${++runSequence}`,
    generatedAtJst: "2026-06-05T16:40:00+09:00",
    historyDir,
    dbPath: options.dbPath ?? join(root, "test.sqlite"),
    reportPath: join(root, "fresh.md"),
    jsonPath: join(root, "fresh.json"),
    csvPath: join(root, "fresh.csv"),
    debugPath: join(root, "debug"),
    expectedHistoryRowCount: options.expected,
    sourceAutoRunner07bArtifact: join(root, "auto07b.json")
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

  it("P0: the legacy API is permanently read-only, even when a caller asks to write with chosen row_ids", () => {
    // TD #6280874842 counterexample: history old_1, old_2, new_3; DB old_1; no append.
    const root = tempRoot();
    const historyDir = join(root, "history");
    writeHistory(historyDir, [historyRow("old_1", "hash_o1"), historyRow("old_2", "hash_o2"), historyRow("new_3", "hash_n3")]);
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("old_1", "hash_o1")]);
    const before = dbSnapshot(dbPath);
    const legacyAsk = { historyToDbSyncGate: "1", trustedRowIds: new Set(["old_2", "new_3"]), testHooks: {} } as unknown as Record<string, never>;
    const report = runFreshHistoryToDbSync({ runId: "p0_direct", generatedAtJst: "2026-10-20T13:00:00+09:00", historyDir, dbPath, reportPath: join(root, "r.md"), jsonPath: join(root, "r.json"), csvPath: join(root, "r.csv"), debugPath: join(root, "d"), expectedHistoryRowCount: undefined, sourceAutoRunner07bArtifact: join(root, "n.json"), ...legacyAsk });
    expect(report.sync_result.db_write_executed).toBe(false);
    expect(report.sync_result.inserted_rows).toBe(0);
    expect(report.decision).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(report.mirror_exact_match).toBe(false);
    expect(dbSnapshot(dbPath)).toBe(before); // rows, schema, sync_runs unchanged
  });

  it("P0: the only DB-writing calls in the sync service are inside trustedAppendAndMirror", () => {
    const trusted = SERVICE_SOURCE.indexOf("export function trustedAppendAndMirror(");
    for (const call of ["openLocalDatabase(", "applyRealSync(", "ensureMirrorSchema(", 'exec("BEGIN IMMEDIATE")', 'exec("COMMIT")']) {
      const at: number[] = [];
      for (let i = SERVICE_SOURCE.indexOf(call); i >= 0; i = SERVICE_SOURCE.indexOf(call, i + 1)) at.push(i);
      expect(at.length).toBeGreaterThan(0);
      for (const i of at) expect(i).toBeGreaterThan(trusted);
    }
    expect(SERVICE_SOURCE).not.toMatch(/trustedRowIds|historyToDbSyncGate/u);
  });

  it("hash conflict is reported and never written", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "hash_old")]);
    const before = dbSnapshot(dbPath);
    const report = runHelper(root, { dbPath, rows: [historyRow("row_1", "hash_new")] });
    expect(report.decision).toBe("fresh_history_to_db_sync_conflict");
    expect(report.sync_result.db_write_executed).toBe(false);
    expect(dbSnapshot(dbPath)).toBe(before);
  });

  it("DB-only rows are reported read-only", () => {
    const root = tempRoot();
    const dbPath = join(root, "test.sqlite");
    seedDb(dbPath, [mappedRow("row_1", "hash_1"), mappedRow("rolled_back_row", "hash_x")]);
    const report = runHelper(root, { dbPath });
    expect(report.gate_result.db_only_row_count).toBe(1);
    expect(report.gate_result.reasons).toContain("DB has 1 row_ids absent from history; approved mirror reconciliation required");
    expect(report.sync_result.db_write_executed).toBe(false);
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

  it("all five scheduled append entries go through trustedAppendAndMirror; none spawns a DB-writing sync", () => {
    const entries = ["runAutoRunnerMarketRefreshRotating.ts", "runAutoRunnerMarketRefresh.ts", "runPricingCriticalRecrawl.ts", "runBookingMarketRecrawlAppendPlan.ts"];
    for (const script of entries) {
      const src = readFileSync(resolve(__dirname, "../src/scripts", script), "utf8");
      expect(src).toContain("trustedAppendAndMirror({");
      expect(src).toMatch(/mirrorEnabled: (env|process\.env)\[TRUSTED_MIRROR_FLAG\] === "1"/u);
      // Every real append call sits inside the trusted writer closure.
      for (const m of src.matchAll(/(appendHistoryRowsAtomic|runRealAppend)\(\{/gu)) {
        expect(src.slice(Math.max(0, m.index! - 220), m.index!)).toMatch(/write: \(r?s?o?w?s?\) => \{/u);
      }
      expect(src).not.toMatch(/HISTORY_TO_DB_SYNC: "1"/u);
      expect(src).not.toMatch(/HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH|EXPECTED_MAX_INSERT_ROWS|writeAppendReceipt/u);
    }
    // pricing-critical's competitor append runs the recrawl append-plan script (5th entry).
    expect(readFileSync(resolve(__dirname, "../src/scripts/runPricingCriticalRecrawl.ts"), "utf8")).toContain('"plan:booking-market-recrawl-append"');
    const rotating = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerMarketRefreshRotating.ts"), "utf8");
    expect(rotating).toContain("dbSynced = isVerifiedTrustedMirror(trustedAppend);");
    expect(rotating).toContain("const aligned = dbSynced && aiContextRefreshed && ");
    expect(rotating).not.toContain("dbSynced = true");
    const live = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerMarketRefresh.ts"), "utf8");
    expect(live).toContain("if (mirrorVerified) aiContextResult = runCommand(\"npm\", [\"run\", \"build:ai-context-packs\"]);");
  });

  it("the trusted mirror is default OFF: no source, script or launchd template sets its flag", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const files = [...walk(resolve(__dirname, "../src")), ...walk(resolve(__dirname, "../ops")), resolve(__dirname, "../package.json")];
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(new RegExp(`${TRUSTED_MIRROR_FLAG}=1|${TRUSTED_MIRROR_FLAG}: "1"`, "u"));
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

describe("P0-G2 insert bound is this run's appended row_ids, not a caller-chosen number", () => {
  const BACKLOG = 68_000;
  const rows = Array.from({ length: BACKLOG + 100 }, (_, i) => historyRow(`row_${String(i).padStart(6, "0")}`, `hash_${i}`));
  const dbRows = rows.slice(0, 100).map((row) => mappedRow(row["row_id"]!, row["row_hash"]!));

  it("refuses a 68,000-row backlog on a DB-only=0 mirror even with EXPECTED_MAX_INSERT_ROWS=68129", () => {
    const { root, dbPath } = cliRoot(rows, dbRows);
    const before = dbSnapshot(dbPath);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", EXPECTED_HISTORY_ROW_COUNT: String(rows.length), EXPECTED_MAX_INSERT_ROWS: "68129" });
    expect(cli.parsed["decision"]).toBe("fresh_history_to_db_sync_ready_not_run");
    expect(cli.parsed["sync_write_refused"]).toBe("true");
    expect(cli.status).toBe(2);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 120_000);

  it("refuses a forged receipt artifact listing the whole 68,000-row backlog", () => {
    const { root, dbPath } = cliRoot(rows, dbRows);
    const before = dbSnapshot(dbPath);
    const receiptPath = join(root, "receipt.json");
    writeFileSync(receiptPath, JSON.stringify({ version: 1, run_id: "forged", shards: [], rows: rows.slice(100).map((row) => ({ row_id: row["row_id"], row_hash: row["row_hash"], shard_file: "zao_signals_2026_06.csv" })) }));
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", EXPECTED_HISTORY_ROW_COUNT: String(rows.length), HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: receiptPath });
    expect(cli.parsed["sync_write_refused"]).toBe("true");
    expect(cli.parsed["inserted_rows"]).toBe("0");
    expect(cli.status).toBe(2);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 120_000);

  it("refuses the backlog even with a genuine append's artifact for this run's 63 rows", () => {
    const { root, dbPath, historyDir } = cliRoot(rows.slice(0, -63), dbRows);
    const receiptPath = join(root, "receipt.json");
    genuineAppend(historyDir, "natural_run", rows.slice(-63), receiptPath);
    const before = dbSnapshot(dbPath);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", EXPECTED_HISTORY_ROW_COUNT: String(rows.length), HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: receiptPath });
    expect(cli.parsed["sync_write_refused"]).toBe("true");
    expect(cli.parsed["inserted_rows"]).toBe("0");
    expect(cli.status).toBe(2);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 120_000);

  it("per-run cap equals one run's page cap at the maximum multiplier", () => {
    expect(SYNC_PERMIT_MAX_ROWS).toBe(150);
  });
});

describe("P0-G3 a refused or unverified sync is never success", () => {
  it("CLI: read-only run exits 0; any write request exits 2, even after a genuine append", () => {
    const { root } = cliRoot([historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")], [mappedRow("row_1", "hash_1"), { ...mappedRow("row_2", "hash_2"), source: "booking" }]);
    expect(runCli(root, {}).status).toBe(0);
    const refused = runCli(root, { HISTORY_TO_DB_SYNC: "1" });
    expect(refused.status).toBe(2);
    expect(refused.parsed["sync_write_refused"]).toBe("true");
    const receiptPath = join(root, "receipt.json");
    genuineAppend(join(root, ".data/history"), "natural_run", [historyRow("row_3", "hash_3")], receiptPath);
    const still = runCli(root, { HISTORY_TO_DB_SYNC: "1", HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: receiptPath });
    expect(still.status).toBe(2);
    expect(still.parsed["inserted_rows"]).toBe("0");
    expect(still.parsed["sync_write_refused_reason"]).toContain("direct CLI DB writes are disabled");
    expect(isVerifiedSyncOutput(still.status, still.parsed, 3)).toBe(false);
    const readOnly = runCli(root, {});
    expect(readOnly.status).toBe(0);
    expect(readOnly.parsed["mirror_exact_match"]).toBe("false"); // row_3 is not mirrored by the CLI
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
// TD 2026-10-20 P0-G2 final (private #13 #6280295102, implementation GO):
// the DB is written only by trustedAppendAndMirror, in the process that did the
// append, under the shared history-writer lock. Files, env and the CLI can never
// authorize an INSERT.

describe("P0-G2 final: caller-forged backup + receipt without any append (formerly it.fails)", () => {
  const SHARD = "zao_signals_2026_06.csv";
  function forged(beforeRows: Array<Record<string, string>> | null, claimed: Array<[string, string]>): { root: string; dbPath: string; historyDir: string; receiptPath: string } {
    const root = tempRoot();
    const historyDir = join(root, ".data/history");
    writeHistory(historyDir, [historyRow("old_1", "hash_o1"), historyRow("old_2", "hash_o2"), historyRow("new_3", "hash_n3")]); // no append is executed
    const dbPath = join(root, ".data/zao-market-intelligence.sqlite");
    seedDb(dbPath, [mappedRow("old_1", "hash_o1")]); // DB-only 0
    const current = readFileSync(join(historyDir, SHARD));
    const header = `${current.toString("utf8").split("\n", 1)[0]}\n`;
    const bak = beforeRows === null ? Buffer.alloc(0) : Buffer.from(header + beforeRows.map((r) => historyCsvLine(r)).join("\n") + "\n");
    mkdirSync(join(historyDir, ".backup", "forged_run"), { recursive: true });
    writeFileSync(join(historyDir, ".backup", "forged_run", `${SHARD}.bak`), bak);
    const receiptPath = join(root, "forged.json");
    writeFileSync(receiptPath, JSON.stringify({ version: 1, run_id: "forged_run", shards: [{ file: SHARD, before_sha256: sha256Hex(bak), before_size: bak.length, after_sha256: sha256Hex(current), after_size: current.length }], rows: claimed.map(([row_id, row_hash]) => ({ row_id, row_hash, shard_file: SHARD })) }));
    return { root, dbPath, historyDir, receiptPath };
  }
  function expectRefusedUnchanged(root: string, dbPath: string, receiptPath: string): void {
    const before = dbSnapshot(dbPath);
    const cli = runCli(root, { HISTORY_TO_DB_SYNC: "1", HISTORY_TO_DB_SYNC_APPEND_RECEIPT_PATH: receiptPath, EXPECTED_MAX_INSERT_ROWS: "68129" });
    expect(cli.parsed["inserted_rows"]).toBe("0");
    expect(cli.status).toBe(2);
    expect(isVerifiedSyncOutput(cli.status, cli.parsed, 3)).toBe(false); // no AI context refresh / publish
    expect(dbSnapshot(dbPath)).toBe(before); // rows, schema, sync_runs unchanged
  }

  it("forged .bak = header + old_1 and receipt claiming old_2, new_3 authorizes no INSERT", () => {
    const { root, dbPath, receiptPath } = forged([historyRow("old_1", "hash_o1")], [["old_2", "hash_o2"], ["new_3", "hash_n3"]]);
    expectRefusedUnchanged(root, dbPath, receiptPath);
  }, 60_000);

  it("forged empty .bak for a shard never backed up promotes nothing", () => {
    const { root, dbPath, receiptPath } = forged(null, [["old_1", "hash_o1"], ["old_2", "hash_o2"], ["new_3", "hash_n3"]]);
    expectRefusedUnchanged(root, dbPath, receiptPath);
  }, 60_000);

  it("the trusted path ignores those artifacts: a real new append on that DB is append-only (no backfill of old_2/new_3)", () => {
    const { root, dbPath, historyDir } = forged([historyRow("old_1", "hash_o1")], [["old_2", "hash_o2"], ["new_3", "hash_n3"]]);
    const before = dbSnapshot(dbPath);
    const r = trustedAppendAndMirror({ historyDir, dbPath, runId: "real_run", generatedAtJst: "2026-10-20T10:00:00+09:00", rows: [], maxRows: 150, captureDir: join(root, "cap"), mirrorEnabled: true, write: () => { throw new Error("not called"); } });
    expect(r.status).toBe("NOTHING_TO_APPEND");
    expect(isVerifiedTrustedMirror(r)).toBe(false);
    expect(dbSnapshot(dbPath)).toBe(before);
  });
});

function historyCsvLine(row: Record<string, string>): string {
  const headers = ["row_id", "row_hash", "shard_month", "collected_date_jst", "collected_at_jst", "normalized_at_jst", "source", "canonical_property_name", "source_property_id", "checkin", "checkout", "stay_scope", "availability_status", "basis_confidence", "debug_artifact_path", "schema_version", "source_url", "normalized_total_jpy", "price_basis", "dp_usage", "classification", "exclusion_reason"];
  return headers.map((h) => csvCell(row[h] ?? "")).join(",");
}

describe("P0-G2 final: trusted in-process append + mirror", () => {
  const AT = "2026-10-20T10:00:00+09:00";
  interface Fx { root: string; historyDir: string; dbPath: string }
  function atomicWriter(historyDir: string, runId: string): (rows: HistoryRow[]) => void {
    return (rows) => { appendHistoryRowsAtomic({ rows, historyDir, backupDir: join(historyDir, ".backup", runId), historyBefore: 0 }); };
  }
  function run(fx: Fx, runId: string, rows: HistoryRow[], opts: { mirror?: boolean; write?: (rows: HistoryRow[]) => void; lockWaitMs?: number } = {}): TrustedAppendResult {
    return trustedAppendAndMirror({ historyDir: fx.historyDir, dbPath: fx.dbPath, runId, generatedAtJst: AT, rows, maxRows: 150, captureDir: join(fx.root, "capture"), mirrorEnabled: opts.mirror ?? true, lockWaitMs: opts.lockWaitMs ?? 2_000, write: opts.write ?? atomicWriter(fx.historyDir, runId) });
  }
  // History and DB start as an exact mirror (both built by the trusted path).
  function mirrored(): Fx {
    const root = tempRoot();
    const fx = { root, historyDir: join(root, ".data/history"), dbPath: join(root, ".data/zao-market-intelligence.sqlite") };
    mkdirSync(fx.historyDir, { recursive: true });
    const r = run(fx, "seed_run", [liveHistoryRow("live_1"), liveHistoryRow("live_2")]);
    expect(r.status).toBe("MIRRORED");
    return fx;
  }
  const shardText = (fx: Fx, shard = "2026_11"): string => (existsSync(join(fx.historyDir, `zao_signals_${shard}.csv`)) ? readFileSync(join(fx.historyDir, `zao_signals_${shard}.csv`), "utf8") : "");

  it("normal append to an existing shard mirrors exactly W", () => {
    const fx = mirrored();
    const r = run(fx, "run_a", [liveHistoryRow("live_3")]);
    expect(r).toMatchObject({ status: "MIRRORED", state: "consistent", rows_appended: 1, inserted_rows: 1, mirror_exact_match: true });
    expect(isVerifiedTrustedMirror(r)).toBe(true);
  });

  it("normal append creating a new shard mirrors exactly W", () => {
    const fx = mirrored();
    const r = run(fx, "run_new", [liveHistoryRow("live_dec", "2026_12")]);
    expect(r).toMatchObject({ status: "MIRRORED", rows_appended: 1, inserted_rows: 1, mirror_exact_match: true });
    expect(shardText(fx, "2026_12")).toContain("live_dec");
  });

  it("runRealAppend (whole-shard rebuild) is verified against before/after history and mirrored", () => {
    const fx = mirrored();
    const r = run(fx, "recrawl_run", [liveHistoryRow("recrawl_1")], { write: (rows) => {
      const res = runRealAppend({ historyDir: fx.historyDir, runId: "recrawl_run", backupTimestamp: "20261020_100000", sourceShards: groupRowsToSourceShards(rows) });
      if (res.decision !== "local_history_real_append_success") throw new Error(res.decision);
    } });
    expect(r).toMatchObject({ status: "MIRRORED", rows_appended: 1, inserted_rows: 1, mirror_exact_match: true });
  });

  it.each([
    ["changes an existing row", (fx: Fx) => (rows: HistoryRow[]) => { appendHistoryRowsAtomic({ rows, historyDir: fx.historyDir, backupDir: join(fx.historyDir, ".backup", "x"), historyBefore: 0 }); writeFileSync(join(fx.historyDir, "zao_signals_2026_11.csv"), shardText(fx).replace("蔵王国際ホテル", "改ざん")); }, /existing row changed/u],
    ["removes an existing row", (fx: Fx) => (rows: HistoryRow[]) => { appendHistoryRowsAtomic({ rows, historyDir: fx.historyDir, backupDir: join(fx.historyDir, ".backup", "x"), historyBefore: 0 }); const lines = shardText(fx).split("\n"); writeFileSync(join(fx.historyDir, "zao_signals_2026_11.csv"), [lines[0], ...lines.slice(2)].join("\n")); }, /existing row removed/u],
    ["appends an extra unintended row", (fx: Fx) => (rows: HistoryRow[]) => { appendHistoryRowsAtomic({ rows: [...rows, liveHistoryRow("extra_backfill")], historyDir: fx.historyDir, backupDir: join(fx.historyDir, ".backup", "x"), historyBefore: 0 }); }, /unexpected row appended: extra_backfill/u]
  ])("refuses to mirror when the writer %s", (_label, makeWriter, reason) => {
    const fx = mirrored();
    const before = dbSnapshot(fx.dbPath);
    const r = run(fx, "bad_run", [liveHistoryRow("live_9")], { write: makeWriter(fx) });
    expect(r.status).toBe("HISTORY_APPEND_UNVERIFIED_MIRROR_BLOCKED");
    expect(r.reasons.join("|")).toMatch(reason);
    expect(isVerifiedTrustedMirror(r)).toBe(false);
    expect(dbSnapshot(fx.dbPath)).toBe(before); // rows, schema, sync_runs
  });

  it("re-processing the same observation appends nothing and stays verified", () => {
    const fx = mirrored();
    const r = run(fx, "rerun", [liveHistoryRow("live_1")]);
    expect(r).toMatchObject({ status: "NOTHING_TO_APPEND", rows_skipped_identical: 1, mirror_exact_match: true });
    expect(isVerifiedTrustedMirror(r)).toBe(true);
  });

  it("a row_id already in history with another row_hash appends nothing and preserves the capture", () => {
    const fx = mirrored();
    const historyBefore = shardText(fx);
    const r = run(fx, "conflict_run", [{ ...liveHistoryRow("live_1"), rowHash: "different" }]);
    expect(r.status).toBe("APPEND_CONFLICT_CAPTURE_PRESERVED");
    expect(shardText(fx)).toBe(historyBefore);
    expect(existsSync(r.capture_path!)).toBe(true);
  });

  it("default OFF: a consistent DB is not written when the mirror flag is off (append-only)", () => {
    const fx = mirrored();
    const before = dbSnapshot(fx.dbPath);
    const r = run(fx, "flag_off", [liveHistoryRow("live_4")], { mirror: false });
    expect(r.status).toBe("HISTORY_APPENDED_MIRROR_DISABLED");
    expect(r.reasons.join("|")).toContain(`${TRUSTED_MIRROR_FLAG} is not 1`);
    expect(shardText(fx)).toContain("live_4");
    expect(dbSnapshot(fx.dbPath)).toBe(before);
  });

  it("current production shape (DB-only rows): append-only, DB/schema/sync_runs untouched, no backfill, not verified", () => {
    const fx = mirrored();
    seedDb(fx.dbPath, [mappedRow("rolled_back_488_like", "h")], "db_only_seed"); // DB-only row like the 488
    const before = dbSnapshot(fx.dbPath);
    const r = run(fx, "degraded", [liveHistoryRow("live_5")]);
    expect(r).toMatchObject({ status: "HISTORY_APPENDED_MIRROR_BLOCKED", state: "inconsistent", rows_appended: 1, inserted_rows: 0 });
    expect(isVerifiedTrustedMirror(r)).toBe(false); // no AI context / publish
    expect(shardText(fx)).toContain("live_5");
    expect(dbSnapshot(fx.dbPath)).toBe(before);
  });

  it("an unreadable DB is STATE_UNKNOWN: no append at all", () => {
    const fx = mirrored();
    writeFileSync(fx.dbPath, "not a database");
    const historyBefore = shardText(fx);
    const r = run(fx, "unknown", [liveHistoryRow("live_6")]);
    expect(r.status).toBe("STATE_UNKNOWN_CAPTURE_PRESERVED");
    expect(shardText(fx)).toBe(historyBefore);
  });

  it("history-writer lock held by another writer: no append (consistent and degraded state)", () => {
    for (const degraded of [false, true]) {
      const fx = mirrored();
      if (degraded) seedDb(fx.dbPath, [mappedRow("db_only", "h")], "db_only_seed");
      const before = dbSnapshot(fx.dbPath);
      const historyBefore = shardText(fx);
      const other = new Database(historyWriterLockPath(fx.historyDir));
      other.exec("BEGIN EXCLUSIVE");
      try {
        const r = run(fx, "contended", [liveHistoryRow("live_7")], { lockWaitMs: 300 });
        expect(r.status).toBe("LOCK_BUSY_CAPTURE_PRESERVED");
        expect(r.reasons).toContain("history writer lock busy");
        expect(existsSync(r.capture_path!)).toBe(true);
      } finally {
        other.exec("ROLLBACK");
        other.close();
      }
      expect(shardText(fx)).toBe(historyBefore);
      expect(dbSnapshot(fx.dbPath)).toBe(before);
    }
  });

  it("DB writer lock held by another connection: no append in the normal state", () => {
    const fx = mirrored();
    const before = dbSnapshot(fx.dbPath);
    const historyBefore = shardText(fx);
    const other = new Database(fx.dbPath);
    other.exec("BEGIN IMMEDIATE");
    try {
      const r = run(fx, "db_contended", [liveHistoryRow("live_8")], { lockWaitMs: 300 });
      expect(r.status).toBe("LOCK_BUSY_CAPTURE_PRESERVED");
      expect(r.reasons).toContain("DB writer lock busy");
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect(shardText(fx)).toBe(historyBefore);
    expect(dbSnapshot(fx.dbPath)).toBe(before);
  });

  it("a multi-shard append failing midway leaves the DB unchanged and later runs mirror-blocked (no auto-repair)", () => {
    const fx = mirrored();
    const before = dbSnapshot(fx.dbPath);
    const r = run(fx, "partial", [liveHistoryRow("nov_ok"), liveHistoryRow("dec_fail", "2026_12")], { write: (rows) => {
      appendHistoryRowsAtomic({ rows: rows.filter((x) => x.shardMonth === "2026_11"), historyDir: fx.historyDir, backupDir: join(fx.historyDir, ".backup", "partial"), historyBefore: 0 });
      throw new Error("disk error on second shard");
    } });
    expect(r.status).toBe("HISTORY_APPEND_FAILED_MIRROR_BLOCKED");
    expect(r.rows_appended).toBe(1);
    expect((JSON.parse(readFileSync(r.capture_path!, "utf8")) as { rows: HistoryRow[] }).rows.map((x) => x.rowId)).toEqual(["dec_fail"]); // the unappended row is preserved
    expect(dbSnapshot(fx.dbPath)).toBe(before);
    expect(shardText(fx)).toContain("nov_ok"); // the partial row stays: nothing is deleted or restored
    const next = run(fx, "after_partial", [liveHistoryRow("live_10")]);
    expect(next.status).toBe("HISTORY_APPENDED_MIRROR_BLOCKED");
    expect(dbSnapshot(fx.dbPath)).toBe(before);
  });

  // Crash injection: a separate OS process runs the trusted path and dies at a hook.
  function childRun(fx: Fx, runId: string, rows: HistoryRow[], extra: { exitAt?: string; holdMs?: number } = {}): { status: number | null; result: TrustedAppendResult | null; stderr: string } {
    const script = join(fx.root, `child_${runId}.mts`);
    writeFileSync(script, `
import { join } from "node:path";
const svc = await import(${JSON.stringify(resolve(REPO_ROOT, "src/services/freshHistoryToDbSync.ts"))});
const arm = await import(${JSON.stringify(resolve(REPO_ROOT, "src/services/autoRunnerMarketRefresh.ts"))});
const cfg = ${JSON.stringify({ historyDir: fx.historyDir, dbPath: fx.dbPath, runId, rows, maxRows: 150, captureDir: join(fx.root, "capture"), ...extra })};
const hooks: Record<string, () => void> = {};
if (cfg.exitAt) hooks[cfg.exitAt] = () => process.exit(9);
if (cfg.holdMs) hooks.afterLock = () => { const end = Date.now() + cfg.holdMs; while (Date.now() < end) { /* hold the lock */ } };
const r = svc.trustedAppendAndMirror({ historyDir: cfg.historyDir, dbPath: cfg.dbPath, runId: cfg.runId, generatedAtJst: ${JSON.stringify(AT)}, rows: cfg.rows, maxRows: 150, captureDir: cfg.captureDir, mirrorEnabled: true, lockWaitMs: 20000, hooks,
  write: (rows: unknown[]) => { arm.appendHistoryRowsAtomic({ rows, historyDir: cfg.historyDir, backupDir: join(cfg.historyDir, ".backup", cfg.runId), historyBefore: 0 }); } });
console.log("RESULT=" + JSON.stringify(r));
`);
    const r = spawnSync(process.execPath, ["--import", TSX_LOADER, script], { cwd: REPO_ROOT, encoding: "utf8" });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT="));
    return { status: r.status, result: line === undefined ? null : JSON.parse(line.slice(7)) as TrustedAppendResult, stderr: r.stderr };
  }

  it.each([["afterAppend"], ["beforeCommit"]])("crash at %s: DB unchanged, lock released, next run mirror-blocked", (exitAt) => {
    const fx = mirrored();
    const before = dbSnapshot(fx.dbPath);
    const child = childRun(fx, `crash_${exitAt}`, [liveHistoryRow(`crash_${exitAt}`)], { exitAt });
    expect(child.status).toBe(9);
    expect(shardText(fx)).toContain(`crash_${exitAt}`); // the CSV rename survived the crash
    expect(dbSnapshot(fx.dbPath)).toBe(before); // uncommitted DB work rolled back by SQLite
    const db = new Database(fx.dbPath, { readonly: true });
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
    const next = run(fx, `after_${exitAt}`, [liveHistoryRow(`next_${exitAt}`)], { lockWaitMs: 1_000 }); // lock was released by the OS
    expect(next.status).toBe("HISTORY_APPENDED_MIRROR_BLOCKED");
    expect(dbSnapshot(fx.dbPath)).toBe(before);
  }, 60_000);

  it("crash right after COMMIT: DB == history, next run mirrors normally", () => {
    const fx = mirrored();
    const child = childRun(fx, "crash_afterCommit", [liveHistoryRow("committed_then_crash")], { exitAt: "afterCommit" });
    expect(child.status).toBe(9);
    const next = run(fx, "after_commit_crash", [liveHistoryRow("next_after_commit")], { lockWaitMs: 1_000 });
    expect(next).toMatchObject({ status: "MIRRORED", inserted_rows: 1, mirror_exact_match: true });
  }, 60_000);

  it("two concurrent writer processes are serialized and both mirrored exactly", () => {
    const fx = mirrored();
    // A starts first and holds the lock for 1.5 s; B starts 0.4 s later and must wait, not fail.
    const results = parallelChildren(fx, [["par_a", [liveHistoryRow("par_a")], 1500], ["par_b", [liveHistoryRow("par_b")], 0]]);
    expect(results.map((r) => r?.status).sort()).toEqual(["MIRRORED", "MIRRORED"]);
    const db = new Database(fx.dbPath, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM market_signal_history").get() as { c: number }).c).toBe(4);
    db.close();
    const check = run(fx, "post_parallel", [liveHistoryRow("par_a")]);
    expect(check).toMatchObject({ status: "NOTHING_TO_APPEND", mirror_exact_match: true });
  }, 60_000);

  function parallelChildren(fx: Fx, jobs: Array<[string, HistoryRow[], number]>): Array<TrustedAppendResult | null> {
    // Launch every child before waiting on any, via a tiny bash fan-out.
    const scripts = jobs.map(([runId, rows, holdMs]) => {
      const script = join(fx.root, `child_${runId}.mts`);
      writeFileSync(script, `
import { join } from "node:path";
const svc = await import(${JSON.stringify(resolve(REPO_ROOT, "src/services/freshHistoryToDbSync.ts"))});
const arm = await import(${JSON.stringify(resolve(REPO_ROOT, "src/services/autoRunnerMarketRefresh.ts"))});
const hooks = ${holdMs} > 0 ? { afterLock: () => { const end = Date.now() + ${holdMs}; while (Date.now() < end) { /* hold */ } } } : {};
const r = svc.trustedAppendAndMirror({ historyDir: ${JSON.stringify(fx.historyDir)}, dbPath: ${JSON.stringify(fx.dbPath)}, runId: ${JSON.stringify(runId)}, generatedAtJst: ${JSON.stringify(AT)}, rows: ${JSON.stringify(rows)}, maxRows: 150, captureDir: ${JSON.stringify(join(fx.root, "capture"))}, mirrorEnabled: true, lockWaitMs: 20000, hooks,
  write: (rows: unknown[]) => { arm.appendHistoryRowsAtomic({ rows, historyDir: ${JSON.stringify(fx.historyDir)}, backupDir: join(${JSON.stringify(fx.historyDir)}, ".backup", ${JSON.stringify(runId)}), historyBefore: 0 }); } });
console.log("RESULT=" + JSON.stringify(r));
`);
      return script;
    });
    const cmd = scripts.map((sc, i) => `("${process.execPath}" --import "${TSX_LOADER}" "${sc}" > "${sc}.out" 2>&1) & ${i === 0 ? "sleep 0.4;" : ""}`).join(" ") + " wait";
    spawnSync("bash", ["-c", cmd], { cwd: REPO_ROOT, encoding: "utf8" });
    return scripts.map((sc) => {
      const line = readFileSync(`${sc}.out`, "utf8").split("\n").find((l) => l.startsWith("RESULT="));
      return line === undefined ? null : JSON.parse(line.slice(7)) as TrustedAppendResult;
    });
  }

  it("isVerifiedTrustedMirror is false for every non-mirrored outcome", () => {
    const base: TrustedAppendResult = { status: "MIRRORED", state: "consistent", mirror_enabled: true, rows_requested: 1, rows_skipped_identical: 0, rows_appended: 1, inserted_rows: 1, history_rows_before: 1, history_rows_after: 2, db_rows_before: 1, db_rows_after: 2, mirror_exact_match: true, lock_wait_ms: 0, capture_path: null, reasons: [], appended_row_ids: ["x"] };
    expect(isVerifiedTrustedMirror(base)).toBe(true);
    for (const status of ["HISTORY_APPENDED_MIRROR_DISABLED", "HISTORY_APPENDED_MIRROR_BLOCKED", "HISTORY_APPEND_FAILED_MIRROR_BLOCKED", "HISTORY_APPEND_UNVERIFIED_MIRROR_BLOCKED", "MIRROR_FAILED_ROLLED_BACK", "LOCK_BUSY_CAPTURE_PRESERVED", "STATE_UNKNOWN_CAPTURE_PRESERVED", "APPEND_CONFLICT_CAPTURE_PRESERVED"] as const) {
      expect(isVerifiedTrustedMirror({ ...base, status })).toBe(false);
    }
    expect(isVerifiedTrustedMirror({ ...base, mirror_exact_match: false })).toBe(false);
    expect(isVerifiedTrustedMirror({ ...base, mirror_enabled: false })).toBe(false);
    expect(isVerifiedTrustedMirror({ ...base, status: "NOTHING_TO_APPEND", state: "inconsistent" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TD 2026-10-20: P0-G1 parsed-bytes digest (accepted) on the in-process write path.

describe("P0-G1 on the trusted path: point-of-use re-checks, parsed-bytes digest, rollback", () => {
  const AT = "2026-10-20T13:00:00+09:00";
  function setup(): { root: string; historyDir: string; dbPath: string } {
    const root = tempRoot();
    const fx = { root, historyDir: join(root, ".data/history"), dbPath: join(root, ".data/zao-market-intelligence.sqlite") };
    mkdirSync(fx.historyDir, { recursive: true });
    const seed = trustedAppendAndMirror({ ...base(fx, "seed"), rows: [liveHistoryRow("g1_1"), liveHistoryRow("g1_2")] });
    expect(seed.status).toBe("MIRRORED");
    return fx;
  }
  function base(fx: { root: string; historyDir: string; dbPath: string }, runId: string) {
    return { historyDir: fx.historyDir, dbPath: fx.dbPath, runId, generatedAtJst: AT, maxRows: 150, captureDir: join(fx.root, "capture"), mirrorEnabled: true, lockWaitMs: 2_000,
      write: (rows: HistoryRow[]) => { appendHistoryRowsAtomic({ rows, historyDir: fx.historyDir, backupDir: join(fx.historyDir, ".backup", runId), historyBefore: 0 }); } };
  }
  it.each([
    ["DB row_hash changed by another process", "UPDATE market_signal_history SET row_hash = 'tampered' WHERE row_id = 'g1_1'"],
    ["DB-only row created by another process", "UPDATE market_signal_history SET row_id = 'injected_db_only' WHERE row_id = 'g1_1'"]
  ])("refuses before appending when %s after classification", (_label, sql) => {
    const fx = setup();
    const historyBefore = readFileSync(join(fx.historyDir, "zao_signals_2026_11.csv"), "utf8");
    let afterInjection = "";
    const r = trustedAppendAndMirror({ ...base(fx, "g1_poi"), rows: [liveHistoryRow("g1_3")], hooks: { afterClassify: () => { mutateInChildProcess(fx.dbPath, sql); afterInjection = dbSnapshot(fx.dbPath); } } });
    expect(r.status).toBe("STATE_UNKNOWN_CAPTURE_PRESERVED");
    expect(r.reasons).toContain("DB changed between classification and write lock");
    expect(readFileSync(join(fx.historyDir, "zao_signals_2026_11.csv"), "utf8")).toBe(historyBefore); // no append
    expect(dbSnapshot(fx.dbPath)).toBe(afterInjection); // the trusted path wrote nothing
  });

  it("an unlocked writer appending to a shard right after it was parsed blocks the mirror (parsed-bytes digest)", () => {
    const fx = setup();
    const before = dbSnapshot(fx.dbPath);
    let injected = false;
    const r = trustedAppendAndMirror({ ...base(fx, "g1_race"), rows: [liveHistoryRow("g1_4")], hooks: { afterShardParsed: (file) => {
      if (injected) return;
      injected = true; // another OS process appends a row to the shard that was just parsed
      const line = readFileSync(join(fx.historyDir, "zao_signals_2026_11.csv"), "utf8").trimEnd().split("\n").pop()!.replace(/^g1_2,hash_g1_2/u, "late_row,hash_late");
      const c = spawnSync(process.execPath, ["-e", `require("node:fs").appendFileSync(${JSON.stringify(join(fx.historyDir, "zao_signals_2026_11.csv"))}, ${JSON.stringify(`${line}\n`)})`], { encoding: "utf8" });
      if (c.status !== 0) throw new Error(c.stderr);
    } } });
    expect(injected).toBe(true);
    expect(r.status).toBe("HISTORY_APPEND_UNVERIFIED_MIRROR_BLOCKED");
    expect(r.reasons.join("|")).toContain("unexpected row appended: late_row");
    expect(dbSnapshot(fx.dbPath)).toBe(before);
  });

  it("an INSERT failing inside the locked transaction rolls the whole mirror back", () => {
    const fx = setup();
    const db = new Database(fx.dbPath);
    db.exec("CREATE TRIGGER inject_fail AFTER INSERT ON market_signal_history WHEN NEW.row_id = 'g1_5' BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;");
    db.close();
    const before = dbSnapshot(fx.dbPath);
    const r = trustedAppendAndMirror({ ...base(fx, "g1_rb"), rows: [liveHistoryRow("g1_5")] });
    expect(r.status).toBe("MIRROR_FAILED_ROLLED_BACK");
    expect(r.reasons.join("|")).toContain("injected_failure");
    expect(isVerifiedTrustedMirror(r)).toBe(false);
    expect(dbSnapshot(fx.dbPath)).toBe(before); // no row, no sync_run, no schema change
  });
});

describe("TD #6280874842 P1/release gate", () => {
  const AT = "2026-10-20T13:00:00+09:00";
  function fx(): { root: string; historyDir: string; dbPath: string } {
    const root = tempRoot();
    const f = { root, historyDir: join(root, ".data/history"), dbPath: join(root, ".data/zao-market-intelligence.sqlite") };
    mkdirSync(f.historyDir, { recursive: true });
    return f;
  }
  function call(f: { root: string; historyDir: string; dbPath: string }, runId: string, rows: HistoryRow[], extra: Partial<Parameters<typeof trustedAppendAndMirror>[0]> = {}): TrustedAppendResult {
    return trustedAppendAndMirror({ historyDir: f.historyDir, dbPath: f.dbPath, runId, generatedAtJst: AT, rows, maxRows: 150, captureDir: join(f.root, "capture"), mirrorEnabled: true, lockWaitMs: 1_000,
      write: (rs) => { appendHistoryRowsAtomic({ rows: rs, historyDir: f.historyDir, backupDir: join(f.historyDir, ".backup", runId), historyBefore: 0 }); }, ...extra });
  }

  it("evidence covers only W: 10 approved rows of which another job already appended 7 -> 3", () => {
    const f = fx();
    const approved = Array.from({ length: 10 }, (_, i) => liveHistoryRow(`ev_${i}`));
    expect(call(f, "other_job", approved.slice(0, 7)).status).toBe("MIRRORED"); // the parallel job got there first
    const r = call(f, "this_run", approved);
    expect(r).toMatchObject({ status: "MIRRORED", rows_appended: 3, rows_skipped_identical: 7 });
    expect(rowsActuallyAppended(approved, r).map((x) => x.rowId)).toEqual(["ev_7", "ev_8", "ev_9"]);
    const rotating = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerMarketRefreshRotating.ts"), "utf8");
    expect(rotating).toContain("exportEvidenceSidecar(rowsActuallyAppended(appendPlan.approved_rows, trustedAppend), bookingEvidence, runId)");
    expect(rotating).not.toMatch(/exportEvidenceSidecar\(appendPlan\.approved_rows/u);
  });

  it("a new row whose 45 columns differ from the intended HistoryRow is not mirrored (same row_id and row_hash)", () => {
    const f = fx();
    expect(call(f, "seed", [liveHistoryRow("c45_1")]).status).toBe("MIRRORED");
    const before = dbSnapshot(f.dbPath);
    const intended = liveHistoryRow("c45_2");
    const r = call(f, "tamper", [intended], { write: (rs) => { appendHistoryRowsAtomic({ rows: rs.map((x) => ({ ...x, normalizedTotalPrice: 99_999 })), historyDir: f.historyDir, backupDir: join(f.historyDir, ".backup", "tamper"), historyBefore: 0 }); } });
    expect(r.status).toBe("HISTORY_APPEND_UNVERIFIED_MIRROR_BLOCKED");
    expect(r.reasons.join("|")).toContain("appended row differs from the intended 45 columns: c45_2");
    expect(dbSnapshot(f.dbPath)).toBe(before);
  });

  it("pricing-critical: a failed or unappended part is a partial failure, never append_ready", () => {
    expect(combineAppendOutcomes([{ name: "competitor", attempted: true, exitCode: 0, status: "MIRRORED" }, { name: "own", attempted: true, status: "HISTORY_APPENDED_MIRROR_BLOCKED" }]).ok).toBe(true);
    expect(combineAppendOutcomes([{ name: "competitor", attempted: true, exitCode: 1, status: "LOCK_BUSY_CAPTURE_PRESERVED" }, { name: "own", attempted: true, status: "MIRRORED" }])).toEqual({ ok: false, failed: ["competitor:LOCK_BUSY_CAPTURE_PRESERVED(exit 1)"] });
    expect(combineAppendOutcomes([{ name: "competitor", attempted: true, exitCode: 0, status: null }]).ok).toBe(false); // exit 0 without a collected status
    expect(combineAppendOutcomes([{ name: "own", attempted: true, status: "STATE_UNKNOWN_CAPTURE_PRESERVED" }]).ok).toBe(false);
    expect(combineAppendOutcomes([]).ok).toBe(true);
    for (const st of TRUSTED_APPEND_COLLECTED_STATUSES) expect(combineAppendOutcomes([{ name: "x", attempted: true, exitCode: 0, status: st }]).ok).toBe(true);
    const src = readFileSync(resolve(__dirname, "../src/scripts/runPricingCriticalRecrawl.ts"), "utf8");
    expect(src).toContain('appendParts.push({ name: "competitor", attempted: true, exitCode: spawnResult.status, status: childStatus });');
    expect(src).toContain("const outcome = combineAppendOutcomes(appendParts);");
    expect(src).toMatch(/decision=pricing_critical_recrawl_append_partial_failure`\);\n\s+process\.exitCode = 1;/u);
    expect(src.match(/decision=pricing_critical_recrawl_append_ready/gu)?.length).toBe(1);
    expect(src).toMatch(/if \(outcome\.ok\) \{\n\s+console\.log\(`decision=pricing_critical_recrawl_append_ready`\);/u);
  });

  it("legacy .append.lock without a live owner record is a busy writer at any age (never removed by mtime)", () => {
    const f = fx();
    expect(call(f, "seed", [liveHistoryRow("lk_1")]).status).toBe("MIRRORED");
    const lock = join(f.historyDir, ".append.lock");
    writeFileSync(lock, "manual_run\n2026-10-20T00:00:00.000Z\n"); // old format, no pid
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(lock, old, old); // 2 h old: runRealAppend's age rule would delete it
    const shard = readFileSync(join(f.historyDir, "zao_signals_2026_11.csv"), "utf8");
    const r = call(f, "blocked_by_manual", [liveHistoryRow("lk_2")]);
    expect(r.status).toBe("LOCK_BUSY_CAPTURE_PRESERVED");
    expect(r.reasons.join("|")).toMatch(/\.append\.lock present \(manual_run, no pid, \d+ min old\); operator must inspect and remove/u);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(join(f.historyDir, "zao_signals_2026_11.csv"), "utf8")).toBe(shard);
  });

  it("legacy .append.lock is never removed automatically, even when its recorded pid is dead (operator removes it)", () => {
    const f = fx();
    expect(call(f, "seed", [liveHistoryRow("lk_3")]).status).toBe("MIRRORED");
    const lock = join(f.historyDir, ".append.lock");
    writeFileSync(lock, `live\nx\npid=${process.pid}\nhost=${hostname()}\n`);
    expect(call(f, "live_owner", [liveHistoryRow("lk_4")]).status).toBe("LOCK_BUSY_CAPTURE_PRESERVED");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(lock, `crashed\nx\npid=${dead.stdout}\nhost=${hostname()}\n`);
    const r = call(f, "after_crash", [liveHistoryRow("lk_5")]);
    expect(r.status).toBe("LOCK_BUSY_CAPTURE_PRESERVED"); // no check-then-delete race: a replaced lock is never removed
    expect(r.reasons.join("|")).toContain(`pid ${dead.stdout}`);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock); // operator inspection + manual removal
    expect(call(f, "after_operator", [liveHistoryRow("lk_5")]).status).toBe("MIRRORED");
  });

  it("refuses input above the job's legal per-run cap before any lock or append (rows preserved)", () => {
    const f = fx();
    expect(call(f, "seed", [liveHistoryRow("cap_0")]).status).toBe("MIRRORED");
    const before = dbSnapshot(f.dbPath);
    const shard = readFileSync(join(f.historyDir, "zao_signals_2026_11.csv"), "utf8");
    const rows = Array.from({ length: 9 }, (_, i) => liveHistoryRow(`cap_${i + 1}`));
    const r = call(f, "over_cap", rows, { maxRows: 8 }); // pricing-critical batch cap
    expect(r.status).toBe("APPEND_CAP_EXCEEDED_CAPTURE_PRESERVED");
    expect(r.reasons).toContain("9 rows > per-run cap 8");
    expect((JSON.parse(readFileSync(r.capture_path!, "utf8")) as { rows: HistoryRow[] }).rows).toHaveLength(9);
    expect(readFileSync(join(f.historyDir, "zao_signals_2026_11.csv"), "utf8")).toBe(shard);
    expect(dbSnapshot(f.dbPath)).toBe(before);
    expect(call(f, "global_cap", Array.from({ length: 151 }, (_, i) => liveHistoryRow(`g_${i}`)), { maxRows: 10_000 }).reasons).toContain("151 rows > per-run cap 150");
    expect(TRUSTED_APPEND_COLLECTED_STATUSES).not.toContain("APPEND_CAP_EXCEEDED_CAPTURE_PRESERVED");
  });

  it("a writer that returns without writing all of W is not success and the missing rows are preserved", () => {
    const f = fx();
    expect(call(f, "seed", [liveHistoryRow("pw_0")]).status).toBe("MIRRORED");
    const before = dbSnapshot(f.dbPath);
    const r = call(f, "partial_quiet", [liveHistoryRow("pw_1"), liveHistoryRow("pw_2"), liveHistoryRow("pw_3")], { write: (rs) => {
      appendHistoryRowsAtomic({ rows: rs.slice(0, 1), historyDir: f.historyDir, backupDir: join(f.historyDir, ".backup", "pq"), historyBefore: 0 }); // returns normally
    } });
    expect(r.status).toBe("HISTORY_APPEND_UNVERIFIED_MIRROR_BLOCKED");
    expect(r.reasons).toContain("2 intended rows missing after append");
    expect(isVerifiedTrustedMirror(r)).toBe(false);
    expect((JSON.parse(readFileSync(r.capture_path!, "utf8")) as { rows: HistoryRow[] }).rows.map((x) => x.rowId)).toEqual(["pw_2", "pw_3"]);
    expect(dbSnapshot(f.dbPath)).toBe(before);
  });

  it("while a scheduled atomic append holds .append.lock, a manual runRealAppend backs off (no CSV damage)", () => {
    const f = fx();
    expect(call(f, "seed", [liveHistoryRow("mx_1")]).status).toBe("MIRRORED");
    let manual: ReturnType<typeof runRealAppend> | null = null;
    const r = call(f, "scheduled", [liveHistoryRow("mx_2")], { legacyAppendLock: "hold", write: (rs) => {
      manual = runRealAppend({ historyDir: f.historyDir, runId: "manual", backupTimestamp: "20261020_130000", sourceShards: groupRowsToSourceShards([liveHistoryRow("mx_manual")]) });
      appendHistoryRowsAtomic({ rows: rs, historyDir: f.historyDir, backupDir: join(f.historyDir, ".backup", "scheduled"), historyBefore: 0 });
    } });
    expect(manual!.decision).toBe("local_history_real_append_failed_preflight"); // saw a fresh lock and aborted
    expect(r).toMatchObject({ status: "MIRRORED", rows_appended: 1, mirror_exact_match: true });
    const shard = readFileSync(join(f.historyDir, "zao_signals_2026_11.csv"), "utf8");
    expect(shard).toContain("mx_2");
    expect(shard).not.toContain("mx_manual");
    expect(existsSync(join(f.historyDir, ".append.lock"))).toBe(false);
  });

  it("runRealAppend records pid and host in its lock (operator diagnostics)", () => {
    expect(readFileSync(resolve(__dirname, "../src/services/localHistoryRealAppend.ts"), "utf8")).toContain("pid=${process.pid}\\nhost=${hostname()}");
    for (const script of ["runAutoRunnerMarketRefreshRotating.ts", "runAutoRunnerMarketRefresh.ts"]) {
      expect(readFileSync(resolve(__dirname, "../src/scripts", script), "utf8")).toContain('legacyAppendLock: "hold"');
    }
  });
});

function liveHistoryRow(rowId: string, shardMonth = "2026_11"): HistoryRow {
  return {
    rowId, rowHash: `hash_${rowId}`, shardMonth, collectedDateJst: "2026-10-20", collectedAtJst: "2026-10-20T08:00:00+09:00", normalizedAtJst: "2026-10-20T08:00:00+09:00",
    source: "booking", sourcePhase: "test", collectorStage: "test", canonicalPropertyName: "蔵王国際ホテル", sourcePropertyName: "蔵王国際ホテル", propertyIdentityMatch: true,
    sourcePropertyId: "zao-kokusai", sourceSlugOrCode: "zao-kokusai", checkin: "2026-11-07", checkout: "2026-11-08", stayNights: 1, groupAdults: 2, noRooms: 1, groupChildren: 0,
    currency: "JPY", language: "ja", stayScope: "2_adults_1_room_1_night", availabilityStatus: "available", soldOutStatus: "available", normalizedTotalPrice: 30000,
    normalizedTotalPriceSource: "test", normalizedTotalPriceBasis: "test", normalizedTotalPriceConfidence: "B", basisConfidence: "B", basisNote: "test", sourcePrimaryPrice: 30000,
    sourceSecondaryPriceOrAdder: null, sourceComputedTotal: 30000, sourceTaxOrFeeClassification: "test", sourceClassification: "test", isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: true, isPriceExcludedFromDp: false, dpExclusionReason: null, warningFlags: "", sourceReportPath: "", sourceCsvPath: "", debugArtifactPath: "", schemaVersion: "zao_local_history_v1"
  };
}

// ---------------------------------------------------------------------------
// TD #6284222401 P0: the legacy real-run sync and the wrapper that chains it.

describe("P0 legacy real-run sync (real-run:history-to-db-sync) is permanently closed", () => {
  // Temp cwd that passes the OLD approval gate: pinned dry-run artifact (ready,
  // 0 conflicts, approved mapped count) + mapped rows; history old_1, old_2, new_3;
  // DB old_1 only; no append is executed.
  function legacyFixture(): { root: string; dbPath: string } {
    const root = tempRoot();
    writeHistory(join(root, ".data/history"), [historyRow("old_1", "hash_o1"), historyRow("old_2", "hash_o2"), historyRow("new_3", "hash_n3")]);
    mkdirSync(join(root, ".data/reports/automation"), { recursive: true });
    writeFileSync(join(root, ".data/reports/automation/history_to_db_sync_dry_run_20260605_104149.json"), JSON.stringify({ decision: "history_to_db_sync_dry_run_ready", mapped_row_count: APPROVED_MAPPED_ROW_COUNT, dedupe_summary: { would_insert_rows: 2, would_skip_identical_rows: 1, would_conflict_rows: 0 } }));
    mkdirSync(join(root, ".data/debug/history-to-db-sync-dry-run/20260605_104149"), { recursive: true });
    writeFileSync(join(root, ".data/debug/history-to-db-sync-dry-run/20260605_104149/mapped_market_signal_history_rows.json"), JSON.stringify({ rows: [mappedRow("old_1", "hash_o1"), mappedRow("old_2", "hash_o2"), mappedRow("new_3", "hash_n3")] }));
    const dbPath = join(root, ".data/zao-market-intelligence.sqlite");
    seedDb(dbPath, [mappedRow("old_1", "hash_o1")]);
    return { root, dbPath };
  }
  function runScript(cwd: string, script: string, env: Record<string, string>): { status: number | null; stdout: string } {
    const r = spawnSync(process.execPath, ["--import", TSX_LOADER, resolve(REPO_ROOT, "src/scripts", script)], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
    return { status: r.status, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  it("HISTORY_TO_DB_SYNC=1 with a gate-passing legacy artifact: exit 2, INSERT 0, every table/schema/sync_runs unchanged", () => {
    const { root, dbPath } = legacyFixture();
    const before = dbSnapshot(dbPath);
    const r = runScript(root, "runHistoryToDbSyncRealRun.ts", { HISTORY_TO_DB_SYNC: "1" });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("legacy_db_sync_disabled=true");
    expect(r.stdout).toContain("decision=history_to_db_sync_ready_not_run");
    expect(r.stdout).toContain("inserted_rows=0");
    expect(dbSnapshot(dbPath)).toBe(before);
    expect(existsSync(join(root, ".data/ai-context"))).toBe(false);
  }, 60_000);

  it("the post-auto refresh wrapper stops when the sync is refused: no AI context, no task queries, no publish, exit 2", () => {
    const { root, dbPath } = legacyFixture();
    const before = dbSnapshot(dbPath);
    const r = runScript(root, "runPostAutoHistoryAppendRefresh.ts", {});
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("decision=post_auto_history_append_refresh_failed_db_sync");
    expect(r.stdout).toContain("downstream_skipped=ai_context,task_queries");
    expect(r.stdout).toContain("context_decision=skipped_db_sync_refused");
    expect(r.stdout).not.toMatch(/publish/iu);
    expect(existsSync(join(root, ".data/ai-context"))).toBe(false);
    expect(dbSnapshot(dbPath)).toBe(before);
  }, 120_000);

  it("the legacy script has no DB-writing code and no approval constant left", () => {
    const src = readFileSync(resolve(REPO_ROOT, "src/scripts/runHistoryToDbSyncRealRun.ts"), "utf8");
    expect(src).not.toMatch(/openLocalDatabase|applyRealSync|ensureMirrorSchema|validatePostSync|EXPLICIT_USER_APPROVED|explicitUserApproved: true/u);
    expect(src).toContain('if (process.env["HISTORY_TO_DB_SYNC"] === "1") {');
    // Only the trusted path and the separately-approved Rakuten revert tool touch market_signal_history.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const scripts = readdirSync(resolve(REPO_ROOT, "src/scripts")).filter((f: string) => f.endsWith(".ts"));
    const writers = scripts.filter((f: string) => /applyRealSync\(|ensureMirrorSchema\(|(INSERT|DELETE|UPDATE)[^;]*market_signal_history/u.test(readFileSync(resolve(REPO_ROOT, "src/scripts", f), "utf8")));
    expect(writers).toEqual(["runRakutenSoldOutRevertRealRun.ts"]);
  });
});
