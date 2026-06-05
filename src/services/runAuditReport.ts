import type { LocalDatabase } from "../db/client";

// ─── Public types ────────────────────────────────────────────────────────────

export type AuditAvailabilityStatus =
  | "available"
  | "failed"
  | "sold_out"
  | "not_listed"
  | "not_found";

export type AuditAttemptOutcome =
  | "success"
  | "failed"
  | "blocked"
  | "skipped";

export type RunAuditRow = {
  runId: string;
  source: string;
  propertyId: string;
  propertyName: string;
  stayDate: string;
  priority: string | null;
  availabilityStatus: AuditAvailabilityStatus;
  attemptOutcome: AuditAttemptOutcome | null;
  persistedPrice: number | null;
  selectedPolicyPrice: number | null;
  priceBasis: string | null;
  errorReason: string | null;
  screenshotPath: string | null;
  debugJsonPath: string | null;
  warnings: string[];
};

export type RunAuditSummary = {
  runId: string;
  source: string;
  rowCount: number;
  countByAvailabilityStatus: Record<string, number>;
  countByAttemptOutcome: Record<string, number>;
  invalidUnavailablePriceCount: number;
  missingErrorReasonCount: number;
  mismatchWarningCount: number;
  rows: RunAuditRow[];
};

// ─── Internal DB row shape ────────────────────────────────────────────────────

interface RawAuditDbRow {
  runId: string;
  source: string;
  propertyId: string;
  propertyName: string;
  stayDate: string;
  priority: string | null;
  availabilityStatus: string;
  persistedPrice: number | null;
  errorReason: string | null;
  attemptOutcome: string | null;
  selectedPolicyPrice: number | null;
  attemptErrorReason: string | null;
  screenshotPath: string | null;
  debugJsonPath: string | null;
}

// ─── Warning generation ───────────────────────────────────────────────────────

function buildWarnings(row: RawAuditDbRow): string[] {
  const warnings: string[] = [];

  // Unavailable row that has a non-null price persisted — schema should prevent this,
  // but if it slips through it is a data integrity issue.
  if (row.availabilityStatus !== "available" && row.persistedPrice !== null) {
    warnings.push("unavailable_row_has_price");
  }

  // Failed or blocked attempt with no error reason in the job attempt record.
  // (rate_snapshots enforce error_reason IS NOT NULL for 'failed' status via DB constraint;
  // the job attempt record has no such constraint and may be missing the reason.)
  if (
    (row.attemptOutcome === "failed" || row.attemptOutcome === "blocked") &&
    row.attemptErrorReason === null
  ) {
    warnings.push("failed_attempt_missing_error_reason");
  }

  // Price in rate_snapshot differs from price in collection_job_attempt.
  if (
    row.persistedPrice !== null &&
    row.selectedPolicyPrice !== null &&
    row.persistedPrice !== row.selectedPolicyPrice
  ) {
    warnings.push(
      `price_mismatch:rate_snapshot=${row.persistedPrice},attempt=${row.selectedPolicyPrice}`
    );
  }

  // Real (non-skipped) attempt has no screenshot path.
  if (
    row.attemptOutcome !== null &&
    row.attemptOutcome !== "skipped" &&
    row.screenshotPath === null
  ) {
    warnings.push("missing_screenshot_path");
  }

  // Real (non-skipped) attempt has no debug JSON path.
  if (
    row.attemptOutcome !== null &&
    row.attemptOutcome !== "skipped" &&
    row.debugJsonPath === null
  ) {
    warnings.push("missing_debug_json_path");
  }

  return warnings;
}

// ─── Public functions ─────────────────────────────────────────────────────────

/** Returns the most recent collector_run id (by started_at_jst), or undefined. */
export function findLatestRunId(db: LocalDatabase): string | undefined {
  const row = db
    .prepare(
      "SELECT id FROM collector_runs ORDER BY started_at_jst DESC, rowid DESC LIMIT 1"
    )
    .get() as { id: string } | undefined;
  return row?.id;
}

/** Builds a source-agnostic audit report for a given run. */
export function buildRunAuditReport(
  db: LocalDatabase,
  runId: string
): RunAuditSummary {
  // Verify the run exists.
  const run = db
    .prepare("SELECT id, ota FROM collector_runs WHERE id = ?")
    .get(runId) as { id: string; ota: string } | undefined;

  if (run === undefined) {
    return {
      runId,
      source: "unknown",
      rowCount: 0,
      countByAvailabilityStatus: {},
      countByAttemptOutcome: {},
      invalidUnavailablePriceCount: 0,
      missingErrorReasonCount: 0,
      mismatchWarningCount: 0,
      rows: []
    };
  }

  const rawRows = db
    .prepare(
      `SELECT
         rs.run_id          AS runId,
         cr.ota             AS source,
         rs.property_id     AS propertyId,
         COALESCE(p.name, rs.property_id) AS propertyName,
         rs.stay_date       AS stayDate,
         td.priority        AS priority,
         rs.availability_status AS availabilityStatus,
         rs.price_total_tax_included AS persistedPrice,
         rs.error_reason    AS errorReason,
         cja.outcome        AS attemptOutcome,
         cja.price_total_tax_included AS selectedPolicyPrice,
         cja.error_reason   AS attemptErrorReason,
         cja.screenshot_path AS screenshotPath,
         cja.debug_json_path AS debugJsonPath
       FROM rate_snapshots rs
       JOIN collector_runs cr ON cr.id = rs.run_id
       LEFT JOIN properties p ON p.id = rs.property_id
       LEFT JOIN target_dates td ON td.stay_date = rs.stay_date
       LEFT JOIN collection_job_attempts cja
         ON  cja.run_id      = rs.run_id
         AND cja.property_id = rs.property_id
         AND cja.ota         = rs.ota
         AND cja.stay_date   = rs.stay_date
       WHERE rs.run_id = ?
       ORDER BY rs.stay_date ASC, COALESCE(p.name, rs.property_id) ASC`
    )
    .all(runId) as RawAuditDbRow[];

  const rows: RunAuditRow[] = rawRows.map((raw) => {
    const warnings = buildWarnings(raw);
    return {
      runId:              raw.runId,
      source:             raw.source,
      propertyId:         raw.propertyId,
      propertyName:       raw.propertyName,
      stayDate:           raw.stayDate,
      priority:           raw.priority,
      availabilityStatus: raw.availabilityStatus as AuditAvailabilityStatus,
      attemptOutcome:     (raw.attemptOutcome ?? null) as AuditAttemptOutcome | null,
      persistedPrice:     raw.persistedPrice,
      selectedPolicyPrice: raw.selectedPolicyPrice,
      priceBasis:
        raw.availabilityStatus === "available" ? "total_tax_included" : null,
      errorReason:    raw.errorReason ?? raw.attemptErrorReason,
      screenshotPath: raw.screenshotPath,
      debugJsonPath:  raw.debugJsonPath,
      warnings
    };
  });

  // Aggregate counters.
  const countByAvailabilityStatus: Record<string, number> = {};
  const countByAttemptOutcome: Record<string, number> = {};
  let invalidUnavailablePriceCount = 0;
  let missingErrorReasonCount = 0;
  let mismatchWarningCount = 0;

  for (const row of rows) {
    countByAvailabilityStatus[row.availabilityStatus] =
      (countByAvailabilityStatus[row.availabilityStatus] ?? 0) + 1;

    if (row.attemptOutcome !== null) {
      countByAttemptOutcome[row.attemptOutcome] =
        (countByAttemptOutcome[row.attemptOutcome] ?? 0) + 1;
    }

    for (const w of row.warnings) {
      if (w === "unavailable_row_has_price") invalidUnavailablePriceCount += 1;
      if (w === "failed_attempt_missing_error_reason") missingErrorReasonCount += 1;
      if (w.startsWith("price_mismatch:")) mismatchWarningCount += 1;
    }
  }

  return {
    runId,
    source: run.ota,
    rowCount: rows.length,
    countByAvailabilityStatus,
    countByAttemptOutcome,
    invalidUnavailablePriceCount,
    missingErrorReasonCount,
    mismatchWarningCount,
    rows
  };
}
