import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_BASELINE_ROW_COUNT,
  buildOpsSummaryResult,
  decideOpsStatus,
  launchdReady,
  renderOpsSummaryReport,
  type OpsSummaryInput
} from "../src/services/autoRunnerOpsSummary";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/autoRunnerOpsSummary.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/runAutoRunnerOpsSummary.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function baseInput(overrides: Partial<OpsSummaryInput> = {}): OpsSummaryInput {
  return {
    now_jst: "2026-06-07T11:00:00+09:00",
    git_head: "a890011 Enable live market refresh launchd schedule",
    working_tree_clean: true,
    launchd: { health_check: true, db_update_dry_run: true, market_refresh_live: true, gated_absent: true },
    latest_run: {
      artifact_timestamp: "2026-06-07T10:47:26+09:00",
      artifact_path: ".data/reports/automation/auto_runner_market_refresh_20260607_104726.json",
      trigger: "manual_kickstart",
      decision: "auto_runner_market_refresh_success",
      append_count: 3,
      skipped_identical_count: 21,
      intraday_price_change_count: 3,
      hard_conflict_count: 0,
      pricing_pms_output_count: 0
    },
    counts: { history_rows: 246, db_rows: 246, ai_context_rows: 246, booking: 67, jalan: 53, rakuten: 126, duplicate_row_id_count: 0 },
    baseline_expected: EXPECTED_BASELINE_ROW_COUNT,
    scheduled_run_observed: false,
    health_check_status: "auto_runner_health_check_ready",
    db_update_status: "auto_runner_db_update_stub_ready_not_run",
    ...overrides
  };
}

describe("AUTO-RUNNER13X - ops summary status", () => {
  it("waiting_first_scheduled_run when healthy but no scheduled run yet", () => {
    expect(decideOpsStatus(baseInput())).toBe("ops_waiting_first_scheduled_run");
  });

  it("healthy when scheduled run observed and counts match baseline", () => {
    expect(decideOpsStatus(baseInput({ scheduled_run_observed: true }))).toBe("ops_healthy");
  });

  it("baseline_stale_after_safe_append when history exceeds baseline", () => {
    const input = baseInput({ counts: { history_rows: 249, db_rows: 249, ai_context_rows: 249, booking: 70, jalan: 53, rakuten: 126, duplicate_row_id_count: 0 }, scheduled_run_observed: true });
    expect(decideOpsStatus(input)).toBe("ops_baseline_stale_after_safe_append");
    expect(buildOpsSummaryResult(input).baseline_stale).toBe(true);
  });

  it("blocked_hard_conflict when latest run had hard conflicts", () => {
    expect(decideOpsStatus(baseInput({ latest_run: { ...baseInput().latest_run, hard_conflict_count: 2 } }))).toBe("ops_blocked_hard_conflict");
  });

  it("db_ai_mismatch when counts diverge", () => {
    expect(decideOpsStatus(baseInput({ counts: { ...baseInput().counts, db_rows: 245 } }))).toBe("ops_db_ai_mismatch");
  });

  it("duplicate_row_id_detected takes top priority", () => {
    expect(decideOpsStatus(baseInput({ counts: { ...baseInput().counts, duplicate_row_id_count: 1 } }))).toBe("ops_duplicate_row_id_detected");
  });

  it("launchd_not_ready when a job is missing or gated lingers", () => {
    expect(decideOpsStatus(baseInput({ launchd: { health_check: true, db_update_dry_run: true, market_refresh_live: false, gated_absent: true } }))).toBe("ops_launchd_not_ready");
    expect(decideOpsStatus(baseInput({ launchd: { health_check: true, db_update_dry_run: true, market_refresh_live: true, gated_absent: false } }))).toBe("ops_launchd_not_ready");
  });

  it("launchdReady helper", () => {
    expect(launchdReady({ health_check: true, db_update_dry_run: true, market_refresh_live: true, gated_absent: true })).toBe(true);
    expect(launchdReady({ health_check: true, db_update_dry_run: true, market_refresh_live: true, gated_absent: false })).toBe(false);
  });
});

describe("AUTO-RUNNER13X - ops summary rendering", () => {
  it("report includes status, launchd, counts, baseline, roadmap", () => {
    const input = baseInput();
    const text = renderOpsSummaryReport(input, buildOpsSummaryResult(input));
    expect(text).toContain("status: ops_waiting_first_scheduled_run");
    expect(text).toContain("com.yuge.zmi.market-refresh-live");
    expect(text).toContain("baseline_expected: 246");
    expect(text).toContain("12X deferred");
    expect(text).toContain("Roadmap");
  });

  it("forbidden_output_detected reflects pricing/pms count", () => {
    expect(buildOpsSummaryResult(baseInput()).forbidden_output_detected).toBe(false);
    expect(buildOpsSummaryResult(baseInput({ latest_run: { ...baseInput().latest_run, pricing_pms_output_count: 1 } })).forbidden_output_detected).toBe(true);
  });
});

describe("AUTO-RUNNER13X - read-only safety scans", () => {
  it("service has no I/O or process spawning", () => {
    expect(SERVICE_SOURCE).not.toMatch(/child_process|spawn|execSync|readFileSync|writeFileSync|playwright/u);
  });

  it("script never runs live collectors / market-refresh / mutation commands", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/COLLECT_BOOKING|COLLECT_JALAN|auto-runner:market-refresh|sync:history-to-db|build:ai-context-packs|probe:|collect:/u);
  });

  it("script never kickstarts/bootstraps/bootouts launchd (print only)", () => {
    // Word boundaries so the inert `manual_kickstart` trigger enum is allowed;
    // we only forbid actual launchctl subcommand usage.
    expect(SCRIPT_SOURCE).not.toMatch(/\bbootstrap\b|\bbootout\b|"enable"|"disable"|"kickstart"/u);
    expect(SCRIPT_SOURCE).toContain('"print"');
  });

  it("script does not write history / pricing / pms", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/writeFileSync\([^)]*\.data\/history|writeFileSync\([^)]*(pricing|beds24|airhost)/iu);
  });

  it("package wires the ops-summary script", () => {
    expect(PACKAGE_JSON).toContain("auto-runner:ops-summary");
  });
});
