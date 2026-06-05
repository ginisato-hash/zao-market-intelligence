import { MockCollector } from "../collectors/mockCollector";
import { closeDatabase, executeMigration, openLocalDatabase } from "../db/client";
import { persistCollectorResult } from "../services/persistCollectorResult";
import { createRunId } from "../utils/ids";

const db = openLocalDatabase();

try {
  executeMigration(db);

  const runId = createRunId();
  const results = await new MockCollector().collect({
    runId,
    propertyId: "property_mock_zao_001",
    propertyName: "Mock Zao Onsen Property",
    ota: "mock",
    stayDate: "2026-02-01",
    guests: 2,
    nights: 1
  });

  for (const result of results) {
    persistCollectorResult(db, result);
  }

  const availabilityCounts = countByAvailability(results.map((result) => result.rateSnapshot.availabilityStatus));

  console.log("Persisted mock collector results");
  console.log(`collector_run_id=${runId}`);
  console.log(`inserted_rate_snapshot_count=${results.length}`);
  console.log(`inserted_inventory_snapshot_count=${results.length}`);
  console.log(`available_count=${availabilityCounts.available ?? 0}`);
  console.log(`sold_out_count=${availabilityCounts.sold_out ?? 0}`);
  console.log(`not_listed_count=${availabilityCounts.not_listed ?? 0}`);
  console.log(`failed_count=${availabilityCounts.failed ?? 0}`);
} finally {
  closeDatabase(db);
}

function countByAvailability(statuses: string[]): Record<string, number> {
  return statuses.reduce<Record<string, number>>((counts, status) => {
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}
