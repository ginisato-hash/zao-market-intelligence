import type { CollectorInput, CollectorResult } from "../domain/types";

export interface MarketCollector {
  collect(input: CollectorInput): Promise<CollectorResult[]>;
}

export type { CollectorInput, CollectorResult };
