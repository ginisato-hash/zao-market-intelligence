import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPEND_ACTION_CSV_HEADERS,
  assertNotRealHistoryPath,
  buildDryRunShards,
  decideM03X,
  findShardDuplicateRowIds,
  isRealHistoryPath,
  renderAppendActionCsv,
  renderDryRunReport,
  simulateAppend,
  type DryRunSummary
} from "../src/services/localHistoryAppendDryRun";
import {
  HISTORY_CSV_HEADERS,
  mapUnifiedRowToHistoryRow,
  type HistoryRow
} from "../src/services/localHistorySchemaDesign";
import { type UnifiedMarketSignalRow } from "../src/services/crossSourceMarketSignalNormalization";

const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/runLocalHistoryAppendDryRun.ts"),
  "utf8"
);

const DRY_RUN_DIR = ".data/debug/history-append-dry-run/TEST/shards";

function makeUnified(overrides: Partial<UnifiedMarketSignalRow> = {}): UnifiedMarketSignalRow {
  return {
    runId: "cross_source_test",
    normalizedAtJst: "2026-06-01T23:07:31+09:00",
    source: "booking",
    sourcePhase: "B04X",
    collectorStage: "local_normalization_only",
    canonicalPropertyName: "蔵王国際ホテル",
    sourcePropertyName: "蔵王国際ホテル",
    propertyIdentityMatch: true,
    sourcePropertyId: "zao-kokusai",
    sourceSlugOrCode: "zao-kokusai",
    checkin: "2026-08-12",
    checkout: "2026-08-13",
    stayNights: 1,
    groupAdults: 2,
    noRooms: 1,
    groupChildren: 0,
    currency: "JPY",
    language: "ja",
    stayScope: "2_adults_1_room_1_night",
    availabilityStatus: "available",
    soldOutStatus: "available",
    normalizedTotalPrice: 60_360,
    normalizedTotalPriceSource: "booking_official_base_plus_visible_tax_fee_adder",
    normalizedTotalPriceBasis: "room_total_official_visible_tax_fee_2_adults_1_room_1_night",
    normalizedTotalPriceConfidence: "B",
    basisConfidence: "B",
    basisNote: "Computed total = base + official adder; no 1.1 multiplier.",
    sourcePrimaryPrice: 60_060,
    sourceSecondaryPriceOrAdder: 300,
    sourceComputedTotal: 60_360,
    sourceTaxOrFeeClassification: "booking_room_total_official_base_plus_tax_fee_adder",
    sourceClassification: "booking_b04a_official_base_plus_adder_numeric",
    mealBasisClass: "assumed_room_only",
    isPriceUsableForDpDirect: false,
    isPriceUsableForDpDirectional: true,
    isPriceExcludedFromDp: false,
    dpExclusionReason: null,
    warningFlags: "",
    sourceReportPath: "/abs/m01x.md",
    sourceCsvPath: "/abs/m01x.csv",
    debugArtifactPath: "/abs/debug/zao-kokusai_2026-08-12",
    ...overrides
  };
}

function row(overrides: Partial<UnifiedMarketSignalRow> = {}): HistoryRow {
  return mapUnifiedRowToHistoryRow(makeUnified(overrides));
}

const OPTS = { scenario: "test", runId: "run_test", dryRunShardDir: DRY_RUN_DIR };

describe("Phase M03X — append simulation", () => {
  it("(1) appends a new row to an empty shard", () => {
    const result = simulateAppend([], [row()], OPTS);
    expect(result.appendedCount).toBe(1);
    expect(result.shardRows).toHaveLength(1);
    expect(result.actions[0]!.appendAction).toBe("append");
  });

  it("(2) skips a duplicate with the same row_hash", () => {
    const r = row();
    const result = simulateAppend([], [r, r], OPTS);
    expect(result.appendedCount).toBe(1);
    expect(result.skippedIdenticalCount).toBe(1);
    expect(result.actions[1]!.appendAction).toBe("skip_duplicate_identical");
  });

  it("(3) detects a conflict: same row_id, different row_hash", () => {
    const original = row();
    // Same identity (slug/date) but a different normalized price → different hash, same row_id.
    const conflicting = row({ normalizedTotalPrice: 99_999 });
    expect(conflicting.rowId).toBe(original.rowId);
    expect(conflicting.rowHash).not.toBe(original.rowHash);
    const result = simulateAppend([], [original, conflicting], OPTS);
    expect(result.conflictCount).toBe(1);
    expect(result.actions[1]!.appendAction).toBe("conflict_same_id_different_hash");
  });

  it("(4) does not append a conflicting duplicate", () => {
    const result = simulateAppend([], [row(), row({ normalizedTotalPrice: 99_999 })], OPTS);
    expect(result.appendedCount).toBe(1);
    expect(result.shardRows).toHaveLength(1);
  });

  it("(5) Scenario A appends unique rows and skips identical duplicates", () => {
    const a = row();
    const b = row({ checkin: "2026-08-13", checkout: "2026-08-14" });
    const result = simulateAppend([], [a, a, b], { ...OPTS, scenario: "A_empty_shard" });
    expect(result.appendedCount).toBe(2);
    expect(result.skippedIdenticalCount).toBe(1);
    expect(result.conflictCount).toBe(0);
  });

  it("(6) Scenario B idempotent replay appends zero rows", () => {
    const input = [row(), row(), row({ checkin: "2026-08-13", checkout: "2026-08-14" })];
    const a = simulateAppend([], input, { ...OPTS, scenario: "A_empty_shard" });
    const b = simulateAppend(a.shardRows, input, { ...OPTS, scenario: "B_idempotent_replay" });
    expect(b.appendedCount).toBe(0);
    expect(b.skippedIdenticalCount).toBe(input.length);
    expect(b.conflictCount).toBe(0);
  });

  it("(19) Scenario B replays raw input rows against Scenario A output", () => {
    const input = [row(), row()]; // raw input includes the benign duplicate
    const a = simulateAppend([], input, { ...OPTS, scenario: "A_empty_shard" });
    expect(a.shardRows).toHaveLength(1);
    const b = simulateAppend(a.shardRows, input, { ...OPTS, scenario: "B_idempotent_replay" });
    expect(b.appendedCount).toBe(0);
    expect(b.skippedIdenticalCount).toBe(2); // both raw rows skipped
  });
});

describe("Phase M03X — shard outputs", () => {
  const rows = [
    row(),
    row({ source: "jalan", sourceSlugOrCode: "", sourcePropertyId: "", canonicalPropertyName: "market_aggregate", checkin: "2026-07-18", checkout: "2026-07-19", normalizedTotalPrice: 12_250 })
  ];

  it("(7) groups dry-run outputs by shard_month", () => {
    const shards = buildDryRunShards(rows, DRY_RUN_DIR);
    expect(shards.map((s) => s.shardMonth)).toEqual(["2026_07", "2026_08"]);
    expect(shards[1]!.futureHistoryPath).toBe(".data/history/zao_signals_2026_08.csv");
    expect(shards[1]!.dryRunShardPath).toBe(`${DRY_RUN_DIR}/zao_signals_2026_08.csv`);
  });

  it("(8) dry-run shard CSV contains a header row", () => {
    const shards = buildDryRunShards(rows, DRY_RUN_DIR);
    const header = shards[0]!.csv.split("\n")[0];
    expect(header).toBe(HISTORY_CSV_HEADERS.join(","));
  });

  it("(9)+(18) dry-run shards contain no duplicate row_id", () => {
    const shards = buildDryRunShards(rows, DRY_RUN_DIR);
    expect(findShardDuplicateRowIds(shards)).toEqual([]);
    // Inject a duplicate to prove detection works.
    const dupShards = buildDryRunShards([row(), row()], DRY_RUN_DIR);
    // buildDryRunShards does not dedupe; it groups. Two identical rows → duplicate detected.
    expect(findShardDuplicateRowIds(dupShards).length).toBeGreaterThan(0);
  });

  it("(10) shard CSV preserves the stable schema column order", () => {
    const shards = buildDryRunShards(rows, DRY_RUN_DIR);
    expect(shards[0]!.csv.split("\n")[0]).toBe(HISTORY_CSV_HEADERS.join(","));
  });

  it("(11)+(12) shard CSV header excludes forbidden + deprecated columns", () => {
    const header = buildDryRunShards(rows, DRY_RUN_DIR)[0]!.csv.split("\n")[0] ?? "";
    expect(header).not.toMatch(/beds24|airhost|\bpms\b|roomid|inventory|minstay|maxstay|multiplier|price[1-5]/iu);
    expect(header).not.toMatch(/tax_multiplier|tax_included_price|tax_normalization_rule/u);
  });
});

describe("Phase M03X — path safety", () => {
  it("(13) real-history path guard rejects .data/history paths", () => {
    expect(isRealHistoryPath(".data/history/zao_signals_2026_08.csv")).toBe(true);
    expect(isRealHistoryPath("/abs/.data/history/x.csv")).toBe(true);
    expect(isRealHistoryPath(".data/debug/history-append-dry-run/X/shards/zao_signals_2026_08.csv")).toBe(false);
    expect(() => assertNotRealHistoryPath(".data/history/zao_signals_2026_08.csv")).toThrow(/real history path/u);
    expect(() => assertNotRealHistoryPath(`${DRY_RUN_DIR}/zao_signals_2026_08.csv`)).not.toThrow();
  });

  it("(14) script writes shards only under the debug dir and never to .data/history", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history/u);
    expect(SCRIPT_SOURCE).toMatch(/assertNotRealHistoryPath/u);
    expect(SCRIPT_SOURCE).toMatch(/must not touch real history/u);
  });

  it("(21) script stops with a clear error when M02X artifact is missing", () => {
    expect(SCRIPT_SOURCE).toMatch(/Stop and report the missing artifact path/u);
    expect(SCRIPT_SOURCE).toMatch(/Do not re-run collectors/u);
  });
});

describe("Phase M03X — action report, decision, summary", () => {
  it("(15) action CSV includes append/skip/conflict rows", () => {
    const result = simulateAppend([], [row(), row(), row({ normalizedTotalPrice: 99_999 })], OPTS);
    const csv = renderAppendActionCsv(result.actions);
    expect(csv.split("\n")[0]).toBe(APPEND_ACTION_CSV_HEADERS.join(","));
    expect(csv).toMatch(/append/u);
    expect(csv).toMatch(/skip_duplicate_identical/u);
    expect(csv).toMatch(/conflict_same_id_different_hash/u);
  });

  it("(16) decision ready when conflicts=0 and scenario B appends 0", () => {
    expect(
      decideM03X({
        inputRowCount: 159,
        validationInvalidRows: 0,
        forbiddenColumnErrors: 0,
        hashConflictCount: 0,
        scenarioBAppendedCount: 0,
        shardDuplicateRowIdCount: 0,
        historyDirCreated: false
      })
    ).toBe("local_history_append_dry_run_ready");
  });

  it("(17) decision not_ready when conflicts > 0", () => {
    expect(
      decideM03X({
        inputRowCount: 159,
        validationInvalidRows: 0,
        forbiddenColumnErrors: 0,
        hashConflictCount: 1,
        scenarioBAppendedCount: 0,
        shardDuplicateRowIdCount: 0,
        historyDirCreated: false
      })
    ).toBe("local_history_append_dry_run_not_ready");
  });

  it("decision not_ready when .data/history is created or scenario B appends", () => {
    expect(
      decideM03X({ inputRowCount: 159, validationInvalidRows: 0, forbiddenColumnErrors: 0, hashConflictCount: 0, scenarioBAppendedCount: 0, shardDuplicateRowIdCount: 0, historyDirCreated: true })
    ).toBe("local_history_append_dry_run_not_ready");
    expect(
      decideM03X({ inputRowCount: 159, validationInvalidRows: 0, forbiddenColumnErrors: 0, hashConflictCount: 0, scenarioBAppendedCount: 5, shardDuplicateRowIdCount: 0, historyDirCreated: false })
    ).toBe("local_history_append_dry_run_not_ready");
  });

  it("(20)+(22) report/summary include both scenarios and future-path-not-written markers", () => {
    const input = [row(), row(), row({ checkin: "2026-07-18", checkout: "2026-07-19", source: "jalan", sourceSlugOrCode: "", sourcePropertyId: "", canonicalPropertyName: "market_aggregate", normalizedTotalPrice: 12_250 })];
    const a = simulateAppend([], input, { ...OPTS, scenario: "A_empty_shard" });
    const b = simulateAppend(a.shardRows, input, { ...OPTS, scenario: "B_idempotent_replay" });
    const shards = buildDryRunShards(a.shardRows, DRY_RUN_DIR);
    const summary: DryRunSummary = {
      runId: "run_test",
      sourceM02xArtifactPath: "/m02x.json",
      schemaVersion: "zao_local_history_v1",
      inputRowCount: input.length,
      uniqueRowIdCount: a.shardRows.length,
      duplicateInputRowCount: a.skippedIdenticalCount,
      hashConflictCount: a.conflictCount + b.conflictCount,
      scenarioAAppendedCount: a.appendedCount,
      scenarioASkippedIdenticalCount: a.skippedIdenticalCount,
      scenarioAConflictCount: a.conflictCount,
      scenarioBAppendedCount: b.appendedCount,
      scenarioBSkippedIdenticalCount: b.skippedIdenticalCount,
      scenarioBConflictCount: b.conflictCount,
      shardCount: shards.length,
      shardPathsDryRun: shards.map((s) => s.dryRunShardPath),
      historyDirCreated: false,
      decision: "local_history_append_dry_run_ready"
    };
    const report = renderDryRunReport({
      generatedAt: "2026-06-01T15:00:00.000Z",
      summary,
      shards,
      scenarioA: a,
      scenarioB: b,
      conflicts: [],
      forbiddenColumnErrors: [],
      reportPath: "/out.md",
      csvPath: "/out.csv",
      jsonPath: "/out.json",
      debugRootPath: "/debug"
    });
    expect(report).toMatch(/Scenario A/u);
    expect(report).toMatch(/Scenario B/u);
    expect(report).toMatch(/NOT written/u);
    expect(report).toMatch(/not written/u);
    expect(summary.scenarioBAppendedCount).toBe(0);
    expect(summary.scenarioBSkippedIdenticalCount).toBe(input.length);
  });
});
