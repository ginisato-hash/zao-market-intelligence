import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";

interface BatchAttemptRow {
  run_id: string;
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

interface InspectRow {
  propertyName: string;
  stayDate: string;
  availabilityStatus: string | null;
  persistedPrice: number | null;
  selectedPolicyPrice: number | null;
  attemptOutcome: string;
  errorReason: string | null;
  warning: string | null;
  screenshotPath: string | null;
  debugJsonPath: string | null;
}

export interface JalanFivePropertyInspectSummary {
  collectorRunId: string;
  propertyCount: number;
  dateCount: number;
  availableCount: number;
  failedCount: number;
  soldOutCount: number;
  notListedCount: number;
  attemptCount: number;
  mismatchWarnings: number;
  rows: InspectRow[];
}

export function findLatestFivePropertyBatchRunId(db: LocalDatabase): string | undefined {
  const row = db
    .prepare(
      `SELECT run_id
       FROM collection_job_attempts
       GROUP BY run_id
       HAVING COUNT(DISTINCT property_id) >= 5 AND COUNT(*) >= 15
       ORDER BY MAX(attempted_at_jst) DESC
       LIMIT 1`
    )
    .get() as { run_id: string } | undefined;
  return row?.run_id;
}

export function loadFivePropertyAttemptRows(db: LocalDatabase, runId: string): BatchAttemptRow[] {
  return db
    .prepare(
      `SELECT
         a.run_id,
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
       ORDER BY p.name ASC, a.stay_date ASC`
    )
    .all(runId) as BatchAttemptRow[];
}

export function buildFivePropertyInspectSummary(
  runId: string,
  rows: BatchAttemptRow[]
): JalanFivePropertyInspectSummary {
  const inspectRows: InspectRow[] = rows.map((row) => {
    const selectedPolicyPrice = readSelectedPolicyPrice(row.debug_json_path);
    const warning =
      row.price_total_tax_included !== null &&
      selectedPolicyPrice !== null &&
      row.price_total_tax_included !== selectedPolicyPrice
        ? "persisted_price_policy_mismatch"
        : null;

    return {
      propertyName: row.property_name ?? row.property_id,
      stayDate: row.stay_date,
      availabilityStatus: row.availability_status,
      persistedPrice: row.price_total_tax_included,
      selectedPolicyPrice,
      attemptOutcome: row.outcome,
      errorReason: row.error_reason,
      warning,
      screenshotPath: row.screenshot_path,
      debugJsonPath: row.debug_json_path
    };
  });

  return {
    collectorRunId: runId,
    propertyCount: new Set(rows.map((row) => row.property_id)).size,
    dateCount: new Set(rows.map((row) => row.stay_date)).size,
    availableCount: rows.filter((row) => row.availability_status === "available").length,
    failedCount: rows.filter((row) => row.availability_status === "failed").length,
    soldOutCount: rows.filter((row) => row.availability_status === "sold_out").length,
    notListedCount: rows.filter((row) => row.availability_status === "not_listed").length,
    attemptCount: rows.length,
    mismatchWarnings: inspectRows.filter((row) => row.warning !== null).length,
    rows: inspectRows
  };
}

export function buildFivePropertyInspectOutput(summary: JalanFivePropertyInspectSummary): string {
  if (summary.rows.length === 0) return "latest_jalan_five_property_batch=none";

  const lines = [
    `collector_run_id=${summary.collectorRunId}`,
    `property_count=${summary.propertyCount}`,
    `date_count=${summary.dateCount}`,
    `attempt_count=${summary.attemptCount}`,
    `available_count=${summary.availableCount}`,
    `failed_count=${summary.failedCount}`,
    `sold_out_count=${summary.soldOutCount}`,
    `not_listed_count=${summary.notListedCount}`,
    `mismatch_warnings=${summary.mismatchWarnings}`,
    "---",
    "property | stay_date | status | persisted_price | selected_policy_price | attempt_outcome | error_reason | warnings"
  ];

  for (const row of summary.rows) {
    lines.push(
      `${row.propertyName} | ${row.stayDate} | ${row.availabilityStatus ?? "null"} | ${row.persistedPrice ?? "null"} | ${row.selectedPolicyPrice ?? "null"} | ${row.attemptOutcome} | ${row.errorReason ?? "null"} | ${row.warning ?? "none"}`
    );
  }

  lines.push("---");
  lines.push("paths:");
  for (const row of summary.rows) {
    lines.push(`  ${row.propertyName} ${row.stayDate} screenshot=${row.screenshotPath ?? "null"}`);
    lines.push(`  ${row.propertyName} ${row.stayDate} debug=${row.debugJsonPath ?? "null"}`);
  }

  return lines.join("\n");
}

export function inspectLatestJalanFivePropertyBatch(db: LocalDatabase): string {
  executeMigration(db);
  const runId = findLatestFivePropertyBatchRunId(db);
  if (runId === undefined) return "no_five_property_batch_found";
  return buildFivePropertyInspectOutput(buildFivePropertyInspectSummary(runId, loadFivePropertyAttemptRows(db, runId)));
}

function readSelectedPolicyPrice(debugJsonPath: string | null): number | null {
  if (debugJsonPath === null) return null;
  const path = resolve(debugJsonPath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      acceptedPricePolicy?: { selectedPrice?: number };
    };
    return typeof parsed.acceptedPricePolicy?.selectedPrice === "number"
      ? parsed.acceptedPricePolicy.selectedPrice
      : null;
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openLocalDatabase();
  try {
    console.log(inspectLatestJalanFivePropertyBatch(db));
  } finally {
    closeDatabase(db);
  }
}
