// Phase ZMI-MKT-OBS01 — collector run manifest + duplicate suppression (pure). §11/§21.
//
// Duplicate suppression is scoped to RETRY duplicates within the same
// collector run — collector_run_id + property + stay_date + product + rate +
// search_context. Two genuinely separate runs (the AM pass and the PM pass,
// or a retried run hours later) producing the SAME observed values are NOT
// duplicates: they are two real, distinct time-series points and must both
// be kept (§11: "raw responseが同一でも別時刻の正規観測は保持").
//
// No I/O, no network.

import type { MarketObservationRow } from "./marketObservationSchema";

export interface RunManifest {
  runId: string;
  startedAt: string;
  completedAt: string;
  source: string;
  propertiesRequested: number;
  stayDatesRequested: number;
  successfulObservations: number;
  failedObservations: number;
  parseFailures: number;
  duplicatesSuppressed: number;
  requestCount: number;
  rateLimitEvents: number;
}

export function buildRunManifest(input: {
  runId: string;
  startedAt: string;
  completedAt: string;
  source: string;
  propertiesRequested: number;
  stayDatesRequested: number;
  rows: readonly MarketObservationRow[];
  failedCount: number;
  parseFailureCount: number;
  duplicatesSuppressed: number;
  requestCount: number;
  rateLimitEvents: number;
}): RunManifest {
  return {
    runId: input.runId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    source: input.source,
    propertiesRequested: input.propertiesRequested,
    stayDatesRequested: input.stayDatesRequested,
    successfulObservations: input.rows.length,
    failedObservations: input.failedCount,
    parseFailures: input.parseFailureCount,
    duplicatesSuppressed: input.duplicatesSuppressed,
    requestCount: input.requestCount,
    rateLimitEvents: input.rateLimitEvents
  };
}

// §11 duplicate identity: collector_run_id + property + stay_date + product +
// rate + search_context. NOT observed_at, NOT price/availability — a retry
// within the SAME run that re-observes the identical cell is the only thing
// this suppresses.
function retryDuplicateKey(row: MarketObservationRow): string {
  return [
    row.collectorRunId,
    row.propertyId,
    row.sourcePlatform,
    row.stayDate,
    row.roomProductKey,
    row.ratePlanKey,
    row.searchAdults,
    row.searchChildren,
    row.searchRooms,
    row.lengthOfStay,
    row.currency
  ].join("|");
}

export interface DuplicateSuppressionResult {
  kept: MarketObservationRow[];
  suppressedCount: number;
}

// Keeps the FIRST occurrence per key within the given row list (a single
// run's output) — a later retry attempt inside the same run never overwrites
// or duplicates the earlier one.
export function suppressRetryDuplicates(rows: readonly MarketObservationRow[]): DuplicateSuppressionResult {
  const seen = new Set<string>();
  const kept: MarketObservationRow[] = [];
  let suppressedCount = 0;
  for (const row of rows) {
    const key = retryDuplicateKey(row);
    if (seen.has(key)) {
      suppressedCount += 1;
      continue;
    }
    seen.add(key);
    kept.push(row);
  }
  return { kept, suppressedCount };
}
