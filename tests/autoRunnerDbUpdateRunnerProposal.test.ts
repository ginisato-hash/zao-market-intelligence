import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAiContextPolicy,
  buildAppendPolicy,
  buildBatchSelectionPolicy,
  buildDbSyncPolicy,
  buildDbUpdatePipelineStages,
  buildFailureHandlingPlan,
  buildFutureRunnerCommandDesign,
  buildGateMatrix,
  buildPriceOutputSeparation,
  buildSafetyConfirmation,
  buildUsabilityIntegrityPolicy,
  decideAutoRunnerDbUpdateRunner,
  renderPipelineCsv,
  renderReport
} from "../src/services/autoRunnerDbUpdateRunnerProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerDbUpdateRunnerProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerDbUpdateRunnerProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const schedule = {
  decision: "auto_runner_bounded_schedule_config_basis_caution",
  booking_batch_plans: [{ plan_id: "booking_near_term_rotating", max_pages_per_run: 30, role: "primary directional backbone" }],
  jalan_batch_plans: [{ plan_id: "jalan_supplemental_rotating", max_pages_per_run: 25, role: "supplementary domestic OTA signal" }]
};

function gate(name: string) {
  return buildGateMatrix().find((item) => item.gate === name)!;
}

describe("AUTO-RUNNER07X - pipeline and gates", () => {
  it("includes all DB update pipeline stages", () => {
    expect(buildDbUpdatePipelineStages().map((stage) => stage.name)).toEqual([
      "preflight / environment / gates",
      "current state snapshot",
      "choose due bounded batches",
      "optional Booking collection, gated",
      "optional Jalan collection, gated",
      "normalize preview rows",
      "generate append proposals",
      "append to .data/history, gated",
      "DB mirror sync, gated",
      "AI context refresh, gated",
      "usability/integrity verification",
      "write run summary",
      "stop before price report / CSV"
    ]);
  });

  it("requires ZMI_AUTORUN_ENABLED for automation", () => {
    expect(gate("ZMI_AUTORUN_ENABLED").default_value).toBe("0");
    expect(buildDbUpdatePipelineStages().some((stage) => stage.required_gates.includes("ZMI_AUTORUN_ENABLED=1"))).toBe(true);
  });

  it("requires COLLECT_BOOKING for Booking collection", () => {
    expect(gate("COLLECT_BOOKING").default_value).toBe("0");
    expect(buildDbUpdatePipelineStages().find((stage) => stage.name.includes("Booking"))!.required_gates).toContain("COLLECT_BOOKING=1");
  });

  it("requires COLLECT_JALAN for Jalan collection", () => {
    expect(gate("COLLECT_JALAN").default_value).toBe("0");
    expect(buildDbUpdatePipelineStages().find((stage) => stage.name.includes("Jalan"))!.required_gates).toContain("COLLECT_JALAN=1");
  });

  it("requires ALLOW_HISTORY_APPEND before any append", () => {
    expect(buildDbUpdatePipelineStages().find((stage) => stage.name.includes("append to"))!.required_gates).toContain("ALLOW_HISTORY_APPEND=1");
  });

  it("requires source-specific append gates", () => {
    const stage = buildDbUpdatePipelineStages().find((item) => item.name.includes("append to"))!;
    expect(stage.required_gates).toContain("source-specific append gate");
    expect(gate("BOOKING_HISTORY_APPEND").default_value).toBe("0");
    expect(gate("JALAN_HISTORY_APPEND").default_value).toBe("0");
  });

  it("requires HISTORY_TO_DB_SYNC for DB sync", () => {
    expect(buildDbUpdatePipelineStages().find((stage) => stage.name.includes("DB mirror"))!.required_gates).toContain("HISTORY_TO_DB_SYNC=1");
  });

  it("requires BUILD_AI_CONTEXT for context refresh", () => {
    expect(buildDbUpdatePipelineStages().find((stage) => stage.name.includes("AI context"))!.required_gates).toContain("BUILD_AI_CONTEXT=1");
  });

  it("defaults GENERATE_PRICE_REPORT to 0", () => {
    expect(gate("GENERATE_PRICE_REPORT").default_value).toBe("0");
  });

  it("defaults GENERATE_PRICE_CSV to 0", () => {
    expect(gate("GENERATE_PRICE_CSV").default_value).toBe("0");
  });

  it("states PMS/OTA upload is out of scope", () => {
    expect(buildPriceOutputSeparation().explicitly_excluded.join("\n")).toContain("PMS/OTA/channel-manager output");
  });
});

describe("AUTO-RUNNER07X - source policy and failure behavior", () => {
  it("uses AUTO-RUNNER05X batch caps", () => {
    const policy = buildBatchSelectionPolicy(schedule);
    expect(policy.booking.max_pages_per_run).toBe(30);
    expect(policy.jalan.max_pages_per_run).toBe(25);
  });

  it("keeps Booking primary", () => {
    expect(buildBatchSelectionPolicy(schedule).booking.role).toContain("primary");
  });

  it("keeps Jalan supplementary", () => {
    expect(buildBatchSelectionPolicy(schedule).jalan.role).toContain("supplementary");
  });

  it("keeps Rakuten frozen", () => {
    expect(buildBatchSelectionPolicy(schedule).rakuten.collect).toBe(false);
    expect(buildBatchSelectionPolicy(schedule).rakuten.role).toContain("frozen");
  });

  it("stops on append conflicts", () => {
    expect(buildAppendPolicy().rules.join("\n")).toContain("Append conflict stops");
    expect(buildFailureHandlingPlan().stop_conditions.join("\n")).toContain("append conflicts");
  });

  it("stops on DB sync conflicts", () => {
    expect(buildFailureHandlingPlan().stop_conditions.join("\n")).toContain("DB sync conflict");
  });

  it("stops on block/CAPTCHA/degraded pages", () => {
    expect(buildFailureHandlingPlan().stop_conditions.join("\n")).toContain("block/CAPTCHA/degraded");
  });

  it("produces run summary stage", () => {
    expect(buildDbUpdatePipelineStages().some((stage) => stage.name === "write run summary")).toBe(true);
    expect(buildFutureRunnerCommandDesign().run_summary_path_pattern).toContain("run_summary");
  });

  it("separates price report/CSV from DB update runner", () => {
    const separation = buildPriceOutputSeparation();
    expect(separation.automated_db_runner_includes).toContain("DB mirror sync");
    expect(separation.explicitly_excluded).toContain("Beds24 CSV");
  });
});

describe("AUTO-RUNNER07X - policies, rendering, and decision", () => {
  it("defines DB sync policy with fresh dry-run", () => {
    expect(buildDbSyncPolicy().rules.join("\n")).toContain("fresh dry-run artifact");
  });

  it("defines AI context policy without price output", () => {
    expect(buildAiContextPolicy().rules.join("\n")).toContain("not price decision output");
  });

  it("defines usability/integrity policy", () => {
    expect(buildUsabilityIntegrityPolicy().checks).toContain("duplicate row_id check");
  });

  it("Decision ready/basis_caution/not_ready", () => {
    expect(decideAutoRunnerDbUpdateRunner({ source06Present: false, schedulePresent: true, executionDisabled: true })).toBe(
      "auto_runner_db_update_runner_proposal_not_ready"
    );
    expect(decideAutoRunnerDbUpdateRunner({ source06Present: true, schedulePresent: true, executionDisabled: true })).toBe(
      "auto_runner_db_update_runner_proposal_basis_caution"
    );
    expect(decideAutoRunnerDbUpdateRunner({ source06Present: true, schedulePresent: true, executionDisabled: false })).toBe(
      "auto_runner_db_update_runner_proposal_ready"
    );
  });

  it("renders CSV and report", () => {
    expect(renderPipelineCsv(buildDbUpdatePipelineStages())).toContain("stage_id");
    expect(
      renderReport({
        generatedAtJst: "2026-06-05T16:30:00+09:00",
        decision: "auto_runner_db_update_runner_proposal_basis_caution",
        source06Path: "auto06x.json",
        source05Path: "auto05x.json",
        current: {
          history_rows: 210,
          db_rows: 210,
          ai_context_rows: 210,
          booking: { rows: 46, directional: 42, excluded: 4, direct: 0, role: "primary" },
          jalan: { rows: 38, directional: 8, excluded: 24, direct: 6, role: "supplementary" },
          rakuten: { rows: 126, role: "frozen" }
        },
        stages: buildDbUpdatePipelineStages(),
        gates: buildGateMatrix(),
        batchPolicy: buildBatchSelectionPolicy(schedule),
        appendPolicy: buildAppendPolicy(),
        dbSyncPolicy: buildDbSyncPolicy(),
        aiContextPolicy: buildAiContextPolicy(),
        usabilityPolicy: buildUsabilityIntegrityPolicy(),
        priceSeparation: buildPriceOutputSeparation(),
        failure: buildFailureHandlingPlan(),
        commandDesign: buildFutureRunnerCommandDesign(),
        risks: [],
        safety: buildSafetyConfirmation()
      })
    ).toContain("Automated Market Signal DB Update Runner Proposal");
  });

  it("package contains proposal script", () => {
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-db-update");
  });
});

describe("AUTO-RUNNER07X - executable safety scans", () => {
  it("No live collector command executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/execSync|execFileSync|spawn\(|child_process|npm run probe:|npm run collect:/u);
  });

  it("No Playwright/browser automation code executed", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium|browser\.launch|newPage/u);
  });

  it("No history write code executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*\.data\/history|appendHistory|realHistoryAppend/u);
  });

  it("No DB sync/write code executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC=1|real-run:history-to-db-sync|INSERT INTO|DELETE FROM|UPDATE market_signal/iu);
  });

  it("No AI context refresh code executed", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("No query smoke execution", () => {
    expect(SCRIPT_SOURCE).not.toContain("query:ai-task");
  });

  it("No pricing CSV/PMS output code", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*beds24|writeFileSync\([^,]*airhost|GENERATE_PRICE_CSV=1|pricing_recommendation/iu);
  });
});
