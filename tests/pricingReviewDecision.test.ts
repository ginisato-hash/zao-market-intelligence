import { describe, it, expect } from "vitest";
import {
  buildPricingReviewDecisionRow,
  normalizeReviewDecision,
  type RawReviewDecisionInput
} from "../src/services/pricingReviewDecision";

function rawInput(overrides: Partial<RawReviewDecisionInput> = {}): RawReviewDecisionInput {
  return {
    targetId: "sample_target",
    stayDate: "2026-08-08",
    recommendedPriceRaw: "18000",
    approvalStatus: "auto_approved",
    reviewDecisionRaw: "approved",
    reviewerNote: "",
    ...overrides
  };
}

describe("normalizeReviewDecision", () => {
  it("maps blank to pending", () => {
    expect(normalizeReviewDecision("")).toBe("pending");
    expect(normalizeReviewDecision("   ")).toBe("pending");
  });

  it("accepts the four allowed decisions case-insensitively", () => {
    expect(normalizeReviewDecision("approved")).toBe("approved");
    expect(normalizeReviewDecision("Rejected")).toBe("rejected");
    expect(normalizeReviewDecision("NEEDS_CHANGE")).toBe("needs_change");
    expect(normalizeReviewDecision("pending")).toBe("pending");
  });

  it("returns undefined for an invalid decision", () => {
    expect(normalizeReviewDecision("maybe")).toBeUndefined();
    expect(normalizeReviewDecision("yes")).toBeUndefined();
  });
});

describe("buildPricingReviewDecisionRow", () => {
  it("accepts a valid approved row with a price", () => {
    const result = buildPricingReviewDecisionRow(rawInput({ reviewDecisionRaw: "approved", recommendedPriceRaw: "18000" }));
    expect(result.errors).toHaveLength(0);
    expect(result.row?.reviewDecision).toBe("approved");
    expect(result.row?.recommendedPriceJpy).toBe(18000);
  });

  it("defaults a blank decision to pending", () => {
    const result = buildPricingReviewDecisionRow(rawInput({ reviewDecisionRaw: "" }));
    expect(result.errors).toHaveLength(0);
    expect(result.row?.reviewDecision).toBe("pending");
  });

  it("rejects an invalid decision", () => {
    const result = buildPricingReviewDecisionRow(rawInput({ reviewDecisionRaw: "maybe" }));
    expect(result.row).toBeUndefined();
    expect(result.errors.join(" ")).toContain("review_decision");
  });

  it("rejects approved with a null/blank price", () => {
    const result = buildPricingReviewDecisionRow(rawInput({ reviewDecisionRaw: "approved", recommendedPriceRaw: "" }));
    expect(result.row).toBeUndefined();
    expect(result.errors.join(" ")).toContain("approved decision requires");
  });

  it("allows rejected with a blank price", () => {
    const result = buildPricingReviewDecisionRow(rawInput({ reviewDecisionRaw: "rejected", recommendedPriceRaw: "" }));
    expect(result.errors).toHaveLength(0);
    expect(result.row?.reviewDecision).toBe("rejected");
    expect(result.row?.recommendedPriceJpy).toBeNull();
  });

  it("allows rejected with a non-null price", () => {
    const result = buildPricingReviewDecisionRow(rawInput({ reviewDecisionRaw: "rejected", recommendedPriceRaw: "9000" }));
    expect(result.errors).toHaveLength(0);
    expect(result.row?.recommendedPriceJpy).toBe(9000);
  });

  it("rejects needs_change with a blank reviewer_note", () => {
    const result = buildPricingReviewDecisionRow(rawInput({ reviewDecisionRaw: "needs_change", reviewerNote: "  " }));
    expect(result.row).toBeUndefined();
    expect(result.errors.join(" ")).toContain("needs_change decision requires");
  });

  it("accepts needs_change with a reviewer_note", () => {
    const result = buildPricingReviewDecisionRow(
      rawInput({ reviewDecisionRaw: "needs_change", reviewerNote: "raise floor price" })
    );
    expect(result.errors).toHaveLength(0);
    expect(result.row?.reviewDecision).toBe("needs_change");
  });

  it("rejects a non-integer price", () => {
    const result = buildPricingReviewDecisionRow(rawInput({ recommendedPriceRaw: "12000.5" }));
    expect(result.row).toBeUndefined();
    expect(result.errors.join(" ")).toContain("recommended_price_jpy");
  });

  it("rejects a non-numeric price", () => {
    const result = buildPricingReviewDecisionRow(rawInput({ recommendedPriceRaw: "abc" }));
    expect(result.row).toBeUndefined();
  });

  it("requires target_id and stay_date", () => {
    const result = buildPricingReviewDecisionRow(rawInput({ targetId: "", stayDate: "" }));
    expect(result.row).toBeUndefined();
    expect(result.errors.join(" ")).toContain("target_id is required");
    expect(result.errors.join(" ")).toContain("stay_date is required");
  });
});
