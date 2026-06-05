import { createHash } from "node:crypto";
import type { TargetDatePriority } from "../../domain/types";
import type { LocalDatabase } from "../client";

export interface TargetDateRecord {
  targetDateId: string;
  stayDate: string;
  priority: TargetDatePriority;
  reason: string;
  active: boolean;
}

interface TargetDateRow {
  target_date_id: string;
  stay_date: string;
  priority: TargetDatePriority;
  reason: string;
  active: number;
}

export function upsertTargetDate(
  db: LocalDatabase,
  record: Omit<TargetDateRecord, "targetDateId"> & { targetDateId?: string }
): "inserted" | "updated" {
  const existing = db
    .prepare("SELECT target_date_id FROM target_dates WHERE stay_date = ?")
    .get(record.stayDate) as { target_date_id: string } | undefined;

  if (existing === undefined) {
    db.prepare(
      `INSERT INTO target_dates (target_date_id, stay_date, priority, reason, active)
       VALUES (@targetDateId, @stayDate, @priority, @reason, @active)`
    ).run({
      targetDateId: record.targetDateId ?? deterministicTargetDateId(record.stayDate),
      stayDate: record.stayDate,
      priority: record.priority,
      reason: record.reason,
      active: Number(record.active)
    });
    return "inserted";
  }

  db.prepare(
    `UPDATE target_dates
     SET priority = @priority,
         reason = @reason,
         active = @active,
         updated_at = datetime('now')
     WHERE target_date_id = @targetDateId`
  ).run({
    targetDateId: existing.target_date_id,
    priority: record.priority,
    reason: record.reason,
    active: Number(record.active)
  });
  return "updated";
}

export function listActiveTargetDates(
  db: LocalDatabase,
  priorities?: readonly TargetDatePriority[]
): TargetDateRecord[] {
  const rows =
    priorities === undefined || priorities.length === 0
      ? db
          .prepare(
            `SELECT target_date_id, stay_date, priority, reason, active
             FROM target_dates
             WHERE active = 1`
          )
          .all()
      : db
          .prepare(
            `SELECT target_date_id, stay_date, priority, reason, active
             FROM target_dates
             WHERE active = 1
               AND priority IN (${priorities.map(() => "?").join(", ")})`
          )
          .all(...priorities);

  return rows.map((row) => {
    const typed = row as TargetDateRow;
    return {
      targetDateId: typed.target_date_id,
      stayDate: typed.stay_date,
      priority: typed.priority,
      reason: typed.reason,
      active: typed.active === 1
    };
  });
}

function deterministicTargetDateId(stayDate: string): string {
  return `target_date_${createHash("sha1").update(stayDate).digest("hex").slice(0, 12)}`;
}
