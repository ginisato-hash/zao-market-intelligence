import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCompatibilityPlan,
  buildExistingSyncFlowInventory,
  buildFailureBehavior,
  buildFreshSyncWorkflowDesign,
  buildFutureCommandDesign,
  buildGateMatrix,
  buildIdempotencyPolicy,
  buildSafetyConfirmation,
  buildSyncRiskAnalysis,
  decideAutoRunnerFreshDbSync,
  renderReport,
  renderWorkflowCsv
} from "../src/services/autoRunnerFreshDbSyncProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerFreshDbSyncProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerFreshDbSyncProposal.ts"), "utf8");
const REAL_RUN_SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runHistoryToDbSyncRealRun.ts"), "utf8");
const REAL_RUN_SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/historyToDbSyncRealRun.ts"), "utf8");
const REAL_RUN_TEST_SOURCE = readFileSync(resolve(__dirname, "../tests/historyToDbSyncRealRun.test.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const inventory = buildExistingSyncFlowInventory({
  dryRunArtifacts: [".data/reports/automation/history_to_db_sync_dry_run_20260605_104149.json"],
  realRunArtifacts: [".data/reports/automation/history_to_db_sync_real_run_20260605_104320.json"],
  realRunScriptSource: REAL_RUN_SCRIPT_SOURCE,
  realRunServiceSource: REAL_RUN_SERVICE_SOURCE,
  realRunTestSource: REAL_RUN_TEST_SOURCE
});

describe("AUTO-RUNNER07B - existing risk analysis", () => {
  it("identifies hardcoded artifact pointer risk", () => {
    expect(inventory.observed_risks.join("\n")).toContain("hardcoded dry-run summary artifact pointer");
    expect(buildSyncRiskAnalysis().risks.map((risk) => risk.risk_id)).toContain("hardcoded_artifact_pointer");
  });

  it("identifies APPROVED_MAPPED_ROW_COUNT stale pin risk", () => {
    expect(inventory.observed_risks.join("\n")).toContain("APPROVED_MAPPED_ROW_COUNT");
    expect(buildSyncRiskAnalysis().risks.map((risk) => risk.risk_id)).toContain("approved_mapped_row_count_stale_pin");
  });

  it("requires fresh dry-run in same run", () => {
    expect(buildFreshSyncWorkflowDesign().steps.map((step) => step.name)).toContain("create fresh dry-run in same run");
  });

  it("requires mapped count equals current history count", () => {
    expect(buildFreshSyncWorkflowDesign().steps.map((step) => step.validation).join("\n")).toContain("mapped_row_count === current_history_row_count");
  });

  it("requires conflict count = 0", () => {
    expect(buildFreshSyncWorkflowDesign().steps.map((step) => step.validation).join("\n")).toContain("conflict count = 0");
  });

  it("requires HISTORY_TO_DB_SYNC=1 for write-capable future command", () => {
    expect(buildGateMatrix().find((gate) => gate.gate === "HISTORY_TO_DB_SYNC")!.default_value).toBe("0");
    expect(buildFreshSyncWorkflowDesign().steps.map((step) => step.validation).join("\n")).toContain("HISTORY_TO_DB_SYNC=1");
  });
});

describe("AUTO-RUNNER07B - idempotency and failure behavior", () => {
  it("supports DB already up-to-date noop", () => {
    expect(buildIdempotencyPolicy().cases.find((item) => item.case_id === "db_already_up_to_date")!.expected_behavior).toContain("inserted=0");
  });

  it("supports DB behind history insertion", () => {
    expect(buildIdempotencyPolicy().cases.find((item) => item.case_id === "db_behind_history")!.expected_behavior).toContain("insert missing rows");
  });

  it("stops on hash conflict", () => {
    expect(buildIdempotencyPolicy().cases.find((item) => item.case_id === "hash_conflict")!.expected_behavior).toContain("stop");
  });

  it("stops on duplicate history row_id", () => {
    expect(buildFailureBehavior().stop_conditions).toContain("duplicate row_id in history");
  });

  it("stops on schema invalid", () => {
    expect(buildFailureBehavior().stop_conditions).toContain("schema invalid");
  });

  it("avoids source-specific AUTO03X naming in future design", () => {
    expect(JSON.stringify(buildFutureCommandDesign())).not.toContain("AUTO03X");
    expect(buildFutureCommandDesign().source_specific_hardcoding_allowed).toBe(false);
  });

  it("proposes generic command name", () => {
    expect(buildFutureCommandDesign().proposed_command).toBe("sync:history-to-db:fresh");
  });

  it("keeps existing manual flow compatible", () => {
    expect(buildCompatibilityPlan().rules.join("\n")).toContain("Keep existing manually reviewed real-run flow intact");
  });
});

describe("AUTO-RUNNER07B - rendering and decision", () => {
  it("Decision ready/basis_caution/not_ready", () => {
    expect(decideAutoRunnerFreshDbSync({ source07xPresent: false, inspectedExistingFlow: true, writeCapableImplementationDeferred: true })).toBe(
      "auto_runner_fresh_db_sync_proposal_not_ready"
    );
    expect(decideAutoRunnerFreshDbSync({ source07xPresent: true, inspectedExistingFlow: true, writeCapableImplementationDeferred: true })).toBe(
      "auto_runner_fresh_db_sync_proposal_basis_caution"
    );
    expect(decideAutoRunnerFreshDbSync({ source07xPresent: true, inspectedExistingFlow: true, writeCapableImplementationDeferred: false })).toBe(
      "auto_runner_fresh_db_sync_proposal_ready"
    );
  });

  it("renders CSV and report", () => {
    expect(renderWorkflowCsv(buildFreshSyncWorkflowDesign())).toContain("step_id");
    expect(
      renderReport({
        generatedAtJst: "2026-06-05T16:45:00+09:00",
        decision: "auto_runner_fresh_db_sync_proposal_basis_caution",
        source07xPath: "auto07x.json",
        current: {
          history_rows: 210,
          db_rows: 210,
          ai_context_rows: 210,
          booking: { rows: 46, directional: 42, excluded: 4, direct: 0, role: "primary" },
          jalan: { rows: 38, directional: 8, excluded: 24, direct: 6, role: "supplementary" },
          rakuten: { rows: 126, role: "frozen" }
        },
        inventory,
        riskAnalysis: buildSyncRiskAnalysis(),
        workflow: buildFreshSyncWorkflowDesign(),
        gates: buildGateMatrix(),
        idempotency: buildIdempotencyPolicy(),
        failure: buildFailureBehavior(),
        futureCommand: buildFutureCommandDesign(),
        compatibility: buildCompatibilityPlan(),
        risks: [],
        safety: buildSafetyConfirmation()
      })
    ).toContain("Fresh History-to-DB Sync Helper Proposal");
  });

  it("package contains proposal script", () => {
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-fresh-db-sync");
  });
});

describe("AUTO-RUNNER07B - executable safety scans", () => {
  it("does not run dry-run command in this phase", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/dry-run:history-to-db-sync|runHistoryToDbSyncDryRun\(/u);
  });

  it("does not run real sync command in this phase", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/real-run:history-to-db-sync|runHistoryToDbSyncRealRun\(/u);
  });

  it("No DB write code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/openLocalDatabase|applyRealSync|INSERT INTO|DELETE FROM|UPDATE market_signal/iu);
  });

  it("No DB sync execution code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC=1|process\.env\[['"]HISTORY_TO_DB_SYNC|applyRealSync/iu);
  });

  it("No AI context refresh code exists", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("No history write code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*\.data\/history|appendHistory|realHistoryAppend/u);
  });

  it("No collector / Playwright code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/npm run probe:|npm run collect:|from\s+["']playwright|chromium|browser\.launch|newPage/u);
  });

  it("No pricing CSV / PMS output code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*beds24|writeFileSync\([^,]*airhost|GENERATE_PRICE_CSV=1|pricing_recommendation/iu);
  });
});
