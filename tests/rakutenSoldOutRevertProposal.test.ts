import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIX01_AUDIT_JSON,
  FUTURE_APPROVAL_SENTENCE,
  FUTURE_ENV_FLAG,
  buildAiContextRebuildPlan,
  buildApprovalGateTemplate,
  buildBackupRollbackPlan,
  buildDbResyncPlan,
  buildRakutenSoldOutRevertProposal,
  buildShardCountPlan,
  buildWritePlan,
  ensureRemovalSetOnlyAuto08x,
  groupAffectedRowsByShard,
  identifyAffectedRemovalRows,
  renderRakutenSoldOutRevertProposalCsv,
  type LoadedHistoryRowForRevert
} from "../src/services/rakutenSoldOutRevertProposal";

const SERVICE_SOURCE = readFileSync(resolve("src/services/rakutenSoldOutRevertProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve("src/scripts/buildRakutenSoldOutRevertProposal.ts"), "utf8");

function affectedRow(shard: "2026_06" | "2026_07", index: number): LoadedHistoryRowForRevert {
  const property = index % 2 === 0 ? "蔵王国際ホテル" : "名湯リゾート ルーセント";
  const sourceCode = property === "蔵王国際ホテル" ? "5723:00" : "39565:honkan-exk";
  const hotelNo = property === "蔵王国際ホテル" ? "5723" : "39565";
  return {
    row_id: `${shard}|affected|${index}`,
    row_hash: `hash-${shard}-${index}`,
    shard_month: shard,
    source: "rakuten",
    source_phase: "AUTO08X",
    collector_stage: "auto_history_append_guarded_real_run",
    canonical_property_name: property,
    source_property_id: hotelNo,
    source_slug_or_code: sourceCode,
    checkin: shard === "2026_06" ? "2026-06-03" : "2026-07-03",
    availability_status: "sold_out",
    source_classification: "rakuten_day_sold_out",
    dp_usage: "excluded",
    is_price_excluded_from_dp: "true",
    debug_artifact_path: ".data/debug/auto-history-append/20260604_094714",
    __source_file: `.data/history/zao_signals_${shard}.csv`
  };
}

function cleanRow(shard: "2026_06" | "2026_07", index: number): LoadedHistoryRowForRevert {
  return {
    row_id: `${shard}|clean|${index}`,
    row_hash: `clean-hash-${shard}-${index}`,
    shard_month: shard,
    source: "rakuten",
    source_phase: "Phase66X",
    canonical_property_name: "蔵王国際ホテル",
    source_property_id: "5723",
    source_slug_or_code: "5723",
    checkin: shard === "2026_06" ? "2026-06-01" : "2026-07-01",
    availability_status: "available",
    source_classification: "rakuten_day_available_price_link",
    dp_usage: "directional",
    debug_artifact_path: ".data/debug/other-run",
    __source_file: `.data/history/zao_signals_${shard}.csv`
  };
}

function fixtureRows(): LoadedHistoryRowForRevert[] {
  return [
    ...Array.from({ length: 54 }, (_, i) => affectedRow("2026_06", i)),
    ...Array.from({ length: 60 }, (_, i) => cleanRow("2026_06", i)),
    ...Array.from({ length: 62 }, (_, i) => affectedRow("2026_07", i)),
    ...Array.from({ length: 65 }, (_, i) => cleanRow("2026_07", i))
  ];
}

function fixtureProposal() {
  return buildRakutenSoldOutRevertProposal({
    runId: "rakuten_sold_out_revert_proposal_test",
    generatedAtJst: "2026-06-04T10:50:00+09:00",
    sourceFix01Artifact: FIX01_AUDIT_JSON,
    fix01Decision: "rakuten_sold_out_semantics_audit_basis_caution",
    fix01AffectedHistoryRows: 116,
    historyRows: fixtureRows()
  });
}

describe("rakuten sold-out revert proposal", () => {
  it("loads FIX01 audit artifact path into proposal", () => {
    const proposal = fixtureProposal();
    expect(proposal.source_fix01_artifact).toBe(FIX01_AUDIT_JSON);
  });

  it("identifies 116 affected row_ids", () => {
    const affected = identifyAffectedRemovalRows(fixtureRows());
    expect(affected).toHaveLength(116);
    expect(new Set(affected.map((row) => row.row_id)).size).toBe(116);
  });

  it("groups affected rows by shard", () => {
    const grouped = groupAffectedRowsByShard(identifyAffectedRemovalRows(fixtureRows()));
    expect(grouped).toEqual({ "2026_06": 54, "2026_07": 62 });
  });

  it("confirms only 2026_06 and 2026_07 are touched", () => {
    const proposal = fixtureProposal();
    expect(proposal.touched_shards).toEqual(["2026_06", "2026_07"]);
  });

  it("computes before/after shard counts", () => {
    const plan = buildShardCountPlan(fixtureRows(), identifyAffectedRemovalRows(fixtureRows()));
    expect(plan).toEqual([
      {
        shard_month: "2026_06",
        source_file: ".data/history/zao_signals_2026_06.csv",
        before_rows: 114,
        affected_rows: 54,
        after_rows: 60
      },
      {
        shard_month: "2026_07",
        source_file: ".data/history/zao_signals_2026_07.csv",
        before_rows: 127,
        affected_rows: 62,
        after_rows: 65
      }
    ]);
  });

  it("ensures no non-AUTO08X row_ids are in removal set", () => {
    const rows = fixtureRows();
    const affected = identifyAffectedRemovalRows(rows);
    expect(ensureRemovalSetOnlyAuto08x(rows, affected.map((row) => row.row_id))).toBe(true);
    expect(ensureRemovalSetOnlyAuto08x(rows, [...affected.map((row) => row.row_id), "2026_06|clean|1"])).toBe(false);
  });

  it("produces backup plan", () => {
    const plan = buildBackupRollbackPlan([".data/history/zao_signals_2026_06.csv"]);
    expect(plan.backup_dir_template).toContain(".data/history/.backup");
    expect(plan.rollback_steps.join("\n")).toContain("restore");
  });

  it("produces temp-write + atomic rename plan", () => {
    const plan = buildWritePlan();
    expect(plan.temp_file_pattern).toContain("tmp_rakuten_soldout_revert");
    expect(plan.steps.join("\n")).toContain("Atomic rename");
    expect(plan.validation_checks).toContain("removed row count = 116");
  });

  it("produces DB resync plan after revert", () => {
    const plan = buildDbResyncPlan();
    expect(plan.expected_market_signal_history_rows_before).toBe(261);
    expect(plan.expected_market_signal_history_rows_after).toBe(145);
    expect(plan.steps.join("\n")).toContain("history-to-DB dry-run");
  });

  it("produces AI context rebuild plan after DB resync", () => {
    const plan = buildAiContextRebuildPlan();
    expect(plan.expected_sold_out_row_count_before).toBe(182);
    expect(plan.expected_sold_out_row_count_after).toBe(66);
    expect(plan.expected_basis_confidence_insufficient_before).toBe(119);
    expect(plan.expected_basis_confidence_insufficient_after).toBe(3);
  });

  it("future approval sentence exists but is not active", () => {
    const gate = buildApprovalGateTemplate();
    expect(gate.approval_sentence_template).toBe(FUTURE_APPROVAL_SENTENCE);
    expect(gate.approval_is_active_in_this_phase).toBe(false);
  });

  it("future env flag is RAKUTEN_SOLDOUT_REVERT=1", () => {
    expect(buildApprovalGateTemplate().required_env_flag).toBe(FUTURE_ENV_FLAG);
    expect(buildApprovalGateTemplate().required_command).toContain("RAKUTEN_SOLDOUT_REVERT=1");
  });

  it("does not modify .data/history", () => {
    expect(SERVICE_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history/u);
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*HISTORY_FILES/u);
    expect(SCRIPT_SOURCE).not.toMatch(/renameSync|copyFileSync|appendFileSync|rmSync|unlinkSync/u);
  });

  it("does not write DB", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/better-sqlite3|openLocalDatabase|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE/i);
  });

  it("does not run DB sync", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/child_process|spawn\(|exec\(|execFile\(/);
  });

  it("does not rebuild AI context", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*ai-context/u);
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/child_process|spawn\(|exec\(|execFile\(/);
  });

  it("does not run collectors", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/runAutoHistoryAppendRealRun|collect:jalan|probe:rakuten-limited/i);
  });

  it("does not use Playwright", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright["']|chromium\.|firefox\.|webkit\./i);
  });

  it("uses no paid-source tooling", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/i);
  });

  it("decision is proposal_ready or proposal_basis_caution", () => {
    expect(["rakuten_sold_out_revert_proposal_ready", "rakuten_sold_out_revert_proposal_basis_caution"]).toContain(fixtureProposal().decision);
  });

  it("CSV renderer emits affected row removal set only", () => {
    const csv = renderRakutenSoldOutRevertProposalCsv(fixtureProposal());
    expect(csv.split(/\r?\n/u).filter(Boolean)).toHaveLength(117);
    expect(csv).not.toMatch(/roomid|inventory|minstay|maxstay|price1|Beds24|AirHost|PMS/);
  });
});
