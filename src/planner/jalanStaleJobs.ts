import type { TargetDatePriority } from "../domain/types";
import type { LocalDatabase } from "../db/client";
import { getLatestCollectionJobAttempt } from "../db/repositories/collectionJobAttemptsRepository";
import { isJobDueForRefresh } from "../services/marketRefreshCadence";
import { selectJalanPlannedJobs } from "./jalanPlannedJobs";
import type { PlannedCollectionJob } from "./runPlanner";

export interface SelectJalanStaleJobsOptions {
  priorityFilter: TargetDatePriority[];
  maxJobs: number;
  postalCode: string;
  nowJst?: string;
}

export interface JalanStaleJobsPlan {
  jobs: PlannedCollectionJob[];
  dueJobsCount: number;
  skippedFreshJobsCount: number;
  countByPriority: Record<string, number>;
  earliestStayDate: string | null;
  latestStayDate: string | null;
  maxJobs: number;
  priorityFilter: TargetDatePriority[];
  postalCode: string;
  nowJst: string;
}

/**
 * Selects verified-Jalan jobs that are due for a market-DB refresh, by cadence.
 *
 * Candidates come from `selectJalanPlannedJobs` (active verified jalan links ×
 * active target dates), so the job_id matches the existing budgeted-runner
 * convention (`jalan_budgeted_*`) — meaning attempts recorded by budgeted runs
 * are picked up here. We then filter by postal code, drop jobs whose latest
 * attempt is still fresh per cadence, and cap to `maxJobs`.
 *
 * Read-only: this planner performs no DB writes.
 */
export function selectJalanStaleJobs(db: LocalDatabase, options: SelectJalanStaleJobsOptions): JalanStaleJobsPlan {
  const nowJst = options.nowJst ?? new Date().toISOString();

  const candidates = selectJalanPlannedJobs(db, {
    ota: "jalan",
    priorityFilter: options.priorityFilter,
    maxJobs: Number.MAX_SAFE_INTEGER,
    adults: 2,
    rooms: 1,
    nights: 1
  });

  const allowedPropertyIds = loadAllowedPropertyIds(db, options.postalCode);

  const dueJobs: PlannedCollectionJob[] = [];
  let skippedFreshJobsCount = 0;

  for (const job of candidates) {
    if (!allowedPropertyIds.has(job.property_id)) {
      continue;
    }
    const latestAttempt = getLatestCollectionJobAttempt(db, job.job_id);
    const due = isJobDueForRefresh({
      priority: job.priority,
      lastAttemptedAtJst: latestAttempt?.attemptedAtJst ?? null,
      nowJst
    });
    if (due) {
      dueJobs.push(job);
    } else {
      skippedFreshJobsCount += 1;
    }
  }

  const jobs = dueJobs.slice(0, options.maxJobs);

  return {
    jobs,
    dueJobsCount: jobs.length,
    skippedFreshJobsCount,
    countByPriority: countBy(jobs, (job) => job.priority),
    earliestStayDate: jobs[0]?.stay_date ?? null,
    latestStayDate: jobs.length === 0 ? null : jobs[jobs.length - 1]?.stay_date ?? null,
    maxJobs: options.maxJobs,
    priorityFilter: options.priorityFilter,
    postalCode: options.postalCode,
    nowJst
  };
}

function loadAllowedPropertyIds(db: LocalDatabase, postalCode: string): Set<string> {
  const rows = db
    .prepare("SELECT id FROM properties WHERE active = 1 AND postal_code = ?")
    .all(postalCode) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
