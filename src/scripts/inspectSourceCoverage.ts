import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import {
  listPropertySourceCoverage,
  summarizePropertySourceCoverage
} from "../db/repositories/propertySourceCoverageRepository";
import { sourceCoverageCandidatesTableExists } from "../db/repositories/sourceCoverageCandidatesRepository";

export interface SourceCoverageSampleRow {
  source: string;
  propertyName: string;
  coverageStatus: string;
  active: boolean;
  sourcePropertyId: string | null;
  propertyUrl: string | null;
}

export interface SourceCoverageInspection {
  totalCoverageRows: number;
  countBySource: Record<string, number>;
  countByCoverageStatus: Record<string, number>;
  confirmedJalanCount: number;
  rakutenNeedsReviewCount: number;
  bookingBlockedOrReviewCount: number;
  googleHotelsReviewOrUnsupportedCount: number;
  propertiesMissingJalanCoverage: number;
  propertiesMissingRakutenCoverage: number;
  propertiesMissingBookingCoverage: number;
  propertiesMissingGoogleHotelsCoverage: number;
  // Phase 42X additions (do not break Phase 40X output)
  activePropertiesCount: number;
  needsReviewCountBySource: Record<string, number>;
  blockedCountBySource: Record<string, number>;
  unsupportedCountBySource: Record<string, number>;
  candidateCountBySource: Record<string, number>;
  sampleRows: SourceCoverageSampleRow[];
}

const SAMPLE_ROW_LIMIT = 30;

export function buildSourceCoverageInspection(db: LocalDatabase): SourceCoverageInspection {
  const summary = summarizePropertySourceCoverage(db);
  const all = listPropertySourceCoverage(db);

  const countStatus = (source: string, statuses: string[]): number =>
    all.filter((row) => row.source === source && statuses.includes(row.coverageStatus)).length;

  const countBySourceForStatus = (status: string): Record<string, number> =>
    Object.fromEntries(
      Object.entries(
        all
          .filter((row) => row.coverageStatus === status)
          .reduce<Record<string, number>>((acc, row) => {
            acc[row.source] = (acc[row.source] ?? 0) + 1;
            return acc;
          }, {})
      ).sort(([a], [b]) => a.localeCompare(b))
    );

  const activePropertiesCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM properties WHERE active = 1 AND postal_code = '990-2301'"
      )
      .get() as { count: number }
  ).count;

  const candidateCountBySource = sourceCoverageCandidatesTableExists(db)
    ? (Object.fromEntries(
        (
          db
            .prepare(
              "SELECT source AS key, COUNT(*) AS count FROM source_coverage_candidates GROUP BY source ORDER BY source"
            )
            .all() as Array<{ key: string; count: number }>
        ).map((row) => [row.key, row.count])
      ) as Record<string, number>)
    : {};

  return {
    totalCoverageRows: summary.totalCoverageRows,
    countBySource: summary.countBySource,
    countByCoverageStatus: summary.countByCoverageStatus,
    confirmedJalanCount: countStatus("jalan", ["confirmed"]),
    rakutenNeedsReviewCount: countStatus("rakuten", ["needs_review"]),
    bookingBlockedOrReviewCount: countStatus("booking", ["blocked", "needs_review"]),
    googleHotelsReviewOrUnsupportedCount: countStatus("google_hotels", ["needs_review", "unsupported"]),
    propertiesMissingJalanCoverage: countPropertiesMissingCoverage(db, "jalan"),
    propertiesMissingRakutenCoverage: countPropertiesMissingCoverage(db, "rakuten"),
    propertiesMissingBookingCoverage: countPropertiesMissingCoverage(db, "booking"),
    propertiesMissingGoogleHotelsCoverage: countPropertiesMissingCoverage(db, "google_hotels"),
    activePropertiesCount,
    needsReviewCountBySource: countBySourceForStatus("needs_review"),
    blockedCountBySource: countBySourceForStatus("blocked"),
    unsupportedCountBySource: countBySourceForStatus("unsupported"),
    candidateCountBySource,
    sampleRows: sampleRows(db)
  };
}

export function formatSourceCoverageInspection(inspection: SourceCoverageInspection): string {
  const lines = [
    `total_coverage_rows=${inspection.totalCoverageRows}`,
    `count_by_source=${JSON.stringify(inspection.countBySource)}`,
    `count_by_coverage_status=${JSON.stringify(inspection.countByCoverageStatus)}`,
    `confirmed_jalan_count=${inspection.confirmedJalanCount}`,
    `rakuten_needs_review_count=${inspection.rakutenNeedsReviewCount}`,
    `booking_blocked_or_review_count=${inspection.bookingBlockedOrReviewCount}`,
    `google_hotels_review_or_unsupported_count=${inspection.googleHotelsReviewOrUnsupportedCount}`,
    `properties_missing_jalan_coverage=${inspection.propertiesMissingJalanCoverage}`,
    `properties_missing_rakuten_coverage=${inspection.propertiesMissingRakutenCoverage}`,
    `properties_missing_booking_coverage=${inspection.propertiesMissingBookingCoverage}`,
    `properties_missing_google_hotels_coverage=${inspection.propertiesMissingGoogleHotelsCoverage}`,
    `active_properties_count=${inspection.activePropertiesCount}`,
    `needs_review_count_by_source=${JSON.stringify(inspection.needsReviewCountBySource)}`,
    `blocked_count_by_source=${JSON.stringify(inspection.blockedCountBySource)}`,
    `unsupported_count_by_source=${JSON.stringify(inspection.unsupportedCountBySource)}`,
    `candidate_count_by_source=${JSON.stringify(inspection.candidateCountBySource)}`,
    "---",
    "source | property_name | coverage_status | active | source_property_id | property_url"
  ];
  for (const row of inspection.sampleRows) {
    lines.push(
      [
        row.source,
        row.propertyName,
        row.coverageStatus,
        String(row.active),
        row.sourcePropertyId ?? "",
        row.propertyUrl ?? ""
      ].join(" | ")
    );
  }
  return lines.join("\n");
}

interface CountRow {
  count: number;
}

// A property is "missing coverage" for a source when no coverage row of any
// kind exists for that (property, source) pair. Blocked / needs_review rows
// still count as tracked coverage so they are intentionally not flagged here.
function countPropertiesMissingCoverage(db: LocalDatabase, source: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM properties p
         WHERE p.active = 1
           AND p.postal_code = '990-2301'
           AND NOT EXISTS (
             SELECT 1
             FROM property_source_coverage c
             WHERE c.property_id = p.id
               AND c.source = ?
           )`
      )
      .get(source) as CountRow
  ).count;
}

interface SampleDbRow {
  source: string;
  property_name: string;
  coverage_status: string;
  active: number;
  source_property_id: string | null;
  property_url: string | null;
}

function sampleRows(db: LocalDatabase): SourceCoverageSampleRow[] {
  return (
    db
      .prepare(
        `SELECT c.source AS source,
                COALESCE(p.name, c.property_id) AS property_name,
                c.coverage_status AS coverage_status,
                c.active AS active,
                c.source_property_id AS source_property_id,
                c.property_url AS property_url
         FROM property_source_coverage c
         LEFT JOIN properties p ON p.id = c.property_id
         ORDER BY c.source ASC, property_name ASC
         LIMIT ?`
      )
      .all(SAMPLE_ROW_LIMIT) as SampleDbRow[]
  ).map((row) => ({
    source: row.source,
    propertyName: row.property_name,
    coverageStatus: row.coverage_status,
    active: row.active === 1,
    sourcePropertyId: row.source_property_id,
    propertyUrl: row.property_url
  }));
}

if (process.argv[1]?.endsWith("inspectSourceCoverage.ts")) {
  const db = openLocalDatabase();
  try {
    executeMigration(db);
    console.log(formatSourceCoverageInspection(buildSourceCoverageInspection(db)));
  } finally {
    closeDatabase(db);
  }
}
