import { closeDatabase, executeMigration, openLocalDatabase } from "../db/client";
import type { LocalDatabase } from "../db/client";

interface AttemptRow {
  run_id: string;
  job_id: string;
  property_id: string;
  property_name: string | null;
  ota: string;
  stay_date: string;
  attempted_at_jst: string;
  outcome: string;
  availability_status: string | null;
  price_total_tax_included: number | null;
  error_reason: string | null;
  screenshot_path: string | null;
  debug_json_path: string | null;
  retry_count: number;
}

interface CountRow {
  count: number;
}

function findLatestRunId(db: LocalDatabase): string | undefined {
  const row = db
    .prepare(
      `SELECT run_id FROM collection_job_attempts
       ORDER BY attempted_at_jst DESC
       LIMIT 1`
    )
    .get() as { run_id: string } | undefined;
  return row?.run_id;
}

function main(): void {
  const db = openLocalDatabase();
  try {
    executeMigration(db);

    const totalCount = (
      db.prepare("SELECT COUNT(*) AS count FROM collection_job_attempts").get() as CountRow
    ).count;

    if (totalCount === 0) {
      console.log("no_collection_job_attempts_found");
      return;
    }

    const latestRunId = findLatestRunId(db);
    if (latestRunId === undefined) {
      console.log("no_collection_job_attempts_found");
      return;
    }

    const attempts = db
      .prepare(
        `SELECT
           a.run_id,
           a.job_id,
           a.property_id,
           p.name AS property_name,
           a.ota,
           a.stay_date,
           a.attempted_at_jst,
           a.outcome,
           a.availability_status,
           a.price_total_tax_included,
           a.error_reason,
           a.screenshot_path,
           a.debug_json_path,
           a.retry_count
         FROM collection_job_attempts a
         LEFT JOIN properties p ON p.id = a.property_id
         WHERE a.run_id = ?
         ORDER BY a.attempted_at_jst ASC`
      )
      .all(latestRunId) as AttemptRow[];

    const outcomeCounts = attempts.reduce<Record<string, number>>((acc, row) => {
      acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
      return acc;
    }, {});

    console.log(`latest_run_id=${latestRunId}`);
    console.log(`attempt_count=${attempts.length}`);
    console.log(`outcome_counts=${JSON.stringify(outcomeCounts)}`);
    console.log("---");

    for (const row of attempts) {
      console.log(`stay_date=${row.stay_date}`);
      console.log(`  ota=${row.ota}`);
      if (row.property_name !== null) {
        console.log(`  property_name=${row.property_name}`);
      }
      console.log(`  outcome=${row.outcome}`);
      console.log(`  availability_status=${row.availability_status ?? "null"}`);
      if (row.price_total_tax_included !== null) {
        console.log(`  price_total_tax_included=${row.price_total_tax_included}`);
      }
      if (row.error_reason !== null) {
        console.log(`  error_reason=${row.error_reason}`);
      }
      if (row.screenshot_path !== null) {
        console.log(`  screenshot_path=${row.screenshot_path}`);
      }
      if (row.debug_json_path !== null) {
        console.log(`  debug_json_path=${row.debug_json_path}`);
      }
      if (row.retry_count > 0) {
        console.log(`  retry_count=${row.retry_count}`);
      }
    }
  } finally {
    closeDatabase(db);
  }
}

main();
