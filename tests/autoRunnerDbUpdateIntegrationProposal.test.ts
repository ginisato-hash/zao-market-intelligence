import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAiContextFollowupPolicy,
  buildCompatibilityPlan,
  buildCurrentStateSummary,
  buildDbSyncIntegrationPolicy,
  buildFailureHandlingPlan,
  buildFreshSyncHelperSummary,
  buildGateMatrix,
  buildPriceOutputSeparation,
  buildSafetyConfirmation,
  buildUpdatedPipelineStages,
  decideAutoRunnerDbUpdateIntegration,
  renderPipelineCsv,
  renderReport
} from "../src/services/autoRunnerDbUpdateIntegrationProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerDbUpdateIntegrationProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerDbUpdateIntegrationProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const source07c = {
  decision: "fresh_history_to_db_sync_noop",
  history_summary: { row_count: 210 },
  fresh_mapping_summary: { mapped_row_count: 210 },
  sync_result: { inserted_rows: 0, skipped_identical_rows: 210, conflict_rows: 0 }
};

function stage(namePart: string) {
  return buildUpdatedPipelineStages().find((item) => item.name.includes(namePart))!;
}

function gate(name: string) {
  return buildGateMatrix().find((item) => item.gate === name)!;
}

describe("AUTO-RUNNER07D - updated pipeline and DB sync integration", () => {
  it("Updated pipeline includes fresh DB sync stage", () => {
    expect(buildUpdatedPipelineStages().map((item) => item.name)).toContain("fresh DB sync via sync:history-to-db:fresh, gated");
  });

  it("Fresh sync stage uses sync:history-to-db:fresh", () => {
    expect(stage("fresh DB sync").candidate_commands).toContain("future: npm run sync:history-to-db:fresh");
    expect(buildDbSyncIntegrationPolicy().approved_automated_sync_path).toBe("sync:history-to-db:fresh");
  });

  it("Does not reference old hardcoded dry-run artifact pointer workflow", () => {
    const policyText = JSON.stringify(buildDbSyncIntegrationPolicy());
    expect(policyText).not.toMatch(/AUTO03X_JSON|AUTO03X_MAPPED_ROWS|history_to_db_sync_dry_run_\d{8}_\d{6}/u);
  });

  it("Does not reference APPROVED_MAPPED_ROW_COUNT as future runner dependency", () => {
    expect(JSON.stringify(buildDbSyncIntegrationPolicy())).not.toContain("APPROVED_MAPPED_ROW_COUNT");
  });

  it("Requires HISTORY_TO_DB_SYNC=1", () => {
    expect(stage("fresh DB sync").required_gates).toContain("HISTORY_TO_DB_SYNC=1");
    expect(gate("HISTORY_TO_DB_SYNC").default_value).toBe("0");
  });

  it("Supports optional EXPECTED_HISTORY_ROW_COUNT", () => {
    expect(buildGateMatrix().map((item) => item.gate)).toContain("EXPECTED_HISTORY_ROW_COUNT");
    expect(buildDbSyncIntegrationPolicy().rules.join("\n")).toContain("EXPECTED_HISTORY_ROW_COUNT");
  });

  it("Keeps old manual real-run flow as emergency/manual compatibility only", () => {
    expect(buildCompatibilityPlan().rules.join("\n")).toContain("emergency/manual use");
    expect(buildCompatibilityPlan().rules.join("\n")).toContain("only approved DB sync path for future automation");
  });
});

describe("AUTO-RUNNER07D - failure handling and downstream gates", () => {
  it("Stops on fresh sync mapped-count mismatch", () => {
    expect(buildFailureHandlingPlan().stop_conditions).toContain("fresh sync mapped-count mismatch");
  });

  it("Stops on fresh sync conflicts", () => {
    expect(buildFailureHandlingPlan().stop_conditions).toContain("fresh sync conflicts > 0");
  });

  it("Stops on fresh sync post-state mismatch", () => {
    expect(buildFailureHandlingPlan().stop_conditions).toContain("fresh sync DB post-state mismatch");
  });

  it("Stops on collector baseline drift", () => {
    expect(buildFailureHandlingPlan().stop_conditions).toContain("fresh sync collector baseline drift");
  });

  it("Allows noop when no new rows are appended", () => {
    expect(buildFailureHandlingPlan().noop_behavior).toContain("return noop");
    expect(buildFailureHandlingPlan().noop_behavior).toContain("no_new_rows");
  });

  it("Separates AI context refresh behind BUILD_AI_CONTEXT", () => {
    expect(stage("AI context").required_gates).toContain("BUILD_AI_CONTEXT=1");
    expect(buildAiContextFollowupPolicy().rules.join("\n")).toContain("BUILD_AI_CONTEXT=1");
  });

  it("Separates price report and CSV outputs", () => {
    const separation = buildPriceOutputSeparation();
    expect(separation.default_gates.GENERATE_PRICE_REPORT).toBe("0");
    expect(separation.default_gates.GENERATE_PRICE_CSV).toBe("0");
    expect(separation.excluded_outputs).toContain("Beds24 CSV");
    expect(stage("stop before price").required_gates).toContain("GENERATE_PRICE_CSV=0");
  });
});

describe("AUTO-RUNNER07D - source roles and rendering", () => {
  it("Keeps Booking primary", () => {
    expect(buildCurrentStateSummary().booking.role).toContain("primary");
  });

  it("Keeps Jalan supplementary", () => {
    expect(buildCurrentStateSummary().jalan.role).toContain("supplementary");
  });

  it("Keeps Rakuten frozen", () => {
    expect(buildCurrentStateSummary().rakuten.role).toContain("frozen");
  });

  it("Summarizes fresh helper result", () => {
    const summary = buildFreshSyncHelperSummary(source07c);
    expect(summary.latest_decision).toBe("fresh_history_to_db_sync_noop");
    expect(summary.history_count).toBe(210);
    expect(summary.mapped_row_count).toBe(210);
    expect(summary.conflict_rows).toBe(0);
    expect(summary.stale_pointer_used).toBe(false);
  });

  it("Decision ready/basis_caution/not_ready", () => {
    expect(decideAutoRunnerDbUpdateIntegration({ source07cPresent: false, source07xPresent: true, executionDisabled: true })).toBe(
      "auto_runner_db_update_integration_proposal_not_ready"
    );
    expect(decideAutoRunnerDbUpdateIntegration({ source07cPresent: true, source07xPresent: true, executionDisabled: true })).toBe(
      "auto_runner_db_update_integration_proposal_basis_caution"
    );
    expect(decideAutoRunnerDbUpdateIntegration({ source07cPresent: true, source07xPresent: true, executionDisabled: false })).toBe(
      "auto_runner_db_update_integration_proposal_ready"
    );
  });

  it("Renders CSV and report", () => {
    expect(renderPipelineCsv(buildUpdatedPipelineStages())).toContain("stage_id");
    expect(
      renderReport({
        generatedAtJst: "2026-06-05T23:30:00+09:00",
        decision: "auto_runner_db_update_integration_proposal_basis_caution",
        source07cPath: "fresh.json",
        source07xPath: "runner.json",
        current: buildCurrentStateSummary(),
        fresh: buildFreshSyncHelperSummary(source07c),
        stages: buildUpdatedPipelineStages(),
        gates: buildGateMatrix(),
        dbSyncPolicy: buildDbSyncIntegrationPolicy(),
        aiContextPolicy: buildAiContextFollowupPolicy(),
        priceSeparation: buildPriceOutputSeparation(),
        failure: buildFailureHandlingPlan(),
        compatibility: buildCompatibilityPlan(),
        risks: [],
        safety: buildSafetyConfirmation()
      })
    ).toContain("DB Update Runner Integration Proposal");
  });

  it("package contains proposal script", () => {
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-db-update-integration");
  });
});

describe("AUTO-RUNNER07D - executable safety scans", () => {
  it("No sync command executed in this phase", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/execSync|execFileSync|spawn\(|child_process|runFreshHistoryToDbSync|syncHistoryToDbFresh/u);
  });

  it("No DB write code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/openLocalDatabase|applyRealSync|INSERT INTO|DELETE FROM|UPDATE market_signal|HISTORY_TO_DB_SYNC=1/iu);
  });

  it("No AI context refresh code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/build:ai-context-packs|buildAiContextPacks/u);
  });

  it("No collector/Playwright code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium|browser\.launch|newPage|npm run probe:|npm run collect:/u);
  });

  it("No pricing CSV/PMS output code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*(beds24|airhost|pricing_recommendation|price_update)|GENERATE_PRICE_CSV=1|PMS_UPLOAD|OTA_UPLOAD/iu);
  });
});
