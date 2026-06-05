// Phase BOOKING-ID01X - build Booking row identity / observation model design.
//
// Reads the B10Y conflict proposal and writes design/report artifacts only. No
// history append, DB write, migration execution, context refresh, live Booking
// collection, or Playwright.

import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildConflictPolicyMatrix,
  buildCurrentProblemSummary,
  buildDbAiViewDesign,
  buildFuturePhasePlan,
  buildIdentityModel,
  buildMigrationPlan,
  buildOptionComparison,
  buildRecommendedPolicy,
  buildSafetyConfirmation,
  decideBookingRowIdentityDesign,
  renderIdentityCsv,
  renderReport,
  validateB10YArtifact,
  type B10YArtifactLike
} from "../services/bookingRowIdentityDesign";

const SOURCE_B10Y_ARTIFACT_PATH = ".data/reports/automation/booking_conflict_resolution_proposal_20260604_163851.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/booking-row-identity-design";

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

async function run(): Promise<{ reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string }> {
  const ts = timestamp();
  const runId = `booking_row_identity_design_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  await mkdir(debugPath, { recursive: true });

  const sourceB10yArtifactPath = resolve(SOURCE_B10Y_ARTIFACT_PATH);
  const b10y = JSON.parse(readFileSync(sourceB10yArtifactPath, "utf8")) as B10YArtifactLike;
  const b10yValidation = validateB10YArtifact(b10y);
  const currentProblemSummary = buildCurrentProblemSummary(b10y);
  const identityModel = buildIdentityModel();
  const optionComparison = buildOptionComparison();
  const recommendedPolicy = buildRecommendedPolicy(currentProblemSummary);
  const conflictPolicyMatrix = buildConflictPolicyMatrix();
  const dbAiViewDesign = buildDbAiViewDesign();
  const migrationPlan = buildMigrationPlan();
  const futurePhasePlan = buildFuturePhasePlan();
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideBookingRowIdentityDesign({
    b10yValid: b10yValidation.valid,
    problemSummary: currentProblemSummary,
    optionComparison,
    identityModel
  });

  const reportPath = resolve(REPORT_DIR, `booking_row_identity_design_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `booking_row_identity_design_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `booking_row_identity_design_${ts}.csv`);

  writeFileSync(csvPath, renderIdentityCsv({ optionComparison, conflictPolicyMatrix }), "utf8");
  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      sourceB10yArtifactPath,
      currentProblemSummary,
      identityModel,
      optionComparison,
      recommendedPolicy,
      conflictPolicyMatrix,
      dbAiViewDesign,
      migrationPlan,
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
    source_b10y_artifact_path: sourceB10yArtifactPath,
    current_problem_summary: currentProblemSummary,
    identity_model: identityModel,
    option_comparison: optionComparison,
    recommended_policy: recommendedPolicy,
    conflict_policy_matrix: conflictPolicyMatrix,
    db_ai_view_design: dbAiViewDesign,
    migration_plan: migrationPlan,
    future_phase_plan: futurePhasePlan,
    safety_confirmation: safetyConfirmation,
    b10y_validation: b10yValidation,
    report_path: reportPath,
    json_path: jsonPath,
    csv_path: csvPath,
    debug_artifact_path: debugPath
  };
  writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf8");

  await writeFile(join(debugPath, "source_b10y_artifact.json"), JSON.stringify(b10y, null, 2), "utf8");
  await writeFile(join(debugPath, "current_row_id_analysis.json"), JSON.stringify(currentProblemSummary, null, 2), "utf8");
  await writeFile(join(debugPath, "identity_option_comparison.json"), JSON.stringify(optionComparison, null, 2), "utf8");
  await writeFile(join(debugPath, "recommended_identity_model.json"), JSON.stringify({ identityModel, recommendedPolicy }, null, 2), "utf8");
  await writeFile(join(debugPath, "conflict_policy_matrix.json"), JSON.stringify(conflictPolicyMatrix, null, 2), "utf8");
  await writeFile(join(debugPath, "db_view_design.json"), JSON.stringify(dbAiViewDesign, null, 2), "utf8");
  await writeFile(join(debugPath, "migration_plan.json"), JSON.stringify(migrationPlan, null, 2), "utf8");
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
