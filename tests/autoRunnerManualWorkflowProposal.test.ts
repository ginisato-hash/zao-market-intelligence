import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCurrentStateSummary,
  buildDryRunBehavior,
  buildFailureHandlingPlan,
  buildFutureRunnerCommandDesign,
  buildGateMatrix,
  buildHumanReviewCheckpoints,
  buildManualWorkflowStages,
  buildSafetyConfirmation,
  buildScriptInventoryClassification,
  decideAutoRunnerManualWorkflowProposal,
  renderInventoryCsv,
  renderReport,
  type AutoRunner02xArtifactLike
} from "../src/services/autoRunnerManualWorkflowProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerManualWorkflowProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerManualWorkflowProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function sourceArtifact(): AutoRunner02xArtifactLike {
  return {
    decision: "auto_runner_bootstrap_proposal_basis_caution",
    current_state_summary: {
      history_rows: 210,
      db_rows: 210,
      ai_context_rows: 210,
      source_counts: { booking: 46, jalan: 38, rakuten: 126 },
      current_blockers: ["always_on_mac_unverified"]
    },
    risks: ["db_regeneration_command_needed"]
  };
}

describe("AUTO-RUNNER03X - workflow stages and gates", () => {
  it("includes all manual workflow stages", () => {
    expect(buildManualWorkflowStages()).toHaveLength(12);
  });

  it("includes disabled-by-default gates", () => {
    expect(buildGateMatrix().every((row) => row.default === "disabled")).toBe(true);
  });

  it("requires COLLECT_BOOKING=1 for Booking collection", () => {
    expect(buildGateMatrix().map((row) => row.gate)).toContain("COLLECT_BOOKING=1");
  });

  it("requires COLLECT_JALAN=1 for Jalan collection", () => {
    expect(buildGateMatrix().map((row) => row.gate)).toContain("COLLECT_JALAN=1");
  });

  it("requires append gates for history append", () => {
    const gates = buildGateMatrix().map((row) => row.gate);
    expect(gates).toContain("BOOKING_HISTORY_APPEND=1");
    expect(gates).toContain("JALAN_HISTORY_APPEND=1");
  });

  it("requires HISTORY_TO_DB_SYNC=1 for DB sync", () => {
    expect(buildGateMatrix().map((row) => row.gate)).toContain("HISTORY_TO_DB_SYNC=1");
  });

  it("requires BUILD_AI_CONTEXT=1 for context refresh", () => {
    expect(buildGateMatrix().map((row) => row.gate)).toContain("BUILD_AI_CONTEXT=1");
  });

  it("requires GENERATE_PRICE_CSV=1 for pricing CSV", () => {
    expect(buildGateMatrix().map((row) => row.gate)).toContain("GENERATE_PRICE_CSV=1");
  });

  it("separates collection from pricing decision", () => {
    const stages = buildManualWorkflowStages();
    expect(stages.find((row) => row.name.includes("Booking"))?.stage).toBeLessThan(stages.find((row) => row.name.includes("pricing CSV"))!.stage);
  });

  it("includes human review checkpoints", () => {
    expect(buildHumanReviewCheckpoints().join("\n")).toContain("Before any pricing CSV generation");
  });
});

describe("AUTO-RUNNER03X - inventory, roles, dry-run, failures", () => {
  it("classifies scripts into safe/proposal/live/write categories", () => {
    const rows = buildScriptInventoryClassification({
      typecheck: "tsc --noEmit",
      "proposal:jalan-history-append": "node --import tsx x.ts",
      "probe:booking-bounded-expanded": "node --import tsx y.ts",
      "real-run:jalan-history-append": "node --import tsx z.ts",
      "build:ai-context-packs": "node --import tsx c.ts"
    });
    expect(rows.map((row) => row.category)).toEqual(expect.arrayContaining(["safe_validation", "proposal_only", "live_collector", "history_append", "ai_context_refresh"]));
  });

  it("keeps Booking primary and Jalan supplementary", () => {
    const current = buildCurrentStateSummary(sourceArtifact());
    expect(current.booking.role).toContain("primary");
    expect(current.jalan.role).toContain("supplementary");
  });

  it("keeps Rakuten frozen", () => {
    expect(buildCurrentStateSummary(sourceArtifact()).rakuten.role).toContain("frozen");
  });

  it("includes dry-run behavior", () => {
    expect(buildDryRunBehavior().future_command).toContain("--dry-run");
  });

  it("includes fail-closed behavior", () => {
    expect(buildFailureHandlingPlan().fail_closed_rules.join("\n")).toContain("stop");
  });

  it("stops on block/CAPTCHA/degraded page", () => {
    expect(buildFailureHandlingPlan().fail_closed_rules.join("\n")).toContain("block/CAPTCHA/degraded");
  });

  it("stops on append conflicts", () => {
    expect(buildFailureHandlingPlan().fail_closed_rules.join("\n")).toContain("append proposal has conflicts");
  });

  it("stops on DB sync conflicts", () => {
    expect(buildFailureHandlingPlan().fail_closed_rules.join("\n")).toContain("DB sync conflicts");
  });

  it("renders report and CSV", () => {
    const current = buildCurrentStateSummary(sourceArtifact());
    const stages = buildManualWorkflowStages();
    const gates = buildGateMatrix();
    expect(renderInventoryCsv(buildScriptInventoryClassification({ typecheck: "tsc --noEmit" }))).toContain("script_name");
    expect(
      renderReport({
        generatedAtJst: "2026-06-05T13:00:00+09:00",
        decision: "auto_runner_manual_workflow_proposal_basis_caution",
        sourceArtifactPath: "auto02x.json",
        current,
        inventory: [],
        stages,
        gates,
        dryRun: buildDryRunBehavior(),
        failure: buildFailureHandlingPlan(),
        review: buildHumanReviewCheckpoints(),
        commandDesign: buildFutureRunnerCommandDesign(),
        risks: [],
        safety: buildSafetyConfirmation()
      })
    ).toContain("Manual Market Intelligence Workflow Proposal");
  });

  it("decision ready/basis_caution/not_ready", () => {
    expect(decideAutoRunnerManualWorkflowProposal({ sourcePresent: true, stages: buildManualWorkflowStages(), gates: buildGateMatrix() })).toBe(
      "auto_runner_manual_workflow_proposal_basis_caution"
    );
    expect(decideAutoRunnerManualWorkflowProposal({ sourcePresent: false, stages: [], gates: [] })).toBe("auto_runner_manual_workflow_proposal_not_ready");
  });
});

describe("AUTO-RUNNER03X - executable safety scans", () => {
  it("No live collector command executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/execSync|spawn\(|child_process|npm run probe:|npm run collect:/u);
  });

  it("No Playwright/browser automation code executed", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium|browser\.launch|newPage/u);
  });

  it("No history write code executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*\.data\/history|appendHistory|realHistoryAppend/u);
  });

  it("No DB sync code executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|real-run:history-to-db-sync|INSERT INTO|DELETE FROM|UPDATE market_signal/iu);
  });

  it("No AI context refresh code executed", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("No pricing CSV/PMS output code executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/execSync\(.*pricing|spawn\(.*pricing|writeFileSync\(.*pricing_recommendation|writeFileSync\(.*beds24|writeFileSync\(.*airhost/iu);
  });

  it("No cron/launchd/GitHub Actions file created", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/LaunchAgents|launchctl|crontab|\.github\/workflows|workflow_dispatch/u);
  });

  it("package contains proposal script", () => {
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-manual-workflow");
  });
});
