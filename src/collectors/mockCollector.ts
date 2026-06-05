import type { MarketCollector } from "./types";
import type { AvailabilityStatus, CollectorInput, CollectorResult, Confidence } from "../domain/types";
import { formatJstDateTime } from "../utils/date";
import { createId } from "../utils/ids";

const SAMPLE_CASES: Array<{
  status: AvailabilityStatus;
  confidence: Confidence;
  priceJpy: number | null;
  errorReason?: string;
  rawTextExcerpt: string;
}> = [
  {
    status: "available",
    confidence: "B",
    priceJpy: 22000,
    rawTextExcerpt: "Mock OTA listing available for requested stay date."
  },
  {
    status: "sold_out",
    confidence: "B",
    priceJpy: null,
    rawTextExcerpt: "Mock OTA listing shows sold out."
  },
  {
    status: "not_listed",
    confidence: "C",
    priceJpy: null,
    rawTextExcerpt: "Mock OTA source does not list this property."
  },
  {
    status: "failed",
    confidence: "C",
    priceJpy: null,
    errorReason: "Mock collector simulated a failed collection attempt.",
    rawTextExcerpt: "Mock collector recorded a failed collection attempt."
  }
];

export class MockCollector implements MarketCollector {
  async collect(input: CollectorInput): Promise<CollectorResult[]> {
    const checkedAtJst = formatJstDateTime(new Date("2026-01-01T00:00:00.000Z"));

    return SAMPLE_CASES.map((sample, index) => ({
      rateSnapshot: {
        id: createId("rate"),
        runId: input.runId,
        propertyId: input.propertyId,
        ota: "mock",
        stayDate: input.stayDate,
        guests: input.guests,
        nights: input.nights,
        priceJpy: sample.priceJpy,
        priceTotalTaxIncluded: sample.priceJpy,
        availabilityStatus: sample.status,
        confidence: sample.confidence,
        checkedAtJst,
        screenshotKey: `mock/${input.runId}/${sample.status}.png`,
        rawTextExcerpt: sample.rawTextExcerpt,
        ...(sample.errorReason === undefined ? {} : { errorReason: sample.errorReason }),
        createdAt: checkedAtJst
      },
      inventorySnapshot: {
        id: createId("inventory"),
        runId: input.runId,
        propertyId: input.propertyId,
        ota: "mock",
        stayDate: input.stayDate,
        availabilityStatus: sample.status,
        confidence: sample.confidence,
        checkedAtJst,
        createdAt: checkedAtJst
      }
    }));
  }
}
