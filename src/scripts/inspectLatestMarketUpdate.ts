import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { listMarketDailySignals } from "../db/repositories/marketSignalsRepository";
import { listPriceQualityFlags } from "../db/repositories/priceQualityRepository";

const DEFAULT_REPORT_DIR = ".data/reports/market-update";

export interface LatestMarketUpdateInspection {
  latestReportPath: string | null;
  latestCollectorRunId: string | null;
  attemptedJobCount: number | null;
  latestMarketSignalCount: number;
  latestQualityFlagCount: number;
}

export function inspectLatestMarketUpdate(
  db: LocalDatabase,
  options: { reportDir?: string } = {}
): LatestMarketUpdateInspection {
  executeMigration(db);
  const reportDir = options.reportDir ?? DEFAULT_REPORT_DIR;

  const latestReportPath = findLatestReportPath(reportDir);
  const latestCollectorRunId = findLatestCollectorRunId(db);
  const attemptedJobCount = latestCollectorRunId === null ? null : countAttemptsForRun(db, latestCollectorRunId);

  return {
    latestReportPath,
    latestCollectorRunId,
    attemptedJobCount,
    latestMarketSignalCount: listMarketDailySignals(db, { source: "jalan", postalCode: "990-2301" }).length,
    latestQualityFlagCount: listPriceQualityFlags(db, { source: "jalan" }).length
  };
}

export function formatLatestMarketUpdateInspection(inspection: LatestMarketUpdateInspection): string {
  return [
    `latest_report_path=${inspection.latestReportPath ?? "null"}`,
    `latest_collector_run_id=${inspection.latestCollectorRunId ?? "null"}`,
    `attempted_job_count=${inspection.attemptedJobCount ?? "null"}`,
    `latest_market_signal_count=${inspection.latestMarketSignalCount}`,
    `latest_quality_flag_count=${inspection.latestQualityFlagCount}`
  ].join("\n");
}

function findLatestReportPath(reportDir: string): string | null {
  if (!existsSync(reportDir)) return null;
  const reports = readdirSync(reportDir)
    .filter((name) => name.startsWith("market_update_report_") && name.endsWith(".md"))
    .sort();
  const latest = reports[reports.length - 1];
  return latest === undefined ? null : join(reportDir, latest);
}

function findLatestCollectorRunId(db: LocalDatabase): string | null {
  const row = db
    .prepare(
      `SELECT run_id
       FROM collection_job_attempts
       WHERE ota = 'jalan'
       GROUP BY run_id
       ORDER BY MAX(attempted_at_jst) DESC
       LIMIT 1`
    )
    .get() as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

function countAttemptsForRun(db: LocalDatabase, runId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM collection_job_attempts WHERE run_id = ?")
    .get(runId) as { count: number };
  return row.count;
}

if (process.argv[1]?.endsWith("inspectLatestMarketUpdate.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatLatestMarketUpdateInspection(inspectLatestMarketUpdate(db)));
  } finally {
    closeDatabase(db);
  }
}
