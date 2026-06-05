import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCurrentStateSummary,
  buildFailureHandlingPlan,
  buildGateMatrix,
  buildLaunchdTemplateDesign,
  buildNotificationPlan,
  buildRunStateLoggingDesign,
  buildSafetyConfirmation,
  buildScheduleTiers,
  decideAutoRunnerLaunchdScheduleProposal,
  renderReport,
  renderScheduleCsv,
  type AutoRunner03xArtifactLike
} from "../src/services/autoRunnerLaunchdScheduleProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerLaunchdScheduleProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerLaunchdScheduleProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function sourceArtifact(): AutoRunner03xArtifactLike {
  return {
    decision: "auto_runner_manual_workflow_proposal_basis_caution",
    current_state_summary: {
      history_rows: 210,
      db_rows: 210,
      ai_context_rows: 210,
      booking: { rows: 46, directional: 42, excluded: 4, direct: 0, role: "primary directional backbone" },
      jalan: { rows: 38, directional: 8, excluded: 24, direct: 6, role: "supplementary domestic OTA signal" },
      rakuten: { rows: 126, role: "frozen / caution" },
      known_cautions: ["always_on_mac_unverified"]
    },
    risks: ["launchd_not_verified"]
  };
}

describe("AUTO-RUNNER04X - schedule tiers", () => {
  it("includes daily dry-run health check tier", () => {
    expect(buildScheduleTiers().find((tier) => tier.tier === 0)?.name).toContain("health check");
  });

  it("includes safe validation tier", () => {
    expect(buildScheduleTiers().find((tier) => tier.tier === 1)?.purpose).toContain("Typecheck");
  });

  it("includes Booking small-batch future tier", () => {
    expect(buildScheduleTiers().find((tier) => tier.tier === 2)?.required_gates).toContain("COLLECT_BOOKING=1");
  });

  it("includes Jalan small-batch future tier", () => {
    expect(buildScheduleTiers().find((tier) => tier.tier === 3)?.required_gates).toContain("COLLECT_JALAN=1");
  });

  it("includes DB/context refresh future tier", () => {
    expect(buildScheduleTiers().find((tier) => tier.tier === 4)?.required_gates).toContain("BUILD_AI_CONTEXT=1");
  });

  it("includes price CSV as not scheduled initially", () => {
    const tier = buildScheduleTiers().find((item) => item.tier === 5)!;
    expect(tier.cadence).toContain("not scheduled initially");
    expect(tier.required_gates).toContain("GENERATE_PRICE_CSV=1");
  });
});

describe("AUTO-RUNNER04X - gates and templates", () => {
  it("requires ZMI_AUTORUN_ENABLED=1 for risky schedules", () => {
    expect(buildGateMatrix().map((gate) => gate.gate)).toContain("ZMI_AUTORUN_ENABLED");
  });

  it("requires COLLECT_BOOKING=1 for Booking collection", () => {
    expect(buildGateMatrix().map((gate) => gate.gate)).toContain("COLLECT_BOOKING");
  });

  it("requires COLLECT_JALAN=1 for Jalan collection", () => {
    expect(buildGateMatrix().map((gate) => gate.gate)).toContain("COLLECT_JALAN");
  });

  it("requires HISTORY_TO_DB_SYNC=1 for DB sync", () => {
    expect(buildGateMatrix().map((gate) => gate.gate)).toContain("HISTORY_TO_DB_SYNC");
  });

  it("requires BUILD_AI_CONTEXT=1 for context refresh", () => {
    expect(buildGateMatrix().map((gate) => gate.gate)).toContain("BUILD_AI_CONTEXT");
  });

  it("requires GENERATE_PRICE_CSV=1 and human review for CSV", () => {
    const tier = buildScheduleTiers().find((item) => item.tier === 5)!;
    expect(tier.required_gates).toContain("human approval");
  });

  it("includes launchd labels", () => {
    expect(buildLaunchdTemplateDesign("/repo").map((tpl) => tpl.label)).toContain("com.yuge.zao-market.preflight");
  });

  it("marks proposed plist enabled_by_default=false", () => {
    expect(buildLaunchdTemplateDesign("/repo").every((tpl) => tpl.enabled_by_default === false)).toBe(true);
  });

  it("includes logs/run-state paths", () => {
    const design = buildRunStateLoggingDesign();
    expect(design.log_paths.join("\n")).toContain(".logs/zmi-preflight");
    expect(design.run_state_paths.join("\n")).toContain(".data/run-state");
  });
});

describe("AUTO-RUNNER04X - failures, outputs, decision", () => {
  it("includes failure handling for sleep/network/block/CAPTCHA", () => {
    const text = buildFailureHandlingPlan().fail_closed_rules.join("\n");
    expect(text).toContain("Mac was asleep");
    expect(text).toContain("network down");
    expect(text).toContain("block/CAPTCHA/degraded");
  });

  it("includes no catch-up burst after sleep", () => {
    expect(buildFailureHandlingPlan().fail_closed_rules.join("\n")).toContain("do not run a catch-up burst");
  });

  it("renders report and CSV", () => {
    const current = buildCurrentStateSummary(sourceArtifact());
    const tiers = buildScheduleTiers();
    const templates = buildLaunchdTemplateDesign("/repo");
    expect(renderScheduleCsv(templates)).toContain("label");
    expect(
      renderReport({
        generatedAtJst: "2026-06-05T13:30:00+09:00",
        decision: "auto_runner_launchd_schedule_proposal_basis_caution",
        sourceArtifactPath: "auto03x.json",
        current,
        tiers,
        templates,
        gates: buildGateMatrix(),
        logging: buildRunStateLoggingDesign(),
        failure: buildFailureHandlingPlan(),
        notification: buildNotificationPlan(),
        risks: [],
        safety: buildSafetyConfirmation()
      })
    ).toContain("Launchd Schedule Proposal");
  });

  it("decision ready/basis_caution/not_ready", () => {
    expect(decideAutoRunnerLaunchdScheduleProposal({ sourcePresent: true, tiers: buildScheduleTiers(), templates: buildLaunchdTemplateDesign("/repo") })).toBe(
      "auto_runner_launchd_schedule_proposal_basis_caution"
    );
    expect(decideAutoRunnerLaunchdScheduleProposal({ sourcePresent: false, tiers: [], templates: [] })).toBe("auto_runner_launchd_schedule_proposal_not_ready");
  });
});

describe("AUTO-RUNNER04X - executable safety scans", () => {
  it("No launchctl call exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/launchctl\s+(load|bootstrap|enable|kickstart|start)/u);
  });

  it("No LaunchAgents write exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^,]*LaunchAgents|Library\/LaunchAgents/u);
  });

  it("No cron file creation exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/crontab|writeFileSync\([^,]*cron/u);
  });

  it("No GitHub Actions workflow creation exists", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\.github\/workflows|workflow_dispatch/u);
  });

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

  it("package contains proposal script", () => {
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-launchd-schedule");
  });
});
