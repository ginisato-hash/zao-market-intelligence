import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReportFixture } from "./helpers/reportFixtureResolver";
import {
  buildAcceptanceCriteria,
  buildAlwaysOnMacBootstrapChecklist,
  buildCurrentStateSummary,
  buildFutureGitignoreRecommendation,
  buildGitStatusSummary,
  buildGitignoreSummary,
  buildHandoffFileMatrix,
  buildSafetyConfirmation,
  decideHandoffPlan,
  renderMatrixCsv,
  renderReport
} from "../src/services/autoRunnerAlwaysOnMacHandoffPlan";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerAlwaysOnMacHandoffPlan.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerAlwaysOnMacHandoffPlan.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");
const GITIGNORE = readFileSync(resolve(__dirname, "../.gitignore"), "utf8");
const SOURCE_07F = JSON.parse(readFileSync(resolveReportFixture(".data/reports/automation/auto_runner_health_check_20260605_235224.json"), "utf8"));

function matrixItem(pathPart: string) {
  return buildHandoffFileMatrix().find((item) => item.path_or_pattern.includes(pathPart))!;
}

describe("AUTO-RUNNER-HANDOFF01X - state and transfer policy", () => {
  it("Includes current state 210/210/210", () => {
    const current = buildCurrentStateSummary(SOURCE_07F);
    expect(current.history_rows).toBe(210);
    expect(current.db_rows).toBe(210);
    expect(current.ai_context_rows).toBe(210);
  });

  it("Includes Booking 46 / Jalan 38 / Rakuten 126 acceptance criteria", () => {
    const acceptance = buildAcceptanceCriteria();
    expect(acceptance.required_counts.booking).toBe(46);
    expect(acceptance.required_counts.jalan).toBe(38);
    expect(acceptance.required_counts.rakuten).toBe(126);
  });

  it("Classifies src/tests/package as transfer through Git", () => {
    expect(matrixItem("src/**").category).toBe("transfer_through_github");
    expect(matrixItem("tests/**").category).toBe("transfer_through_github");
    expect(matrixItem("package.json").category).toBe("transfer_through_github");
  });

  it("Classifies .data/history shards as canonical transfer with approval", () => {
    const item = matrixItem("zao_signals");
    expect(item.category).toBe("canonical_transfer_with_approval");
    expect(item.action).toContain("approval");
  });

  it("Classifies SQLite DB as regenerate", () => {
    expect(matrixItem("sqlite").category).toBe("regenerate_on_always_on_mac");
  });

  it("Classifies AI context as regenerate", () => {
    expect(matrixItem("ai-context").category).toBe("regenerate_on_always_on_mac");
  });

  it("Classifies debug/screenshots/reports/logs as archive/ignore", () => {
    const item = matrixItem("screenshots");
    expect(item.category).toBe("archive_or_ignore");
    expect(item.path_or_pattern).toContain(".logs");
  });

  it("Classifies .env/secrets as never transfer", () => {
    expect(matrixItem(".env").category).toBe("never_transfer");
  });
});

describe("AUTO-RUNNER-HANDOFF01X - checklist and gitignore", () => {
  it("Includes future .gitignore negation for .data/history", () => {
    expect(buildFutureGitignoreRecommendation()).toContain("!.data/history/zao_signals_*.csv");
    expect(buildGitignoreSummary(GITIGNORE).blanket_data_ignore).toBe(true);
  });

  it("Includes always-on Mac bootstrap checklist", () => {
    expect(buildAlwaysOnMacBootstrapChecklist().length).toBeGreaterThan(8);
    expect(buildAlwaysOnMacBootstrapChecklist().every((item) => item.execution_location === "future_always_on_mac" && item.execute_in_this_phase === false)).toBe(true);
  });

  it("Includes health-check command in checklist", () => {
    expect(buildAlwaysOnMacBootstrapChecklist().map((item) => item.command_or_action)).toContain("npm run auto-runner:health-check");
  });

  it("Includes auto-runner:db-update command in checklist", () => {
    expect(buildAlwaysOnMacBootstrapChecklist().map((item) => item.command_or_action)).toContain("npm run auto-runner:db-update");
  });

  it("Explicitly forbids live collectors during handoff", () => {
    expect(renderReport(reportInput())).toContain("Do not run live collectors yet");
  });

  it("Explicitly forbids launchd during handoff", () => {
    expect(renderReport(reportInput())).toContain("Do not run launchd yet");
  });

  it("Explicitly forbids pricing CSV during handoff", () => {
    expect(renderReport(reportInput())).toContain("Do not run pricing CSV");
  });
});

describe("AUTO-RUNNER-HANDOFF01X - rendering and decision", () => {
  it("Renders matrix CSV and report", () => {
    expect(renderMatrixCsv(buildHandoffFileMatrix())).toContain("path_or_pattern");
    expect(renderReport(reportInput())).toContain("Always-On Mac Handoff Plan");
  });

  it("Builds git status summary", () => {
    const summary = buildGitStatusSummary({ statusEntries: [" M .gitignore", "?? src/"], trackedFiles: [".gitignore", "README.md"], gitignoreText: GITIGNORE });
    expect(summary.tracked_file_count).toBe(2);
    expect(summary.gitignore_blanket_ignores_data).toBe(true);
  });

  it("Decision ready/basis_caution/not_ready", () => {
    expect(decideHandoffPlan({ source07fPresent: false, currentStateReady: true, handoffMatrixReady: true, futureManualActionsRemain: true })).toBe(
      "auto_runner_always_on_mac_handoff_plan_not_ready"
    );
    expect(decideHandoffPlan({ source07fPresent: true, currentStateReady: true, handoffMatrixReady: true, futureManualActionsRemain: true })).toBe(
      "auto_runner_always_on_mac_handoff_plan_basis_caution"
    );
    expect(decideHandoffPlan({ source07fPresent: true, currentStateReady: true, handoffMatrixReady: true, futureManualActionsRemain: false })).toBe(
      "auto_runner_always_on_mac_handoff_plan_ready"
    );
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-always-on-mac-handoff");
  });
});

describe("AUTO-RUNNER-HANDOFF01X - executable safety scans", () => {
  it("No git add/commit/push code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/git",\s*\["(?:add|commit|push|tag|remote)|git\s+(?:add|commit|push|tag|remote)/u);
  });

  it("No .gitignore modification code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*\.gitignore/u);
  });

  it("No DB sync execution code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/sync:history-to-db:fresh|real-run:history-to-db-sync|HISTORY_TO_DB_SYNC=1/u);
  });

  it("No AI context refresh execution code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/build:ai-context-packs|buildAiContextPacks/u);
  });

  it("No collector/Playwright code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/probe:booking|probe:jalan|collect:|from\s+["']playwright|browser\.launch|newPage/u);
  });

  it("No pricing/PMS output code exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/pricing:|Beds24|AirHost|PMS_UPLOAD|OTA_UPLOAD|writeFileSync\([^,]*(beds24|airhost|pricing)/iu);
  });

  it("Safety confirmation says no mutation", () => {
    const safety = buildSafetyConfirmation();
    expect(safety.always_on_mac_commands_executed).toBe(false);
    expect(safety.git_mutation).toBe(false);
    expect(safety.db_sync).toBe(false);
  });
});

function reportInput() {
  return {
    generatedAtJst: "2026-06-05T23:59:00+09:00",
    decision: "auto_runner_always_on_mac_handoff_plan_basis_caution" as const,
    source07fPath: "auto07f.json",
    current: buildCurrentStateSummary(SOURCE_07F),
    gitStatus: buildGitStatusSummary({ statusEntries: [" M .gitignore"], trackedFiles: [".gitignore", "README.md"], gitignoreText: GITIGNORE }),
    gitignore: buildGitignoreSummary(GITIGNORE),
    matrix: buildHandoffFileMatrix(),
    gitignoreRecommendation: buildFutureGitignoreRecommendation(),
    checklist: buildAlwaysOnMacBootstrapChecklist(),
    acceptance: buildAcceptanceCriteria(),
    failureHandling: [],
    risks: [],
    safety: buildSafetyConfirmation(),
    nextPhase: "manual handoff"
  };
}
