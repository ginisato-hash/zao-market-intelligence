import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, openLocalDatabase } from "../src/db/client";
import { applyRealSync, ensureMirrorSchema } from "../src/services/historyToDbSyncRealRun";
import {
  evaluateFreshSyncGate,
  runFreshHistoryToDbSync,
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

function runHelper(root: string, options: { rows?: Array<Record<string, string>>; dbPath?: string; gate?: string; expected?: string } = {}): FreshHistoryToDbSyncReport {
  const historyDir = join(root, "history");
  writeHistory(historyDir, options.rows ?? [historyRow("row_1", "hash_1"), historyRow("row_2", "hash_2", "booking")]);
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

function seedDb(dbPath: string, rows: MarketSignalHistoryDryRunRow[]): void {
  const db = openLocalDatabase(dbPath);
  try {
    ensureMirrorSchema(db);
    applyRealSync({
      db,
      runId: "seed_run",
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
    expect(evaluateFreshSyncGate({ envFlag: "1", expectedHistoryRowCount: "2", historyCount: 2, mapping: runHelper(tempRoot()).fresh_mapping_summary, duplicateRowIdCount: 0, schemaValid: true }).passed).toBe(true);
  });

  it("package contains sync script", () => {
    expect(PACKAGE_JSON).toContain("sync:history-to-db:fresh");
  });
});
