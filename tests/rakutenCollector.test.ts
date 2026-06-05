import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildRakutenCollectorResult } from "../src/collectors/rakutenCollector";
import { writeRakutenDebugArtifact } from "../src/collectors/rakutenDebugArtifact";
import type { CollectorInput } from "../src/domain/types";

function makeInput(overrides: Partial<CollectorInput> = {}): CollectorInput {
  return {
    runId: "run_test",
    propertyId: "property_test",
    propertyName: "蔵王温泉 ル・ベール蔵王",
    ota: "rakuten",
    propertyUrl: "https://travel.rakuten.co.jp/HOTEL/29465/",
    stayDate: "2026-08-08",
    guests: 2,
    adults: 2,
    rooms: 1,
    nights: 1,
    jobId: "rakuten_prototype_2026-08-08",
    ...overrides
  };
}

describe("buildRakutenCollectorResult", () => {
  it("available decision maps to available status with price", () => {
    const result = buildRakutenCollectorResult(makeInput(), { status: "available", priceJpy: 18000 });

    expect(result.rateSnapshot.availabilityStatus).toBe("available");
    expect(result.rateSnapshot.priceTotalTaxIncluded).toBe(18000);
    expect(result.rateSnapshot.priceJpy).toBe(18000);
    expect(result.rateSnapshot.confidence).toBe("B");
    expect(result.rateSnapshot.errorReason).toBeUndefined();
  });

  it("available decision with null price falls back to failed", () => {
    const result = buildRakutenCollectorResult(makeInput(), { status: "available", priceJpy: null });

    expect(result.rateSnapshot.availabilityStatus).toBe("failed");
    expect(result.rateSnapshot.priceTotalTaxIncluded).toBeNull();
    expect(result.rateSnapshot.errorReason).toBeDefined();
  });

  it("sold_out decision maps correctly with no price", () => {
    const result = buildRakutenCollectorResult(makeInput(), { status: "sold_out", priceJpy: null });

    expect(result.rateSnapshot.availabilityStatus).toBe("sold_out");
    expect(result.rateSnapshot.priceTotalTaxIncluded).toBeNull();
    expect(result.rateSnapshot.confidence).toBe("C");
  });

  it("failed decision preserves error_reason", () => {
    const result = buildRakutenCollectorResult(makeInput(), {
      status: "failed",
      priceJpy: null,
      errorReason: "rakuten_access_blocked_or_captcha"
    });

    expect(result.rateSnapshot.availabilityStatus).toBe("failed");
    expect(result.rateSnapshot.errorReason).toBe("rakuten_access_blocked_or_captcha");
    expect(result.rateSnapshot.priceTotalTaxIncluded).toBeNull();
  });

  it("failed decision without explicit errorReason gets default", () => {
    const result = buildRakutenCollectorResult(makeInput(), { status: "failed", priceJpy: null });

    expect(result.rateSnapshot.errorReason).toBeDefined();
    expect(result.rateSnapshot.errorReason?.length).toBeGreaterThan(0);
  });

  it("not_listed decision maps correctly", () => {
    const result = buildRakutenCollectorResult(makeInput(), { status: "not_listed", priceJpy: null });

    expect(result.rateSnapshot.availabilityStatus).toBe("not_listed");
    expect(result.rateSnapshot.priceTotalTaxIncluded).toBeNull();
  });

  it("screenshotPath is set on rateSnapshot.screenshotKey when provided", () => {
    const result = buildRakutenCollectorResult(
      makeInput(),
      { status: "available", priceJpy: 18000 },
      ".data/screenshots/test.png"
    );

    expect(result.rateSnapshot.screenshotKey).toBe(".data/screenshots/test.png");
  });

  it("screenshotPath is absent when not provided", () => {
    const result = buildRakutenCollectorResult(makeInput(), { status: "available", priceJpy: 18000 });

    expect(result.rateSnapshot.screenshotKey).toBeUndefined();
  });

  it("ota is always rakuten on both snapshots", () => {
    const result = buildRakutenCollectorResult(makeInput(), { status: "available", priceJpy: 18000 });

    expect(result.rateSnapshot.ota).toBe("rakuten");
    expect(result.inventorySnapshot.ota).toBe("rakuten");
  });

  it("inventory snapshot matches rate snapshot status", () => {
    const result = buildRakutenCollectorResult(makeInput(), { status: "sold_out", priceJpy: null });

    expect(result.inventorySnapshot.availabilityStatus).toBe(result.rateSnapshot.availabilityStatus);
  });
});

describe("writeRakutenDebugArtifact", () => {
  it("writes rakutenAccessStrategy to the debug JSON file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rakuten-debug-test-"));
    const runId = "run_debug_test";

    // We can't override .data/debug path directly, but we can verify the return path
    // and that the file contains the strategy by writing to the default path then reading it back.
    // Since this is a side-effect test, we accept writing to .data/debug/rakuten/<runId>/
    const writtenPath = await writeRakutenDebugArtifact({
      runId,
      propertyName: "テストホテル",
      propertyUrl: "https://travel.rakuten.co.jp/HOTEL/99999/",
      attemptUrl: "https://travel.rakuten.co.jp/HOTEL/99999/PLAN/?f_checkin_date=2026%2F08%2F08",
      stayDate: "2026-08-08",
      status: "failed",
      evidence: {
        stayDate: "2026-08-08",
        selectedDateEvidenceFound: true,
        availabilityMarkerFound: false,
        priceFound: false,
        priceBasis: "unknown",
        confidence: "low",
        rejectionReason: "rakuten_plan_results_not_reached"
      },
      selectedPrice: null,
      errorReason: "rakuten_plan_results_not_reached",
      rakutenAccessStrategy: {
        attemptedUrl: "https://travel.rakuten.co.jp/HOTEL/99999/?f_checkin_date=2026%2F08%2F08",
        strategy: "overview_url_without_click",
        searchInteraction: {
          attempted: false,
          success: false,
          strategy: "not_attempted",
          beforeUrl: ""
        },
        reachedPlanResults: false,
        finalUrl: "https://travel.rakuten.co.jp/HOTEL/99999/?f_checkin_date=2026%2F08%2F08",
        rejectionReason: "rakuten_plan_results_not_reached"
      },
      rakutenFormInspection: {
        inspected: true,
        searchButtonCandidates: [{ text: "検索", tagName: "button" }],
        dateFieldCandidates: [],
        guestFieldCandidates: [],
        visibleSignals: ["date_not_set", "select_count:2"]
      }
    });

    const contents = JSON.parse(await readFile(writtenPath, "utf8")) as Record<string, unknown>;

    expect(contents["rakutenAccessStrategy"]).toBeDefined();
    const strategy = contents["rakutenAccessStrategy"] as Record<string, unknown>;
    expect(strategy["strategy"]).toBe("overview_url_without_click");
    expect(strategy["reachedPlanResults"]).toBe(false);
    expect(strategy["rejectionReason"]).toBe("rakuten_plan_results_not_reached");

    expect(contents["rakutenFormInspection"]).toBeDefined();
    const inspection = contents["rakutenFormInspection"] as Record<string, unknown>;
    expect(inspection["inspected"]).toBe(true);
    expect(Array.isArray(inspection["dateFieldCandidates"])).toBe(true);
    expect(Array.isArray(inspection["visibleSignals"])).toBe(true);
  });
});
