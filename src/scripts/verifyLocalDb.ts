import { closeDatabase, executeMigration, openLocalDatabase } from "../db/client";
import { verifyLocalDb } from "../db/verify";

const db = openLocalDatabase();

try {
  executeMigration(db);
  const result = verifyLocalDb(db);

  console.log(`collector_runs_count=${result.collectorRunsCount}`);
  console.log(`rate_snapshots_count=${result.rateSnapshotsCount}`);
  console.log(`inventory_snapshots_count=${result.inventorySnapshotsCount}`);
  console.log(`count_by_availability_status=${JSON.stringify(result.availabilityCounts)}`);
  console.log(`failed_rows_with_error_reason_count=${result.failedRowsWithErrorReasonCount}`);
  console.log(`invalid_unavailable_price_count=${result.invalidUnavailablePriceCount}`);
  console.log(`collection_job_attempts_count=${result.collectionJobAttemptsCount}`);
  console.log(`invalid_attempt_price_count=${result.invalidAttemptPriceCount}`);
  console.log(`attempts_missing_error_reason_count=${result.attemptsMissingErrorReasonCount}`);

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`verification_error=${error}`);
    }
    process.exitCode = 1;
  }
} finally {
  closeDatabase(db);
}
