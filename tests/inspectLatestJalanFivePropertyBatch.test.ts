import { describe, expect, it } from "vitest";
import {
  buildFivePropertyInspectOutput,
  buildFivePropertyInspectSummary
} from "../src/scripts/inspectLatestJalanFivePropertyBatch";

describe("inspectLatestJalanFivePropertyBatch", () => {
  it("prints matrix rows for mixed available and failed attempts", () => {
    const output = buildFivePropertyInspectOutput(
      buildFivePropertyInspectSummary("run_test", [
        row("Property A", "property_a", "2026-07-18", "available", 20000, "success"),
        row("Property B", "property_b", "2026-07-18", "failed", null, "failed", "price_basis_or_date_scope_unclear")
      ])
    );

    expect(output).toContain("property | stay_date | status | persisted_price | selected_policy_price | attempt_outcome | error_reason | warnings");
    expect(output).toContain("Property A | 2026-07-18 | available | 20000");
    expect(output).toContain("Property B | 2026-07-18 | failed | null");
    expect(output).toContain("failed_count=1");
  });
});

function row(
  propertyName: string,
  propertyId: string,
  stayDate: string,
  status: "available" | "failed",
  price: number | null,
  outcome: "success" | "failed",
  errorReason: string | null = null
) {
  return {
    run_id: "run_test",
    property_id: propertyId,
    property_name: propertyName,
    stay_date: stayDate,
    outcome,
    availability_status: status,
    price_total_tax_included: price,
    error_reason: errorReason,
    screenshot_path: `.data/screenshots/${propertyId}.png`,
    debug_json_path: null
  };
}
