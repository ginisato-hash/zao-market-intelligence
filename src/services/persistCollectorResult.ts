import type { CollectorResult, CollectorRun } from "../domain/types";
import type { LocalDatabase } from "../db/client";
import { runInTransaction } from "../db/client";
import { insertCollectorRunIfNeeded } from "../db/repositories/collectorRunsRepository";
import { insertInventorySnapshot } from "../db/repositories/inventorySnapshotsRepository";
import { ensureProperty, propertyExists } from "../db/repositories/propertiesRepository";
import { insertRateSnapshot } from "../db/repositories/rateSnapshotsRepository";

export function persistCollectorResult(db: LocalDatabase, result: CollectorResult): void {
  runInTransaction(db, () => {
    if (!propertyExists(db, result.rateSnapshot.propertyId)) {
      ensureProperty(db, result.rateSnapshot.propertyId);
    }
    insertCollectorRunIfNeeded(db, collectorRunFromResult(result));
    insertRateSnapshot(db, result.rateSnapshot);
    insertInventorySnapshot(db, result.inventorySnapshot);
  });
}

function collectorRunFromResult(result: CollectorResult): CollectorRun {
  return {
    id: result.rateSnapshot.runId,
    ota: result.rateSnapshot.ota,
    startedAtJst: result.rateSnapshot.checkedAtJst,
    finishedAtJst: result.rateSnapshot.checkedAtJst,
    status: "completed",
    createdAt: result.rateSnapshot.createdAt
  };
}
