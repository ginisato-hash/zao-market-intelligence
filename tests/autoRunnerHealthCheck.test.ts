import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReportFixture } from "./helpers/reportFixtureResolver";
import {
  buildCurrentStateSnapshot,
  buildMutationCheck,
  buildSafetyConfirmation,
  decideAutoRunnerHealthCheck,
  evaluateGates,
  renderHealthCheckCsv,
  renderHealthCheckLog,
  renderReport,
  summarizeRunnerStub,
  type AutoRunnerHealthCheckOutput,
  type CurrentStateSnapshot
} from "../src/services/autoRunnerHealthCheck";
import type { AutoRunnerDbUpdateStubOutput } from "../src/services/autoRunnerDbUpdateStub";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerHealthCheck.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerHealthCheck.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const sourceStub = JSON.parse(
  readFileSync(resolveReportFixture(".data/reports/automation/auto_runner_db_update_stub_20260605_234414.json"), "utf8")
) as AutoRunnerDbUpdateStubOutput;

function currentSnapshot(): CurrentStateSnapshot {
  return buildCurrentStateSnapshot({
    historyDir: resolve(__dirname, "../.data/history"),
    dbPath: resolve(__dirname, "../.data/zao-market-intelligence.sqlite"),
    aiContextPath: resolve(__dirname, "../.data/ai-context/latest_market_snapshot.json")
  });
}

function sampleOutput(): AutoRunnerHealthCheckOutput {
  const before = currentSnapshot();
  const after = currentSnapshot();
  return {
    run_id: "auto_runner_health_check_test",
    generated_at_jst: "2026-06-05T23:55:00+09:00",
    decision: "auto_runner_health_check_ready",
    source_auto_runner07e_artifact: "auto07e.json",
    current_state_before: before,
    current_state_after: after,
    gate_evaluation: evaluateGates({}),
    runner_stub_summary: summarizeRunnerStub(sourceStub),
    mutation_check: buildMutationCheck(before, after),
    run_state_artifact: ".data/run-state/auto_runner_health_check_test.json",
    log_artifact: ".logs/auto-runner-health-check-test.log",
    safety_confirmation: buildSafetyConfirmation(),
    next_phase: "none",
    report_path: ".data/reports/automation/auto_runner_health_check_test.md",
    json_path: ".data/reports/automation/auto_runner_health_check_test.json",
    csv_path: ".data/reports/automation/auto_runner_health_check_test.csv",
    debug_artifact_path: ".data/debug/auto-runner-health-check/test"
  };
}

describe("AUTO-RUNNER07F - state and gates", () => {
  it("Builds current-state summary", () => {
    const snapshot = currentSnapshot();
    expect(snapshot.current_state_summary.history_rows).toBe(427);
    expect(snapshot.current_state_summary.db_rows).toBeGreaterThanOrEqual(0);
    expect(snapshot.current_state_summary.ai_context_rows).toBeGreaterThanOrEqual(0);
  });

  it("Confirms expected row counts", () => {
    const summary = currentSnapshot().current_state_summary;
    expect(summary.booking).toMatchObject({ rows: 140, directional: 136, excluded: 4, direct: 0 });
    expect(summary.jalan).toMatchObject({ rows: 161, directional: 53, excluded: 102, direct: 6 });
    expect(summary.rakuten.rows).toBe(126);
  });

  it("Missing gates default disabled", () => {
    expect(evaluateGates({}).every((gate) => gate.value === "0" && gate.enabled === false)).toBe(true);
  });

  it("Detects risky gates if set", () => {
    const gates = evaluateGates({ HISTORY_TO_DB_SYNC: "1" });
    expect(gates.find((gate) => gate.gate === "HISTORY_TO_DB_SYNC")?.enabled).toBe(true);
    expect(
      decideAutoRunnerHealthCheck({
        stateCountsMatchExpected: true,
        gates,
        runnerStub: summarizeRunnerStub(sourceStub),
        mutation: buildMutationCheck(currentSnapshot(), currentSnapshot()),
        sourceArtifactPresent: true
      })
    ).toBe("auto_runner_health_check_basis_caution");
  });
});

describe("AUTO-RUNNER07F - runner stub and mutation checks", () => {
  it("Summarizes runner stub decision", () => {
    expect(summarizeRunnerStub(sourceStub).decision).toBe("auto_runner_db_update_stub_ready_not_run");
  });

  it("Confirms risky stages enabled = 0", () => {
    expect(summarizeRunnerStub(sourceStub).risky_stages_enabled).toBe(0);
  });

  it("Confirms actual_executed=false for risky stages", () => {
    expect(summarizeRunnerStub(sourceStub).all_risky_actual_executed_false).toBe(true);
  });

  it("Detects mutation if before/after counts differ", () => {
    const before = currentSnapshot();
    const after = { ...before, current_state_summary: { ...before.current_state_summary, db_rows: before.current_state_summary.db_rows + 1 } };
    const mutation = buildMutationCheck(before, after);
    expect(mutation.mutation_detected).toBe(true);
    expect(mutation.details).toContain("DB row count changed");
  });
});

describe("AUTO-RUNNER07F - artifacts and decision", () => {
  it("Writes report/json/csv/debug artifact shapes", () => {
    const output = sampleOutput();
    expect(renderReport(output)).toContain("Auto Runner Health Check");
    expect(renderHealthCheckCsv(output)).toContain("runner_stub_decision");
    expect(output.json_path).toContain(".json");
    expect(output.debug_artifact_path).toContain("auto-runner-health-check");
  });

  it("Writes run-state artifact shape", () => {
    expect(sampleOutput().run_state_artifact).toContain(".data/run-state/auto_runner_health_check");
  });

  it("Writes lightweight log artifact shape", () => {
    const output = sampleOutput();
    expect(output.log_artifact).toContain(".logs/auto-runner-health-check");
    expect(renderHealthCheckLog(output)).toContain("mutation_detected=false");
  });

  it("Decision ready/basis_caution/not_ready", () => {
    const mutation = buildMutationCheck(currentSnapshot(), currentSnapshot());
    const runnerStub = summarizeRunnerStub(sourceStub);
    expect(decideAutoRunnerHealthCheck({ stateCountsMatchExpected: true, gates: evaluateGates({}), runnerStub, mutation, sourceArtifactPresent: true })).toBe(
      "auto_runner_health_check_ready"
    );
    expect(decideAutoRunnerHealthCheck({ stateCountsMatchExpected: false, gates: evaluateGates({}), runnerStub, mutation, sourceArtifactPresent: true })).toBe(
      "auto_runner_health_check_not_ready"
    );
    expect(PACKAGE_JSON).toContain("auto-runner:health-check");
  });
});

describe("AUTO-RUNNER07F - executable safety scans", () => {
  it("No collector command executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/execSync|execFileSync|spawn\(|child_process|probe:booking|probe:jalan|collect:/u);
  });

  it("No sync command executed", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/runFreshHistoryToDbSync|syncHistoryToDbFresh|sync:history-to-db:fresh|real-run:history-to-db-sync/u);
  });

  it("No DB write code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/openLocalDatabase|applyRealSync|INSERT INTO|DELETE FROM|UPDATE market_signal|HISTORY_TO_DB_SYNC=1/iu);
  });

  it("No AI context refresh code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/build:ai-context-packs|buildAiContextPacks|runPost.*Refresh/u);
  });

  it("No Playwright/browser automation code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium|browser\.launch|newPage/u);
  });

  it("No pricing CSV/PMS output code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*(beds24|airhost|pricing_recommendation|price_update)|PMS_UPLOAD|OTA_UPLOAD/iu);
  });

  it("No launchd/cron/GitHub Actions code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/launchctl|crontab|LaunchAgents|\.github\/workflows/u);
  });
});
