import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReportFixture } from "./helpers/reportFixtureResolver";
import {
  buildClassifierPolicyAudit,
  buildExtractorImprovementPlan,
  buildFutureAuto03bPlan,
  buildProposedClassificationFix,
  buildSafetyConfirmation,
  decideJalanProbeResultReview,
  diagnoseRows,
  renderDiagnosisCsv,
  renderReport,
  summarizeExclusions,
  validateAuto03xArtifact,
  type Auto03xArtifactLike,
  type Auto03xReviewRow
} from "../src/services/jalanProbeResultReview";

const SERVICE_SOURCE = readFileSync(resolve(__dirname, "../src/services/jalanProbeResultReview.ts"), "utf8");
const SCRIPT_SOURCE = readFileSync(resolve(__dirname, "../src/scripts/buildJalanProbeResultReview.ts"), "utf8");
const PACKAGE_JSON = readFileSync(resolve(__dirname, "../package.json"), "utf8");

function loadAuto03x(): Auto03xArtifactLike {
  return JSON.parse(
    readFileSync(resolveReportFixture(".data/reports/source-discovery/jalan_bounded_collection_probe_20260604_232102.json"), "utf8")
  ) as Auto03xArtifactLike;
}

function row(overrides: Partial<Auto03xReviewRow> = {}): Auto03xReviewRow {
  return {
    canonical_property_name: "ル・ベール蔵王",
    source_slug_or_code: "yad328232",
    checkin: "2026-06-06",
    availability_status: "available",
    normalized_total_price: 25000,
    normalized_total_price_basis: "tax_included_total",
    screenshot_path: "/tmp/yad328232.png",
    basis_confidence: "C",
    dp_usage: "excluded",
    source_classification: "jalan_price_disqualified",
    dp_exclusion_reason: "coupon_member_point_or_suspicious_price",
    warning_flags: "coupon_member_point_or_suspicious_evidence",
    error_reason: "",
    room_or_plan_name: "【素泊まり】旅は自由に自分流",
    meal_condition: "素泊まり",
    property_identity_match: "verified_target_url",
    source_url: "https://www.jalan.net/yad328232/plan/?stayYear=2026&stayMonth=06&stayDay=06&roomCrack=200000",
    debug_artifact_path: "/tmp/target.json",
    raw_text_excerpt: "ル・ベール蔵王 2026年6月 6 ○ 1部屋 大人 2名 合計(税込) 25,000円 ポイントがたまる",
    ...overrides
  };
}

describe("JALAN-AUTO03R - source rows", () => {
  it("loads AUTO03X rows", () => {
    expect(validateAuto03xArtifact(loadAuto03x()).valid).toBe(true);
  });

  it("detects 25 preview/failure rows", () => {
    expect(validateAuto03xArtifact(loadAuto03x()).rows).toHaveLength(25);
  });

  it("detects price-detected excluded rows", () => {
    const rows = diagnoseRows(validateAuto03xArtifact(loadAuto03x()).rows);
    expect(rows.filter((item) => item.tax_included_detected && item.dp_usage === "excluded")).toHaveLength(13);
  });

  it("buckets exclusion reasons", () => {
    const summary = summarizeExclusions(diagnoseRows(validateAuto03xArtifact(loadAuto03x()).rows));
    expect(summary.price_detected_but_excluded_count).toBe(13);
    expect(summary.coupon_or_discount_count).toBe(13);
    expect(summary.plan_level_discount_count).toBe(8);
    expect(summary.generic_page_level_discount_only_count).toBe(5);
  });
});

describe("JALAN-AUTO03R - row diagnosis", () => {
  it("distinguishes hard exclusion from direct downgrade", () => {
    const diagnosed = diagnoseRows([row({ room_or_plan_name: "【じゃらんスペシャルウィーク】温泉プラン" })])[0]!;
    expect(diagnosed.reason_buckets).toContain("plan_level_discount_detected");
    expect(diagnosed.should_remain_excluded).toBe(true);
  });

  it("marks coupon/member/suspicious rows as hard excluded", () => {
    const diagnosed = diagnoseRows([row({ room_or_plan_name: "【直前割】朝食付プラン" })])[0]!;
    expect(diagnosed.recommended_action).toBe("keep_excluded_until_standard_plan_extracted");
  });

  it("allows directional recommendation for price-detected rows with partial direct evidence", () => {
    const diagnosed = diagnoseRows([row()])[0]!;
    expect(diagnosed.reason_buckets).toContain("classification_policy_too_strict");
    expect(diagnosed.could_be_directional_under_relaxed_policy).toBe(true);
    expect(diagnosed.recommended_action).toBe("candidate_directional_after_coupon_detector_fix");
  });

  it("does not promote rows to direct", () => {
    const diagnosed = diagnoseRows([row()])[0]!;
    expect(diagnosed.recommended_action).not.toBe("promote_to_direct");
  });

  it("does not infer missing price", () => {
    const diagnosed = diagnoseRows([row({ normalized_total_price: null, normalized_total_price_basis: "missing_or_unclear", availability_status: "failed" })])[0]!;
    expect(diagnosed.tax_included_detected).toBe(false);
    expect(diagnosed.reason_buckets).toContain("missing_price");
  });

  it("handles insufficient debug evidence", () => {
    const diagnosed = diagnoseRows([row({ raw_text_excerpt: "", normalized_total_price: 25000 })])[0]!;
    expect(diagnosed.reason_buckets).toContain("insufficient_debug_evidence");
  });
});

describe("JALAN-AUTO03R - plans and outputs", () => {
  const summary = summarizeExclusions(diagnoseRows(validateAuto03xArtifact(loadAuto03x()).rows));

  it("produces classifier policy audit", () => {
    expect(buildClassifierPolicyAudit(summary).finding).toContain("All 13");
  });

  it("produces extractor improvement plan", () => {
    expect(buildExtractorImprovementPlan().improvements).toContain("Split coupon/member/point/discount evidence into selected_price_block flags and generic_page_text flags.");
  });

  it("produces future AUTO03B plan", () => {
    expect(buildFutureAuto03bPlan().phase).toBe("JALAN-AUTO03B");
  });

  it("JSON includes required top-level keys by construction", () => {
    const keys = [
      "run_id",
      "generated_at_jst",
      "decision",
      "source_auto03x_summary",
      "row_level_diagnosis",
      "price_detected_excluded_rows",
      "exclusion_reason_summary",
      "classifier_policy_audit",
      "evidence_review_summary",
      "proposed_classification_fix",
      "extractor_improvement_plan",
      "future_auto03b_plan",
      "safety_confirmation",
      "next_phase"
    ];
    expect(keys).toContain("proposed_classification_fix");
  });

  it("report includes proposed classification fix", () => {
    const report = renderReport({
      generatedAtJst: "2026-06-04T23:30:00+09:00",
      decision: "jalan_probe_result_review_ready",
      sourceAuto03xArtifact: "auto03x.json",
      summary,
      policyAudit: buildClassifierPolicyAudit(summary),
      proposedFix: buildProposedClassificationFix(),
      extractorPlan: buildExtractorImprovementPlan(),
      futurePlan: buildFutureAuto03bPlan(),
      safety: buildSafetyConfirmation()
    });
    expect(report).toContain("Proposed Classification Fix");
  });

  it("renders CSV", () => {
    expect(renderDiagnosisCsv(diagnoseRows([row()]))).toContain("recommended_action");
  });

  it("decision ready/basis_caution/not_ready", () => {
    expect(decideJalanProbeResultReview({ validAuto03x: true, summary })).toBe("jalan_probe_result_review_ready");
    expect(decideJalanProbeResultReview({ validAuto03x: false, summary })).toBe("jalan_probe_result_review_not_ready");
  });
});

describe("JALAN-AUTO03R - safety scans", () => {
  it("No live fetch code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/\bfetch\s*\(|goto\s*\(/u);
  });

  it("No Playwright/browser automation code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/from\s+["']playwright|chromium|newPage|browser\.launch/u);
  });

  it("No history write code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/appendHistory|realHistoryAppend|writeHistory|\.data\/history\/zao_signals/u);
  });

  it("No DB write code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/INSERT INTO|DELETE FROM|UPDATE market_signal|db\.prepare\(.*(insert|delete|update)/iu);
  });

  it("No DB sync code exists", () => {
    expect(PACKAGE_JSON).toContain("review:jalan-probe-result");
    expect(SCRIPT_SOURCE).not.toContain("real-run:history-to-db-sync");
  });

  it("No AI context refresh code exists", () => {
    expect(SCRIPT_SOURCE).not.toContain("build:ai-context-packs");
  });

  it("No price update / PMS output code exists", () => {
    expect(SERVICE_SOURCE + SCRIPT_SOURCE).not.toMatch(/Beds24|AirHost|pricing CSV|generatePricing|approvePricing/u);
  });
});
