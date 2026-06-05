import { JalanCollector } from "../collectors/jalanCollector";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { insertCollectionJobAttempt } from "../db/repositories/collectionJobAttemptsRepository";
import type { CollectorInput, CollectorResult } from "../domain/types";
import { selectJalanPlannedJobs } from "../planner/jalanPlannedJobs";
import type { PlannedCollectionJob } from "../planner/runPlanner";
import { persistCollectorResult } from "../services/persistCollectorResult";
import { buildCollectionJobAttempt } from "../services/recordCollectionJobAttempt";
import { LocalScreenshotStorage } from "../services/screenshotStorage";
import { createRunId } from "../utils/ids";
import { formatJalanBudgetedPlan, loadJalanBudgetedPlanOptions, type JalanBudgetedPlanOptions } from "./planJalanBudgetedJobs";

const DEFAULT_DELAY_MS = 3000;

export interface JalanBudgetedRunSummary {
  collectorRunId: string;
  plannedJobsCount: number;
  attemptedJobsCount: number;
  statusCounts: Record<string, number>;
  outcomeCounts: Record<string, number>;
  jobResults: Array<{
    priority: string;
    stayDate: string;
    propertyName: string;
    status: string;
    price: number | null;
    errorReason: string | null;
    screenshotPath: string | null;
    debugJsonPath: string;
  }>;
  persistedRateSnapshots: number;
  persistedInventorySnapshots: number;
  persistedJobAttempts: number;
  crawlBudget: {
    maxJobs: number;
    actualJobs: number;
    delayMsBetweenJobs: number;
    sequential: true;
    priorityFilter: string[];
  };
}

export interface JalanBudgetedCollectionDeps {
  db?: LocalDatabase;
  collector?: { collect(input: CollectorInput): Promise<CollectorResult[]> };
  delay?: (ms: number) => Promise<void>;
}

export function planBudgetedJobsForRun(db: LocalDatabase, options: JalanBudgetedPlanOptions): PlannedCollectionJob[] {
  executeMigration(db);
  return selectJalanPlannedJobs(db, {
    ota: "jalan",
    priorityFilter: options.priorityFilter,
    maxJobs: options.maxJobs,
    adults: 2,
    rooms: 1,
    nights: 1
  });
}

export async function runJalanBudgetedCollection(
  options: JalanBudgetedPlanOptions,
  deps: JalanBudgetedCollectionDeps = {}
): Promise<JalanBudgetedRunSummary> {
  const ownsDb = deps.db === undefined;
  const db = deps.db ?? openLocalDatabase();
  const collector = deps.collector ?? new JalanCollector({ screenshotStorage: new LocalScreenshotStorage() });
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runId = createRunId();

  try {
    const jobs = planBudgetedJobsForRun(db, options);
    const summary: JalanBudgetedRunSummary = {
      collectorRunId: runId,
      plannedJobsCount: jobs.length,
      attemptedJobsCount: 0,
      statusCounts: {},
      outcomeCounts: {},
      jobResults: [],
      persistedRateSnapshots: 0,
      persistedInventorySnapshots: 0,
      persistedJobAttempts: 0,
      crawlBudget: {
        maxJobs: options.maxJobs,
        actualJobs: 0,
        delayMsBetweenJobs: DEFAULT_DELAY_MS,
        sequential: true,
        priorityFilter: options.priorityFilter
      }
    };

    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      if (job === undefined) continue;
      if (index > 0) await delay(DEFAULT_DELAY_MS);

      const input = jobToCollectorInput(job, runId);
      const [result] = await collector.collect(input);
      if (result === undefined) continue;

      persistCollectorResult(db, result);
      const debugJsonPath = `.data/debug/jalan/${runId}/${job.property_id}_${job.stay_date}.json`;
      const attempt = buildCollectionJobAttempt(input, result, { debugJsonPath });
      insertCollectionJobAttempt(db, attempt);

      const status = result.rateSnapshot.availabilityStatus;
      summary.statusCounts[status] = (summary.statusCounts[status] ?? 0) + 1;
      summary.outcomeCounts[attempt.outcome] = (summary.outcomeCounts[attempt.outcome] ?? 0) + 1;
      summary.jobResults.push({
        priority: job.priority,
        stayDate: job.stay_date,
        propertyName: job.property_name,
        status,
        price: result.rateSnapshot.priceTotalTaxIncluded ?? null,
        errorReason: result.rateSnapshot.errorReason ?? null,
        screenshotPath: result.rateSnapshot.screenshotKey ?? null,
        debugJsonPath
      });
      summary.attemptedJobsCount += 1;
      summary.persistedRateSnapshots += 1;
      summary.persistedInventorySnapshots += 1;
      summary.persistedJobAttempts += 1;
      summary.crawlBudget.actualJobs += 1;
    }

    return summary;
  } finally {
    if (ownsDb) closeDatabase(db);
  }
}

export function formatJalanBudgetedRunSummary(summary: JalanBudgetedRunSummary): string {
  const lines = [
    `collector_run_id=${summary.collectorRunId}`,
    `planned_jobs_count=${summary.plannedJobsCount}`,
    `attempted_jobs_count=${summary.attemptedJobsCount}`,
    `status_counts=${JSON.stringify(summary.statusCounts)}`,
    `outcome_counts=${JSON.stringify(summary.outcomeCounts)}`,
    `available_count=${summary.statusCounts.available ?? 0}`,
    `failed_count=${summary.statusCounts.failed ?? 0}`,
    `not_listed_count=${summary.statusCounts.not_listed ?? 0}`,
    `sold_out_count=${summary.statusCounts.sold_out ?? 0}`,
    `persisted_rate_snapshots=${summary.persistedRateSnapshots}`,
    `persisted_inventory_snapshots=${summary.persistedInventorySnapshots}`,
    `persisted_job_attempts=${summary.persistedJobAttempts}`,
    `crawl_budget=${JSON.stringify(summary.crawlBudget)}`,
    "---",
    "priority | stay_date | property | status | price | error_reason | screenshot | debug_json"
  ];

  for (const result of summary.jobResults) {
    lines.push(
      `${result.priority} | ${result.stayDate} | ${result.propertyName} | ${result.status} | ${result.price ?? "null"} | ${result.errorReason ?? "null"} | ${result.screenshotPath ?? "null"} | ${result.debugJsonPath}`
    );
  }
  return lines.join("\n");
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

async function main(): Promise<void> {
  const options = loadJalanBudgetedPlanOptions();
  const db = openLocalDatabase();
  try {
    if (process.env.JALAN_BUDGETED_DRY_RUN === "true") {
      const jobs = planBudgetedJobsForRun(db, options);
      console.log("jalan_budgeted_collection_dry_run=true");
      console.log(formatJalanBudgetedPlan(jobs, options));
      console.log("db_writes=0");
      console.log("screenshots=0");
      console.log("attempts=0");
      return;
    }
  } finally {
    closeDatabase(db);
  }

  console.log(formatJalanBudgetedRunSummary(await runJalanBudgetedCollection(options)));
}

if (process.argv[1]?.endsWith("runJalanBudgetedCollection.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
