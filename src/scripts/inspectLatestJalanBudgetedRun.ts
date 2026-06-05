import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeDatabase, executeMigration, openLocalDatabase, type LocalDatabase } from "../db/client";

interface BudgetedAttemptRow {
  run_id: string;
  property_name: string | null;
  stay_date: string;
  outcome: string;
  availability_status: string | null;
  price_total_tax_included: number | null;
  error_reason: string | null;
  screenshot_path: string | null;
  debug_json_path: string | null;
  priority: string | null;
}

export function findLatestJalanBudgetedRunId(db: LocalDatabase): string | undefined {
  const row = db
    .prepare(
      `SELECT run_id
       FROM collection_job_attempts
       WHERE ota = 'jalan' AND job_id LIKE 'jalan_budgeted_%'
       GROUP BY run_id
       ORDER BY MAX(attempted_at_jst) DESC
       LIMIT 1`
    )
    .get() as { run_id: string } | undefined;
  return row?.run_id;
}

export function inspectLatestJalanBudgetedRun(db: LocalDatabase): string {
  executeMigration(db);
  const runId = findLatestJalanBudgetedRunId(db);
  if (runId === undefined) return "no_jalan_budgeted_run_found";
  const rows = loadRows(db, runId);
  return formatRows(runId, rows);
}

function loadRows(db: LocalDatabase, runId: string): BudgetedAttemptRow[] {
  return db
    .prepare(
      `SELECT
         a.run_id,
         p.name AS property_name,
         a.stay_date,
         a.outcome,
         a.availability_status,
         a.price_total_tax_included,
         a.error_reason,
         a.screenshot_path,
         a.debug_json_path,
         td.priority
       FROM collection_job_attempts a
       LEFT JOIN properties p ON p.id = a.property_id
       LEFT JOIN target_dates td ON td.stay_date = a.stay_date
       WHERE a.run_id = ?
         AND a.ota = 'jalan'
         AND a.job_id LIKE 'jalan_budgeted_%'
       ORDER BY
         CASE td.priority WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END ASC,
         a.stay_date ASC,
         p.name ASC`
    )
    .all(runId) as BudgetedAttemptRow[];
}

function formatRows(runId: string, rows: BudgetedAttemptRow[]): string {
  const lines = [
    `collector_run_id=${runId}`,
    `job_count=${rows.length}`,
    `count_by_priority=${JSON.stringify(countBy(rows, (row) => row.priority ?? "unknown"))}`,
    `count_by_property=${JSON.stringify(countBy(rows, (row) => row.property_name ?? "unknown"))}`,
    `count_by_availability_status=${JSON.stringify(countBy(rows, (row) => row.availability_status ?? "null"))}`,
    `count_by_attempt_outcome=${JSON.stringify(countBy(rows, (row) => row.outcome))}`,
    "---",
    "priority | stay_date | property | status | persisted_price | selected_policy_price | attempt_outcome | error_reason | warnings"
  ];

  for (const row of rows) {
    const selectedPolicyPrice = readSelectedPolicyPrice(row.debug_json_path);
    const warning =
      row.price_total_tax_included !== null &&
      selectedPolicyPrice !== null &&
      row.price_total_tax_included !== selectedPolicyPrice
        ? "persisted_price_policy_mismatch"
        : "none";
    lines.push(
      `${row.priority ?? "unknown"} | ${row.stay_date} | ${row.property_name ?? "unknown"} | ${row.availability_status ?? "null"} | ${row.price_total_tax_included ?? "null"} | ${selectedPolicyPrice ?? "null"} | ${row.outcome} | ${row.error_reason ?? "null"} | ${warning}`
    );
  }

  lines.push("---");
  lines.push("paths:");
  for (const row of rows) {
    lines.push(`  ${row.property_name ?? "unknown"} ${row.stay_date} screenshot=${row.screenshot_path ?? "null"}`);
    lines.push(`  ${row.property_name ?? "unknown"} ${row.stay_date} debug=${row.debug_json_path ?? "null"}`);
  }

  return lines.join("\n");
}

function readSelectedPolicyPrice(debugJsonPath: string | null): number | null {
  if (debugJsonPath === null) return null;
  const path = resolve(debugJsonPath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { acceptedPricePolicy?: { selectedPrice?: number } };
    return typeof parsed.acceptedPricePolicy?.selectedPrice === "number" ? parsed.acceptedPricePolicy.selectedPrice : null;
  } catch {
    return null;
  }
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

if (process.argv[1]?.endsWith("inspectLatestJalanBudgetedRun.ts")) {
  const db = openLocalDatabase();
  try {
    console.log(inspectLatestJalanBudgetedRun(db));
  } finally {
    closeDatabase(db);
  }
}
