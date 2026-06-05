import { closeDatabase, executeMigration, openLocalDatabase } from "../db/client";
import { buildPlannedCollectionJobs } from "../planner/runPlanner";
import { summarizePlannedJobs } from "../planner/jobSummary";
import { importPropertySeeds } from "../seeds/importPropertySeeds";
import { importTargetDateSeeds } from "../seeds/importTargetDateSeeds";

const db = openLocalDatabase();

try {
  executeMigration(db);
  importPropertySeeds({ db });
  importTargetDateSeeds({ db });

  const jobs = buildPlannedCollectionJobs(db);
  const summary = summarizePlannedJobs(jobs);

  console.log(`total_jobs=${summary.totalJobs}`);
  console.log(`jobs_by_priority=${JSON.stringify(summary.jobsByPriority)}`);
  console.log(`jobs_by_ota=${JSON.stringify(summary.jobsByOta)}`);
  console.log(`jobs_with_property_url=${summary.jobsWithPropertyUrl}`);
  console.log(`jobs_missing_property_url=${summary.jobsMissingPropertyUrl}`);
  console.log(`first_10_planned_jobs=${JSON.stringify(jobs.slice(0, 10))}`);
} finally {
  closeDatabase(db);
}
