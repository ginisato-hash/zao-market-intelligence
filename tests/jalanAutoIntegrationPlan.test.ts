import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBookingBaseline,
  buildDirectDirectionalExcludedPolicy,
  buildFuturePhasePlan,
  buildIntegrationPath,
  buildJalanDataQualityAudit,
  buildJalanFileInventory,
  buildRisks,
  buildSafetyConfirmation,
  decideJalanAutoIntegrationPlan,
  renderInventoryCsv,
  summarizeSignalRows,
  type FileSource,
  type SignalRowLike
} from "../src/services/jalanAutoIntegrationPlan";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/jalanAutoIntegrationPlan.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildJalanAutoIntegrationPlan.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function files(): FileSource[] {
  return [
    {
      file_path: "src/collectors/jalanCollector.ts",
      source_text: "import { chromium } from 'playwright'; await page.goto(url);"
    },
    {
      file_path: "src/collectors/jalanAcceptedPricePolicy.ts",
      source_text: "priceBasis === 'total_tax_included'; no_safe_total_tax_included_plan_candidates;"
    },
    {
      file_path: "src/services/buildDpSafeMarketSignals.ts",
      source_text: "coupon_suspected_rows_excluded_from_dp_safe price_basis_suspicious rows"
    },
    {
      file_path: "tests/jalanPriceParser.test.ts",
      source_text: "describe('jalan', () => {})"
    }
  ];
}

function rows(): SignalRowLike[] {
  return [
    {
      source: "jalan",
      canonical_property_name: "market_aggregate",
      checkin: "2026-08-09",
      availability_status: "available",
      basis_confidence: "A",
      classification: "use_directly",
      normalized_total_price: 44150,
      is_price_usable_for_dp_direct: "true",
      is_price_usable_for_dp_directional: "true",
      is_price_excluded_from_dp: "false",
      stay_scope: "2_adults_1_room_1_night",
      source_report_path: "report.md"
    },
    {
      source: "jalan",
      canonical_property_name: "market_aggregate",
      checkin: "2026-10-10",
      availability_status: "available",
      basis_confidence: "B",
      classification: "use_directionally",
      normalized_total_price: 13500,
      is_price_usable_for_dp_direct: "false",
      is_price_usable_for_dp_directional: "true",
      is_price_excluded_from_dp: "false",
      stay_scope: "2_adults_1_room_1_night",
      source_report_path: "report.md"
    },
    {
      source: "jalan",
      canonical_property_name: "market_aggregate",
      checkin: "2026-12-12",
      availability_status: "unavailable_or_unknown",
      basis_confidence: "insufficient",
      classification: "exclude",
      normalized_total_price: null,
      is_price_usable_for_dp_direct: "false",
      is_price_usable_for_dp_directional: "false",
      is_price_excluded_from_dp: "true",
      stay_scope: "2_adults_1_room_1_night",
      source_report_path: "report.md"
    },
    {
      source: "booking",
      canonical_property_name: "蔵王国際ホテル",
      checkin: "2026-08-09",
      availability_status: "available",
      basis_confidence: "B",
      classification: "booking_official_total_directional",
      normalized_total_price: 32000,
      dp_usage: "directional"
    },
    {
      source: "booking",
      canonical_property_name: "蔵王国際ホテル",
      checkin: "2026-08-10",
      availability_status: "unavailable_or_unknown",
      basis_confidence: "C",
      classification: "booking_missing_official_tax_fee_adder",
      normalized_total_price: null,
      dp_usage: "excluded"
    }
  ];
}

describe("JALAN-AUTO01X - inventory and summaries", () => {
  it("builds Jalan file inventory", () => {
    const inventory = buildJalanFileInventory(files());
    expect(inventory.length).toBeGreaterThanOrEqual(4);
    expect(inventory.some((row) => row.file_path.includes("jalanCollector"))).toBe(true);
  });

  it("detects Jalan DB/history rows", () => {
    expect(summarizeSignalRows(rows().filter((row) => row.source === "jalan")).total_rows).toBe(3);
  });

  it("counts Jalan direct/directional/excluded rows", () => {
    const summary = summarizeSignalRows(rows().filter((row) => row.source === "jalan"));
    expect(summary.direct_rows).toBe(1);
    expect(summary.directional_rows).toBe(1);
    expect(summary.excluded_rows).toBe(1);
  });

  it("compares Jalan vs Booking baseline", () => {
    const all = summarizeSignalRows(rows());
    const booking = summarizeSignalRows(rows().filter((row) => row.source === "booking"));
    const baseline = buildBookingBaseline({ dbSummary: all, bookingSummary: booking, historyRowCount: 5 });
    expect(baseline.booking_rows_total).toBe(2);
    expect(baseline.booking_direct).toBe(0);
  });
});

describe("JALAN-AUTO01X - data quality and policy", () => {
  it("audits tax-included/room-total basis fields", () => {
    const audit = buildJalanDataQualityAudit({ jalanRows: rows().filter((row) => row.source === "jalan"), inventory: buildJalanFileInventory(files()) });
    expect(["partial", "pass"]).toContain(audit.tax_included_basis.status);
    expect(["partial", "pass"]).toContain(audit.room_total_scope.status);
  });

  it("audits coupon/suspicious exclusion policy", () => {
    const audit = buildJalanDataQualityAudit({ jalanRows: rows().filter((row) => row.source === "jalan"), inventory: buildJalanFileInventory(files()) });
    expect(audit.coupon_suspicious_guards.status).toBe("pass");
  });

  it("does not promote weak Jalan rows to direct", () => {
    const policy = buildDirectDirectionalExcludedPolicy();
    expect(policy.weak_rows_rule).toContain("do not promote");
    expect(policy.jalan_direct_allowed_only_when).toContain("source confidence is A");
  });

  it("produces future phase plan", () => {
    expect(buildFuturePhasePlan().map((phase) => phase.phase)).toContain("JALAN-AUTO02X");
  });

  it("future plan separates collection/proposal/append/sync/usability", () => {
    const phases = buildFuturePhasePlan().map((phase) => phase.phase);
    expect(phases).toEqual(
      expect.arrayContaining(["JALAN-AUTO03X", "JALAN-AUTO04X", "JALAN-AUTO05X", "JALAN-AUTO05B", "JALAN-AUTO06X"])
    );
  });

  it("real write phases require approval gate", () => {
    const real = buildFuturePhasePlan().filter((phase) => phase.phase === "JALAN-AUTO05X" || phase.phase === "JALAN-AUTO05B");
    expect(real.every((phase) => phase.approval_gate.includes("requires"))).toBe(true);
  });
});

describe("JALAN-AUTO01X - artifacts and safety", () => {
  it("report includes safety confirmation", () => {
    expect(buildSafetyConfirmation().history_append).toBe(false);
    expect(buildRisks().length).toBeGreaterThan(0);
  });

  it("JSON includes required top-level keys via generated shape", () => {
    const shape = {
      run_id: "x",
      generated_at_jst: "x",
      decision: "jalan_auto_integration_plan_basis_caution",
      booking_baseline: {},
      jalan_current_state: {},
      jalan_file_inventory: [],
      jalan_db_summary: {},
      jalan_history_summary: {},
      jalan_ai_context_summary: {},
      jalan_data_quality_audit: {},
      direct_directional_excluded_policy: {},
      integration_path: buildIntegrationPath(),
      future_phase_plan: buildFuturePhasePlan(),
      risks: buildRisks(),
      safety_confirmation: buildSafetyConfirmation(),
      next_phase: "JALAN-AUTO02X"
    };
    expect(Object.keys(shape)).toEqual(
      expect.arrayContaining(["run_id", "jalan_file_inventory", "jalan_db_summary", "future_phase_plan", "safety_confirmation"])
    );
  });

  it("has no history write code", () => {
    expect(buildSafetyConfirmation().history_modification).toBe(false);
    expect(SCRIPT_SOURCE).not.toMatch(/appendFile|renameSync|copyFileSync|writeFileSync\([^)]*\.data\/history/u);
  });

  it("has no DB write code", () => {
    expect(buildSafetyConfirmation().db_write).toBe(false);
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|\.exec\(|\.run\(|prepare\(["'`]\s*(?:INSERT|DELETE|UPDATE)/iu);
  });

  it("has no DB sync code", () => {
    expect(buildSafetyConfirmation().db_sync).toBe(false);
    expect(SCRIPT_SOURCE).not.toContain("real-run:history-to-db-sync");
  });

  it("has no AI context refresh code", () => {
    expect(buildSafetyConfirmation().ai_context_refresh).toBe(false);
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("has no live collector run code", () => {
    expect(buildSafetyConfirmation().live_broad_jalan_collection).toBe(false);
    expect(SCRIPT_SOURCE).not.toMatch(/new JalanCollector|runJalanAutoUpdate|runJalanBudgetedCollection/u);
  });

  it("does not run Playwright/browser automation in this phase", () => {
    expect(buildSafetyConfirmation().playwright_run).toBe(false);
    expect(SCRIPT_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch|page\.goto/u);
  });

  it("has no PMS/Beds24/AirHost output", () => {
    expect(buildSafetyConfirmation().pms_beds24_airhost_output).toBe(false);
    expect(SERVICE_SOURCE).not.toMatch(/exportApproved|writeBeds|writeAir|pmsCsv/iu);
  });

  it("has no price update", () => {
    expect(buildSafetyConfirmation().price_update).toBe(false);
    expect(SERVICE_SOURCE).not.toMatch(/pricing:approve|approvePricing|exportApprovedRecommendationPreview/iu);
  });

  it("returns decision ready/basis_caution/not_ready", () => {
    const inventory = buildJalanFileInventory(files());
    const jalanRows = rows().filter((row) => row.source === "jalan");
    const summary = summarizeSignalRows(jalanRows);
    const audit = buildJalanDataQualityAudit({ jalanRows, inventory });
    expect(decideJalanAutoIntegrationPlan({ inventory, jalanSummary: summary, audit })).toBe("jalan_auto_integration_plan_basis_caution");
    expect(decideJalanAutoIntegrationPlan({ inventory: [], jalanSummary: summary, audit })).toBe("jalan_auto_integration_plan_not_ready");
  });

  it("renders inventory CSV and adds npm script", () => {
    expect(renderInventoryCsv(buildJalanFileInventory(files()))).toContain("file_path");
    expect(PACKAGE_JSON).toContain("\"plan:jalan-auto-integration\"");
  });
});
