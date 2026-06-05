import type { CollectionJobAttempt, CollectionJobAttemptOutcome, AvailabilityStatus, OtaSource } from "../../domain/types";
import type { LocalDatabase } from "../client";

interface CollectionJobAttemptRow {
  id: string;
  job_id: string;
  run_id: string;
  property_id: string;
  ota: OtaSource;
  stay_date: string;
  guests: number;
  nights: number;
  attempted_at_jst: string;
  outcome: CollectionJobAttemptOutcome;
  availability_status: AvailabilityStatus | null;
  price_total_tax_included: number | null;
  error_reason: string | null;
  screenshot_path: string | null;
  debug_json_path: string | null;
  retry_count: number;
  created_at: string;
}

function rowToAttempt(row: CollectionJobAttemptRow): CollectionJobAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    runId: row.run_id,
    propertyId: row.property_id,
    ota: row.ota,
    stayDate: row.stay_date,
    guests: row.guests,
    nights: row.nights,
    attemptedAtJst: row.attempted_at_jst,
    outcome: row.outcome,
    availabilityStatus: row.availability_status,
    priceTotalTaxIncluded: row.price_total_tax_included,
    errorReason: row.error_reason,
    screenshotPath: row.screenshot_path,
    debugJsonPath: row.debug_json_path,
    retryCount: row.retry_count,
    createdAt: row.created_at
  };
}

// Uses INSERT OR IGNORE: duplicate (job_id, run_id) pairs are silently dropped.
// This is intentional — the same job should not produce two attempt rows within
// one run, and idempotent inserts are safer for any retry scenario.
export function insertCollectionJobAttempt(db: LocalDatabase, attempt: CollectionJobAttempt): void {
  db.prepare(
    `INSERT OR IGNORE INTO collection_job_attempts (
      id,
      job_id,
      run_id,
      property_id,
      ota,
      stay_date,
      guests,
      nights,
      attempted_at_jst,
      outcome,
      availability_status,
      price_total_tax_included,
      error_reason,
      screenshot_path,
      debug_json_path,
      retry_count
    )
    VALUES (
      @id,
      @jobId,
      @runId,
      @propertyId,
      @ota,
      @stayDate,
      @guests,
      @nights,
      @attemptedAtJst,
      @outcome,
      @availabilityStatus,
      @priceTotalTaxIncluded,
      @errorReason,
      @screenshotPath,
      @debugJsonPath,
      @retryCount
    )`
  ).run({
    id: attempt.id,
    jobId: attempt.jobId,
    runId: attempt.runId,
    propertyId: attempt.propertyId,
    ota: attempt.ota,
    stayDate: attempt.stayDate,
    guests: attempt.guests,
    nights: attempt.nights,
    attemptedAtJst: attempt.attemptedAtJst,
    outcome: attempt.outcome,
    availabilityStatus: attempt.availabilityStatus ?? null,
    priceTotalTaxIncluded: attempt.priceTotalTaxIncluded ?? null,
    errorReason: attempt.errorReason ?? null,
    screenshotPath: attempt.screenshotPath ?? null,
    debugJsonPath: attempt.debugJsonPath ?? null,
    retryCount: attempt.retryCount
  });
}

export function listCollectionJobAttemptsByRun(db: LocalDatabase, runId: string): CollectionJobAttempt[] {
  return db
    .prepare(
      `SELECT * FROM collection_job_attempts
       WHERE run_id = ?
       ORDER BY attempted_at_jst ASC`
    )
    .all(runId)
    .map((row) => rowToAttempt(row as CollectionJobAttemptRow));
}

export function getLatestCollectionJobAttempt(db: LocalDatabase, jobId: string): CollectionJobAttempt | undefined {
  const row = db
    .prepare(
      `SELECT * FROM collection_job_attempts
       WHERE job_id = ?
       ORDER BY attempted_at_jst DESC
       LIMIT 1`
    )
    .get(jobId);
  return row === undefined ? undefined : rowToAttempt(row as CollectionJobAttemptRow);
}

export function countCollectionJobAttempts(db: LocalDatabase): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM collection_job_attempts").get() as { count: number };
  return row.count;
}
