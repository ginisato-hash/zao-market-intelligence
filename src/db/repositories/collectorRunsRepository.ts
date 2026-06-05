import type { CollectorRun } from "../../domain/types";
import type { LocalDatabase } from "../client";

export function insertCollectorRunIfNeeded(db: LocalDatabase, run: CollectorRun): void {
  db.prepare(
    `INSERT OR IGNORE INTO collector_runs (id, ota, started_at_jst, finished_at_jst, status, created_at)
     VALUES (@id, @ota, @startedAtJst, @finishedAtJst, @status, @createdAt)`
  ).run({
    id: run.id,
    ota: run.ota,
    startedAtJst: run.startedAtJst,
    finishedAtJst: run.finishedAtJst ?? null,
    status: run.status,
    createdAt: run.createdAt
  });
}
