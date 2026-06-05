import { describe, expect, it } from "vitest";
import { buildLatestJalanRunReport, buildWarnings, type JalanDebugJson, type LatestJalanRunRow } from "../src/scripts/inspectLatestJalanRun";
import { selectAcceptedJalanPriceCandidate } from "../src/collectors/jalanAcceptedPricePolicy";
import type { JalanPlanBlockCandidate } from "../src/collectors/jalanPlanBlockExtractor";

describe("latest Jalan run inspection", () => {
  it("detects matching persisted price and selected policy price", () => {
    const report = buildLatestJalanRunReport({
      row: row({ priceTotalTaxIncluded: 25000, availabilityStatus: "available" }),
      debugJsonPath: ".data/debug/jalan/run_test/2026-08-08.json",
      debugJson: debugJson({ selectedPrice: 25000 })
    });

    expect(report).toContain("persisted_price_total_tax_included=25000");
    expect(report).toContain("selected_price=25000");
    expect(report).toContain("warnings=none");
  });

  it("detects mismatch between persisted price and selected policy price", () => {
    const warnings = buildWarnings(row({ priceTotalTaxIncluded: 37000 }), debugJson({ selectedPrice: 25000 }));

    expect(warnings).toContain("persisted_price_mismatch_selected_policy_price");
  });

  it("handles missing debug JSON gracefully", () => {
    const report = buildLatestJalanRunReport({
      row: row({ priceTotalTaxIncluded: 25000 }),
      debugJsonPath: ".data/debug/jalan/missing/2026-08-08.json",
      debugJson: null
    });

    expect(report).toContain("accepted_policy=missing");
    expect(report).toContain("warning=acceptedPricePolicy_missing");
  });

  it("keeps accepted price policy behavior after cleanup", () => {
    const selection = selectAcceptedJalanPriceCandidate(
      [candidate(37000), { ...candidate(12000), rejectionReason: "block_not_tightly_scoped" }, candidate(25000)],
      "cheapest_total_tax_included_safe_plan"
    );

    expect(selection.selectedCandidate?.priceValue).toBe(25000);
    expect(selection.selectedIndex).toBe(2);
    expect(selection.safeCandidateCount).toBe(2);
  });
});

function row(overrides: Partial<LatestJalanRunRow>): LatestJalanRunRow {
  return {
    collectorRunId: "run_test",
    propertyName: "ル・ベール蔵王",
    ota: "jalan",
    stayDate: "2026-08-08",
    availabilityStatus: "available",
    priceTotalTaxIncluded: 25000,
    screenshotPath: ".data/screenshots/test.png",
    createdAt: "2026-05-28 19:00:00",
    ...overrides
  };
}

function debugJson(overrides: Partial<NonNullable<JalanDebugJson["acceptedPricePolicy"]>>): JalanDebugJson {
  return {
    acceptedPricePolicy: {
      policy: "cheapest_total_tax_included_safe_plan",
      safeCandidateCount: 2,
      rejectedCandidateCount: 1,
      selectedIndex: 1,
      selectedPrice: 25000,
      selectedPriceText: "25,000円",
      selectedPlanName: "素泊まりプラン",
      selectedRoomName: "◇和室7.5畳◆禁煙",
      reason: "selected_lowest_total_tax_included_safe_plan",
      ...overrides
    },
    planBlockExtraction: {
      topCandidates: [
        {
          planName: "夕食付きプラン",
          roomName: "◆ツイン◆禁煙",
          priceValue: 37000,
          priceBasis: "total_tax_included",
          confidence: "high"
        },
        {
          planName: "素泊まりプラン",
          roomName: "◇和室7.5畳◆禁煙",
          priceValue: 25000,
          priceBasis: "total_tax_included",
          confidence: "high"
        }
      ]
    }
  };
}

function candidate(priceValue: number): JalanPlanBlockCandidate {
  return {
    blockText: `宿泊プラン 部屋タイプ・詳細 合計(税込) ${priceValue.toLocaleString()}円`,
    planName: `plan-${priceValue}`,
    roomName: "◆ツイン◆禁煙",
    priceText: `${priceValue.toLocaleString()}円`,
    priceValue,
    priceBasis: "total_tax_included",
    hasTotalTaxIncludedEvidence: true,
    hasStayConditionEvidence: true,
    hasPlanOrRoomEvidence: true,
    confidence: "high"
  };
}
