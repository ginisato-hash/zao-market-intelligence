import { describe, expect, it } from "vitest";
import {
  buildDateReport,
  buildJalanMultiDateInspectOutput,
  type JalanMultiDateInspectRow
} from "../src/scripts/inspectLatestJalanMultiDateRun";
import type { JalanDebugJson } from "../src/scripts/inspectLatestJalanRun";

describe("latest Jalan multi-date inspection", () => {
  it("handles mixed available and failed dates", () => {
    const reports = [
      buildDateReport(row("2026-08-08", "available", 25000, null), ".data/debug/jalan/run_test/2026-08-08.json", debug(25000)),
      buildDateReport(row("2026-08-15", "failed", null, "selected_date_not_found"), ".data/debug/jalan/run_test/2026-08-15.json", null)
    ];
    const output = buildJalanMultiDateInspectOutput(reports);

    expect(output).toContain("date_count=2");
    expect(output).toContain("property_name=ル・ベール蔵王");
    expect(output).toContain("stay_date | status | persisted_price | selected_policy_price | plan | room | error_reason | warnings");
    expect(output).toContain("2026-08-08 | available | 25000");
    expect(output).toContain("| none");
    expect(output).toContain("2026-08-15 | failed | null");
    expect(output).toContain("acceptedPricePolicy_missing");
  });
});

function row(
  stayDate: string,
  availabilityStatus: string,
  priceTotalTaxIncluded: number | null,
  errorReason: string | null
): JalanMultiDateInspectRow {
  return {
    collectorRunId: "run_test",
    propertyName: "ル・ベール蔵王",
    propertyUrl: "https://www.jalan.net/yad328232/",
    ota: "jalan",
    stayDate,
    availabilityStatus,
    priceTotalTaxIncluded,
    screenshotPath: `.data/screenshots/${stayDate}.png`,
    errorReason,
    createdAt: "2026-05-28 19:00:00"
  };
}

function debug(selectedPrice: number): JalanDebugJson {
  return {
    acceptedPricePolicy: {
      policy: "cheapest_total_tax_included_safe_plan",
      safeCandidateCount: 2,
      rejectedCandidateCount: 1,
      selectedIndex: 1,
      selectedPrice,
      selectedPlanName: "素泊まり",
      selectedRoomName: "和室",
      reason: "selected_lowest_total_tax_included_safe_plan"
    }
  };
}
