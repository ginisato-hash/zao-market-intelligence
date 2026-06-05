import { closeDatabase, DEFAULT_LOCAL_DB_PATH, openLocalDatabase, type LocalDatabase } from "../db/client";
import { buildWarnings, loadJalanDebugJson, type JalanDebugJson, type LatestJalanRunRow } from "./inspectLatestJalanRun";

export interface JalanMultiDateInspectRow extends LatestJalanRunRow {
  propertyUrl: string | null;
  errorReason: string | null;
}

export interface JalanMultiDateInspectDateReport {
  propertyName: string;
  propertyUrl: string | null;
  stayDate: string;
  status: string;
  persistedPrice: number | null;
  acceptedPolicy: string;
  safeCandidateCount: number | string;
  selectedPrice: number | string;
  selectedPlanName: string;
  selectedRoomName: string;
  errorReason: string | null;
  screenshotPath: string | null;
  debugJsonPath: string;
  warnings: string[];
}

export function findLatestJalanMultiDateRunRows(db: LocalDatabase): JalanMultiDateInspectRow[] {
  const run = db
    .prepare(
      `SELECT run_id AS runId
       FROM rate_snapshots
       WHERE ota = 'jalan'
       GROUP BY run_id
       HAVING COUNT(*) > 1
       ORDER BY MAX(created_at) DESC
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
         rs.ota AS ota,
         rs.stay_date AS stayDate,
         rs.availability_status AS availabilityStatus,
         rs.price_total_tax_included AS priceTotalTaxIncluded,
         rs.screenshot_key AS screenshotPath,
         rs.error_reason AS errorReason,
         rs.created_at AS createdAt
       FROM rate_snapshots rs
       JOIN collector_runs cr ON cr.id = rs.run_id
       LEFT JOIN properties p ON p.id = rs.property_id
       LEFT JOIN property_ota_links pol ON pol.property_id = rs.property_id AND pol.ota = rs.ota
       WHERE rs.run_id = ?
       ORDER BY rs.stay_date ASC`
    )
    .all(run.runId) as JalanMultiDateInspectRow[];
}

export function buildJalanMultiDateInspectReports(rows: JalanMultiDateInspectRow[]): JalanMultiDateInspectDateReport[] {
  return rows.map((row) => {
    const debugJsonPath = `.data/debug/jalan/${row.collectorRunId}/${row.stayDate}.json`;
    const debugJson = loadJalanDebugJson(debugJsonPath);
    return buildDateReport(row, debugJsonPath, debugJson);
  });
}

export function buildDateReport(
  row: JalanMultiDateInspectRow,
  debugJsonPath: string,
  debugJson: JalanDebugJson | null
): JalanMultiDateInspectDateReport {
  const policy = debugJson?.acceptedPricePolicy;
  return {
    propertyName: row.propertyName,
    propertyUrl: row.propertyUrl,
    stayDate: row.stayDate,
    status: row.availabilityStatus,
    persistedPrice: row.priceTotalTaxIncluded,
    acceptedPolicy: policy?.policy ?? "missing",
    safeCandidateCount: policy?.safeCandidateCount ?? "missing",
    selectedPrice: policy?.selectedPrice ?? "null",
    selectedPlanName: policy?.selectedPlanName ?? "null",
    selectedRoomName: policy?.selectedRoomName ?? "null",
    errorReason: row.errorReason,
    screenshotPath: row.screenshotPath,
    debugJsonPath,
    warnings: buildWarnings(row, debugJson)
  };
}

export function buildJalanMultiDateInspectOutput(reports: JalanMultiDateInspectDateReport[]): string {
  if (reports.length === 0) {
    return "latest_jalan_multi_date_run=none";
  }

  const first = reports[0];
  const lines = [
    `collector_run_id=${first?.debugJsonPath.split("/")[3] ?? "unknown"}`,
    `property_name=${first?.propertyName ?? "unknown"}`,
    `property_url=${first?.propertyUrl ?? "unknown"}`,
    `date_count=${reports.length}`,
    `available_count=${reports.filter((report) => report.status === "available").length}`,
    `failed_count=${reports.filter((report) => report.status === "failed").length}`,
    "stay_date | status | persisted_price | selected_policy_price | plan | room | error_reason | warnings"
  ];

  for (const report of reports) {
    lines.push(
      `${report.stayDate} | ${report.status} | ${report.persistedPrice ?? "null"} | ${report.selectedPrice} | ${report.selectedPlanName} | ${report.selectedRoomName} | ${report.errorReason ?? "null"} | ${report.warnings.length === 0 ? "none" : report.warnings.join(",")}`
    );
  }
  lines.push("paths:");
  for (const report of reports) {
    lines.push(`  ${report.stayDate} screenshot=${report.screenshotPath ?? "null"} debug=${report.debugJsonPath}`);
  }

  return lines.join("\n");
}

export function inspectLatestJalanMultiDateRun(dbPath = DEFAULT_LOCAL_DB_PATH): string {
  const db = openLocalDatabase(dbPath);
  try {
    return buildJalanMultiDateInspectOutput(buildJalanMultiDateInspectReports(findLatestJalanMultiDateRunRows(db)));
  } finally {
    closeDatabase(db);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(inspectLatestJalanMultiDateRun());
}
