import { describe, expect, it } from "vitest";
import type { JalanExtractionEvidence } from "../src/collectors/jalanEvidence";
import { decideJalanCollectorResult } from "../src/collectors/jalanCollectorDecision";

const baseEvidence: JalanExtractionEvidence = {
  stayDate: "2026-08-08",
  availabilityMarkerFound: true,
  availabilityMarkerText: "○",
  priceFound: true,
  priceValue: 12000,
  priceText: "合計 税込12,000円",
  priceBasis: "total_tax_included",
  surroundingText: "2026年8月8日 宿泊プラン 合計 税込12,000円",
  selectedDateTextFound: true,
  confidence: "high"
};

describe("decideJalanCollectorResult", () => {
  it("accepts medium or high confidence scoped total price", () => {
    expect(decideJalanCollectorResult(baseEvidence, { status: "failed" })).toEqual({
      status: "available",
      priceJpy: 12000
    });
    expect(decideJalanCollectorResult({ ...baseEvidence, confidence: "medium" }, { status: "failed" })).toEqual({
      status: "available",
      priceJpy: 12000
    });
  });

  it("rejects low confidence evidence", () => {
    const decision = decideJalanCollectorResult({ ...baseEvidence, confidence: "low" }, { status: "failed" });

    expect(decision.status).toBe("failed");
    expect(decision.priceJpy).toBeNull();
  });

  it("rejects non-total price basis", () => {
    const decision = decideJalanCollectorResult(
      { ...baseEvidence, priceBasis: "per_person_tax_included" },
      { status: "failed" }
    );

    expect(decision.status).toBe("failed");
    expect(decision.errorReason).toBe("price_basis_or_date_scope_unclear");
  });
});
