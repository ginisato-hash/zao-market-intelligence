import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import {
  listPropertySourceCoverage,
  summarizePropertySourceCoverage
} from "../db/repositories/propertySourceCoverageRepository";

/**
 * Feasibility-focused view over property_source_coverage. Distinct from
 * inspect:source-coverage (Phase 40X): this view foregrounds access_status and
 * last_verified_at — the fields feasibility probes write — and counts coverage
 * by the feasibility status vocabulary so probe outcomes are easy to audit.
 */
export interface SourceFeasibilityRow {
  source: string;
  propertyName: string;
  coverageStatus: string;
  accessStatus: string | null;
  lastVerifiedAt: string | null;
  active: boolean;
  notes: string | null;
}

export interface SourceFeasibilityInspection {
  totalCoverageRows: number;
  countBySource: Record<string, number>;
  countByCoverageStatus: Record<string, number>;
  activeCount: number;
  inactiveCount: number;
  rows: SourceFeasibilityRow[];
}

const ROW_LIMIT = 50;

export function buildSourceFeasibilityInspection(db: LocalDatabase): SourceFeasibilityInspection {
  const summary = summarizePropertySourceCoverage(db);
  const all = listPropertySourceCoverage(db);
  const nameById = propertyNameById(db);

  const rows: SourceFeasibilityRow[] = all.slice(0, ROW_LIMIT).map((row) => ({
    source: row.source,
    propertyName: nameById.get(row.propertyId) ?? row.propertyId,
    coverageStatus: row.coverageStatus,
    accessStatus: row.accessStatus,
    lastVerifiedAt: row.lastVerifiedAt,
    active: row.active,
    notes: row.notes
  }));

  return {
    totalCoverageRows: summary.totalCoverageRows,
    countBySource: summary.countBySource,
    countByCoverageStatus: summary.countByCoverageStatus,
    activeCount: all.filter((row) => row.active).length,
    inactiveCount: all.filter((row) => !row.active).length,
    rows
  };
}

export function formatSourceFeasibilityInspection(inspection: SourceFeasibilityInspection): string {
  const lines = [
    `total_coverage_rows=${inspection.totalCoverageRows}`,
    `count_by_source=${JSON.stringify(inspection.countBySource)}`,
    `count_by_coverage_status=${JSON.stringify(inspection.countByCoverageStatus)}`,
    `active_count=${inspection.activeCount}`,
    `inactive_count=${inspection.inactiveCount}`,
    "---",
    "source | property_name | coverage_status | access_status | last_verified_at | active | notes"
  ];
  for (const row of inspection.rows) {
    lines.push(
      [
        row.source,
        row.propertyName,
        row.coverageStatus,
        row.accessStatus ?? "",
        row.lastVerifiedAt ?? "",
        String(row.active),
        row.notes ?? ""
      ].join(" | ")
    );
  }
  return lines.join("\n");
}

interface PropertyNameRow {
  id: string;
  name: string;
}

function propertyNameById(db: LocalDatabase): Map<string, string> {
  const rows = db.prepare("SELECT id, name FROM properties").all() as PropertyNameRow[];
  return new Map(rows.map((row) => [row.id, row.name]));
}

if (process.argv[1]?.endsWith("inspectSourceFeasibility.ts")) {
  const db = openLocalDatabase();
  try {
    executeMigration(db);
    console.log(formatSourceFeasibilityInspection(buildSourceFeasibilityInspection(db)));
  } finally {
    closeDatabase(db);
  }
}
