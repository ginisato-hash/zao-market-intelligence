import { describe, expect, it } from "vitest";
import {
  buildCoverageUpdateFromFeasibility,
  buildSourceFeasibilityResult,
  isActiveForFeasibilityStatus,
  mapFeasibilityToCoverageStatus,
  type SourceFeasibilityStatus
} from "../src/services/sourceFeasibilityResult";

const ALL_STATUSES: SourceFeasibilityStatus[] = [
  "confirmed",
  "needs_review",
  "not_found",
  "blocked",
  "captcha",
  "login_required",
  "unsupported"
];

describe("sourceFeasibilityResult", () => {
  it("marks only confirmed and needs_review as active", () => {
    const active = ALL_STATUSES.filter((status) => isActiveForFeasibilityStatus(status));
    expect(active).toEqual(["confirmed", "needs_review"]);
  });

  it("maps feasibility status one-to-one to coverage status", () => {
    for (const status of ALL_STATUSES) {
      const result = buildSourceFeasibilityResult({
        source: "rakuten",
        propertyName: "ル・ベール蔵王",
        classification: { status, accessStatus: "x", notes: "y" },
        checkedAtJst: "2026-05-29T12:00:00+09:00"
      });
      expect(mapFeasibilityToCoverageStatus(result)).toBe(status);
    }
  });

  it("never sets a price in the result", () => {
    const result = buildSourceFeasibilityResult({
      source: "rakuten",
      propertyName: "ル・ベール蔵王",
      sourcePropertyId: "29465",
      propertyUrl: "https://travel.rakuten.co.jp/HOTEL/29465/",
      classification: { status: "needs_review", accessStatus: "date_write_reflected", notes: "ok" },
      checkedAtJst: "2026-05-29T12:00:00+09:00"
    });
    expect(result.safePriceExtracted).toBe(false);
    expect(result.priceTotalTaxIncluded).toBeNull();
  });

  it("builds a coverage update with no propertyId and no price, active derived from status", () => {
    const result = buildSourceFeasibilityResult({
      source: "booking",
      propertyName: "ル・ベール蔵王",
      sourcePropertyId: "le-vert-zao",
      propertyUrl: "https://www.booking.com/hotel/jp/le-vert-zao.ja.html",
      classification: { status: "blocked", accessStatus: "empty_or_near_empty_body", notes: "blocked" },
      checkedAtJst: "2026-05-29T12:00:00+09:00"
    });
    const update = buildCoverageUpdateFromFeasibility(result);

    expect(update).not.toHaveProperty("propertyId");
    expect(update).not.toHaveProperty("priceTotalTaxIncluded");
    expect(update.coverageStatus).toBe("blocked");
    expect(update.active).toBe(false);
    expect(update.lastVerifiedAt).toBe("2026-05-29T12:00:00+09:00");
    expect(update.sourcePropertyId).toBe("le-vert-zao");
  });
});
