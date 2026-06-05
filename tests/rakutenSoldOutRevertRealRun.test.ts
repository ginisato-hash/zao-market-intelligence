import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REAL_REVERT_ENV_FLAG,
  buildCleanedShards,
  evaluateRakutenSoldOutRevertGate,
  parseCsvWithHeaderLine,
  preflightRakutenSoldOutRevert,
  renderCsvTable,
  validateContextRebuild,
  validateDbReconciliation,
  validateExpectedHistoryAfter,
  validateHistoryAfterRevert,
  type HistoryShardInput
} from "../src/services/rakutenSoldOutRevertRealRun";
import type { RakutenSoldOutRevertProposal } from "../src/services/rakutenSoldOutRevertProposal";
import type { HistoryRowLike } from "../src/services/rakutenSoldOutSemanticsAudit";

const SERVICE_SOURCE = readFileSync(resolve("src/services/rakutenSoldOutRevertRealRun.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve("src/scripts/runRakutenSoldOutRevertRealRun.ts"), "utf8");

const HEADER = [
  "row_id",
  "row_hash",
  "shard_month",
  "source",
  "source_phase",
  "collector_stage",
  "canonical_property_name",
  "source_property_id",
  "source_slug_or_code",
  "checkin",
  "availability_status",
  "source_classification",
  "dp_usage",
  "is_price_excluded_from_dp",
  "debug_artifact_path",
  "schema_version"
];

function affected(shard: "2026_06" | "2026_07", index: number): Record<string, string> {
  return {
    row_id: `${shard}|affected|${index}`,
    row_hash: `hash-${shard}-${index}`,
    shard_month: shard,
    source: "rakuten",
    source_phase: "AUTO08X",
    collector_stage: "auto_history_append_guarded_real_run",
    canonical_property_name: index % 2 === 0 ? "蔵王国際ホテル" : "名湯リゾート ルーセント",
    source_property_id: index % 2 === 0 ? "5723" : "39565",
    source_slug_or_code: index % 2 === 0 ? "5723:00" : "39565:honkan-exk",
    checkin: shard === "2026_06" ? "2026-06-03" : "2026-07-03",
    availability_status: "sold_out",
    source_classification: "rakuten_day_sold_out",
    dp_usage: "excluded",
    is_price_excluded_from_dp: "true",
    debug_artifact_path: ".data/debug/auto-history-append/20260604_094714",
    schema_version: "zao_local_history_v1"
  };
}

function clean(shard: string, index: number): Record<string, string> {
  return {
    row_id: `${shard}|clean|${index}`,
    row_hash: `clean-${shard}-${index}`,
    shard_month: shard,
    source: "rakuten",
    source_phase: "Phase66X",
    collector_stage: "prototype_read_only",
    canonical_property_name: "蔵王国際ホテル",
    source_property_id: "5723",
    source_slug_or_code: "5723",
    checkin: shard === "2026_06" ? "2026-06-01" : "2026-07-01",
    availability_status: "available",
    source_classification: "rakuten_day_available_price_link",
    dp_usage: "directional",
    is_price_excluded_from_dp: "false",
    debug_artifact_path: ".data/debug/other",
    schema_version: "zao_local_history_v1"
  };
}

function csv(rows: Record<string, string>[]): string {
  return renderCsvTable(HEADER, rows);
}

function shards(): HistoryShardInput[] {
  return [
    {
      path: ".data/history/zao_signals_2026_06.csv",
      csv: csv([
        ...Array.from({ length: 54 }, (_, i) => affected("2026_06", i)),
        ...Array.from({ length: 60 }, (_, i) => clean("2026_06", i))
      ])
    },
    {
      path: ".data/history/zao_signals_2026_07.csv",
      csv: csv([
        ...Array.from({ length: 62 }, (_, i) => affected("2026_07", i)),
        ...Array.from({ length: 65 }, (_, i) => clean("2026_07", i))
      ])
    }
  ];
}

function proposal(): RakutenSoldOutRevertProposal {
  const ids = [
    ...Array.from({ length: 54 }, (_, i) => `2026_06|affected|${i}`),
    ...Array.from({ length: 62 }, (_, i) => `2026_07|affected|${i}`)
  ];
  return {
    run_id: "proposal",
    generated_at_jst: "2026-06-04T10:47:47+09:00",
    decision: "rakuten_sold_out_revert_proposal_ready",
    source_fix01_artifact: "fix01.json",
    affected_run_id: "20260604_094714",
    affected_source: "rakuten",
    affected_semantics: "room_type_context_sold_out",
    affected_history_rows: 116,
    affected_row_ids: ids,
    affected_rows: [],
    touched_shards: ["2026_06", "2026_07"],
    shard_count_plan: [
      { shard_month: "2026_06", source_file: ".data/history/zao_signals_2026_06.csv", before_rows: 114, affected_rows: 54, after_rows: 60 },
      { shard_month: "2026_07", source_file: ".data/history/zao_signals_2026_07.csv", before_rows: 127, affected_rows: 62, after_rows: 65 }
    ],
    total_history_rows_before: 261,
    total_history_rows_after: 145,
    backup_rollback_plan: { backup_dir_template: "", touched_files: [], backup_steps: [], rollback_steps: [] },
    write_plan: { temp_file_pattern: "", steps: [], validation_checks: [] },
    db_resync_plan: { expected_market_signal_history_rows_before: 261, expected_market_signal_history_rows_after: 145, steps: [] },
    ai_context_rebuild_plan: {
      expected_sold_out_row_count_before: 182,
      expected_sold_out_row_count_after: 66,
      expected_basis_confidence_insufficient_before: 119,
      expected_basis_confidence_insufficient_after: 3,
      steps: []
    },
    approval_gate_template: {
      approval_sentence_template: "",
      approval_is_active_in_this_phase: false,
      required_env_flag: "RAKUTEN_SOLDOUT_REVERT=1",
      required_command: "RAKUTEN_SOLDOUT_REVERT=1 npm run real-run:rakuten-sold-out-revert"
    },
    safety_confirmation: {},
    validation_notes: []
  };
}

function allRowsAfter(cleanedShards: ReturnType<typeof buildCleanedShards>): HistoryRowLike[] {
  return [
    ...Array.from({ length: 20 }, (_, i) => ({ ...clean("2026_06", i + 100), __source_file: ".data/history/zao_signals_2026_05.csv", shard_month: "2026_05" })),
    ...cleanedShards.flatMap((shard) => parseCsvWithHeaderLine(shard.content).rows.map((row) => ({ ...row, __source_file: shard.path })))
  ];
}

describe("rakuten sold-out revert real run", () => {
  it("gate false without env flag", () => {
    const gate = evaluateRakutenSoldOutRevertGate({ explicitApprovalPresent: true, envFlag: undefined, proposal: proposal() });
    expect(gate.passed).toBe(false);
    expect(gate.decision).toBe("rakuten_sold_out_revert_ready_not_run");
  });

  it("gate true only with approval + RAKUTEN_SOLDOUT_REVERT=1", () => {
    const gate = evaluateRakutenSoldOutRevertGate({ explicitApprovalPresent: true, envFlag: "1", proposal: proposal() });
    expect(gate.passed).toBe(true);
    expect(REAL_REVERT_ENV_FLAG).toBe("RAKUTEN_SOLDOUT_REVERT");
  });

  it("preflight requires exactly 116 target row_ids", () => {
    const p = { ...proposal(), affected_row_ids: proposal().affected_row_ids.slice(1) };
    const result = preflightRakutenSoldOutRevert({ proposal: p, allHistoryRows: [], touchedShards: shards() });
    expect(result.passed).toBe(false);
    expect(result.errors.join("\n")).toContain("target row_id count is not 116");
  });

  it("preflight requires only 2026_06 and 2026_07 shards", () => {
    const p = { ...proposal(), affected_row_ids: [...proposal().affected_row_ids.slice(0, 115), "2026_08|affected|0"] };
    const result = preflightRakutenSoldOutRevert({ proposal: p, allHistoryRows: [], touchedShards: shards() });
    expect(result.passed).toBe(false);
    expect(result.errors.join("\n")).toContain("target row_ids found is not 116");
  });

  it("preflight rejects missing target row_id", () => {
    const p = { ...proposal(), affected_row_ids: [...proposal().affected_row_ids.slice(0, 115), "missing"] };
    const result = preflightRakutenSoldOutRevert({ proposal: p, allHistoryRows: [], touchedShards: shards() });
    expect(result.errors.join("\n")).toContain("target row_ids found is not 116");
  });

  it("preflight rejects non-AUTO08X row in removal set", () => {
    const p = { ...proposal(), affected_row_ids: [...proposal().affected_row_ids.slice(0, 115), "2026_06|clean|0"] };
    const result = preflightRakutenSoldOutRevert({ proposal: p, allHistoryRows: [], touchedShards: shards() });
    expect(result.errors.join("\n")).toContain("target row is not AUTO08X contaminated");
  });

  it("revert preserves header", () => {
    const cleaned = buildCleanedShards({ proposal: proposal(), touchedShards: shards() });
    expect(parseCsvWithHeaderLine(cleaned[0]!.content).headerLine).toBe(HEADER.join(","));
  });

  it("revert removes only affected rows", () => {
    const cleaned = buildCleanedShards({ proposal: proposal(), touchedShards: shards() });
    const juneRows = parseCsvWithHeaderLine(cleaned[0]!.content).rows;
    expect(juneRows).toHaveLength(60);
    expect(juneRows.every((row) => row["row_id"]?.includes("|clean|"))).toBe(true);
  });

  it("revert computes 114 -> 60 for June", () => {
    expect(buildCleanedShards({ proposal: proposal(), touchedShards: shards() })[0]).toMatchObject({ beforeRows: 114, removedRows: 54, afterRows: 60 });
  });

  it("revert computes 127 -> 65 for July", () => {
    expect(buildCleanedShards({ proposal: proposal(), touchedShards: shards() })[1]).toMatchObject({ beforeRows: 127, removedRows: 62, afterRows: 65 });
  });

  it("revert validates total 261 -> 145", () => {
    const cleaned = buildCleanedShards({ proposal: proposal(), touchedShards: shards() });
    const rows = allRowsAfter(cleaned);
    const summary = validateHistoryAfterRevert({ allHistoryRows: rows, removedRowIds: proposal().affected_row_ids });
    expect(summary.total_history_rows).toBe(145);
    expect(validateExpectedHistoryAfter(summary)).toHaveLength(0);
  });

  it("rollback restores backups on failure path is implemented", () => {
    expect(SCRIPT_SOURCE).toContain("rollbackFromBackup");
    expect(SCRIPT_SOURCE).toMatch(/copyFileSync\(backupFile, resolve\(file\)\)/);
  });

  it("DB reconciliation deletes only approved 116 row_ids", () => {
    expect(SCRIPT_SOURCE).toContain("DELETE FROM market_signal_history");
    expect(SCRIPT_SOURCE).toContain("WHERE row_id = ?");
    expect(SCRIPT_SOURCE).toContain("source = 'rakuten'");
    expect(SCRIPT_SOURCE).toContain("classification = 'rakuten_day_sold_out'");
    expect(validateDbReconciliation({ deletedRows: 116, remainingApprovedRowIds: 0, marketSignalHistoryRows: 145 })).toHaveLength(0);
  });

  it("DB reconciliation does not delete unrelated rows", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/DELETE FROM market_signal_history\s*;|TRUNCATE|DROP TABLE/i);
  });

  it("context rebuild expectation returns sold_out 66", () => {
    expect(validateContextRebuild({
      marketSignalHistoryRows: 145,
      soldOutCount: 66,
      basisConfidenceInsufficient: 3,
      latestFilesRegular: true
    })).toHaveLength(0);
  });

  it("future smoke checks are read-only", () => {
    expect(SCRIPT_SOURCE).toContain("query:ai-task");
    expect(SCRIPT_SOURCE).toContain("--task");
    expect(SCRIPT_SOURCE).not.toContain("pricing:approve");
  });

  it("does not run collectors", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/collect:jalan|collect:rakuten|runAutoHistoryAppendRealRun|real-run:auto-history-append/);
  });

  it("does not fetch external sites", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/\bfetch\(|http\.request|https\.request/);
  });

  it("does not use Playwright", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright["']|chromium\.|firefox\.|webkit\./i);
  });

  it("uses no paid-source tooling", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/i);
  });

  it("has no PMS/Beds24/AirHost output", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/Beds24|AirHost|PMS upload|OTA upload/i);
  });

  it("decision success / ready_not_run / rollback labels work", () => {
    expect(SERVICE_SOURCE).toContain("rakuten_sold_out_revert_success");
    expect(SERVICE_SOURCE).toContain("rakuten_sold_out_revert_ready_not_run");
    expect(SERVICE_SOURCE).toContain("rakuten_sold_out_revert_failed_rolled_back");
  });
});
