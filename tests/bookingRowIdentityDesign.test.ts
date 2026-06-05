import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConflictPolicyMatrix,
  buildCurrentProblemSummary,
  buildDbAiViewDesign,
  buildFuturePhasePlan,
  buildIdentityModel,
  buildMigrationPlan,
  buildOptionComparison,
  buildRecommendedPolicy,
  buildSafetyConfirmation,
  decideBookingRowIdentityDesign,
  renderIdentityCsv,
  validateB10YArtifact,
  type B10YArtifactLike
} from "../src/services/bookingRowIdentityDesign";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/bookingRowIdentityDesign.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildBookingRowIdentityDesign.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");
const B10Y_PATH = resolve(__dirname, "../.data/reports/automation/booking_conflict_resolution_proposal_20260604_163851.json");

function loadB10Y(): B10YArtifactLike {
  return JSON.parse(readFileSync(B10Y_PATH, "utf8")) as B10YArtifactLike;
}

describe("BOOKING-ID01X - source B10Y artifact", () => {
  it("loads B10Y artifact", () => {
    expect(loadB10Y().decision).toBe("booking_conflict_resolution_proposal_basis_caution");
  });

  it("recognizes 15 conflicts", () => {
    const artifact = loadB10Y();
    expect(validateB10YArtifact(artifact).valid).toBe(true);
    expect(buildCurrentProblemSummary(artifact).total_conflicts).toBe(15);
  });

  it("recognizes 10 market-value conflicts", () => {
    expect(buildCurrentProblemSummary(loadB10Y()).market_value_conflicts).toBe(10);
  });

  it("recognizes 5 metadata-only conflicts", () => {
    expect(buildCurrentProblemSummary(loadB10Y()).metadata_only_conflicts).toBe(5);
  });
});

describe("BOOKING-ID01X - identity model", () => {
  it("defines market_identity_key", () => {
    expect(buildIdentityModel().market_identity_key.name).toBe("market_identity_key");
  });

  it("market_identity_key excludes collected_at_jst", () => {
    expect(buildIdentityModel().market_identity_key.excludes).toContain("collected_at_jst");
    expect(buildIdentityModel().market_identity_key.fields).not.toContain("collected_at_jst");
  });

  it("market_identity_key excludes debug/report paths", () => {
    const key = buildIdentityModel().market_identity_key;
    expect(key.excludes).toEqual(expect.arrayContaining(["debug_artifact_path", "source_report_path", "source_csv_path"]));
    expect(key.fields).not.toContain("debug_artifact_path");
  });

  it("defines observation_id", () => {
    expect(buildIdentityModel().observation_id.name).toBe("observation_id");
  });

  it("observation_id includes collected_at_jst or run_id", () => {
    const fields = buildIdentityModel().observation_id.fields;
    expect(fields.includes("collected_at_jst") || fields.includes("collected_run_id")).toBe(true);
  });

  it("defines market_value_hash", () => {
    expect(buildIdentityModel().market_value_hash.name).toBe("market_value_hash");
    expect(buildIdentityModel().market_value_hash.fields).toContain("normalized_total_price");
  });

  it("market_value_hash excludes debug/report paths", () => {
    const hash = buildIdentityModel().market_value_hash;
    expect(hash.excludes).toEqual(expect.arrayContaining(["debug_artifact_path", "source_report_path", "source_csv_path"]));
    expect(hash.fields).not.toContain("source_report_path");
  });
});

describe("BOOKING-ID01X - option comparison and recommendation", () => {
  it("compares at least four options", () => {
    expect(buildOptionComparison()).toHaveLength(4);
  });

  it("Option A keeps current row_id policy", () => {
    const option = buildOptionComparison().find((item) => item.option === "A");
    expect(option?.title).toContain("current row_id");
  });

  it("Option B redefines row_id as observation identity", () => {
    const option = buildOptionComparison().find((item) => item.option === "B");
    expect(option?.summary).toContain("observation identity");
  });

  it("Option C adds market_identity_key + observation_id", () => {
    const option = buildOptionComparison().find((item) => item.option === "C");
    expect(option?.summary).toContain("market_identity_key");
    expect(option?.summary).toContain("observation_id");
  });

  it("Option D is metadata-only skip", () => {
    const option = buildOptionComparison().find((item) => item.option === "D");
    expect(option?.title).toContain("Metadata-only");
  });

  it("recommends Option C short-term", () => {
    const option = buildOptionComparison().find((item) => item.option === "C");
    const policy = buildRecommendedPolicy(buildCurrentProblemSummary(loadB10Y()));
    expect(option?.recommendation).toBe("recommended_short_term");
    expect(policy.short_term).toContain("Option C");
  });

  it("recommends future v2 observation model", () => {
    expect(buildRecommendedPolicy(buildCurrentProblemSummary(loadB10Y())).medium_term).toContain("history v2");
  });
});

describe("BOOKING-ID01X - conflict policy and DB/AI impact", () => {
  it("defines conflict policy matrix", () => {
    expect(buildConflictPolicyMatrix().map((rule) => rule.action)).toEqual(
      expect.arrayContaining(["skip_identical", "true_conflict", "append_new_observation_price_changed"])
    );
  });

  it("includes latest-observation DB view design", () => {
    expect(buildDbAiViewDesign().map((view) => view.view_name)).toContain("v_ai_market_latest_observation");
  });

  it("includes observation-history DB view design", () => {
    expect(buildDbAiViewDesign().map((view) => view.view_name)).toContain("v_ai_market_observation_history");
  });

  it("includes price-movement DB view design", () => {
    expect(buildDbAiViewDesign().map((view) => view.view_name)).toContain("v_ai_price_movement_by_market_identity");
  });

  it("includes migration plan preserving v1 history", () => {
    expect(buildMigrationPlan()[0]?.action).toContain("existing .data/history v1 rows unchanged");
  });

  it("builds future phase plan", () => {
    expect(buildFuturePhasePlan().map((phase) => phase.phase)).toEqual(
      expect.arrayContaining(["BOOKING-ID02X", "BOOKING-B10Z", "BOOKING-B11X"])
    );
  });

  it("renders CSV", () => {
    expect(renderIdentityCsv({ optionComparison: buildOptionComparison(), conflictPolicyMatrix: buildConflictPolicyMatrix() })).toContain(
      "option,C"
    );
  });
});

describe("BOOKING-ID01X - safety and decision", () => {
  it("does not write history", () => {
    expect(buildSafetyConfirmation().history_modification).toBe(false);
    expect(SERVICE_SOURCE).not.toMatch(/appendFile|renameSync|copyFileSync/);
    expect(SCRIPT_SOURCE).not.toMatch(/appendFile|renameSync|copyFileSync/);
  });

  it("does not write DB", () => {
    expect(buildSafetyConfirmation().db_writes).toBe(false);
    expect(SERVICE_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM|UPDATE\s+/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM|UPDATE\s+/iu);
  });

  it("does not run migration", () => {
    expect(buildSafetyConfirmation().db_schema_migration_execution).toBe(false);
    expect(SCRIPT_SOURCE).not.toContain("db:migrate");
  });

  it("does not fetch Booking", () => {
    expect(buildSafetyConfirmation().live_booking_fetch).toBe(false);
    expect(SCRIPT_SOURCE).not.toMatch(/page\.goto|fetch\(/u);
  });

  it("has no PMS/Beds24/AirHost output", () => {
    expect(buildSafetyConfirmation().pms_beds24_airhost_ota_output).toBe(false);
    expect(SERVICE_SOURCE).not.toMatch(/exportApproved|writeBeds|writeAir|pmsCsv/iu);
  });

  it("has no synthetic Booking multiplier", () => {
    expect(buildSafetyConfirmation().booking_synthetic_multiplier).toBe(false);
    expect(SERVICE_SOURCE).not.toMatch(/\*\s*1\.1/);
    expect(SCRIPT_SOURCE).not.toMatch(/\*\s*1\.1/);
  });

  it("returns ready / basis_caution / not_ready decisions", () => {
    const artifact = loadB10Y();
    const problemSummary = buildCurrentProblemSummary(artifact);
    const identityModel = buildIdentityModel();
    const optionComparison = buildOptionComparison();
    expect(
      decideBookingRowIdentityDesign({
        b10yValid: true,
        problemSummary,
        optionComparison,
        identityModel
      })
    ).toBe("booking_row_identity_design_ready");
    expect(
      decideBookingRowIdentityDesign({
        b10yValid: true,
        problemSummary: { ...problemSummary, total_conflicts: 16 },
        optionComparison,
        identityModel
      })
    ).toBe("booking_row_identity_design_basis_caution");
    expect(
      decideBookingRowIdentityDesign({
        b10yValid: false,
        problemSummary,
        optionComparison,
        identityModel
      })
    ).toBe("booking_row_identity_design_not_ready");
  });

  it("has no paid-source tooling and adds npm script", () => {
    expect(SERVICE_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/iu);
    expect(PACKAGE_JSON).toContain("\"design:booking-row-identity\"");
  });
});
