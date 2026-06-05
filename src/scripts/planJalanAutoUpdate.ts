import type { TargetDatePriority } from "../domain/types";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import { selectJalanStaleJobs, type JalanStaleJobsPlan } from "../planner/jalanStaleJobs";

export interface JalanAutoUpdatePlanOptions {
  priorityFilter: TargetDatePriority[];
  maxJobs: number;
  postalCode: string;
}

export function parsePriorityFilter(value = process.env.JALAN_PRIORITY_FILTER ?? "S,A"): TargetDatePriority[] {
  const priorities = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const priority of priorities) {
    if (!["S", "A", "B", "C"].includes(priority)) {
      throw new Error(`Invalid JALAN_PRIORITY_FILTER value: ${priority}`);
    }
  }
  return priorities as TargetDatePriority[];
}

export function parseMaxJobs(value = process.env.JALAN_MAX_JOBS ?? "30"): number {
  const maxJobs = Number(value);
  if (!Number.isInteger(maxJobs) || maxJobs < 1) {
    throw new Error("JALAN_MAX_JOBS must be a positive integer");
  }
  return maxJobs;
}

export function parsePostalCode(value = process.env.JALAN_POSTAL_CODE ?? "990-2301"): string {
  const postalCode = value.trim();
  if (postalCode === "") {
    throw new Error("JALAN_POSTAL_CODE must not be empty");
  }
  return postalCode;
}

export function loadJalanAutoUpdatePlanOptions(): JalanAutoUpdatePlanOptions {
  return {
    priorityFilter: parsePriorityFilter(),
    maxJobs: parseMaxJobs(),
    postalCode: parsePostalCode()
  };
}

export function planJalanAutoUpdate(
  db: LocalDatabase,
  options: JalanAutoUpdatePlanOptions,
  nowJst?: string
): JalanStaleJobsPlan {
  executeMigration(db);
  return selectJalanStaleJobs(db, {
    priorityFilter: options.priorityFilter,
    maxJobs: options.maxJobs,
    postalCode: options.postalCode,
    ...(nowJst === undefined ? {} : { nowJst })
  });
}

export function formatJalanAutoUpdatePlan(plan: JalanStaleJobsPlan): string {
  const lines = [
    `due_jobs_count=${plan.dueJobsCount}`,
    `skipped_fresh_jobs_count=${plan.skippedFreshJobsCount}`,
    `max_jobs=${plan.maxJobs}`,
    `priority_filter=${plan.priorityFilter.join(",")}`,
    `postal_code=${plan.postalCode}`,
    `count_by_priority=${JSON.stringify(plan.countByPriority)}`,
    `earliest_stay_date=${plan.earliestStayDate ?? "null"}`,
    `latest_stay_date=${plan.latestStayDate ?? "null"}`,
    "sample_jobs:"
  ];
  if (plan.jobs.length === 0) {
    lines.push("  none");
  } else {
    for (const job of plan.jobs.slice(0, 10)) {
      lines.push(`  ${job.priority} | ${job.stay_date} | ${job.property_name} | ${job.property_url ?? "null"}`);
    }
  }
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("planJalanAutoUpdate.ts")) {
  const db = openLocalDatabase();
  try {
    const options = loadJalanAutoUpdatePlanOptions();
    console.log(formatJalanAutoUpdatePlan(planJalanAutoUpdate(db, options)));
    console.log("db_writes=0");
  } finally {
    closeDatabase(db);
  }
}
