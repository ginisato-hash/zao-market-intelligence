import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, DEFAULT_LOCAL_DB_PATH, openLocalDatabase, type LocalDatabase } from "../db/client";

export interface LatestJalanRunRow {
  collectorRunId: string;
  propertyName: string;
  ota: string;
  stayDate: string;
  availabilityStatus: string;
  priceTotalTaxIncluded: number | null;
  screenshotPath: string | null;
  createdAt: string;
}

export interface InspectReportInput {
  row: LatestJalanRunRow;
  debugJsonPath: string;
  debugJson: JalanDebugJson | null;
}

export interface JalanDebugJson {
  acceptedPricePolicy?: {
    policy?: string;
    safeCandidateCount?: number;
    rejectedCandidateCount?: number;
    selectedIndex?: number;
    selectedPrice?: number;
    selectedPriceText?: string;
    selectedPlanName?: string;
    selectedRoomName?: string;
    reason?: string;
  };
  planBlockExtraction?: {
    topCandidates?: Array<{
      planName?: string;
      roomName?: string;
      priceText?: string;
      priceValue?: number;
      priceBasis?: string;
      confidence?: string;
      rejectionReason?: string;
    }>;
  };
}

export function findLatestJalanRunRow(db: LocalDatabase): LatestJalanRunRow | null {
  const row = db
    .prepare(
      `SELECT
         cr.id AS collectorRunId,
         COALESCE(p.name, rs.property_id) AS propertyName,
         rs.ota AS ota,
         rs.stay_date AS stayDate,
         rs.availability_status AS availabilityStatus,
         rs.price_total_tax_included AS priceTotalTaxIncluded,
         rs.screenshot_key AS screenshotPath,
         rs.created_at AS createdAt
       FROM rate_snapshots rs
       JOIN collector_runs cr ON cr.id = rs.run_id
       LEFT JOIN properties p ON p.id = rs.property_id
       WHERE rs.ota = 'jalan'
       ORDER BY rs.created_at DESC, cr.started_at_jst DESC
       LIMIT 1`
    )
    .get() as LatestJalanRunRow | undefined;

  return row ?? null;
}

export function loadJalanDebugJson(path: string): JalanDebugJson | null {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as JalanDebugJson;
}

export function buildLatestJalanRunReport(input: InspectReportInput): string {
  const policy = input.debugJson?.acceptedPricePolicy;
  const warnings = buildWarnings(input.row, input.debugJson);
  const lines = [
    `latest_collector_run_id=${input.row.collectorRunId}`,
    `property_name=${input.row.propertyName}`,
    `ota=${input.row.ota}`,
    `stay_date=${input.row.stayDate}`,
    `persisted_availability_status=${input.row.availabilityStatus}`,
    `persisted_price_total_tax_included=${input.row.priceTotalTaxIncluded ?? "null"}`,
    `persisted_price_basis=${input.row.priceTotalTaxIncluded === null ? "null" : "total_tax_included"}`,
    `screenshot_path=${input.row.screenshotPath ?? "null"}`,
    `debug_json_path=${input.debugJsonPath}`,
    `accepted_policy=${policy?.policy ?? "missing"}`,
    `safe_candidate_count=${policy?.safeCandidateCount ?? "missing"}`,
    `rejected_candidate_count=${policy?.rejectedCandidateCount ?? "missing"}`,
    `selected_index=${policy?.selectedIndex ?? "null"}`,
    `selected_price=${policy?.selectedPrice ?? "null"}`,
    `selected_plan_name=${policy?.selectedPlanName ?? "null"}`,
    `selected_room_name=${policy?.selectedRoomName ?? "null"}`,
    `selection_reason=${policy?.reason ?? "missing"}`,
    "top_candidates:"
  ];

  const topCandidates = input.debugJson?.planBlockExtraction?.topCandidates ?? [];
  if (topCandidates.length === 0) {
    lines.push("  none");
  } else {
    topCandidates.forEach((candidate, index) => {
      lines.push(
        `  ${index + 1}. price=${candidate.priceValue ?? "null"} basis=${candidate.priceBasis ?? "unknown"} confidence=${candidate.confidence ?? "unknown"} plan=${candidate.planName ?? "null"} room=${candidate.roomName ?? "null"} rejection=${candidate.rejectionReason ?? "none"}`
      );
    });
  }

  if (warnings.length === 0) {
    lines.push("warnings=none");
  } else {
    for (const warning of warnings) {
      lines.push(`warning=${warning}`);
    }
  }

  return lines.join("\n");
}

export function buildWarnings(row: LatestJalanRunRow, debugJson: JalanDebugJson | null): string[] {
  const warnings: string[] = [];
  const policy = debugJson?.acceptedPricePolicy;
  if (debugJson === null || policy === undefined) {
    warnings.push("acceptedPricePolicy_missing");
    return warnings;
  }

  const persistedPrice = row.priceTotalTaxIncluded ?? null;
  const selectedPrice = policy.selectedPrice ?? null;
  if (persistedPrice !== selectedPrice) {
    warnings.push("persisted_price_mismatch_selected_policy_price");
  }
  if (row.availabilityStatus === "available" && policy.selectedPrice === undefined) {
    warnings.push("available_status_without_policy_selected_price");
  }

  return warnings;
}

export function inspectLatestJalanRun(dbPath = DEFAULT_LOCAL_DB_PATH): string {
  const db = openLocalDatabase(dbPath);
  try {
    const row = findLatestJalanRunRow(db);
    if (row === null) {
      return "latest_jalan_run=none";
    }
    const debugJsonPath = join(".data/debug/jalan", row.collectorRunId, `${row.stayDate}.json`);
    const debugJson = loadJalanDebugJson(debugJsonPath);
    return buildLatestJalanRunReport({ row, debugJsonPath, debugJson });
  } finally {
    closeDatabase(db);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(inspectLatestJalanRun());
}
