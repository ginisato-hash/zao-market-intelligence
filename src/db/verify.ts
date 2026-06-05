import type { LocalDatabase } from "./client";

export interface LocalDbVerification {
  collectorRunsCount: number;
  rateSnapshotsCount: number;
  inventorySnapshotsCount: number;
  availabilityCounts: Record<string, number>;
  failedRowsWithErrorReasonCount: number;
  invalidUnavailablePriceCount: number;
  failedRowsMissingErrorReasonCount: number;
  collectionJobAttemptsCount: number;
  invalidAttemptPriceCount: number;
  attemptsMissingErrorReasonCount: number;
  errors: string[];
}

interface CountRow {
  count: number;
}

interface AvailabilityCountRow {
  availability_status: string;
  count: number;
}

export function verifyLocalDb(db: LocalDatabase): LocalDbVerification {
  const collectorRunsCount = count(db, "SELECT COUNT(*) AS count FROM collector_runs");
  const rateSnapshotsCount = count(db, "SELECT COUNT(*) AS count FROM rate_snapshots");
  const inventorySnapshotsCount = count(db, "SELECT COUNT(*) AS count FROM inventory_snapshots");
  const failedRowsWithErrorReasonCount = count(
    db,
    `SELECT COUNT(*) AS count
     FROM rate_snapshots
     WHERE availability_status = 'failed'
       AND error_reason IS NOT NULL
       AND trim(error_reason) <> ''`
  );
  const invalidUnavailablePriceCount = count(
    db,
    `SELECT COUNT(*) AS count
     FROM rate_snapshots
     WHERE availability_status IN ('failed', 'sold_out', 'not_listed')
       AND price_total_tax_included IS NOT NULL`
  );
  const failedRowsMissingErrorReasonCount = count(
    db,
    `SELECT COUNT(*) AS count
     FROM rate_snapshots
     WHERE availability_status = 'failed'
       AND (error_reason IS NULL OR trim(error_reason) = '')`
  );

  const availabilityCounts = Object.fromEntries(
    db
      .prepare(
        `SELECT availability_status, COUNT(*) AS count
         FROM rate_snapshots
         GROUP BY availability_status
         ORDER BY availability_status`
      )
      .all()
      .map((row) => {
        const typed = row as AvailabilityCountRow;
        return [typed.availability_status, typed.count];
      })
  );

  const collectionJobAttemptsTableExists =
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collection_job_attempts'")
      .get() !== undefined;

  const collectionJobAttemptsCount = collectionJobAttemptsTableExists
    ? count(db, "SELECT COUNT(*) AS count FROM collection_job_attempts")
    : 0;

  const invalidAttemptPriceCount = collectionJobAttemptsTableExists
    ? count(
        db,
        `SELECT COUNT(*) AS count
         FROM collection_job_attempts
         WHERE availability_status <> 'available'
           AND price_total_tax_included IS NOT NULL`
      )
    : 0;

  const attemptsMissingErrorReasonCount = collectionJobAttemptsTableExists
    ? count(
        db,
        `SELECT COUNT(*) AS count
         FROM collection_job_attempts
         WHERE outcome IN ('failed', 'blocked')
           AND (error_reason IS NULL OR trim(error_reason) = '')`
      )
    : 0;

  const errors: string[] = [];
  if (invalidUnavailablePriceCount > 0) {
    errors.push("failed/sold_out/not_listed rows must not have price_total_tax_included");
  }
  if (failedRowsMissingErrorReasonCount > 0) {
    errors.push("failed rows must have error_reason");
  }
  if (invalidAttemptPriceCount > 0) {
    errors.push("collection_job_attempts: non-available rows must not have price_total_tax_included");
  }

  return {
    collectorRunsCount,
    rateSnapshotsCount,
    inventorySnapshotsCount,
    availabilityCounts,
    failedRowsWithErrorReasonCount,
    invalidUnavailablePriceCount,
    failedRowsMissingErrorReasonCount,
    collectionJobAttemptsCount,
    invalidAttemptPriceCount,
    attemptsMissingErrorReasonCount,
    errors
  };
}

function count(db: LocalDatabase, sql: string): number {
  return (db.prepare(sql).get() as CountRow).count;
}
