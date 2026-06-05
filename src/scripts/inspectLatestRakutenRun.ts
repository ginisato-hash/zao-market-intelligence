import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";

interface RakutenRunRow {
  collectorRunId: string;
  propertyName: string;
  propertyUrl: string | null;
  stayDate: string;
  availabilityStatus: string;
  priceTotalTaxIncluded: number | null;
  errorReason: string | null;
  screenshotPath: string | null;
  createdAt: string;
}

interface AttemptRow {
  outcome: string;
  errorReason: string | null;
}

interface CountRow {
  count: number;
}

function findLatestRakutenRunRows(db: LocalDatabase): RakutenRunRow[] {
  const run = db
    .prepare(
      `SELECT run_id AS runId
       FROM rate_snapshots
       WHERE ota = 'rakuten'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get() as { runId: string } | undefined;

  if (run === undefined) {
    return [];
  }

  return db
    .prepare(
      `SELECT
         cr.id AS collectorRunId,
         COALESCE(p.name, rs.property_id) AS propertyName,
         pol.property_url AS propertyUrl,
         rs.stay_date AS stayDate,
         rs.availability_status AS availabilityStatus,
         rs.price_total_tax_included AS priceTotalTaxIncluded,
         rs.error_reason AS errorReason,
         rs.screenshot_key AS screenshotPath,
         rs.created_at AS createdAt
       FROM rate_snapshots rs
       JOIN collector_runs cr ON cr.id = rs.run_id
       LEFT JOIN properties p ON p.id = rs.property_id
       LEFT JOIN property_ota_links pol ON pol.property_id = rs.property_id AND pol.ota = rs.ota
       WHERE rs.run_id = ?
       ORDER BY rs.stay_date ASC`
    )
    .all(run.runId) as RakutenRunRow[];
}

function findAttemptForRow(db: LocalDatabase, runId: string, stayDate: string): AttemptRow | undefined {
  return db
    .prepare(
      `SELECT outcome, error_reason AS errorReason
       FROM collection_job_attempts
       WHERE run_id = ? AND stay_date = ? AND ota = 'rakuten'
       LIMIT 1`
    )
    .get(runId, stayDate) as AttemptRow | undefined;
}

export function buildRakutenInspectOutput(db: LocalDatabase, rows: RakutenRunRow[]): string {
  if (rows.length === 0) {
    return "no_rakuten_runs_found";
  }

  const runId = rows[0]?.collectorRunId ?? "unknown";
  const lines = [
    `collector_run_id=${runId}`,
    `property_name=${rows[0]?.propertyName ?? "unknown"}`,
    `property_url=${rows[0]?.propertyUrl ?? "unknown"}`,
    `date_count=${rows.length}`
  ];

  for (const row of rows) {
    const attempt = findAttemptForRow(db, runId, row.stayDate);
    const debugJsonPath = `.data/debug/rakuten/${runId}/${row.stayDate}.json`;

    lines.push("---");
    lines.push(`stay_date=${row.stayDate}`);
    lines.push(`availability_status=${row.availabilityStatus}`);
    lines.push(`persisted_price=${row.priceTotalTaxIncluded ?? "null"}`);
    lines.push(`error_reason=${row.errorReason ?? "null"}`);
    lines.push(`attempt_outcome=${attempt?.outcome ?? "not_found"}`);
    lines.push(`screenshot_path=${row.screenshotPath ?? "null"}`);
    lines.push(`debug_json_path=${debugJsonPath}`);
  }

  return lines.join("\n");
}

export function inspectLatestRakutenRun(db: LocalDatabase): string {
  executeMigration(db);

  const totalCount = (db.prepare("SELECT COUNT(*) AS count FROM rate_snapshots WHERE ota = 'rakuten'").get() as CountRow).count;
  if (totalCount === 0) {
    return "no_rakuten_runs_found";
  }

  const rows = findLatestRakutenRunRows(db);
  return buildRakutenInspectOutput(db, rows);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openLocalDatabase();
  try {
    console.log(inspectLatestRakutenRun(db));
  } finally {
    closeDatabase(db);
  }
}
