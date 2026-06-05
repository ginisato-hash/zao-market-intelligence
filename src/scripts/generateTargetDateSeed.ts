import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeDatabase, executeMigration, openLocalDatabase, runInTransaction, type LocalDatabase } from "../db/client";
import { upsertTargetDate } from "../db/repositories/targetDatesRepository";
import { generateTargetDates, type GeneratedTargetDate, type TargetDatePriority } from "../services/generateTargetDates";

const DEFAULT_HOLIDAY_PATH = "data/calendars/jp_holidays_2026_2027.json";
const DEFAULT_FROM = "2026-06-01";
const DEFAULT_TO = "2027-05-31";
const DEFAULT_TODAY = "2026-05-29";

export interface GenerateTargetDateSeedSummary {
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  totalGenerated: number;
  countByPriority: Record<TargetDatePriority, number>;
  firstDate: string | null;
  lastDate: string | null;
}

interface ExistingTargetDateRow {
  priority: TargetDatePriority;
  reason: string;
  active: number;
}

export function generateTargetDateSeed(options: {
  db?: LocalDatabase;
  from?: string;
  to?: string;
  today?: string;
  holidayPath?: string;
} = {}): GenerateTargetDateSeedSummary {
  const ownsDb = options.db === undefined;
  const db = options.db ?? openLocalDatabase();

  try {
    executeMigration(db);
    const generated = generateTargetDates({
      from: options.from ?? process.env.TARGET_DATE_FROM ?? DEFAULT_FROM,
      to: options.to ?? process.env.TARGET_DATE_TO ?? DEFAULT_TO,
      today: options.today ?? process.env.TARGET_DATE_TODAY ?? DEFAULT_TODAY,
      holidays: readHolidayCalendar(options.holidayPath ?? DEFAULT_HOLIDAY_PATH)
    });

    return runInTransaction(db, () => importGeneratedTargetDates(db, generated));
  } finally {
    if (ownsDb) {
      closeDatabase(db);
    }
  }
}

export function importGeneratedTargetDates(
  db: LocalDatabase,
  generated: GeneratedTargetDate[]
): GenerateTargetDateSeedSummary {
  const summary: GenerateTargetDateSeedSummary = {
    insertedCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    totalGenerated: generated.length,
    countByPriority: { S: 0, A: 0, B: 0, C: 0 },
    firstDate: generated[0]?.stayDate ?? null,
    lastDate: generated[generated.length - 1]?.stayDate ?? null
  };

  for (const record of generated) {
    summary.countByPriority[record.priority] += 1;
    const existing = db
      .prepare("SELECT priority, reason, active FROM target_dates WHERE stay_date = ?")
      .get(record.stayDate) as ExistingTargetDateRow | undefined;

    if (
      existing !== undefined &&
      existing.priority === record.priority &&
      existing.reason === record.reason &&
      existing.active === Number(record.active)
    ) {
      summary.unchangedCount += 1;
      continue;
    }

    const result = upsertTargetDate(db, {
      stayDate: record.stayDate,
      priority: record.priority,
      reason: record.reason,
      active: record.active
    });
    if (result === "inserted") {
      summary.insertedCount += 1;
    } else {
      summary.updatedCount += 1;
    }
  }

  return summary;
}

function readHolidayCalendar(path: string): Array<{ date: string; name: string }> {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Holiday calendar must be an array");
  }
  return parsed.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { date?: unknown }).date !== "string" ||
      typeof (item as { name?: unknown }).name !== "string"
    ) {
      throw new Error("Holiday calendar records must contain date and name strings");
    }
    return {
      date: (item as { date: string }).date,
      name: (item as { name: string }).name
    };
  });
}

if (process.argv[1]?.endsWith("generateTargetDateSeed.ts")) {
  const summary = generateTargetDateSeed();
  console.log(`inserted_count=${summary.insertedCount}`);
  console.log(`updated_count=${summary.updatedCount}`);
  console.log(`unchanged_count=${summary.unchangedCount}`);
  console.log(`total_generated=${summary.totalGenerated}`);
  console.log(`count_by_priority=${JSON.stringify(summary.countByPriority)}`);
  console.log(`first_date=${summary.firstDate ?? "null"}`);
  console.log(`last_date=${summary.lastDate ?? "null"}`);
}
