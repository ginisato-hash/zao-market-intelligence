import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConflictComparisons,
  buildFuturePhasePlan,
  buildRecommendedPolicy,
  buildRowIdentityPolicyEvaluation,
  buildSafetyConfirmation,
  decideB10Y,
  renderConflictCsv,
  summarizeDifferences,
  validateB10XArtifact,
  type B09XArtifactLike,
  type B10XArtifactLike
} from "../src/services/bookingConflictResolutionProposal";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/bookingConflictResolutionProposal.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildBookingConflictResolutionProposal.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

const ROW_ID = "2026-06-04|booking|蔵王国際ホテル|zao-kokusai|2026-06-14|2026-06-15|2_adults_1_room_1_night";

function existing(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    row_id: ROW_ID,
    row_hash: "a".repeat(64),
    canonical_property_name: "蔵王国際ホテル",
    source_slug_or_code: "zao-kokusai",
    checkin: "2026-06-14",
    checkout: "2026-06-15",
    collected_date_jst: "2026-06-04",
    collected_at_jst: "2026-06-04T14:24:35+09:00",
    normalized_at_jst: "2026-06-04T14:24:35+09:00",
    availability_status: "available",
    normalized_total_price: "32000",
    basis_confidence: "B",
    is_price_usable_for_dp_direct: "false",
    is_price_usable_for_dp_directional: "true",
    is_price_excluded_from_dp: "false",
    source_primary_price: "31700",
    source_secondary_price_or_adder: "300",
    source_computed_total: "32000",
    source_tax_or_fee_classification: "booking_room_total_official_base_plus_tax_fee_adder",
    source_classification: "booking_official_total_directional",
    warning_flags: "",
    source_phase: "B05X",
    collector_stage: "prototype_read_only_b05x_broader_normalized",
    debug_artifact_path: "/old/debug",
    ...overrides
  };
}

function newer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    row_id: ROW_ID,
    row_hash: "b".repeat(64),
    canonical_property_name: "蔵王国際ホテル",
    source_slug_or_code: "zao-kokusai",
    checkin: "2026-06-14",
    checkout: "2026-06-15",
    collected_date_jst: "2026-06-04",
    collected_at_jst: "2026-06-04T16:16:23+09:00",
    normalized_at_jst: "2026-06-04T16:16:23+09:00",
    availability_status: "available",
    normalized_total_price: 33300,
    basis_confidence: "B",
    dp_usage: "directional",
    source_primary_price: 33000,
    source_secondary_price_or_adder: 300,
    source_computed_total: 33300,
    source_tax_or_fee_classification: "booking_room_total_official_base_plus_tax_fee_adder",
    source_classification: "booking_official_total_directional",
    warning_flags: "",
    source_phase: "B09X",
    collector_stage: "bounded_expanded_normalized_collection",
    debug_artifact_path: "/new/debug",
    ...overrides
  };
}

function compare(oldRow = existing(), newRow = newer()) {
  return buildConflictComparisons({
    conflictRowIds: [ROW_ID],
    existingHistoryRowsById: new Map([[ROW_ID, oldRow]]),
    b09xRowsById: new Map([[ROW_ID, newRow]])
  })[0]!;
}

describe("BOOKING-B10Y — source artifact loading", () => {
  it("loads B10X artifact", () => {
    const artifact = JSON.parse(
      readFileSync(resolve(__dirname, "../.data/reports/automation/booking_bounded_history_append_proposal_20260604_163035.json"), "utf8")
    ) as B10XArtifactLike;
    expect(artifact.preflight_summary.conflict_count).toBe(15);
  });

  it("requires B10X decision = booking_bounded_history_append_proposal_not_ready", () => {
    const artifact = JSON.parse(
      readFileSync(resolve(__dirname, "../.data/reports/automation/booking_bounded_history_append_proposal_20260604_163035.json"), "utf8")
    ) as B10XArtifactLike;
    expect(validateB10XArtifact(artifact).valid).toBe(true);
    expect(validateB10XArtifact({ ...artifact, decision: "booking_bounded_history_append_proposal_ready" }).reasons).toContain(
      "b10x_decision_not_not_ready"
    );
  });

  it("extracts 15 conflict row_ids", () => {
    const artifact = JSON.parse(
      readFileSync(resolve(__dirname, "../.data/reports/automation/booking_bounded_history_append_proposal_20260604_163035.json"), "utf8")
    ) as B10XArtifactLike;
    expect(validateB10XArtifact(artifact).conflictRowIds).toHaveLength(15);
  });

  it("loads B09X preview rows", () => {
    const artifact = JSON.parse(
      readFileSync(resolve(__dirname, "../.data/reports/source-discovery/booking_bounded_expanded_collection_20260604_161623.json"), "utf8")
    ) as B09XArtifactLike;
    expect(artifact.normalized_rows_preview).toHaveLength(30);
  });
});

describe("BOOKING-B10Y — field comparisons", () => {
  it("loads matching existing history rows", () => {
    const row = compare();
    expect(row.existing_row_hash).toBe("a".repeat(64));
  });

  it("loads matching B09X preview rows", () => {
    const row = compare();
    expect(row.new_b09x_row_hash).toBe("b".repeat(64));
  });

  it("compares market-value fields", () => {
    const row = compare();
    expect(row.market_value_changed_fields).toContain("normalized_total_price");
    expect(row.market_value_changed_fields).toContain("source_primary_price");
  });

  it("compares metadata/debug fields", () => {
    const row = compare();
    expect(row.metadata_changed_fields).toContain("source_phase");
    expect(row.metadata_changed_fields).toContain("collector_stage");
    expect(row.metadata_changed_fields).toContain("debug_artifact_path");
  });

  it("detects metadata-only conflict", () => {
    const row = compare(
      existing({ row_hash: "a".repeat(64), source_phase: "B05X", collector_stage: "old", debug_artifact_path: "/old" }),
      newer({
        row_hash: "b".repeat(64),
        normalized_total_price: 32000,
        source_primary_price: 31700,
        source_computed_total: 32000,
        source_phase: "B09X",
        collector_stage: "new",
        debug_artifact_path: "/new"
      })
    );
    expect(row.difference_types).toContain("metadata_only_changed");
    expect(row.recommended_action).toBe("skip_benign_duplicate");
  });

  it("detects price_changed conflict", () => {
    expect(compare().difference_types).toContain("price_changed");
  });

  it("detects availability_changed conflict", () => {
    expect(compare(existing({ availability_status: "available" }), newer({ availability_status: "sold_out" })).difference_types).toContain(
      "availability_changed"
    );
  });

  it("detects basis_changed conflict", () => {
    expect(compare(existing({ basis_confidence: "B" }), newer({ basis_confidence: "C" })).difference_types).toContain("basis_changed");
  });

  it("recommends append_as_new_observation_after_identity_fix for market-value conflict", () => {
    expect(compare().recommended_action).toBe("append_as_new_observation_after_identity_fix");
  });
});

describe("BOOKING-B10Y — policy evaluation", () => {
  it("evaluates Option A existing conflict policy", () => {
    const option = buildRowIdentityPolicyEvaluation().find((o) => o.option === "A");
    expect(option?.title).toContain("Existing policy");
  });

  it("evaluates Option B observation_id / run_id policy", () => {
    const option = buildRowIdentityPolicyEvaluation().find((o) => o.option === "B");
    expect(option?.summary).toContain("unique observation IDs");
  });

  it("evaluates Option C market_identity_key + version policy", () => {
    const option = buildRowIdentityPolicyEvaluation().find((o) => o.option === "C");
    expect(option?.summary).toContain("stable market identity");
  });

  it("evaluates Option D benign metadata skip policy", () => {
    const option = buildRowIdentityPolicyEvaluation().find((o) => o.option === "D");
    expect(option?.summary).toContain("Skip conflicts");
  });

  it("recommends short-term / medium-term policy", () => {
    const summary = summarizeDifferences([compare()]);
    const policy = buildRecommendedPolicy(summary);
    expect(policy.short_term).toContain("blocking");
    expect(policy.medium_term).toContain("market_identity_key");
  });

  it("keeps B11X blocked if market-value conflicts exist", () => {
    const policy = buildRecommendedPolicy(summarizeDifferences([compare()]));
    expect(policy.b11x_recommendation).toContain("B11X remains blocked");
  });

  it("builds future phase plan", () => {
    expect(buildFuturePhasePlan(summarizeDifferences([compare()]))[0]).toContain("BOOKING-ID01X");
  });

  it("returns ready / basis_caution / not_ready decisions", () => {
    const market = summarizeDifferences([compare()]);
    expect(decideB10Y({ validB10x: true, summary: market })).toBe("booking_conflict_resolution_proposal_basis_caution");
    const metadataOnly = summarizeDifferences([
      compare(existing(), newer({ normalized_total_price: 32000, source_primary_price: 31700, source_computed_total: 32000 }))
    ]);
    expect(decideB10Y({ validB10x: true, summary: metadataOnly })).toBe("booking_conflict_resolution_proposal_ready");
    expect(decideB10Y({ validB10x: false, summary: market })).toBe("booking_conflict_resolution_proposal_not_ready");
  });

  it("renders conflict CSV", () => {
    expect(renderConflictCsv([compare()])).toContain("append_as_new_observation_after_identity_fix");
  });
});

describe("BOOKING-B10Y — safety scans", () => {
  it("does not write history", () => {
    expect(SERVICE_SOURCE).not.toMatch(/appendFile|renameSync|copyFileSync/);
    expect(SCRIPT_SOURCE).not.toMatch(/appendFile|renameSync|copyFileSync/);
  });

  it("does not write DB", () => {
    expect(SERVICE_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM|UPDATE\s+/i);
    expect(SCRIPT_SOURCE).not.toMatch(/HISTORY_TO_DB_SYNC|INSERT INTO|DELETE FROM|UPDATE\s+/i);
  });

  it("does not refresh AI context", () => {
    expect(SERVICE_SOURCE).not.toContain("build:ai-context-packs");
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("does not run Playwright", () => {
    expect(SERVICE_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/from ["']playwright["']|chromium\.launch/iu);
  });

  it("does not fetch Booking", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/page\.goto|fetch\(/u);
  });

  it("has no PMS/Beds24/AirHost output", () => {
    expect(buildSafetyConfirmation().pms_beds24_airhost_ota_output).toBe(false);
    expect(SERVICE_SOURCE).not.toMatch(/exportApproved|writeBeds|writeAir|pmsCsv/iu);
  });

  it("has no paid-source tooling", () => {
    expect(SERVICE_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/iu);
    expect(SCRIPT_SOURCE).not.toMatch(/SerpAPI|DataForSEO|Apify|Bright Data|Oxylabs|paid proxy/iu);
  });

  it("adds the npm script", () => {
    expect(PACKAGE_JSON).toContain("\"proposal:booking-conflict-resolution\"");
  });
});
