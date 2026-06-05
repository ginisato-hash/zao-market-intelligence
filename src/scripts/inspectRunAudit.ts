import {
  closeDatabase,
  executeMigration,
  openLocalDatabase
} from "../db/client";
import {
  buildRunAuditReport,
  findLatestRunId,
  type RunAuditRow,
  type RunAuditSummary
} from "../services/runAuditReport";

// ─── Formatting helpers ───────────────────────────────────────────────────────

function truncate(s: string | null | undefined, max: number): string {
  if (s === null || s === undefined) return "-";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatHuman(summary: RunAuditSummary): string {
  const lines: string[] = [
    `run_id=${summary.runId}`,
    `source=${summary.source}`,
    `row_count=${summary.rowCount}`,
    `count_by_availability_status=${JSON.stringify(summary.countByAvailabilityStatus)}`,
    `count_by_attempt_outcome=${JSON.stringify(summary.countByAttemptOutcome)}`,
    `invalid_unavailable_price_count=${summary.invalidUnavailablePriceCount}`,
    `missing_error_reason_count=${summary.missingErrorReasonCount}`,
    `mismatch_warning_count=${summary.mismatchWarningCount}`
  ];

  if (summary.rowCount === 0) {
    lines.push("no_rows_found");
    return lines.join("\n");
  }

  // Column widths — fixed for compactness.
  const COL = {
    source:   8,
    property: 24,
    date:     10,
    status:   10,
    outcome:  8,
    price:    8,
    error:    28,
    warnings: 36
  } as const;

  const pad = (s: string, w: number) => s.padEnd(w).slice(0, w);
  const header = [
    pad("source",   COL.source),
    pad("property", COL.property),
    pad("date",     COL.date),
    pad("status",   COL.status),
    pad("outcome",  COL.outcome),
    pad("price",    COL.price),
    pad("error",    COL.error),
    pad("warnings", COL.warnings)
  ].join(" | ");
  const divider = "-".repeat(header.length);

  lines.push("---");
  lines.push(header);
  lines.push(divider);

  for (const row of summary.rows) {
    const warningStr =
      row.warnings.length === 0 ? "-" : row.warnings.join("; ");
    lines.push(
      [
        pad(truncate(row.source,           COL.source),   COL.source),
        pad(truncate(row.propertyName,     COL.property), COL.property),
        pad(row.stayDate,                                 COL.date),
        pad(row.availabilityStatus,                       COL.status),
        pad(row.attemptOutcome ?? "-",                    COL.outcome),
        pad(row.persistedPrice?.toString() ?? "-",        COL.price),
        pad(truncate(row.errorReason,      COL.error),    COL.error),
        pad(truncate(warningStr,           COL.warnings), COL.warnings)
      ].join(" | ")
    );
  }

  // Warning detail for any rows that have them.
  const warnRows = summary.rows.filter((r: RunAuditRow) => r.warnings.length > 0);
  if (warnRows.length > 0) {
    lines.push("---");
    lines.push(`warnings_detail (${warnRows.length} rows):`);
    for (const row of warnRows) {
      lines.push(`  ${row.stayDate} ${row.propertyName}: ${row.warnings.join(", ")}`);
    }
  }

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const outputJson = process.env["AUDIT_OUTPUT"] === "json";
const runIdEnv   = process.env["AUDIT_RUN_ID"];

const db = openLocalDatabase();
try {
  executeMigration(db);

  const runId = runIdEnv ?? findLatestRunId(db);
  if (runId === undefined) {
    if (outputJson) {
      console.log(JSON.stringify({ error: "no_runs_found" }));
    } else {
      console.log("no_runs_found");
    }
    process.exit(0);
  }

  const summary = buildRunAuditReport(db, runId);

  if (outputJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatHuman(summary));
  }
} finally {
  closeDatabase(db);
}
