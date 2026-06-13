import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBookingPlanFromPlannerTargets,
  buildJalanMatrixFromPlannerTargets,
  type PlannerStayDateTarget
} from "../src/services/autoRunnerMarketRefresh";

const RUNNER_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerMarketRefreshRotating.ts"), "utf8");
const PLANNER_SOURCE = readFileSync(resolve(__dirname, "../src/services/rotatingCollectionScopePlanner.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

describe("AUTO-RUNNER16X - planner stay_date handoff (Booking)", () => {
  it("preserves planner-selected stay_date as Booking checkin (no PEAK_DATE fallback)", () => {
    const targets: PlannerStayDateTarget[] = [
      { source: "booking", property_slug: "zao-kokusai", canonical_property_name: "蔵王国際ホテル", stay_date: "2026-09-19" },
      { source: "booking", property_slug: "zao-shiki-no", canonical_property_name: "蔵王四季のホテル", stay_date: "2026-10-10" }
    ];
    const plan = buildBookingPlanFromPlannerTargets(targets);
    const checkins = plan.selected_targets.map((c) => c.checkin).sort();
    expect(checkins).toEqual(["2026-09-19", "2026-10-10"]);
    // 2026-08-10 (the old fixed PEAK_DATE) must NOT appear unless planner selected it
    expect(plan.selected_targets.some((c) => c.checkin === "2026-08-10")).toBe(false);
  });

  it("only includes 2026-08-10 when planner actually selects it", () => {
    const plan = buildBookingPlanFromPlannerTargets([
      { source: "booking", property_slug: "shinzanso-takamiya", canonical_property_name: "深山荘 高見屋", stay_date: "2026-08-10" }
    ]);
    expect(plan.selected_targets[0]!.checkin).toBe("2026-08-10");
  });

  it("drops unknown booking slugs as excluded_missing_mapping", () => {
    const plan = buildBookingPlanFromPlannerTargets([
      { source: "booking", property_slug: "ghost-hotel", canonical_property_name: "幽霊", stay_date: "2026-09-19" }
    ]);
    expect(plan.selected_targets).toHaveLength(0);
    expect(plan.excluded_missing_mapping).toHaveLength(1);
  });

  it("respects booking page cap", () => {
    const many: PlannerStayDateTarget[] = Array.from({ length: 30 }, (_, i) => ({
      source: "booking", property_slug: "zao-kokusai", canonical_property_name: "蔵王国際ホテル", stay_date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`
    }));
    const plan = buildBookingPlanFromPlannerTargets(many);
    expect(plan.page_cap_respected).toBe(true);
    expect(plan.selected_targets.length).toBeLessThanOrEqual(plan.max_pages);
  });
});

describe("AUTO-RUNNER16X - planner stay_date handoff (Jalan)", () => {
  it("preserves planner-selected stay_date as Jalan checkin", () => {
    const targets: PlannerStayDateTarget[] = [
      { source: "jalan", property_slug: "yad325153", canonical_property_name: "ホテル喜らく", stay_date: "2026-09-19" },
      { source: "jalan", property_slug: "yad328232", canonical_property_name: "ル・ベール蔵王", stay_date: "2026-08-10" }
    ];
    const out = buildJalanMatrixFromPlannerTargets(targets);
    const checkins = out.targets.map((t) => t.checkin).sort();
    expect(checkins).toEqual(["2026-08-10", "2026-09-19"]);
  });

  it("drops unknown yadIds as excluded_missing_mapping", () => {
    const out = buildJalanMatrixFromPlannerTargets([
      { source: "jalan", property_slug: "yad999999", canonical_property_name: "未知", stay_date: "2026-09-19" }
    ]);
    expect(out.targets).toHaveLength(0);
    expect(out.excluded_missing_mapping).toHaveLength(1);
  });
});

describe("AUTO-RUNNER16X - rotating runner safety scans", () => {
  it("runner never collects Rakuten or Google Hotels", () => {
    expect(RUNNER_SOURCE).not.toMatch(/probe:rakuten|runRakuten|googleHotels|google-hotels|collect:rakuten/u);
  });

  it("runner generates no pricing/PMS output", () => {
    expect(RUNNER_SOURCE).not.toMatch(/writeFileSync\([^)]*(beds24|airhost|pricing_recommendation|price_update)|PMS_UPLOAD|OTA_UPLOAD/iu);
    expect(RUNNER_SOURCE).toContain("pricing_output_generated: false");
    expect(RUNNER_SOURCE).toContain("pms_output_generated: false");
  });

  it("runner is fail-closed: live requires all gates + PLANNER_ROTATION_ENABLED and not dry-run", () => {
    expect(RUNNER_SOURCE).toContain("PLANNER_ROTATION_ENABLED");
    expect(RUNNER_SOURCE).toContain("ZMI_ROTATING_DRY_RUN");
    expect(RUNNER_SOURCE).toMatch(/liveMode\s*=\s*!dryRun\s*&&\s*liveGates\s*&&\s*rotationEnabled/u);
  });

  it("runner uses atomic append with backup dir", () => {
    expect(RUNNER_SOURCE).toContain("appendHistoryRowsAtomic");
    expect(RUNNER_SOURCE).toMatch(/backupDir/u);
  });

  it("runner publishes only when aligned and PUBLISH_CHATGPT_DB=1", () => {
    expect(RUNNER_SOURCE).toMatch(/PUBLISH_CHATGPT_DB.*===.*"1".*&&.*aligned|aligned[\s\S]{0,80}PUBLISH_CHATGPT_DB/u);
  });

  it("rotating planner never produces a direct-price flag", () => {
    expect(PLANNER_SOURCE).not.toMatch(/is_price_usable_for_dp_direct\s*[:=]\s*true|dp_usage\s*[:=]\s*["']direct/u);
  });

  it("package.json wires rotating + coverage scripts", () => {
    expect(PACKAGE_JSON).toContain("auto-runner:market-refresh-rotating");
    expect(PACKAGE_JSON).toContain("auto-runner:market-refresh-rotating:dry-run");
    expect(PACKAGE_JSON).toContain("report:collection-coverage");
  });
});

describe("AUTO-RUNNER16X-E0 - real source-block reporting wiring", () => {
  it("runner output object no longer hardcodes the flag to false", () => {
    // The old output object had `source_block_or_captcha_detected: false,` immediately
    // followed by pricing_output_generated. That hardcode must be gone (the default
    // initializer of sourceBlockReport may still legitimately set false).
    expect(RUNNER_SOURCE).not.toMatch(/source_block_or_captcha_detected:\s*false,\s*\n\s*pricing_output_generated/u);
  });

  it("runner derives the flag from buildSourceBlockReport", () => {
    expect(RUNNER_SOURCE).toContain("buildSourceBlockReport");
    expect(RUNNER_SOURCE).toContain("source_block_or_captcha_detected: sourceBlockReport.source_block_or_captcha_detected");
  });

  it("runner emits the breakdown fields in its output", () => {
    expect(RUNNER_SOURCE).toContain("booking_source_level_captcha_or_block: sourceBlockReport.booking_source_level_captcha_or_block");
    expect(RUNNER_SOURCE).toContain("jalan_source_level_captcha_or_block: sourceBlockReport.jalan_source_level_captcha_or_block");
    expect(RUNNER_SOURCE).toContain("blocked_or_captcha_rejected_rows_count: sourceBlockReport.blocked_or_captcha_rejected_rows_count");
  });

  it("dry-run keeps the flag false (default before any collection)", () => {
    // The default initializer must be false so a dry-run (no live collection) reports false.
    expect(RUNNER_SOURCE).toMatch(/sourceBlockReport[\s\S]{0,200}source_block_or_captcha_detected:\s*false/u);
  });
});

describe("AUTO-RUNNER16X-F - daily capacity reporting", () => {
  it("runner emits theoretical/booking/jalan daily capacity from DAILY_PAGE_CAPACITY", () => {
    expect(RUNNER_SOURCE).toContain("DAILY_PAGE_CAPACITY");
    expect(RUNNER_SOURCE).toContain("theoretical_daily_page_capacity: DAILY_PAGE_CAPACITY.theoretical_daily_page_capacity");
    expect(RUNNER_SOURCE).toContain("booking_daily_capacity: DAILY_PAGE_CAPACITY.booking_daily_capacity");
    expect(RUNNER_SOURCE).toContain("jalan_daily_capacity: DAILY_PAGE_CAPACITY.jalan_daily_capacity");
  });
});
