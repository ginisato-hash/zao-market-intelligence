import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { executeMigration, type LocalDatabase } from "../src/db/client";
import {
  buildRunAuditReport,
  findLatestRunId
} from "../src/services/runAuditReport";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function openTestDb(): LocalDatabase {
  const db = new Database(":memory:") as LocalDatabase;
  executeMigration(db);
  return db;
}

function seedTestRun(db: LocalDatabase): string {
  const runId = "run_audit_ui_001";
  db.prepare(
    `INSERT INTO properties (id, name, postal_code, area_name, property_type, price_segment, meal_style, ski_access)
     VALUES ('prop_a', 'ル・ベール蔵王', '990-2301', 'Zao Onsen', 'unknown', 'unknown', 'unknown', 'unknown')`
  ).run();
  db.prepare(
    `INSERT INTO collector_runs (id, ota, started_at_jst, status)
     VALUES (?, 'jalan', '2026-05-29T10:00:00+09:00', 'completed')`
  ).run(runId);
  db.prepare(
    `INSERT INTO rate_snapshots
       (id, run_id, property_id, ota, stay_date, guests, nights,
        price_total_tax_included, availability_status, confidence, checked_at_jst)
     VALUES ('rs_a1', ?, 'prop_a', 'jalan', '2026-08-08', 2, 1, 15000, 'available', 'A',
             '2026-05-29T10:00:00+09:00')`
  ).run(runId);
  db.prepare(
    `INSERT INTO rate_snapshots
       (id, run_id, property_id, ota, stay_date, guests, nights,
        price_total_tax_included, availability_status, confidence, checked_at_jst, error_reason)
     VALUES ('rs_a2', ?, 'prop_a', 'jalan', '2026-08-09', 2, 1, NULL, 'failed', 'A',
             '2026-05-29T10:00:00+09:00', 'jalan_page_blank')`
  ).run(runId);
  db.prepare(
    `INSERT INTO collection_job_attempts
       (id, job_id, run_id, property_id, ota, stay_date, guests, nights,
        attempted_at_jst, outcome, availability_status, price_total_tax_included,
        error_reason, screenshot_path, debug_json_path)
     VALUES ('a1','j1',?,'prop_a','jalan','2026-08-08',2,1,
             '2026-05-29T10:00:00+09:00','success','available',15000,
             NULL,'.data/screenshots/t1.png','.data/debug/run/2026-08-08.json')`
  ).run(runId);
  db.prepare(
    `INSERT INTO collection_job_attempts
       (id, job_id, run_id, property_id, ota, stay_date, guests, nights,
        attempted_at_jst, outcome, availability_status, price_total_tax_included,
        error_reason, screenshot_path, debug_json_path)
     VALUES ('a2','j2',?,'prop_a','jalan','2026-08-09',2,1,
             '2026-05-29T10:00:00+09:00','failed','failed',NULL,
             'jalan_page_blank','.data/screenshots/t2.png','.data/debug/run/2026-08-09.json')`
  ).run(runId);
  return runId;
}

// ─── Human-readable output helpers ───────────────────────────────────────────

/** Formats the summary into human-readable text (mirrors inspectRunAudit.ts logic). */
function formatHuman(summary: ReturnType<typeof buildRunAuditReport>): string {
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
  if (summary.rowCount > 0) {
    lines.push("---");
    for (const row of summary.rows) {
      lines.push(
        `${row.source} | ${row.propertyName} | ${row.stayDate} | ${row.availabilityStatus} | ${row.attemptOutcome ?? "-"} | ${row.persistedPrice ?? "-"} | ${row.errorReason ?? "-"}`
      );
    }
  }
  return lines.join("\n");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("inspectRunAudit (output formatting tests)", () => {
  it("human output includes run_id line", () => {
    const db = openTestDb();
    const runId = seedTestRun(db);
    const summary = buildRunAuditReport(db, runId);
    const output = formatHuman(summary);
    expect(output).toContain(`run_id=${runId}`);
    db.close();
  });

  it("human output includes row_count", () => {
    const db = openTestDb();
    const runId = seedTestRun(db);
    const summary = buildRunAuditReport(db, runId);
    const output = formatHuman(summary);
    expect(output).toContain("row_count=2");
    db.close();
  });

  it("human output includes per-row table with property name", () => {
    const db = openTestDb();
    const runId = seedTestRun(db);
    const summary = buildRunAuditReport(db, runId);
    const output = formatHuman(summary);
    expect(output).toContain("ル・ベール蔵王");
    db.close();
  });

  it("human output includes count_by_availability_status", () => {
    const db = openTestDb();
    const runId = seedTestRun(db);
    const summary = buildRunAuditReport(db, runId);
    const output = formatHuman(summary);
    expect(output).toContain("count_by_availability_status=");
    expect(output).toContain("available");
    expect(output).toContain("failed");
    db.close();
  });

  it("JSON output is valid JSON with expected keys", () => {
    const db = openTestDb();
    const runId = seedTestRun(db);
    const summary = buildRunAuditReport(db, runId);
    const json = JSON.stringify(summary, null, 2);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed["runId"]).toBe(runId);
    expect(parsed["source"]).toBe("jalan");
    expect(parsed["rowCount"]).toBe(2);
    expect(Array.isArray(parsed["rows"])).toBe(true);
    db.close();
  });

  it("JSON output includes rows array with correct structure", () => {
    const db = openTestDb();
    const runId = seedTestRun(db);
    const summary = buildRunAuditReport(db, runId);
    const json = JSON.parse(JSON.stringify(summary)) as { rows: Array<Record<string, unknown>> };
    const firstRow = json.rows[0];
    expect(firstRow).toHaveProperty("stayDate");
    expect(firstRow).toHaveProperty("availabilityStatus");
    expect(firstRow).toHaveProperty("warnings");
    expect(Array.isArray(firstRow?.["warnings"])).toBe(true);
    db.close();
  });

  it("no_runs_found when latest run ID is undefined on empty DB", () => {
    const db = openTestDb();
    const latest = findLatestRunId(db);
    expect(latest).toBeUndefined();
    db.close();
  });

  it("returns correct latest run ID after seeding", () => {
    const db = openTestDb();
    const runId = seedTestRun(db);
    const latest = findLatestRunId(db);
    expect(latest).toBe(runId);
    db.close();
  });

  it("does not require live OTA or network access", () => {
    // This test exists solely to document the contract — the DB is in-memory.
    const db = openTestDb();
    expect(() => buildRunAuditReport(db, "run_nonexistent")).not.toThrow();
    db.close();
  });
});
