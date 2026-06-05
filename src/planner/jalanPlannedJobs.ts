import { createHash } from "node:crypto";
import type { TargetDatePriority } from "../domain/types";
import type { LocalDatabase } from "../db/client";
import type { PlannedCollectionJob } from "./runPlanner";

export interface SelectJalanPlannedJobsInput {
  priorityFilter: TargetDatePriority[];
  maxJobs: number;
  ota: "jalan";
  adults: 2;
  rooms: 1;
  nights: 1;
}

interface JalanPlannedJobRow {
  property_id: string;
  property_name: string;
  property_url: string;
  stay_date: string;
  priority: TargetDatePriority;
  reason: string;
}

const PRIORITY_ORDER: Record<TargetDatePriority, number> = { S: 0, A: 1, B: 2, C: 3 };

export function selectJalanPlannedJobs(
  db: LocalDatabase,
  input: SelectJalanPlannedJobsInput
): PlannedCollectionJob[] {
  const priorities = input.priorityFilter.length === 0 ? ["S", "A", "B", "C"] : input.priorityFilter;
  const priorityPlaceholders = priorities.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT
         p.id AS property_id,
         p.name AS property_name,
         l.property_url AS property_url,
         td.stay_date,
         td.priority,
         td.reason
       FROM properties p
       INNER JOIN property_ota_links l ON l.property_id = p.id
       INNER JOIN target_dates td ON td.active = 1
       WHERE p.active = 1
         AND l.active = 1
         AND l.ota = 'jalan'
         AND l.property_url IS NOT NULL
         AND l.last_verified_at IS NOT NULL
         AND td.priority IN (${priorityPlaceholders})
       ORDER BY
         CASE td.priority WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END ASC,
         td.stay_date ASC,
         p.name ASC`
    )
    .all(...priorities) as JalanPlannedJobRow[];

  const jobs: PlannedCollectionJob[] = rows.map((row) => ({
    job_id: createJalanBudgetedJobId(row.property_id, row.stay_date, input),
    property_id: row.property_id,
    property_name: row.property_name,
    ota: input.ota,
    property_url: row.property_url,
    stay_date: row.stay_date,
    priority: row.priority,
    reason: row.reason,
    adults: input.adults,
    children: 0,
    rooms: input.rooms,
    nights: input.nights,
    currency: "JPY" as const,
    price_basis_preference: "total_tax_included" as const
  }));

  return dedupeByUrlAndDate(jobs.sort(compareJobs)).slice(0, input.maxJobs);
}

function compareJobs(left: PlannedCollectionJob, right: PlannedCollectionJob): number {
  return (
    PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
    left.stay_date.localeCompare(right.stay_date) ||
    left.property_name.localeCompare(right.property_name)
  );
}

function createJalanBudgetedJobId(
  propertyId: string,
  stayDate: string,
  input: SelectJalanPlannedJobsInput
): string {
  const raw = [propertyId, input.ota, stayDate, input.adults, input.rooms, input.nights].join("|");
  return `jalan_budgeted_${createHash("sha1").update(raw).digest("hex").slice(0, 16)}`;
}

function dedupeByUrlAndDate(jobs: PlannedCollectionJob[]): PlannedCollectionJob[] {
  const seen = new Set<string>();
  const deduped: PlannedCollectionJob[] = [];
  for (const job of jobs) {
    const key = `${job.property_url ?? job.property_id}|${job.stay_date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }
  return deduped;
}
