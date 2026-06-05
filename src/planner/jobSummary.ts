import type { PlannedCollectionJob } from "./runPlanner";

export interface PlannedJobSummary {
  totalJobs: number;
  jobsByPriority: Record<string, number>;
  jobsByOta: Record<string, number>;
  jobsWithPropertyUrl: number;
  jobsMissingPropertyUrl: number;
}

export function summarizePlannedJobs(jobs: PlannedCollectionJob[]): PlannedJobSummary {
  return {
    totalJobs: jobs.length,
    jobsByPriority: countBy(jobs, (job) => job.priority),
    jobsByOta: countBy(jobs, (job) => job.ota),
    jobsWithPropertyUrl: jobs.filter((job) => job.property_url !== null && job.property_url !== undefined).length,
    jobsMissingPropertyUrl: jobs.filter((job) => job.property_url === null || job.property_url === undefined).length
  };
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
