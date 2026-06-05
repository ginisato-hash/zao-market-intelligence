export type TargetDatePriority = "S" | "A" | "B" | "C";

const HOURS_PER_DAY = 24;

/**
 * How often each target-date priority should be refreshed.
 * Higher priority → shorter cadence → fresher data.
 */
const CADENCE_HOURS: Record<TargetDatePriority, number> = {
  S: 24,
  A: 72,
  B: 7 * HOURS_PER_DAY,
  C: 14 * HOURS_PER_DAY
};

export function getRefreshCadenceHours(priority: TargetDatePriority): number {
  return CADENCE_HOURS[priority];
}

/**
 * Pure cadence check. A job is due when:
 * - there is no previous attempt, or
 * - the last attempt is at least `cadence` hours old.
 *
 * Failed attempts still count as attempts here: we respect the cadence and do
 * not retry aggressively in this phase. An unparseable last-attempt timestamp is
 * treated as "due" (safer to refresh than to skip on bad data).
 */
export function isJobDueForRefresh(args: {
  priority: TargetDatePriority;
  lastAttemptedAtJst: string | null;
  nowJst: string;
}): boolean {
  if (args.lastAttemptedAtJst === null || args.lastAttemptedAtJst.trim() === "") {
    return true;
  }

  const lastMs = Date.parse(args.lastAttemptedAtJst);
  if (Number.isNaN(lastMs)) {
    return true;
  }

  const nowMs = Date.parse(args.nowJst);
  if (Number.isNaN(nowMs)) {
    throw new Error(`invalid nowJst timestamp: ${args.nowJst}`);
  }

  const elapsedHours = (nowMs - lastMs) / (1000 * 60 * 60);
  return elapsedHours >= getRefreshCadenceHours(args.priority);
}
