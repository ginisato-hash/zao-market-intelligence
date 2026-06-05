import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, openLocalDatabase } from "../src/db/client";
import type { CollectorInput, CollectorResult } from "../src/domain/types";
import { runJalanMultiDateDryRun, runJalanMultiDatePrototype } from "../src/scripts/runJalanMultiDatePrototype";

describe("Jalan multi-date runner", () => {
  it("dry-run does not write DB", () => {
    const summary = runJalanMultiDateDryRun();

    expect(summary.dryRun).toBe(true);
    expect(summary.plannedDates).toHaveLength(5);
  });

  it("processes dates sequentially with mockable delay and mixed results", async () => {
    const db = openLocalDatabase(join(mkdtempSync(join(tmpdir(), "jalan-multi-")), "test.sqlite"));
    const calls: string[] = [];
    const delays: number[] = [];
    try {
      const summary = await runJalanMultiDatePrototype(config(), {
        db,
        delay: async (ms) => {
          delays.push(ms);
        },
        collector: {
          async collect(input: CollectorInput): Promise<CollectorResult[]> {
            calls.push(input.stayDate);
            return [resultFor(input, input.stayDate === "2026-08-08" ? "available" : "failed")];
          }
        }
      });

      expect(calls).toEqual(["2026-07-18", "2026-08-08", "2026-08-15"]);
      expect(delays).toEqual([3000, 3000]);
      expect(summary.statusCounts.available).toBe(1);
      expect(summary.statusCounts.failed).toBe(2);
      expect(summary.acceptedPricesByDate["2026-08-08"]).toBe(25000);
      expect(summary.failedDates).toHaveLength(2);
      expect(summary.persistedRateSnapshots).toBe(3);
      expect(summary.persistedInventorySnapshots).toBe(3);
      expect(summary.crawlBudget).toEqual({
        maxAttempts: 3,
        actualAttempts: 3,
        delayMsBetweenAttempts: 3000,
        sequential: true
      });
      expect(summary.attemptedDateCount).toBe(3);
    } finally {
      closeDatabase(db);
    }
  });
});

function config() {
  return {
    ota: "jalan" as const,
    property_name: "ル・ベール蔵王",
    property_url: "https://www.jalan.net/yad328232/",
    stay_dates: ["2026-07-18", "2026-08-08", "2026-08-15"],
    adults: 2 as const,
    children: 0,
    rooms: 1 as const,
    nights: 1 as const,
    max_attempts: 3,
    delay_ms_between_attempts: 3000
  };
}

function resultFor(input: CollectorInput, status: "available" | "failed"): CollectorResult {
  const price = status === "available" ? 25000 : null;
  const checkedAtJst = "2026-05-28 19:00:00";
  return {
    rateSnapshot: {
      id: `rate_${input.stayDate}`,
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "jalan",
      stayDate: input.stayDate,
      guests: input.adults ?? input.guests,
      nights: input.nights,
      priceJpy: price,
      priceTotalTaxIncluded: price,
      availabilityStatus: status,
      confidence: price === null ? "C" : "B",
      checkedAtJst,
      screenshotKey: `.data/screenshots/${input.stayDate}.png`,
      rawTextExcerpt: status === "available" ? "selected policy price 25000" : "failed_reason",
      ...(status === "failed" ? { errorReason: "mock_failed" } : {}),
      createdAt: checkedAtJst
    },
    inventorySnapshot: {
      id: `inventory_${input.stayDate}`,
      runId: input.runId,
      propertyId: input.propertyId,
      ota: "jalan",
      stayDate: input.stayDate,
      availabilityStatus: status,
      confidence: price === null ? "C" : "B",
      checkedAtJst,
      createdAt: checkedAtJst
    }
  };
}
