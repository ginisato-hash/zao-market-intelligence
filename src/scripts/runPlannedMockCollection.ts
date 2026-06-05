import type { CollectorResult } from "../domain/types";
import { MockCollector } from "../collectors/mockCollector";
import { closeDatabase, executeMigration, openLocalDatabase } from "../db/client";
import { buildPlannedCollectionJobs } from "../planner/runPlanner";
import { importPropertySeeds } from "../seeds/importPropertySeeds";
import { importTargetDateSeeds } from "../seeds/importTargetDateSeeds";
import { persistCollectorResult } from "../services/persistCollectorResult";
import { createRunId } from "../utils/ids";

const db = openLocalDatabase();

try {
  executeMigration(db);
  importPropertySeeds({ db });
  importTargetDateSeeds({ db });

  const jobs = buildPlannedCollectionJobs(db, { maxJobs: 10 });
  const runId = createRunId();
  const collector = new MockCollector();
  const persistedResults: CollectorResult[] = [];

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    if (job === undefined) {
      continue;
    }

    const mockResults = await collector.collect({
      runId,
      propertyId: job.property_id,
      propertyName: job.property_name,
      ota: "mock",
      stayDate: job.stay_date,
      guests: job.adults,
      nights: job.nights
    });
    const selectedResult = mockResults[index % mockResults.length];
    if (selectedResult === undefined) {
      continue;
    }

    persistCollectorResult(db, selectedResult);
    persistedResults.push(selectedResult);
  }

  const availabilityCounts = countBy(persistedResults.map((result) => result.rateSnapshot.availabilityStatus));

  console.log(`collector_run_id=${runId}`);
  console.log(`planned_jobs_count=${jobs.length}`);
  console.log(`executed_jobs_count=${persistedResults.length}`);
  console.log(`persisted_rate_snapshots=${persistedResults.length}`);
  console.log(`persisted_inventory_snapshots=${persistedResults.length}`);
  console.log(`availability_status_counts=${JSON.stringify(availabilityCounts)}`);
} finally {
  closeDatabase(db);
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
