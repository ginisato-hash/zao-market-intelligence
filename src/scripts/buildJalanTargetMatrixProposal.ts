// Phase JALAN-AUTO02X - build Jalan target matrix proposal.
//
// Reads local artifacts/seeds only. Writes proposal/debug artifacts only. It
// does not run live Jalan collection, browser automation, history writes, DB
// writes/sync, AI context refresh, or pricing output.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildAuto03xBoundedMatrix,
  buildBotRiskSafetyRules,
  buildDateWindowMatrix,
  buildDirectDirectionalExcludedPolicy,
  buildEvidenceRequirements,
  buildFuturePhasePlan,
  buildLocalJalanEvidenceInventory,
  buildManualReviewProperties,
  buildPageCapPlan,
  buildRisks,
  buildSafetyConfirmation,
  buildTargetPropertyMatrix,
  decideJalanTargetMatrixProposal,
  renderReport,
  renderTargetMatrixCsv,
  type LocalEvidenceFile,
  type JalanTargetMatrixProposal
} from "../services/jalanTargetMatrixProposal";

const AUTO01X_PATH = ".data/reports/automation/jalan_auto_integration_plan_20260604_214930.json";
const REPORT_DIR = ".data/reports/automation";
const DEBUG_ROOT = ".data/debug/jalan-target-matrix-proposal";
const EVIDENCE_PATHS = [
  "data/seeds/jalan_verified_properties.990-2301.sample.json",
  "data/seeds/property_source_coverage.990-2301.sample.json",
  "data/seeds/source_coverage_candidates.990-2301.ai-discovered.local.json",
  "data/seeds/source_coverage_candidates.990-2301.sample.json",
  "data/seeds/zao_source_listings.latest.json",
  "data/prototype/jalan.prototype.json",
  "data/prototype/jalan.three-property-batch.local.json",
  "data/prototype/jalan.five-property-batch.sample.json",
  ".data/reports/source-discovery/property_discovery_inventory_20260603_190920.json",
  ".data/reports/source-discovery/property_discovery_inventory_20260602_160622.json"
];

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

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
}

function readIfExists(path: string): LocalEvidenceFile | null {
  try {
    return { file_path: path, source_text: readFileSync(resolve(path), "utf8") };
  } catch {
    return null;
  }
}

function listDebugJalanJsonFiles(): string[] {
  const root = resolve(".data/debug/jalan");
  try {
    return readdirSync(root)
      .flatMap((runDir) => {
        const fullRun = join(root, runDir);
        if (!statSync(fullRun).isDirectory()) return [];
        return readdirSync(fullRun)
          .filter((file) => /^property_.*\.json$/u.test(file))
          .map((file) => join(".data/debug/jalan", runDir, file));
      })
      .sort();
  } catch {
    return [];
  }
}

function loadEvidenceFiles(): LocalEvidenceFile[] {
  const staticFiles = EVIDENCE_PATHS.map(readIfExists).filter((file): file is LocalEvidenceFile => file !== null);
  const debugFiles = listDebugJalanJsonFiles()
    .slice(-80)
    .map(readIfExists)
    .filter((file): file is LocalEvidenceFile => file !== null);
  return [...staticFiles, ...debugFiles];
}

function buildSourceAuto01xSummary(auto01x: Record<string, unknown>): Record<string, unknown> {
  return {
    decision: auto01x["decision"],
    jalan_db_summary: auto01x["jalan_db_summary"],
    booking_baseline: auto01x["booking_baseline"],
    next_phase: auto01x["next_phase"],
    key_gaps: ["property-level identity", "meal condition", "direct rows need revalidation before broader automation"]
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(): { reportPath: string; jsonPath: string; csvPath: string; debugPath: string; decision: string } {
  const ts = timestamp();
  const runId = `jalan_target_matrix_proposal_${ts}`;
  const generatedAtJst = jstIso();
  const reportDir = resolve(REPORT_DIR);
  const debugPath = resolve(DEBUG_ROOT, ts);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(debugPath, { recursive: true });

  const sourceAuto01x = readJson(AUTO01X_PATH);
  const sourceAuto01xSummary = buildSourceAuto01xSummary(sourceAuto01x);
  const evidenceFiles = loadEvidenceFiles();
  const localJalanEvidenceInventory = buildLocalJalanEvidenceInventory(evidenceFiles);
  const targetPropertyMatrix = buildTargetPropertyMatrix(localJalanEvidenceInventory);
  const manualReviewProperties = buildManualReviewProperties(targetPropertyMatrix);
  const dateWindowMatrix = buildDateWindowMatrix();
  const auto03xBoundedMatrix = buildAuto03xBoundedMatrix(targetPropertyMatrix, dateWindowMatrix);
  const pageCapPlan = buildPageCapPlan(auto03xBoundedMatrix);
  const directDirectionalExcludedPolicy = buildDirectDirectionalExcludedPolicy();
  const evidenceRequirements = buildEvidenceRequirements();
  const botRiskSafetyRules = buildBotRiskSafetyRules();
  const futurePhasePlan = buildFuturePhasePlan();
  const risks = buildRisks();
  const safetyConfirmation = buildSafetyConfirmation();
  const decision = decideJalanTargetMatrixProposal({ targetPropertyMatrix, pageCapPlan });
  const nextPhase = "JALAN-AUTO03X — Bounded Jalan collection probe / preview rows";

  const output: JalanTargetMatrixProposal = {
    run_id: runId,
    generated_at_jst: generatedAtJst,
    decision,
    source_auto01x_summary: sourceAuto01xSummary,
    local_jalan_evidence_inventory: localJalanEvidenceInventory,
    target_property_matrix: targetPropertyMatrix,
    manual_review_properties: manualReviewProperties,
    date_window_matrix: dateWindowMatrix,
    auto03x_bounded_matrix: auto03xBoundedMatrix,
    page_cap_plan: pageCapPlan,
    direct_directional_excluded_policy: directDirectionalExcludedPolicy,
    evidence_requirements: evidenceRequirements,
    bot_risk_safety_rules: botRiskSafetyRules,
    future_phase_plan: futurePhasePlan,
    risks,
    safety_confirmation: safetyConfirmation,
    next_phase: nextPhase
  };

  const reportPath = resolve(REPORT_DIR, `jalan_target_matrix_proposal_${ts}.md`);
  const jsonPath = resolve(REPORT_DIR, `jalan_target_matrix_proposal_${ts}.json`);
  const csvPath = resolve(REPORT_DIR, `jalan_target_matrix_proposal_${ts}.csv`);

  writeFileSync(
    reportPath,
    renderReport({
      generatedAtJst,
      decision,
      sourceAuto01xSummary,
      targetPropertyMatrix,
      manualReviewProperties,
      dateWindowMatrix,
      auto03xBoundedMatrix,
      pageCapPlan,
      policy: directDirectionalExcludedPolicy,
      evidenceRequirements,
      botRiskSafetyRules,
      futurePhasePlan,
      risks,
      safetyConfirmation
    }),
    "utf8"
  );
  writeJson(jsonPath, output);
  writeFileSync(csvPath, renderTargetMatrixCsv(targetPropertyMatrix), "utf8");

  writeJson(resolve(debugPath, "source_auto01x_artifact.json"), sourceAuto01x);
  writeJson(resolve(debugPath, "local_jalan_evidence_inventory.json"), localJalanEvidenceInventory);
  writeJson(resolve(debugPath, "target_property_matrix.json"), targetPropertyMatrix);
  writeJson(resolve(debugPath, "manual_review_properties.json"), manualReviewProperties);
  writeJson(resolve(debugPath, "date_window_matrix.json"), dateWindowMatrix);
  writeJson(resolve(debugPath, "auto03x_bounded_matrix.json"), auto03xBoundedMatrix);
  writeJson(resolve(debugPath, "direct_directional_excluded_policy.json"), directDirectionalExcludedPolicy);
  writeJson(resolve(debugPath, "future_phase_plan.json"), futurePhasePlan);
  writeJson(resolve(debugPath, "safety_confirmation.json"), safetyConfirmation);

  console.log(
    JSON.stringify(
      {
        decision,
        report_path: reportPath,
        json_path: jsonPath,
        csv_path: csvPath,
        debug_path: debugPath,
        proposed_pages: pageCapPlan.proposed_pages,
        proposed_properties: pageCapPlan.proposed_properties,
        manual_review_properties: manualReviewProperties.length
      },
      null,
      2
    )
  );

  return { reportPath, jsonPath, csvPath, debugPath, decision };
}

run();
