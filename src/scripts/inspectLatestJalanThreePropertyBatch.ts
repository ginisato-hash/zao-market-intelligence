import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";

interface BatchAttemptRow {
  run_id: string;
  job_id: string;
  property_id: string;
  property_name: string | null;
  stay_date: string;
  outcome: string;
  availability_status: string | null;
  price_total_tax_included: number | null;
  error_reason: string | null;
  screenshot_path: string | null;
  debug_json_path: string | null;
}

interface CountRow {
  count: number;
}

export interface ThreePropertyInspectRow {
  propertyName: string;
  stayDate: string;
  availabilityStatus: string | null;
  persistedPrice: number | null;
  attemptOutcome: string;
  errorReason: string | null;
  screenshotPath: string | null;
  debugJsonPath: string | null;
}

export interface ThreePropertyInspectSummary {
  collectorRunId: string;
  propertyCount: number;
  dateCount: number;
  availableCount: number;
  failedCount: number;
  soldOutCount: number;
  notListedCount: number;
  attemptCount: number;
  rows: ThreePropertyInspectRow[];
}

export function findLatestThreePropertyBatchRunId(db: LocalDatabase): string | undefined {
  const row = db
    .prepare(
      `SELECT run_id
       FROM collection_job_attempts
       GROUP BY run_id
       HAVING COUNT(DISTINCT property_id) >= 3
       ORDER BY MAX(attempted_at_jst) DESC
       LIMIT 1`
    )
    .get() as { run_id: string } | undefined;
  return row?.run_id;
}

export function loadBatchAttemptRows(db: LocalDatabase, runId: string): BatchAttemptRow[] {
  return db
    .prepare(
      `SELECT
         a.run_id,
         a.job_id,
         a.property_id,
         p.name AS property_name,
         a.stay_date,
         a.outcome,
         a.availability_status,
         a.price_total_tax_included,
         a.error_reason,
         a.screenshot_path,
         a.debug_json_path
       FROM collection_job_attempts a
       LEFT JOIN properties p ON p.id = a.property_id
       WHERE a.run_id = ?
       ORDER BY a.property_id ASC, a.stay_date ASC`
    )
    .all(runId) as BatchAttemptRow[];
}

export function buildThreePropertyInspectSummary(
  runId: string,
  rows: BatchAttemptRow[]
): ThreePropertyInspectSummary {
  const propertyIds = new Set(rows.map((r) => r.property_id));
  const dates = new Set(rows.map((r) => r.stay_date));

  const inspectRows: ThreePropertyInspectRow[] = rows.map((r) => ({
    propertyName: r.property_name ?? r.property_id,
    stayDate: r.stay_date,
    availabilityStatus: r.availability_status,
    persistedPrice: r.price_total_tax_included,
    attemptOutcome: r.outcome,
    errorReason: r.error_reason,
    screenshotPath: r.screenshot_path,
    debugJsonPath: r.debug_json_path
  }));

  return {
    collectorRunId: runId,
    propertyCount: propertyIds.size,
    dateCount: dates.size,
    availableCount: rows.filter((r) => r.availability_status === "available").length,
    failedCount: rows.filter((r) => r.availability_status === "failed").length,
    soldOutCount: rows.filter((r) => r.availability_status === "sold_out").length,
    notListedCount: rows.filter((r) => r.availability_status === "not_listed").length,
    attemptCount: rows.length,
    rows: inspectRows
  };
}

export function buildThreePropertyInspectOutput(summary: ThreePropertyInspectSummary): string {
  if (summary.rows.length === 0) {
    return "latest_jalan_three_property_batch=none";
  }

  const lines = [
    `collector_run_id=${summary.collectorRunId}`,
    `property_count=${summary.propertyCount}`,
    `date_count=${summary.dateCount}`,
    `attempt_count=${summary.attemptCount}`,
    `available_count=${summary.availableCount}`,
    `failed_count=${summary.failedCount}`,
    `sold_out_count=${summary.soldOutCount}`,
    `not_listed_count=${summary.notListedCount}`,
    "---",
    "property | stay_date | status | persisted_price | attempt_outcome | error_reason"
  ];

  for (const row of summary.rows) {
    lines.push(
      `${row.propertyName} | ${row.stayDate} | ${row.availabilityStatus ?? "null"} | ${row.persistedPrice ?? "null"} | ${row.attemptOutcome} | ${row.errorReason ?? "null"}`
    );
  }

  const rowsWithScreenshot = summary.rows.filter((r) => r.screenshotPath !== null);
  if (rowsWithScreenshot.length > 0) {
    lines.push("---");
    lines.push("paths:");
    for (const row of rowsWithScreenshot) {
      lines.push(`  ${row.propertyName} ${row.stayDate} screenshot=${row.screenshotPath}`);
    }
  }

  const rowsWithDebug = summary.rows.filter((r) => r.debugJsonPath !== null);
  if (rowsWithDebug.length > 0) {
    if (rowsWithScreenshot.length === 0) {
      lines.push("---");
      lines.push("paths:");
    }
    for (const row of rowsWithDebug) {
      lines.push(`  ${row.propertyName} ${row.stayDate} debug=${row.debugJsonPath}`);
    }
  }

  return lines.join("\n");
}

export function inspectLatestJalanThreePropertyBatch(db: LocalDatabase): string {
  executeMigration(db);

  const totalCount = (
    db.prepare("SELECT COUNT(*) AS count FROM collection_job_attempts").get() as CountRow
  ).count;

  if (totalCount === 0) {
    return "no_collection_job_attempts_found";
  }

  const runId = findLatestThreePropertyBatchRunId(db);
  if (runId === undefined) {
    return "no_three_property_batch_found";
  }

  const rows = loadBatchAttemptRows(db, runId);
  return buildThreePropertyInspectOutput(buildThreePropertyInspectSummary(runId, rows));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openLocalDatabase();
  try {
    console.log(inspectLatestJalanThreePropertyBatch(db));
  } finally {
    closeDatabase(db);
  }
}
