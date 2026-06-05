import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBookingBatchPlans,
  buildCurrentStateSummary,
  buildDateWindowPolicy,
  buildFailureBehavior,
  buildFutureRunnerIntegration,
  buildGateMatrix,
  buildJalanBatchPlans,
  buildSafetyConfirmation,
  buildTargetInventory,
  decideAutoRunnerBoundedSchedule,
  renderBatchPlanCsv,
  renderReport,
  type AutoRunner04xArtifactLike
} from "../src/services/autoRunnerBoundedScheduleConfig";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerBoundedScheduleConfig.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildAutoRunnerBoundedScheduleConfigReport.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function artifact(): AutoRunner04xArtifactLike {
  return {
    decision: "auto_runner_launchd_schedule_proposal_basis_caution",
    current_state_summary: {
      history_rows: 210,
      db_rows: 210,
      ai_context_rows: 210,
      booking: { rows: 46, directional: 42, excluded: 4, direct: 0, role: "primary directional backbone" },
      jalan: { rows: 38, directional: 8, excluded: 24, direct: 6, role: "supplementary domestic OTA signal" },
      rakuten: { rows: 126, role: "frozen / caution" },
      known_cautions: ["always_on_mac_unverified"]
    },
    risks: ["date_expansion_future"]
  };
}

describe("AUTO-RUNNER05X - target inventory and date policy", () => {
  it("includes Booking verified slugs", () => {
    expect(buildTargetInventory().booking_verified_slugs.map((item) => item.slug)).toEqual(["zao-kokusai", "zao-shiki-no", "shinzanso-takamiya"]);
  });

  it("includes Jalan verified yad IDs", () => {
    expect(buildTargetInventory().jalan_verified_yads.map((item) => item.yad_id)).toEqual(["yad325153", "yad328232", "yad348320", "yad327282", "yad332556"]);
  });

  it("does not invent unverified targets", () => {
    const allScheduled = [...buildTargetInventory().booking_verified_slugs.map((item) => item.slug), ...buildTargetInventory().jalan_verified_yads.map((item) => item.yad_id)];
    expect(allScheduled).not.toContain("lucent");
    expect(allScheduled).not.toContain("OAKHILL");
  });

  it("separates candidate/manual-review targets", () => {
    expect(buildTargetInventory().manual_review_targets.length).toBeGreaterThan(0);
  });

  it("includes near_term_60d date policy", () => {
    expect(buildDateWindowPolicy().near_term_60d.description).toContain("60");
  });

  it("includes major_dates_1y policy", () => {
    expect(buildDateWindowPolicy().major_dates_1y.categories).toContain("Obon");
  });

  it("includes manual_override_dates", () => {
    expect(buildDateWindowPolicy().manual_override_dates.allowed).toBe(true);
  });
});

describe("AUTO-RUNNER05X - batch plans and gates", () => {
  it("Booking max_pages_per_run <= 30", () => {
    expect(buildBookingBatchPlans().every((plan) => plan.max_pages_per_run <= 30)).toBe(true);
  });

  it("Jalan max_pages_per_run <= 25", () => {
    expect(buildJalanBatchPlans().every((plan) => plan.max_pages_per_run <= 25)).toBe(true);
  });

  it("Booking requires ZMI_AUTORUN_ENABLED and COLLECT_BOOKING", () => {
    const plan = buildBookingBatchPlans()[0]!;
    expect(plan.requires_global_gate).toBe("ZMI_AUTORUN_ENABLED=1");
    expect(plan.requires_source_gate).toBe("COLLECT_BOOKING=1");
  });

  it("Jalan requires ZMI_AUTORUN_ENABLED and COLLECT_JALAN", () => {
    const plan = buildJalanBatchPlans()[0]!;
    expect(plan.requires_global_gate).toBe("ZMI_AUTORUN_ENABLED=1");
    expect(plan.requires_source_gate).toBe("COLLECT_JALAN=1");
  });

  it("all batch plans enabled_by_default=false", () => {
    expect([...buildBookingBatchPlans(), ...buildJalanBatchPlans()].every((plan) => plan.enabled_by_default === false)).toBe(true);
  });

  it("Booking is primary", () => {
    expect(buildBookingBatchPlans()[0]!.role).toContain("primary");
  });

  it("Jalan is supplementary", () => {
    expect(buildJalanBatchPlans()[0]!.role).toContain("supplementary");
  });

  it("No append included in collector batch output", () => {
    expect([...buildBookingBatchPlans(), ...buildJalanBatchPlans()].every((plan) => plan.output === "preview_report_artifacts_only")).toBe(true);
  });

  it("No DB sync included in collector batch output", () => {
    expect([...buildBookingBatchPlans(), ...buildJalanBatchPlans()].every((plan) => plan.excludes.includes("DB sync"))).toBe(true);
  });

  it("No AI context refresh included in collector batch output", () => {
    expect([...buildBookingBatchPlans(), ...buildJalanBatchPlans()].every((plan) => plan.excludes.includes("AI context refresh"))).toBe(true);
  });

  it("No price CSV included in collector batch output", () => {
    expect([...buildBookingBatchPlans(), ...buildJalanBatchPlans()].every((plan) => plan.excludes.includes("pricing CSV"))).toBe(true);
  });

  it("renders CSV and report", () => {
    const current = buildCurrentStateSummary(artifact());
    expect(renderBatchPlanCsv([...buildBookingBatchPlans(), ...buildJalanBatchPlans()])).toContain("plan_id");
    expect(
      renderReport({
        generatedAtJst: "2026-06-05T16:00:00+09:00",
        decision: "auto_runner_bounded_schedule_config_basis_caution",
        sourceArtifactPath: "auto04x.json",
        current,
        inventory: buildTargetInventory(),
        datePolicy: buildDateWindowPolicy(),
        bookingPlans: buildBookingBatchPlans(),
        jalanPlans: buildJalanBatchPlans(),
        gates: buildGateMatrix(),
        failure: buildFailureBehavior(),
        integration: buildFutureRunnerIntegration(),
        risks: [],
        safety: buildSafetyConfirmation()
      })
    ).toContain("Bounded Collector Schedule Config Proposal");
  });
});

describe("AUTO-RUNNER05X - failure behavior and decision", () => {
  it("Failure behavior includes block/CAPTCHA/degraded page", () => {
    expect(buildFailureBehavior().rules.join("\n")).toContain("blocked/CAPTCHA/degraded");
  });

  it("Failure behavior includes screenshot requirement", () => {
    expect(buildFailureBehavior().rules.join("\n")).toContain("screenshot missing");
  });

  it("Failure behavior includes no inferred prices", () => {
    expect(buildFailureBehavior().rules.join("\n")).toContain("do not infer");
  });

  it("Failure behavior includes no catch-up burst", () => {
    expect(buildFailureBehavior().rules.join("\n")).toContain("do not catch up with burst");
  });

  it("Decision ready/basis_caution/not_ready", () => {
    expect(
      decideAutoRunnerBoundedSchedule({
        sourcePresent: true,
        inventory: buildTargetInventory(),
        bookingPlans: buildBookingBatchPlans(),
        jalanPlans: buildJalanBatchPlans()
      })
    ).toBe("auto_runner_bounded_schedule_config_basis_caution");
    expect(decideAutoRunnerBoundedSchedule({ sourcePresent: false, inventory: buildTargetInventory(), bookingPlans: [], jalanPlans: [] })).toBe(
      "auto_runner_bounded_schedule_config_not_ready"
    );
  });
});

describe("AUTO-RUNNER05X - executable safety scans", () => {
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
    expect(PACKAGE_JSON).toContain("proposal:auto-runner-bounded-schedule");
  });
});
