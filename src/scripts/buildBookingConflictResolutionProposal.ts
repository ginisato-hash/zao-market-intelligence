// Phase BOOKING-B10Y — build Booking conflict resolution proposal.
//
// Reads B10X/B09X/history artifacts and compares conflict rows in memory. Writes
// local proposal/debug artifacts only. No history append, DB write, AI context
// refresh, live Booking fetch, or Playwright.

import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildConflictComparisons,
  buildFuturePhasePlan,
  buildRecommendedPolicy,
  buildRowIdentityPolicyEvaluation,
  buildSafetyConfirmation,
  decideB10Y,
  renderConflictCsv,
  renderReport,
  summarizeDifferences,
  validateB10XArtifact,
  type B09XArtifactLike,
  type B10XArtifactLike
} from "../services/bookingConflictResolutionProposal";
import { parseCsvTable } from "../services/historyToDbSyncDryRun";

const SOURCE_B10X_ARTIFACT_PATH =
  ".data/reports/automation/booking_bounded_history_append_proposal_20260604_163035.json";
const SOURCE_B09X_ARTIFACT_PATH =
  ".data/reports/source-discovery/booking_bounded_expanded_collection_20260604_161623.json";
const HISTORY_DIR = ".data/history";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/booking-conflict-resolution-proposal";

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function jstIso(): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return `${formatted.replace(" ", "T")}+09:00`;
}

function loadHistoryRowsById(): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  const dir = resolve(HISTORY_DIR);
  const files = readdirSync(dir).filter((file) => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(file));
  for (const file of files) {
    const table = parseCsvTable(readFileSync(join(dir, file), "utf8"));
    for (const row of table.rows) {
      const rowId = row["row_id"] ?? "";
      if (rowId) out.set(rowId, row);
    }
  }
  return out;
}

async function run(): Promise<{ reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string }> {
  const ts = timestamp();
  const runId = `booking_conflict_resolution_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugPath, { recursive: true });

  const sourceB10xArtifactPath = resolve(SOURCE_B10X_ARTIFACT_PATH);
  const sourceB09xArtifactPath = resolve(SOURCE_B09X_ARTIFACT_PATH);
  const b10x = JSON.parse(readFileSync(sourceB10xArtifactPath, "utf8")) as B10XArtifactLike;
  const b09x = JSON.parse(readFileSync(sourceB09xArtifactPath, "utf8")) as B09XArtifactLike;
  const b10xValidation = validateB10XArtifact(b10x);
  const historyRowsById = loadHistoryRowsById();
  const b09xRowsById = new Map<string, Record<string, unknown>>();
  for (const row of b09x.normalized_rows_preview ?? []) {
    const rowId = String(row["row_id"] ?? "");
    if (rowId) b09xRowsById.set(rowId, row);
  }

  const conflictComparisonRows = buildConflictComparisons({
    conflictRowIds: b10xValidation.conflictRowIds,
    existingHistoryRowsById: historyRowsById,
    b09xRowsById
  });
  const differenceSummary = summarizeDifferences(conflictComparisonRows);
  const rowIdentityPolicyEvaluation = buildRowIdentityPolicyEvaluation();
  const recommendedPolicy = buildRecommendedPolicy(differenceSummary);
  const futurePhasePlan = buildFuturePhasePlan(differenceSummary);
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideB10Y({ validB10x: b10xValidation.valid, summary: differenceSummary });

  const reportPath = resolve(REPORT_DIR, `booking_conflict_resolution_proposal_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `booking_conflict_resolution_proposal_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `booking_conflict_resolution_proposal_${ts}.csv`);

  writeFileSync(csvPath, renderConflictCsv(conflictComparisonRows), "utf8");
  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      sourceB10xArtifactPath,
      sourceB09xArtifactPath,
      summary: differenceSummary,
      recommendedPolicy,
      futurePhasePlan,
      reportPath,
      jsonPath,
      csvPath,
      debugPath
    }),
    "utf8"
  );

  const output = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_b10x_artifact_path: sourceB10xArtifactPath,
    source_b09x_artifact_path: sourceB09xArtifactPath,
    conflict_count: conflictComparisonRows.length,
    conflict_comparison_rows: conflictComparisonRows,
    difference_summary: differenceSummary,
    per_row_recommended_actions: conflictComparisonRows.map((row) => ({
      row_id: row.row_id,
      recommended_action: row.recommended_action,
      reason: row.recommendation_reason
    })),
    row_identity_policy_evaluation: rowIdentityPolicyEvaluation,
    recommended_policy: recommendedPolicy,
    b11x_blocker_status: recommendedPolicy.b11x_recommendation,
    future_phase_plan: futurePhasePlan,
    safety_confirmation: safetyConfirmation,
    b10x_validation: b10xValidation,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };
  writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf8");

  const existingConflictRows = conflictComparisonRows.map((row) => historyRowsById.get(row.row_id) ?? null);
  const newConflictRows = conflictComparisonRows.map((row) => b09xRowsById.get(row.row_id) ?? null);
  await writeFile(join(debugPath, "source_b10x_artifact.json"), JSON.stringify(b10x, null, 2), "utf8");
  await writeFile(join(debugPath, "source_b09x_artifact.json"), JSON.stringify(b09x, null, 2), "utf8");
  await writeFile(join(debugPath, "conflict_rows_existing.json"), JSON.stringify(existingConflictRows, null, 2), "utf8");
  await writeFile(join(debugPath, "conflict_rows_new.json"), JSON.stringify(newConflictRows, null, 2), "utf8");
  await writeFile(join(debugPath, "conflict_comparison_rows.json"), JSON.stringify(conflictComparisonRows, null, 2), "utf8");
  await writeFile(join(debugPath, "difference_summary.json"), JSON.stringify(differenceSummary, null, 2), "utf8");
  await writeFile(join(debugPath, "row_identity_policy_options.json"), JSON.stringify(rowIdentityPolicyEvaluation, null, 2), "utf8");
  await writeFile(join(debugPath, "recommended_resolution_plan.json"), JSON.stringify(recommendedPolicy, null, 2), "utf8");
  await writeFile(join(debugPath, "future_phase_plan.json"), JSON.stringify(futurePhasePlan, null, 2), "utf8");
  await writeFile(join(debugPath, "safety_confirmation.json"), JSON.stringify(safetyConfirmation, null, 2), "utf8");

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

run()
  .then((result) => {
    console.log(`report_path=${result.reportPath}`);
    console.log(`json_path=${result.jsonPath}`);
    console.log(`csv_path=${result.csvPath}`);
    console.log(`debug_artifact_path=${result.debugPath}`);
    console.log(`decision=${result.decision}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
