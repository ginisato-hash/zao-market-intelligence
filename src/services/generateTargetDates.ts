export type TargetDatePriority = "S" | "A" | "B" | "C";

export type GeneratedTargetDate = {
  stayDate: string;
  priority: TargetDatePriority;
  reason: string;
  active: boolean;
};

export interface GenerateTargetDatesInput {
  from: string;
  to: string;
  holidays: Array<{ date: string; name: string }>;
  today?: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function generateTargetDates(input: GenerateTargetDatesInput): GeneratedTargetDate[] {
  const from = parseYmd(input.from);
  const to = parseYmd(input.to);
  if (from.getTime() > to.getTime()) {
    throw new Error("from must be on or before to");
  }

  const today = parseYmd(input.today ?? toYmd(new Date()));
  const holidays = new Map(input.holidays.map((holiday) => [holiday.date, holiday.name]));
  const generated: GeneratedTargetDate[] = [];

  for (let current = from; current.getTime() <= to.getTime(); current = addDays(current, 1)) {
    const stayDate = toYmd(current);
    const rule = classifyDate(stayDate, holidays, today);
    generated.push({
      stayDate,
      priority: rule.priority,
      reason: rule.reason,
      active: true
    });
  }

  return generated;
}

function classifyDate(
  stayDate: string,
  holidays: Map<string, string>,
  today: Date
): { priority: TargetDatePriority; reason: string } {
  const date = parseYmd(stayDate);
  const holidayName = holidays.get(stayDate);
  if (holidayName !== undefined) {
    return { priority: "S", reason: `national_holiday:${holidayName}` };
  }

  const nextHolidayName = holidays.get(toYmd(addDays(date, 1)));
  if (nextHolidayName !== undefined) {
    return { priority: "S", reason: `day_before_national_holiday:${nextHolidayName}` };
  }

  if (isInRange(stayDate, "2026-08-08", "2026-08-16") || isInRange(stayDate, "2027-08-07", "2027-08-15")) {
    return { priority: "S", reason: "obon_peak" };
  }

  if (isNewYearSkiPeak(stayDate)) {
    return { priority: "S", reason: "new_year_ski_peak" };
  }

  const day = date.getUTCDay();
  const month = date.getUTCMonth() + 1;
  if (day === 6 && (month === 1 || month === 2)) {
    return { priority: "S", reason: "ski_peak_saturday" };
  }

  if ((day === 6 || day === 0) && isMajorThreeDayWeekend(stayDate, holidays)) {
    return { priority: "S", reason: "major_three_day_weekend" };
  }

  if (day === 6) {
    return { priority: "A", reason: isSummerAutumn(month) ? "summer_autumn_saturday" : "saturday" };
  }

  if (day === 5 && isSkiSeason(month)) {
    return { priority: "A", reason: "ski_season_friday" };
  }

  if (day === 5 && isSummerAutumn(month)) {
    return { priority: "A", reason: "summer_autumn_friday" };
  }

  if (day === 0 && (month === 1 || month === 2 || month === 8 || month === 10)) {
    return { priority: "A", reason: "high_season_sunday" };
  }

  if (day !== 0 && day !== 6 && daysBetween(today, date) >= 0 && daysBetween(today, date) <= 90) {
    return { priority: "B", reason: "near_term_weekday" };
  }

  if (day === 5) {
    return { priority: "B", reason: "friday" };
  }

  if (day !== 0 && day !== 6 && isSkiSeason(month)) {
    return { priority: "B", reason: "ski_season_weekday" };
  }

  if (day !== 0 && day !== 6 && isSummerAutumn(month)) {
    return { priority: "B", reason: "summer_autumn_weekday" };
  }

  return { priority: "C", reason: "low_demand_weekday" };
}

function isMajorThreeDayWeekend(stayDate: string, holidays: Map<string, string>): boolean {
  const date = parseYmd(stayDate);
  const day = date.getUTCDay();
  if (day === 6) {
    return holidays.has(toYmd(addDays(date, 2))) || holidays.has(toYmd(addDays(date, -1)));
  }
  if (day === 0) {
    return holidays.has(toYmd(addDays(date, 1))) || holidays.has(toYmd(addDays(date, -2)));
  }
  return false;
}

function isNewYearSkiPeak(stayDate: string): boolean {
  const parts = stayDate.split("-").map(Number);
  const month = parts[1] ?? 0;
  const day = parts[2] ?? 0;
  return (month === 12 && day >= 26) || (month === 1 && day <= 3);
}

function isSkiSeason(month: number): boolean {
  return month === 12 || month === 1 || month === 2 || month === 3;
}

function isSummerAutumn(month: number): boolean {
  return month === 7 || month === 8 || month === 10;
}

function isInRange(value: string, from: string, to: string): boolean {
  return value >= from && value <= to;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * ONE_DAY_MS);
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / ONE_DAY_MS);
}

function parseYmd(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`Invalid YYYY-MM-DD date: ${value}`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || toYmd(date) !== value) {
    throw new Error(`Invalid YYYY-MM-DD date: ${value}`);
  }
  return date;
}

function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}
