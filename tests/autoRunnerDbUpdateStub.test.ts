import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCurrentStateSummary,
  buildPriceOutputSeparation,
  buildSafetyConfirmation,
  buildStagePlan,
  decideAutoRunnerDbUpdateStub,
  evaluateGates,
  renderReport,
  renderStagePlanCsv,
  summarizeAiContextRows,
  summarizeDbRowsReadOnly,
  summarizeHistoryState,
  type SourceStageLike
} from "../src/services/autoRunnerDbUpdateStub";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerDbUpdateStub.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerDbUpdateStub.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const sourceStages: SourceStageLike[] = [
  { stage_id: 0, name: "preflight / env / gates", candidate_commands: [], required_gates: ["none"], mutation_level: "none" },
  { stage_id: 1, name: "current state snapshot", candidate_commands: [], required_gates: ["none"], mutation_level: "summary_artifact" },
  { stage_id: 2, name: "choose due bounded batches", candidate_commands: [], required_gates: ["ZMI_AUTORUN_ENABLED=1"], mutation_level: "summary_artifact" },
  { stage_id: 3, name: "optional Booking collection, gated", candidate_commands: [], required_gates: ["ZMI_AUTORUN_ENABLED=1", "COLLECT_BOOKING=1"], mutation_level: "preview_artifacts" },
  { stage_id: 4, name: "optional Jalan collection, gated", candidate_commands: [], required_gates: ["ZMI_AUTORUN_ENABLED=1", "COLLECT_JALAN=1"], mutation_level: "preview_artifacts" },
  { stage_id: 5, name: "normalize preview rows", candidate_commands: [], required_gates: ["none"], mutation_level: "preview_artifacts" },
  { stage_id: 6, name: "generate append proposals", candidate_commands: [], required_gates: ["none"], mutation_level: "summary_artifact" },
  { stage_id: 7, name: "append to .data/history, gated", candidate_commands: [], required_gates: ["ZMI_AUTORUN_ENABLED=1", "ALLOW_HISTORY_APPEND=1", "BOOKING_HISTORY_APPEND=1 or JALAN_HISTORY_APPEND=1"], mutation_level: "history_write_gated" },
  { stage_id: 8, name: "fresh DB sync via sync:history-to-db:fresh, gated", candidate_commands: [], required_gates: ["ZMI_AUTORUN_ENABLED=1", "HISTORY_TO_DB_SYNC=1"], mutation_level: "db_write_gated" },
  { stage_id: 9, name: "AI context refresh, gated", candidate_commands: [], required_gates: ["ZMI_AUTORUN_ENABLED=1", "BUILD_AI_CONTEXT=1"], mutation_level: "context_write_gated" },
  { stage_id: 10, name: "usability/integrity verification", candidate_commands: [], required_gates: ["RUN_USABILITY_CHECK=1"], mutation_level: "summary_artifact" },
  { stage_id: 11, name: "write run summary", candidate_commands: [], required_gates: ["none"], mutation_level: "summary_artifact" },
  { stage_id: 12, name: "stop before price report / CSV", candidate_commands: [], required_gates: ["GENERATE_PRICE_REPORT=0", "GENERATE_PRICE_CSV=0"], mutation_level: "none" }
];

function defaultPlan() {
  return buildStagePlan(sourceStages, evaluateGates({}));
}

describe("AUTO-RUNNER07E - state and gates", () => {
  it("Builds current state summary", () => {
    const history = summarizeHistoryState(resolve(__dirname, "../.data/history"));
    const current = buildCurrentStateSummary({
      history,
      dbRows: summarizeDbRowsReadOnly(resolve(__dirname, "../.data/zao-market-intelligence.sqlite")),
      aiContextRows: summarizeAiContextRows(resolve(__dirname, "../.data/ai-context/latest_market_snapshot.json"))
    });
    expect(current.history_rows).toBe(210);
    expect(current.db_rows).toBe(210);
    expect(current.ai_context_rows).toBe(210);
    expect(current.booking.rows).toBe(46);
    expect(current.booking.directional).toBe(42);
    expect(current.booking.excluded).toBe(4);
    expect(current.booking.direct).toBe(0);
    expect(current.jalan.rows).toBe(38);
    expect(current.jalan.directional).toBe(8);
    expect(current.jalan.excluded).toBe(24);
    expect(current.jalan.direct).toBe(6);
    expect(current.rakuten.rows).toBe(126);
  });

  it("Reads gate values with missing gates defaulting to disabled", () => {
    const gates = evaluateGates({});
    expect(gates.every((gate) => gate.value === "0" && gate.enabled === false)).toBe(true);
    expect(gates.find((gate) => gate.gate === "HISTORY_TO_DB_SYNC")?.source).toBe("default");
  });

  it("Includes all expected runner stages", () => {
    expect(defaultPlan().map((stage) => stage.stage_name)).toEqual(sourceStages.map((stage) => stage.name));
  });

  it("Stage 8 candidate command is npm run sync:history-to-db:fresh", () => {
    expect(defaultPlan().find((stage) => stage.stage_id === 8)?.candidate_command).toBe("npm run sync:history-to-db:fresh");
  });

  it("Does not use old real-run sync as future automation command", () => {
    expect(defaultPlan().map((stage) => stage.candidate_command).join("\n")).not.toContain("real-run:history-to-db-sync");
  });
});

describe("AUTO-RUNNER07E - stage gating and price separation", () => {
  it("Keeps Booking collection gated", () => {
    const stage = defaultPlan().find((item) => item.stage_id === 3)!;
    expect(stage.enabled).toBe(false);
    expect(stage.required_gates).toContain("COLLECT_BOOKING=1");
  });

  it("Keeps Jalan collection gated", () => {
    const stage = defaultPlan().find((item) => item.stage_id === 4)!;
    expect(stage.enabled).toBe(false);
    expect(stage.required_gates).toContain("COLLECT_JALAN=1");
  });

  it("Keeps history append gated", () => {
    const stage = defaultPlan().find((item) => item.stage_id === 7)!;
    expect(stage.enabled).toBe(false);
    expect(stage.required_gates).toContain("ALLOW_HISTORY_APPEND=1");
  });

  it("Keeps DB sync gated", () => {
    const stage = defaultPlan().find((item) => item.stage_id === 8)!;
    expect(stage.enabled).toBe(false);
    expect(stage.required_gates).toContain("HISTORY_TO_DB_SYNC=1");
  });

  it("Keeps AI context refresh gated", () => {
    const stage = defaultPlan().find((item) => item.stage_id === 9)!;
    expect(stage.enabled).toBe(false);
    expect(stage.required_gates).toContain("BUILD_AI_CONTEXT=1");
  });

  it("Keeps price report out of scope", () => {
    expect(buildPriceOutputSeparation().price_report_out_of_scope).toBe(true);
  });

  it("Keeps CSV/PMS output out of scope", () => {
    const separation = buildPriceOutputSeparation();
    expect(separation.csv_pms_output_out_of_scope).toBe(true);
    expect(separation.rule).toContain("PMS output");
  });

  it("No stage actual_executed=true in default mode", () => {
    expect(defaultPlan().every((stage) => stage.actual_executed === false)).toBe(true);
  });

  it("Default decision is ready_not_run", () => {
    expect(decideAutoRunnerDbUpdateStub({ sourceArtifactsPresent: true, currentStateReady: true, riskyStagesEnabled: 0 })).toBe(
      "auto_runner_db_update_stub_ready_not_run"
    );
  });
});

describe("AUTO-RUNNER07E - artifacts and decisions", () => {
  it("Writes report/json/csv/debug artifact shapes", () => {
    const stagePlan = defaultPlan();
    const safety = buildSafetyConfirmation(stagePlan);
    const output = {
      run_id: "auto_runner_db_update_stub_test",
      generated_at_jst: "2026-06-05T23:50:00+09:00",
      decision: "auto_runner_db_update_stub_ready_not_run" as const,
      source_auto_runner07d_artifact: "auto07d.json",
      source_schedule_config_artifact: "auto05x.json",
      current_state_summary: buildCurrentStateSummary({
        history: { row_count: 210, files: ["zao_signals.csv"], sources: { booking: { rows: 46, directional: 42, excluded: 4, direct: 0 }, jalan: { rows: 38, directional: 8, excluded: 24, direct: 6 }, rakuten: { rows: 126, directional: 124, excluded: 2, direct: 0 } } },
        dbRows: 210,
        aiContextRows: 210
      }),
      gate_evaluation: evaluateGates({}),
      stage_plan: stagePlan,
      price_output_separation: buildPriceOutputSeparation(),
      safety_confirmation: safety,
      next_phase: "none",
      report_path: ".data/reports/automation/auto_runner_db_update_stub_test.md",
      json_path: ".data/reports/automation/auto_runner_db_update_stub_test.json",
      csv_path: ".data/reports/automation/auto_runner_db_update_stub_test.csv",
      debug_artifact_path: ".data/debug/auto-runner-db-update-stub/test"
    };
    expect(renderReport(output)).toContain("Auto Runner DB Update Stub");
    expect(renderStagePlanCsv(stagePlan)).toContain("actual_executed");
    expect(output.json_path).toContain(".json");
    expect(output.debug_artifact_path).toContain("auto-runner-db-update-stub");
  });

  it("Decision labels are valid", () => {
    expect(decideAutoRunnerDbUpdateStub({ sourceArtifactsPresent: false, currentStateReady: true, riskyStagesEnabled: 0 })).toBe("auto_runner_db_update_stub_not_ready");
    expect(decideAutoRunnerDbUpdateStub({ sourceArtifactsPresent: true, currentStateReady: true, riskyStagesEnabled: 1 })).toBe("auto_runner_db_update_stub_plan_ready");
  });

  it("package contains runner script", () => {
    expect(PACKAGE_JSON).toContain("auto-runner:db-update");
  });
});

describe("AUTO-RUNNER07E - executable safety scans", () => {
  it("No collector command executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/execSync|execFileSync|spawn\(|child_process|runBooking|runJalan|probeBooking|probeJalan/u);
  });

  it("No sync command executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/runFreshHistoryToDbSync|syncHistoryToDbFresh|execSync|execFileSync|spawn\(|child_process/u);
  });

  it("No DB write code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/openLocalDatabase|applyRealSync|INSERT INTO|DELETE FROM|UPDATE market_signal|HISTORY_TO_DB_SYNC=1/iu);
  });

  it("No AI context refresh code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/buildAiContextPacks|runPost.*Refresh/u);
  });

  it("No Playwright/browser automation code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium|browser\.launch|newPage/u);
  });

  it("No pricing CSV/PMS output code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*(beds24|airhost|pricing_recommendation|price_update)|PMS_UPLOAD|OTA_UPLOAD/iu);
  });
});
