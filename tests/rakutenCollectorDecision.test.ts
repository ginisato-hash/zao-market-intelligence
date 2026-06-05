import { describe, expect, it } from "vitest";
import { decideRakutenCollectorResult } from "../src/collectors/rakutenCollectorDecision";
import type { RakutenExtractionEvidence } from "../src/collectors/rakutenEvidence";

describe("Rakuten collector decision", () => {
  it("accepts available only with scoped total-tax-included evidence", () => {
    const decision = decideRakutenCollectorResult(evidence(), { status: "failed", errorReason: "rakuten_status_unclear" });

    expect(decision.status).toBe("available");
    expect(decision.priceJpy).toBe(24000);
  });

  it("keeps sold_out and not_listed explicit statuses", () => {
    expect(decideRakutenCollectorResult(evidence(), { status: "sold_out" }).status).toBe("sold_out");
    expect(decideRakutenCollectorResult(evidence(), { status: "not_listed" }).status).toBe("not_listed");
  });

  it("reports rakuten_plan_url_404_not_found when status detection identifies 404", () => {
    const decision = decideRakutenCollectorResult(
      {
        stayDate: "2026-08-08",
        selectedDateEvidenceFound: true,
        availabilityMarkerFound: false,
        priceFound: false,
        priceBasis: "unknown",
        confidence: "low",
        rejectionReason: "availability_marker_not_found"
      },
      { status: "failed", errorReason: "rakuten_plan_url_404_not_found" }
    );

    expect(decision.status).toBe("failed");
    expect(decision.errorReason).toBe("rakuten_plan_url_404_not_found");
  });

  it("fails when evidence is unclear", () => {
    const decision = decideRakutenCollectorResult(
      {
        stayDate: "2026-08-08",
        selectedDateEvidenceFound: true,
        availabilityMarkerFound: true,
        availabilityMarkerText: "空室",
        priceFound: false,
        priceBasis: "unknown",
        confidence: "low",
        rejectionReason: "total_tax_included_price_not_found"
      },
      { status: "failed", errorReason: "rakuten_status_unclear" }
    );

    expect(decision.status).toBe("failed");
    expect(decision.priceJpy).toBeNull();
    expect(decision.errorReason).toBe("total_tax_included_price_not_found");
  });
});

function evidence(): RakutenExtractionEvidence {
  return {
    stayDate: "2026-08-08",
    selectedDateEvidenceFound: true,
    availabilityMarkerFound: true,
    availabilityMarkerText: "空室",
    priceFound: true,
    priceValue: 24000,
    priceText: "24,000円",
    priceBasis: "total_tax_included",
    confidence: "high"
  };
}
