import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JalanCollector } from "../collectors/jalanCollector";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { insertCollectionJobAttempt } from "../db/repositories/collectionJobAttemptsRepository";
import type { CollectorInput, CollectorResult } from "../domain/types";
import { selectJalanStaleJobs, type JalanStaleJobsPlan } from "../planner/jalanStaleJobs";
import type { PlannedCollectionJob } from "../planner/runPlanner";
import { computeAndUpsertMarketSignals } from "./computeMarketSignals";
import { computeAndPersistPriceQualityFlags } from "./computePriceQualityFlags";
import { persistCollectorResult } from "../services/persistCollectorResult";
import { buildCollectionJobAttempt } from "../services/recordCollectionJobAttempt";
import { LocalScreenshotStorage } from "../services/screenshotStorage";
import { createRunId } from "../utils/ids";
import {
  loadJalanAutoUpdatePlanOptions,
  type JalanAutoUpdatePlanOptions
} from "./planJalanAutoUpdate";

const DEFAULT_DELAY_MS = 3000;
const DEFAULT_REPORT_DIR = ".data/reports/market-update";

export const AUTO_UPDATE_NON_GOAL_WARNING = [
  "Non-goals (NOT performed by this runner):",
  "- No Beds24 / AirHost export generated.",
  "- No prices applied to any facility.",
  "- No upload performed to any PMS or OTA."
];

export const AUTO_UPDATE_NO_PAID_NOTE =
  "No paid APIs / SERP APIs / proxies / scraping infrastructure used. Jalan direct collection only.";

export interface JalanAutoUpdateOptions extends JalanAutoUpdatePlanOptions {
  delayMs?: number;
  nowJst?: string;
}

export interface JalanAutoUpdateResult {
  runId: string;
  generatedAt: string;
  plan: JalanStaleJobsPlan;
  attemptedJobsCount: number;
  successCount: number;
  failedCount: number;
  statusCounts: Record<string, number>;
  countByPriority: Record<string, number>;
  marketSignalsRecomputedCount: number | null;
  qualityFlagsRecomputedCount: number | null;
  reportPath: string | null;
}

export interface JalanAutoUpdateDeps {
  db?: LocalDatabase;
  collector?: { collect(input: CollectorInput): Promise<CollectorResult[]> };
  delay?: (ms: number) => Promise<void>;
  now?: () => Date;
  writeReport?: boolean;
  reportDir?: string;
}

export async function runJalanAutoUpdate(
  options: JalanAutoUpdateOptions,
  deps: JalanAutoUpdateDeps = {}
): Promise<JalanAutoUpdateResult> {
  const ownsDb = deps.db === undefined;
  const db = deps.db ?? openLocalDatabase();
  const collector = deps.collector ?? new JalanCollector({ screenshotStorage: new LocalScreenshotStorage() });
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const writeReport = deps.writeReport ?? true;
  const reportDir = deps.reportDir ?? DEFAULT_REPORT_DIR;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const runId = createRunId();
  const generatedAt = now().toISOString();

  try {
    executeMigration(db);

    const plan = selectJalanStaleJobs(db, {
      priorityFilter: options.priorityFilter,
      maxJobs: options.maxJobs,
      postalCode: options.postalCode,
      ...(options.nowJst === undefined ? { nowJst: generatedAt } : { nowJst: options.nowJst })
    });

    const statusCounts: Record<string, number> = {};
    const countByPriority: Record<string, number> = {};
    let attemptedJobsCount = 0;
    let failedCount = 0;

    for (let index = 0; index < plan.jobs.length; index += 1) {
      const job = plan.jobs[index];
      if (job === undefined) continue;
      if (index > 0) await delay(delayMs);

      const input = jobToCollectorInput(job, runId);
      const [result] = await collector.collect(input);
      if (result === undefined) continue;

      persistCollectorResult(db, result);
      const debugJsonPath = `.data/debug/jalan/${runId}/${job.property_id}_${job.stay_date}.json`;
      const attempt = buildCollectionJobAttempt(input, result, { debugJsonPath });
      insertCollectionJobAttempt(db, attempt);

      const status = result.rateSnapshot.availabilityStatus;
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      countByPriority[job.priority] = (countByPriority[job.priority] ?? 0) + 1;
      if (status === "failed") failedCount += 1;
      attemptedJobsCount += 1;
    }

    // Recompute analytics on the freshly updated snapshots.
    // Quality flags must be recomputed before the second market-signals pass so
    // the quality-adjusted metrics reflect the latest suspicious-price flags.
    let marketSignalsRecomputedCount: number | null = null;
    let qualityFlagsRecomputedCount: number | null = null;
    if (attemptedJobsCount > 0) {
      computeAndUpsertMarketSignals(db, { source: "jalan", postalCode: "990-2301" });
      const quality = computeAndPersistPriceQualityFlags(db, { source: "jalan", postalCode: "990-2301" });
      qualityFlagsRecomputedCount = quality.assessedCount;
      const market = computeAndUpsertMarketSignals(db, { source: "jalan", postalCode: "990-2301" });
      marketSignalsRecomputedCount = market.processedDatesCount;
    }

    const result: JalanAutoUpdateResult = {
      runId,
      generatedAt,
      plan,
      attemptedJobsCount,
      successCount: attemptedJobsCount - failedCount,
      failedCount,
      statusCounts,
      countByPriority,
      marketSignalsRecomputedCount,
      qualityFlagsRecomputedCount,
      reportPath: null
    };

    if (writeReport) {
      mkdirSync(reportDir, { recursive: true });
      const reportPath = join(reportDir, `market_update_report_${formatTimestampForFilename(now())}.md`);
      writeFileSync(reportPath, renderMarketUpdateReport(result));
      result.reportPath = reportPath;
    }

    return result;
  } finally {
    if (ownsDb) closeDatabase(db);
  }
}

export function renderMarketUpdateReport(result: JalanAutoUpdateResult): string {
  return [
    "# Market DB Auto-Update Report",
    "",
    `Run id: ${result.runId}`,
    `Generated: ${result.generatedAt}`,
    "",
    "## Collection Summary",
    "",
    `- Jobs attempted: ${result.attemptedJobsCount}`,
    `- Success count: ${result.successCount}`,
    `- Failed count: ${result.failedCount}`,
    `- Status counts: ${JSON.stringify(result.statusCounts)}`,
    `- Count by priority: ${JSON.stringify(result.countByPriority)}`,
    "",
    "## Stale / Due Job Summary",
    "",
    `- Priority filter: ${result.plan.priorityFilter.join(",")}`,
    `- Postal code: ${result.plan.postalCode}`,
    `- Max jobs: ${result.plan.maxJobs}`,
    `- Due jobs selected: ${result.plan.dueJobsCount}`,
    `- Skipped fresh jobs: ${result.plan.skippedFreshJobsCount}`,
    `- Earliest stay date: ${result.plan.earliestStayDate ?? "null"}`,
    `- Latest stay date: ${result.plan.latestStayDate ?? "null"}`,
    "",
    "## Analytics Recompute",
    "",
    `- Market signals recomputed count: ${result.marketSignalsRecomputedCount ?? "n/a"}`,
    `- Quality flags recomputed count: ${result.qualityFlagsRecomputedCount ?? "n/a"}`,
    "",
    "## No-Paid Guard Note",
    "",
    `- ${AUTO_UPDATE_NO_PAID_NOTE}`,
    "",
    "## Non-Goal Warning",
    "",
    ...AUTO_UPDATE_NON_GOAL_WARNING.map((line) => `${line}`),
    ""
  ].join("\n");
}

export function formatJalanAutoUpdateResult(result: JalanAutoUpdateResult): string {
  return [
    `collector_run_id=${result.runId}`,
    `attempted_jobs_count=${result.attemptedJobsCount}`,
    `success_count=${result.successCount}`,
    `failed_count=${result.failedCount}`,
    `status_counts=${JSON.stringify(result.statusCounts)}`,
    `count_by_priority=${JSON.stringify(result.countByPriority)}`,
    `due_jobs_count=${result.plan.dueJobsCount}`,
    `skipped_fresh_jobs_count=${result.plan.skippedFreshJobsCount}`,
    `market_signals_recomputed_count=${result.marketSignalsRecomputedCount ?? "n/a"}`,
    `quality_flags_recomputed_count=${result.qualityFlagsRecomputedCount ?? "n/a"}`,
    `report_path=${result.reportPath ?? "null"}`
  ].join("\n");
}

function jobToCollectorInput(job: PlannedCollectionJob, runId: string): CollectorInput {
  return {
    runId,
    propertyId: job.property_id,
    propertyName: job.property_name,
    ota: "jalan",
    stayDate: job.stay_date,
    guests: job.adults,
    adults: job.adults,
    children: job.children,
    rooms: job.rooms,
    nights: job.nights,
    propertyUrl: job.property_url ?? null,
    jobId: job.job_id
  };
}

function formatTimestampForFilename(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

if (process.argv[1]?.endsWith("runJalanAutoUpdate.ts")) {
  const options = loadJalanAutoUpdatePlanOptions();
  runJalanAutoUpdate(options)
    .then((result) => {
      console.log(formatJalanAutoUpdateResult(result));
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
