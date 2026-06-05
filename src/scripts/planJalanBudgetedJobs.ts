import type { TargetDatePriority } from "../domain/types";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { selectJalanPlannedJobs } from "../planner/jalanPlannedJobs";
import type { PlannedCollectionJob } from "../planner/runPlanner";

export interface JalanBudgetedPlanOptions {
  priorityFilter: TargetDatePriority[];
  maxJobs: number;
}

export function parsePriorityFilter(value = process.env.JALAN_PRIORITY_FILTER ?? "S,A"): TargetDatePriority[] {
  const priorities = value.split(",").map((item) => item.trim()).filter(Boolean);
  for (const priority of priorities) {
    if (!["S", "A", "B", "C"].includes(priority)) {
      throw new Error(`Invalid JALAN_PRIORITY_FILTER value: ${priority}`);
    }
  }
  return priorities as TargetDatePriority[];
}

export function parseMaxJobs(value = process.env.JALAN_MAX_JOBS ?? "10"): number {
  const maxJobs = Number(value);
  if (!Number.isInteger(maxJobs) || maxJobs < 1) {
    throw new Error("JALAN_MAX_JOBS must be a positive integer");
  }
  return maxJobs;
}

export function loadJalanBudgetedPlanOptions(): JalanBudgetedPlanOptions {
  return {
    priorityFilter: parsePriorityFilter(),
    maxJobs: parseMaxJobs()
  };
}

export function planJalanBudgetedJobs(db: LocalDatabase, options = loadJalanBudgetedPlanOptions()): PlannedCollectionJob[] {
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

export function formatJalanBudgetedPlan(jobs: PlannedCollectionJob[], options: JalanBudgetedPlanOptions): string {
  const lines = [
    `planned_jobs_count=${jobs.length}`,
    `priority_filter=${options.priorityFilter.join(",")}`,
    `max_jobs=${options.maxJobs}`,
    `jobs_by_priority=${JSON.stringify(countBy(jobs, (job) => job.priority))}`,
    `jobs_by_property=${JSON.stringify(countBy(jobs, (job) => job.property_name))}`,
    `earliest_stay_date=${jobs[0]?.stay_date ?? "null"}`,
    `latest_stay_date=${jobs.length === 0 ? "null" : jobs[jobs.length - 1]?.stay_date ?? "null"}`,
    "first_10_planned_jobs:"
  ];

  for (const job of jobs.slice(0, 10)) {
    lines.push(`  ${job.priority} | ${job.stay_date} | ${job.property_name} | ${job.property_url ?? "null"}`);
  }

  return lines.join("\n");
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

if (process.argv[1]?.endsWith("planJalanBudgetedJobs.ts")) {
  const db = openLocalDatabase();
  try {
    const options = loadJalanBudgetedPlanOptions();
    console.log(formatJalanBudgetedPlan(planJalanBudgetedJobs(db, options), options));
  } finally {
    closeDatabase(db);
  }
}
