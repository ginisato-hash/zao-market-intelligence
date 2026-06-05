import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROPOSED_REAL_RUN_COMMAND,
  REQUIRED_OPT_IN_FLAGS,
  TARGET_FILE_PLAN_CSV_HEADERS,
  TARGET_HISTORY_DIR,
  aggregateAppendActionsByShard,
  buildPreflightChecklist,
  buildRollbackPlan,
  buildTargetFilePlan,
  decideM05X,
  evaluateRealAppendApproval,
  renderProposalReport,
  renderTargetFilePlanCsv,
  type ProposalSummary,
  type RealAppendApprovalInput,
  type ShardAppendStats,
  type TargetFilePlanEntry
} from "../src/services/localHistoryRealAppendProposal";
import { type AppendActionRecord } from "../src/services/localHistoryAppendDryRun";

const SCRIPT_SOURCE = readFileSync(
  resolve(__dirname, "../src/scripts/buildLocalHistoryRealAppendProposal.ts"),
  "utf8"
);

// ---------------------------------------------------------------------------
// Fixtures: synthesize the M03X scenario-A append actions across 6 shards
// with 145 appends + 14 skips (06:6, 07:8) + 0 conflicts.
// ---------------------------------------------------------------------------

function action(shardMonth: string, appendAction: AppendActionRecord["appendAction"], i: number): AppendActionRecord {
  return {
    runId: "run_test",
    scenario: "A_empty_shard",
    shardMonth,
    futureHistoryPath: `.data/history/zao_signals_${shardMonth}.csv`,
    dryRunShardPath: `.data/debug/history-append-dry-run/TS/shards/zao_signals_${shardMonth}.csv`,
    rowId: `${shardMonth}-row-${appendAction}-${i}`,
    rowHash: `hash-${shardMonth}-${i}`,
    source: "booking",
    canonicalPropertyName: "蔵王国際ホテル",
    checkin: `${shardMonth.replace("_", "-")}-12`,
    appendAction,
    reason: "test"
  };
}

function makeScenarioActions(): AppendActionRecord[] {
  const plan: { month: string; append: number; skip: number }[] = [
    { month: "2026_05", append: 2, skip: 0 },
    { month: "2026_06", append: 60, skip: 6 },
    { month: "2026_07", append: 65, skip: 8 },
    { month: "2026_08", append: 13, skip: 0 },
    { month: "2026_10", append: 4, skip: 0 },
    { month: "2026_12", append: 1, skip: 0 }
  ];
  const out: AppendActionRecord[] = [];
  for (const p of plan) {
    for (let i = 0; i < p.append; i += 1) out.push(action(p.month, "append", i));
    for (let i = 0; i < p.skip; i += 1) out.push(action(p.month, "skip_duplicate_identical", i));
  }
  return out;
}

function buildPlan(historyFiles: string[] = []): TargetFilePlanEntry[] {
  const stats = aggregateAppendActionsByShard(makeScenarioActions());
  return buildTargetFilePlan({
    shardStats: stats,
    existingHistoryFiles: historyFiles,
    backupTimestamp: "20260602_090000",
    dryRunShardSourceByMonth: Object.fromEntries(stats.map((s) => [s.shardMonth, `.data/debug/x/zao_signals_${s.shardMonth}.csv`]))
  });
}

// ---------------------------------------------------------------------------
// Target file plan
// ---------------------------------------------------------------------------

describe("Phase M05X — target file plan", () => {
  it("(1) builds target file plan from M03X shard summary", () => {
    const plan = buildPlan();
    expect(plan.length).toBe(6);
    expect(plan.every((e) => e.targetFile.startsWith(`${TARGET_HISTORY_DIR}/zao_signals_`))).toBe(true);
  });

  it("(2) includes six expected target files", () => {
    const plan = buildPlan();
    expect(plan.map((e) => e.targetFile)).toEqual([
      ".data/history/zao_signals_2026_05.csv",
      ".data/history/zao_signals_2026_06.csv",
      ".data/history/zao_signals_2026_07.csv",
      ".data/history/zao_signals_2026_08.csv",
      ".data/history/zao_signals_2026_10.csv",
      ".data/history/zao_signals_2026_12.csv"
    ]);
  });

  it("(3) computes would_append_rows = 145 total", () => {
    const plan = buildPlan();
    expect(plan.reduce((s, e) => s + e.wouldAppendRows, 0)).toBe(145);
  });

  it("(4) computes would_skip_duplicates = 14 total", () => {
    const plan = buildPlan();
    expect(plan.reduce((s, e) => s + e.wouldSkipDuplicates, 0)).toBe(14);
  });

  it("(5) computes conflicts = 0 total", () => {
    const plan = buildPlan();
    expect(plan.reduce((s, e) => s + e.wouldConflictRows, 0)).toBe(0);
  });

  it("per-shard skips: 06=6, 07=8, others=0", () => {
    const plan = buildPlan();
    const byMonth = Object.fromEntries(plan.map((e) => [e.shardMonth, e.wouldSkipDuplicates]));
    expect(byMonth["2026_06"]).toBe(6);
    expect(byMonth["2026_07"]).toBe(8);
    expect(byMonth["2026_05"]).toBe(0);
  });

  it("(13) target file plan uses .data/history/zao_signals_YYYY_MM.csv future paths only", () => {
    const plan = buildPlan();
    for (const e of plan) {
      expect(e.targetFile).toMatch(/^\.data\/history\/zao_signals_\d{4}_\d{2}\.csv$/u);
    }
  });

  it("would_create_file=true when history dir empty; would_modify_file=true when file exists", () => {
    const createPlan = buildPlan([]);
    expect(createPlan.every((e) => e.wouldCreateFile && !e.wouldModifyFile)).toBe(true);
    const modifyPlan = buildPlan(["zao_signals_2026_06.csv"]);
    const jun = modifyPlan.find((e) => e.shardMonth === "2026_06")!;
    expect(jun.wouldCreateFile).toBe(false);
    expect(jun.wouldModifyFile).toBe(true);
  });

  it("(14) dry-run shard source uses debug path", () => {
    const plan = buildPlan();
    expect(plan.every((e) => e.dryRunShardSource.startsWith(".data/debug/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

describe("Phase M05X — approval gate", () => {
  const allPass: RealAppendApprovalInput = {
    explicitUserApproved: true,
    envRealHistoryAppend: "1",
    dryRunDecision: "local_history_append_dry_run_ready",
    policyDecision: "local_history_append_validation_policy_ready",
    hashConflictCount: 0,
    schemaValid: true,
    shardIntegrityPassed: true,
    forbiddenColumnErrors: 0,
    dbWriteMode: false,
    githubActionsMode: false
  };

  it("(6) false when explicitUserApproved=false", () => {
    const r = evaluateRealAppendApproval({ ...allPass, explicitUserApproved: false });
    expect(r.realAppendCurrentlyAllowed).toBe(false);
    expect(r.failedConditions).toContain("explicitUserApproved!=true");
  });

  it("(7) false when REAL_HISTORY_APPEND missing", () => {
    const r = evaluateRealAppendApproval({ ...allPass, envRealHistoryAppend: undefined });
    expect(r.realAppendCurrentlyAllowed).toBe(false);
    expect(r.failedConditions).toContain("REAL_HISTORY_APPEND!=1");
  });

  it("(8) false when dry-run decision not ready", () => {
    const r = evaluateRealAppendApproval({ ...allPass, dryRunDecision: "local_history_append_dry_run_not_ready" });
    expect(r.realAppendCurrentlyAllowed).toBe(false);
    expect(r.failedConditions).toContain("dryRunDecision!=ready");
  });

  it("(9) false when policy decision not ready", () => {
    const r = evaluateRealAppendApproval({ ...allPass, policyDecision: "local_history_append_validation_policy_not_ready" });
    expect(r.realAppendCurrentlyAllowed).toBe(false);
    expect(r.failedConditions).toContain("policyDecision!=ready");
  });

  it("(10) false when hash conflicts > 0", () => {
    const r = evaluateRealAppendApproval({ ...allPass, hashConflictCount: 3 });
    expect(r.realAppendCurrentlyAllowed).toBe(false);
    expect(r.failedConditions).toContain("hashConflictCount!=0");
  });

  it("(11) true only when all required conditions are true", () => {
    const r = evaluateRealAppendApproval(allPass);
    expect(r.realAppendCurrentlyAllowed).toBe(true);
    expect(r.failedConditions).toHaveLength(0);
  });

  it("false when shard integrity fails / forbidden columns / db / gha", () => {
    expect(evaluateRealAppendApproval({ ...allPass, shardIntegrityPassed: false }).realAppendCurrentlyAllowed).toBe(false);
    expect(evaluateRealAppendApproval({ ...allPass, forbiddenColumnErrors: 1 }).realAppendCurrentlyAllowed).toBe(false);
    expect(evaluateRealAppendApproval({ ...allPass, dbWriteMode: true }).realAppendCurrentlyAllowed).toBe(false);
    expect(evaluateRealAppendApproval({ ...allPass, githubActionsMode: true }).realAppendCurrentlyAllowed).toBe(false);
  });

  it("required opt-in flags include REAL_HISTORY_APPEND=1", () => {
    expect(REQUIRED_OPT_IN_FLAGS).toContain("REAL_HISTORY_APPEND=1");
  });
});

// ---------------------------------------------------------------------------
// Rollback plan & preflight checklist
// ---------------------------------------------------------------------------

describe("Phase M05X — rollback & preflight", () => {
  it("(15) rollback plan includes a backup path", () => {
    const plan = buildRollbackPlan("20260602_090000");
    expect(plan.backupPathTemplate).toBe(".data/history/.backup/20260602_090000/zao_signals_YYYY_MM.csv.bak");
    expect(plan.backupsCreated).toBe(false);
  });

  it("(16) rollback plan requires temp write then atomic rename", () => {
    const plan = buildRollbackPlan("20260602_090000");
    expect(plan.noPartialWrites).toMatch(/temp file/u);
    expect(plan.noPartialWrites).toMatch(/atomic rename/u);
  });

  it("(17) preflight checklist includes M03X and M04X reruns", () => {
    const checklist = buildPreflightChecklist();
    const text = checklist.map((c) => c.check).join("\n");
    expect(text).toMatch(/M03X/u);
    expect(text).toMatch(/M04X/u);
    expect(text).toMatch(/REAL_HISTORY_APPEND=1/u);
    expect(checklist).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

describe("Phase M05X — decision", () => {
  const passing = {
    dryRunDecision: "local_history_append_dry_run_ready",
    policyDecision: "local_history_append_validation_policy_ready",
    hashConflictCount: 0,
    schemaValid: true,
    targetFilePlanGenerated: true,
    rollbackPlanGenerated: true,
    realAppendCurrentlyAllowed: false,
    historyDirModified: false,
    historyDirPreExisted: false
  };

  it("(18) ready when all preconditions pass and real append remains blocked", () => {
    expect(decideM05X(passing)).toBe("local_history_real_append_proposal_ready");
  });

  it("(19) not_ready if approval gate allows real append in proposal mode", () => {
    expect(decideM05X({ ...passing, realAppendCurrentlyAllowed: true })).toBe("local_history_real_append_proposal_not_ready");
  });

  it("not_ready if hash conflicts > 0 or M03X/M04X not ready", () => {
    expect(decideM05X({ ...passing, hashConflictCount: 1 })).toBe("local_history_real_append_proposal_not_ready");
    expect(decideM05X({ ...passing, dryRunDecision: "x" })).toBe("local_history_real_append_proposal_not_ready");
    expect(decideM05X({ ...passing, policyDecision: "x" })).toBe("local_history_real_append_proposal_not_ready");
  });

  it("not_ready if .data/history modified", () => {
    expect(decideM05X({ ...passing, historyDirModified: true })).toBe("local_history_real_append_proposal_not_ready");
  });

  it("basis_caution if .data/history pre-existed but otherwise ready", () => {
    expect(decideM05X({ ...passing, historyDirPreExisted: true })).toBe("local_history_real_append_proposal_basis_caution");
  });
});

// ---------------------------------------------------------------------------
// CSV renderer
// ---------------------------------------------------------------------------

describe("Phase M05X — CSV renderer", () => {
  it("(20) outputs the target file plan, not history rows", () => {
    const csv = renderTargetFilePlanCsv("prop_test", buildPlan());
    expect(csv.split("\n")[0]).toBe(TARGET_FILE_PLAN_CSV_HEADERS.join(","));
    expect(csv).toMatch(/zao_signals_2026_06\.csv/u);
    expect(csv).toMatch(/prop_test/u);
  });

  it("(21) excludes history schema payload columns like normalized_total_price", () => {
    const csv = renderTargetFilePlanCsv("prop_test", buildPlan());
    expect(csv).not.toMatch(/normalized_total_price/u);
    expect(csv).not.toMatch(/availability_status/u);
    expect(csv).not.toMatch(/row_hash/u);
  });
});

// ---------------------------------------------------------------------------
// Report renderer
// ---------------------------------------------------------------------------

describe("Phase M05X — report renderer", () => {
  function makeSummary(): ProposalSummary {
    const plan = buildPlan();
    return {
      proposalId: "prop_test",
      generatedAtJst: "2026-06-02T09:00:00+09:00",
      sourceDryRunArtifact: "/m03x.json",
      sourcePolicyArtifact: "/m04x.json",
      schemaVersion: "zao_local_history_v1",
      realAppendDefaultEnabled: false,
      realAppendCurrentlyAllowed: false,
      requiredOptInFlags: [...REQUIRED_OPT_IN_FLAGS],
      targetHistoryDir: TARGET_HISTORY_DIR,
      targetFiles: plan.map((e) => e.targetFile),
      wouldCreateHistoryDir: true,
      wouldCreateFiles: plan.map((e) => e.targetFile),
      wouldModifyFiles: [],
      wouldAppendRows: 145,
      wouldSkipDuplicates: 14,
      wouldBlockConflicts: 0,
      decision: "local_history_real_append_proposal_ready"
    };
  }

  it("(22) report explicitly states no real write performed", () => {
    const report = renderProposalReport({
      summary: makeSummary(),
      approval: { realAppendCurrentlyAllowed: false, failedConditions: ["explicitUserApproved!=true"] },
      targetFilePlan: buildPlan(),
      rollbackPlan: buildRollbackPlan("20260602_090000"),
      preflightChecklist: buildPreflightChecklist(),
      proposedRealRunCommand: PROPOSED_REAL_RUN_COMMAND,
      historyDirExistedBefore: false,
      historyDirExistingFiles: [],
      historyDirModified: false,
      reportPath: "/out.md",
      csvPath: "/out.csv",
      jsonPath: "/out.json",
      debugRootPath: "/debug"
    });
    expect(report).toMatch(/PROPOSAL ONLY: M05X performs NO real \.data\/history write/u);
    expect(report).toMatch(/real_append_currently_allowed=false/u);
    expect(report).toMatch(/REAL_HISTORY_APPEND=1/u);
    expect(report).toMatch(/NOT written this phase/u);
  });
});

// ---------------------------------------------------------------------------
// Script source scans
// ---------------------------------------------------------------------------

describe("Phase M05X — script source scans", () => {
  it("(12)+(23) script never writes to .data/history", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history/u);
    expect(SCRIPT_SOURCE).toMatch(/assertNotRealHistoryPath/u);
  });

  it("(24) script sets EXPLICIT_USER_APPROVED = false", () => {
    expect(SCRIPT_SOURCE).toMatch(/EXPLICIT_USER_APPROVED\s*=\s*false/u);
  });

  it("(25) missing M03X or M04X artifact gives a clear error", () => {
    expect(SCRIPT_SOURCE).toMatch(/Stop and report the missing artifact path/u);
    expect(SCRIPT_SOURCE).toMatch(/Do not re-run collectors/u);
  });

  it("script guards against a real-run by keeping the approval gate closed", () => {
    expect(SCRIPT_SOURCE).toMatch(/proposal-only/u);
    expect(SCRIPT_SOURCE).toMatch(/Safety violation/u);
  });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe("Phase M05X — aggregation", () => {
  it("aggregateAppendActionsByShard sorts and counts correctly", () => {
    const stats: ShardAppendStats[] = aggregateAppendActionsByShard(makeScenarioActions());
    expect(stats.map((s) => s.shardMonth)).toEqual(["2026_05", "2026_06", "2026_07", "2026_08", "2026_10", "2026_12"]);
    expect(stats.reduce((s, e) => s + e.appendRows, 0)).toBe(145);
    expect(stats.reduce((s, e) => s + e.skipDuplicates, 0)).toBe(14);
  });
});
