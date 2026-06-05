import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHistoryToDbSyncDryRun,
  buildSyncRunPreview,
  mapHistoryRowToMarketSignalHistoryRow,
  parseCsvTable,
  renderHistoryToDbSyncDryRunReport,
  simulateHistoryToDbSync,
  validateMappedRows,
  validateRequiredColumns,
  type LoadedHistoryRow,
  type MarketSignalHistoryDryRunRow
} from "../src/services/historyToDbSyncDryRun";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/historyToDbSyncDryRun.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runHistoryToDbSyncDryRun.ts"), "utf8");

function historyRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    row_id: "rakuten:5723:2026-06-03",
    row_hash: "hash_a",
    shard_month: "2026_06",
    collected_date_jst: "2026-06-01",
    collected_at_jst: "2026-06-01T20:00:00+09:00",
    normalized_at_jst: "2026-06-01T20:10:00+09:00",
    source: "rakuten",
    canonical_property_name: "蔵王国際ホテル",
    source_property_id: "5723",
    checkin: "2026-06-03",
    checkout: "2026-06-04",
    stay_scope: "2_adults_1_room_1_night",
    availability_status: "available",
    sold_out_status: "available",
    normalized_total_price: "64790",
    normalized_total_price_basis: "per_person_tax_included_times_2",
    basis_confidence: "B",
    is_price_usable_for_dp_direct: "false",
    is_price_usable_for_dp_directional: "true",
    is_price_excluded_from_dp: "false",
    source_classification: "rakuten_day_available_price_link",
    dp_exclusion_reason: "",
    debug_artifact_path: ".data/debug/example",
    schema_version: "history_v1",
    ...overrides
  };
}

function mapped(overrides: Record<string, string> = {}): MarketSignalHistoryDryRunRow {
  return mapHistoryRowToMarketSignalHistoryRow(historyRow(overrides), "2026-06-03T22:10:00+09:00");
}

function dryRun(rows: Record<string, string>[] = [historyRow()]) {
  const loadedRows: LoadedHistoryRow[] = rows.map((row, i) => ({
    sourceFile: ".data/history/zao_signals_2026_06.csv",
    row: { ...row, __source_file: `.data/history/zao_signals_2026_06.csv#${i}` }
  }));
  return buildHistoryToDbSyncDryRun({
    runId: "history_to_db_sync_dry_run_test",
    generatedAtJst: "2026-06-03T22:10:00+09:00",
    reportPath: ".data/reports/automation/history_to_db_sync_dry_run_test.md",
    sourceHistoryFiles: [".data/history/zao_signals_2026_06.csv"],
    loadedRows,
    requiredColumnCheck: validateRequiredColumns([{ path: "fixture.csv", headers: Object.keys(historyRow()) }])
  });
}

describe("history-to-DB sync dry-run", () => {
  it("loads history rows", () => {
    const csv = `row_id,row_hash,schema_version\nr1,h1,v1\nr2,h2,v1\n`;
    const table = parseCsvTable(csv);
    expect(table.headers).toEqual(["row_id", "row_hash", "schema_version"]);
    expect(table.rows).toHaveLength(2);
  });

  it("maps history row to market_signal_history row", () => {
    const row = mapped();
    expect(row.row_id).toBe("rakuten:5723:2026-06-03");
    expect(row.checkin_date).toBe("2026-06-03");
    expect(row.checkout_date).toBe("2026-06-04");
    expect(row.normalized_total_jpy).toBe(64790);
    expect(row.price_basis).toContain("per_person");
  });

  it("preserves extra fields in raw_json", () => {
    const row = mapped({ extra_debug_field: "kept" });
    expect(JSON.parse(row.raw_json).extra_debug_field).toBe("kept");
  });

  it("requires row_id", () => {
    expect(validateMappedRows([mapped({ row_id: "" })]).errors.join("\n")).toContain("missing row_id");
  });

  it("requires row_hash", () => {
    expect(validateMappedRows([mapped({ row_hash: "" })]).errors.join("\n")).toContain("missing row_hash");
  });

  it("requires schema_version", () => {
    expect(validateMappedRows([mapped({ schema_version: "" })]).errors.join("\n")).toContain("missing schema_version");
  });

  it("validates source known set", () => {
    expect(validateMappedRows([mapped({ source: "unknown_ota" })]).errors.join("\n")).toContain("unknown source");
  });

  it("validates dp_usage allowed values", () => {
    expect(validateMappedRows([mapped({ dp_usage: "auto_price" })]).errors.join("\n")).toContain("invalid dp_usage");
  });

  it("validates basis_confidence allowed values", () => {
    expect(validateMappedRows([mapped({ basis_confidence: "AA" })]).errors.join("\n")).toContain("invalid basis_confidence");
  });

  it("new row_id becomes would_insert", () => {
    const result = simulateHistoryToDbSync({ runId: "run", rows: [mapped()] });
    expect(result.actions[0]!.action).toBe("would_insert");
  });

  it("same row_id plus same row_hash becomes would_skip_identical", () => {
    const row = mapped();
    const result = simulateHistoryToDbSync({ runId: "run", rows: [row], existingRows: [row] });
    expect(result.actions[0]!.action).toBe("would_skip_identical");
  });

  it("same row_id plus different row_hash becomes would_conflict_block", () => {
    const existing = mapped({ row_hash: "hash_existing" });
    const incoming = mapped({ row_hash: "hash_incoming" });
    const result = simulateHistoryToDbSync({ runId: "run", rows: [incoming], existingRows: [existing] });
    expect(result.actions[0]!.action).toBe("would_conflict_block");
  });

  it("conflict blocks dry-run ready decision", () => {
    const plan = dryRun([
      historyRow({ row_hash: "hash_a" }),
      historyRow({ row_hash: "hash_b" })
    ]);
    expect(plan.decision).toBe("history_to_db_sync_dry_run_blocked_conflicts");
  });

  it("creates sync_run_preview", () => {
    const plan = dryRun();
    expect(plan.sync_run_preview.sync_run_id).toBe(plan.run_id);
    expect(plan.sync_run_preview.input_rows).toBe(1);
  });

  it("status dry_run_ready when no conflicts", () => {
    const preview = buildSyncRunPreview({
      runId: "run",
      generatedAtJst: "2026-06-03T22:10:00+09:00",
      sourceHistoryFiles: ["f.csv"],
      inputRows: 1,
      dedupe: { would_insert_rows: 1, would_skip_identical_rows: 0, would_conflict_rows: 0 },
      reportPath: "r.md",
      validationPassed: true
    });
    expect(preview.status).toBe("dry_run_ready");
  });

  it("status dry_run_blocked_conflicts when conflicts", () => {
    const preview = buildSyncRunPreview({
      runId: "run",
      generatedAtJst: "2026-06-03T22:10:00+09:00",
      sourceHistoryFiles: ["f.csv"],
      inputRows: 1,
      dedupe: { would_insert_rows: 0, would_skip_identical_rows: 0, would_conflict_rows: 1 },
      reportPath: "r.md",
      validationPassed: true
    });
    expect(preview.status).toBe("dry_run_blocked_conflicts");
  });

  it("detects duplicate row_id with different hash in source", () => {
    const plan = dryRun([historyRow({ row_hash: "a" }), historyRow({ row_hash: "b" })]);
    expect(plan.conflict_summary.source_duplicate_conflict_count).toBe(1);
  });

  it("does not fail on extra columns", () => {
    const plan = dryRun([historyRow({ extra_column_ok: "yes" })]);
    expect(plan.validation_result.passed).toBe(true);
    expect(JSON.parse(mapHistoryRowToMarketSignalHistoryRow(historyRow({ extra_column_ok: "yes" }), "now").raw_json).extra_column_ok).toBe("yes");
  });

  it("forbids PMS/Beds24/AirHost columns in mapped DB rows", () => {
    const keys = Object.keys(mapped()).join(",");
    expect(keys).not.toMatch(/Beds24|AirHost|\bPMS\b|roomid|inventory|minstay|maxstay|multiplier|price[1-5]/u);
  });

  it("has no DB-write code", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i);
      expect(src).not.toMatch(/openLocalDatabase|runInTransaction|collector_runs|rate_snapshots|inventory_snapshots/);
    }
  });

  it("has no SQL execution code", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/executeMigration|better-sqlite3|\.exec\s*\(|\.prepare\s*\(/);
    }
  });

  it("creates no migrations", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*migrations/u);
    expect(SCRIPT_SOURCE).toContain("Does not execute SQL");
  });

  it("does not modify .data/history", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/history/);
    }
  });

  it("does not modify property master", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/(writeFileSync|renameSync|copyFileSync)\s*\([^)]*\.data\/exports\/zao-universe-review/);
    }
  });

  it("has no GitHub Actions activation", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/\.github\/workflows|workflow_dispatch|schedule:/);
    }
  });

  it("has no paid-source tooling", () => {
    for (const src of [SERVICE_SOURCE, SCRIPT_SOURCE]) {
      expect(src).not.toMatch(/serpapi|dataforseo|apify|bright\s*data|oxylabs|paid proxy/i);
    }
  });

  it("report generated when dry-run passes", () => {
    const plan = dryRun();
    const report = renderHistoryToDbSyncDryRunReport(plan);
    expect(plan.decision).toBe("history_to_db_sync_dry_run_ready");
    expect(report).toContain("# History-to-DB Sync Dry-Run");
    expect(report).toContain("## 8. Sync Run Preview");
  });
});
