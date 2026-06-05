import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";
import type { TargetDatePriority } from "../services/generateTargetDates";

interface CountRow {
  count: number;
}

interface PriorityCountRow {
  priority: TargetDatePriority;
  count: number;
}

interface DateRangeRow {
  earliest_date: string | null;
  latest_date: string | null;
}

interface TargetDateRow {
  stay_date: string;
  reason: string;
}

export interface TargetDatesInspection {
  totalTargetDates: number;
  activeTargetDates: number;
  countByPriority: Record<TargetDatePriority, number>;
  earliestDate: string | null;
  latestDate: string | null;
  samples: Record<TargetDatePriority, TargetDateRow[]>;
}

export function inspectTargetDates(db: LocalDatabase): TargetDatesInspection {
  executeMigration(db);
  const totalTargetDates = (db.prepare("SELECT COUNT(*) AS count FROM target_dates").get() as CountRow).count;
  const activeTargetDates = (
    db.prepare("SELECT COUNT(*) AS count FROM target_dates WHERE active = 1").get() as CountRow
  ).count;
  const range = db.prepare("SELECT MIN(stay_date) AS earliest_date, MAX(stay_date) AS latest_date FROM target_dates").get() as DateRangeRow;
  const countByPriority: Record<TargetDatePriority, number> = { S: 0, A: 0, B: 0, C: 0 };
  for (const row of db.prepare("SELECT priority, COUNT(*) AS count FROM target_dates GROUP BY priority").all() as PriorityCountRow[]) {
    countByPriority[row.priority] = row.count;
  }

  return {
    totalTargetDates,
    activeTargetDates,
    countByPriority,
    earliestDate: range.earliest_date,
    latestDate: range.latest_date,
    samples: {
      S: samplePriority(db, "S"),
      A: samplePriority(db, "A"),
      B: samplePriority(db, "B"),
      C: samplePriority(db, "C")
    }
  };
}

export function formatTargetDatesInspection(inspection: TargetDatesInspection): string {
  return [
    `total_target_dates=${inspection.totalTargetDates}`,
    `active_target_dates=${inspection.activeTargetDates}`,
    `count_by_priority=${JSON.stringify(inspection.countByPriority)}`,
    `earliest_date=${inspection.earliestDate ?? "null"}`,
    `latest_date=${inspection.latestDate ?? "null"}`,
    "sample_s_dates:",
    ...formatSamples(inspection.samples.S),
    "sample_a_dates:",
    ...formatSamples(inspection.samples.A),
    "sample_b_dates:",
    ...formatSamples(inspection.samples.B),
    "sample_c_dates:",
    ...formatSamples(inspection.samples.C)
  ].join("\n");
}

function samplePriority(db: LocalDatabase, priority: TargetDatePriority): TargetDateRow[] {
  return db
    .prepare(
      `SELECT stay_date, reason
       FROM target_dates
       WHERE priority = ? AND active = 1
       ORDER BY stay_date ASC
       LIMIT 5`
    )
    .all(priority) as TargetDateRow[];
}

function formatSamples(rows: TargetDateRow[]): string[] {
  return rows.length === 0 ? ["  none"] : rows.map((row) => `  ${row.stay_date} ${row.reason}`);
}

if (process.argv[1]?.endsWith("inspectTargetDates.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(formatTargetDatesInspection(inspectTargetDates(db)));
  } finally {
    closeDatabase(db);
  }
}
