import { describe, expect, it } from "vitest";
import { buildCollectionJobAttempt } from "../src/services/recordCollectionJobAttempt";
import type { CollectorInput, CollectorResult } from "../src/domain/types";

function makeInput(overrides: Partial<CollectorInput> = {}): CollectorInput {
  return {
    runId: "run_test",
    propertyId: "property_test",
    propertyName: "ル・ベール蔵王",
    ota: "jalan",
    stayDate: "2026-08-08",
    guests: 2,
    nights: 1,
    jobId: "jalan_multi_date_2026-08-08",
    ...overrides
  };
}

function makeResult(
  availabilityStatus: string,
  priceTotalTaxIncluded: number | null,
  errorReason?: string
): CollectorResult {
  return {
    rateSnapshot: {
      id: "rate_test",
      runId: "run_test",
      propertyId: "property_test",
      ota: "jalan",
      stayDate: "2026-08-08",
      guests: 2,
      nights: 1,
      priceJpy: priceTotalTaxIncluded,
      priceTotalTaxIncluded,
      availabilityStatus: availabilityStatus as never,
      confidence: priceTotalTaxIncluded !== null ? "B" : "C",
      checkedAtJst: "2026-05-28T10:00:00+09:00",
      screenshotKey: ".data/screenshots/test.png",
      ...(errorReason !== undefined && { errorReason }),
      createdAt: "2026-05-28T10:00:00+09:00"
    },
    inventorySnapshot: {
      id: "inv_test",
      runId: "run_test",
      propertyId: "property_test",
      ota: "jalan",
      stayDate: "2026-08-08",
      availabilityStatus: availabilityStatus as never,
      confidence: "B",
      checkedAtJst: "2026-05-28T10:00:00+09:00",
      createdAt: "2026-05-28T10:00:00+09:00"
    }
  };
}

describe("buildCollectionJobAttempt", () => {
  it("maps available to outcome success and preserves price", () => {
    const attempt = buildCollectionJobAttempt(makeInput(), makeResult("available", 25000));

    expect(attempt.outcome).toBe("success");
    expect(attempt.availabilityStatus).toBe("available");
    expect(attempt.priceTotalTaxIncluded).toBe(25000);
    expect(attempt.errorReason).toBeNull();
  });

  it("maps sold_out to outcome success with no price", () => {
    const attempt = buildCollectionJobAttempt(makeInput(), makeResult("sold_out", null));

    expect(attempt.outcome).toBe("success");
    expect(attempt.availabilityStatus).toBe("sold_out");
    expect(attempt.priceTotalTaxIncluded).toBeNull();
  });

  it("maps not_listed to outcome success with no price", () => {
    const attempt = buildCollectionJobAttempt(makeInput(), makeResult("not_listed", null));

    expect(attempt.outcome).toBe("success");
    expect(attempt.priceTotalTaxIncluded).toBeNull();
  });

  it("maps not_found to outcome success with no price", () => {
    const attempt = buildCollectionJobAttempt(makeInput(), makeResult("not_found", null));

    expect(attempt.outcome).toBe("success");
    expect(attempt.priceTotalTaxIncluded).toBeNull();
  });

  it("maps failed to outcome failed and preserves error reason", () => {
    const attempt = buildCollectionJobAttempt(
      makeInput(),
      makeResult("failed", null, "price_basis_or_date_scope_unclear")
    );

    expect(attempt.outcome).toBe("failed");
    expect(attempt.availabilityStatus).toBe("failed");
    expect(attempt.priceTotalTaxIncluded).toBeNull();
    expect(attempt.errorReason).toBe("price_basis_or_date_scope_unclear");
  });

  it("maps failed with blocked error reason to outcome blocked", () => {
    const attempt = buildCollectionJobAttempt(
      makeInput(),
      makeResult("failed", null, "Jalan page appears blocked or challenged access.")
    );

    expect(attempt.outcome).toBe("blocked");
    expect(attempt.priceTotalTaxIncluded).toBeNull();
  });

  it("maps failed with captcha in error reason to outcome blocked", () => {
    const attempt = buildCollectionJobAttempt(
      makeInput(),
      makeResult("failed", null, "booking_com_blocked_captcha")
    );

    expect(attempt.outcome).toBe("blocked");
  });

  it("does not carry price for available status when price is null", () => {
    const attempt = buildCollectionJobAttempt(makeInput(), makeResult("available", null));

    expect(attempt.priceTotalTaxIncluded).toBeNull();
  });

  it("uses jobId from CollectorInput", () => {
    const attempt = buildCollectionJobAttempt(makeInput(), makeResult("available", 25000));

    expect(attempt.jobId).toBe("jalan_multi_date_2026-08-08");
  });

  it("derives fallback jobId when input.jobId is undefined", () => {
    const { jobId: _omitted, ...rest } = makeInput();
    const input = rest as CollectorInput;
    const attempt = buildCollectionJobAttempt(input, makeResult("available", 25000));

    expect(attempt.jobId).toContain("property_test");
    expect(attempt.jobId).toContain("jalan");
    expect(attempt.jobId).toContain("2026-08-08");
  });

  it("includes screenshotPath from rateSnapshot.screenshotKey", () => {
    const attempt = buildCollectionJobAttempt(makeInput(), makeResult("available", 25000));

    expect(attempt.screenshotPath).toBe(".data/screenshots/test.png");
  });

  it("includes debugJsonPath from options", () => {
    const attempt = buildCollectionJobAttempt(makeInput(), makeResult("available", 25000), {
      debugJsonPath: ".data/debug/jalan/run_test/2026-08-08.json"
    });

    expect(attempt.debugJsonPath).toBe(".data/debug/jalan/run_test/2026-08-08.json");
  });

  it("defaults retryCount to 0", () => {
    const attempt = buildCollectionJobAttempt(makeInput(), makeResult("available", 25000));
    expect(attempt.retryCount).toBe(0);
  });

  it("preserves explicit retryCount from options", () => {
    const attempt = buildCollectionJobAttempt(makeInput(), makeResult("available", 25000), { retryCount: 2 });
    expect(attempt.retryCount).toBe(2);
  });
});
